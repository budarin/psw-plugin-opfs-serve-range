/**
 * Состояние для LRU-эвикции: только in-memory (без индексного файла на диске).
 * Заполняется при скане плоского store; данные для эвикции берутся из футеров файлов.
 */

import type { FolderName, OpfsKey } from './types.js';
import {
    readMetadataFromFileFooter,
    OPFS_META_FOOTER_LENGTH,
} from './opfsFormat.js';
import { getRangeCache } from './opfsRangeCache.js';
import {
    getMetadataCache,
    type OpfsMetadataCacheEntry,
} from './opfsMetadataCache.js';
import { logCacheEvent } from './opfsCacheEventLog.js';

const LAST_ACCESSED_THROTTLE_MS = 5000;
const FOOTER_WRITE_THROTTLE_MS = 5000;

const lastAccessedUpdateByKey = new Map<OpfsKey, number>();

/** Очередь записей lastAccessed в футер (троттлинг 5 с). */
const pendingFooterWrites = new Map<OpfsKey, number>();
let pendingFooterDir: FileSystemDirectoryHandle | null = null;
let footerFlushTimer: ReturnType<typeof setTimeout> | null = null;

export interface EvictionIndexEntry {
    key: OpfsKey;
    size: number;
    lastAccessed: number;
}

interface FileCacheEntry {
    size: number;
    lastAccessed: number;
    evictable: boolean;
}

/** Один глобальный кэш: key → { size, lastAccessed, evictable } для плоского хранилища. */
const globalEvictionCache = new Map<OpfsKey, FileCacheEntry>();
let cachePopulated = false;

let indexLock: Promise<void> = Promise.resolve();

async function runWithLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = indexLock;
    let resolve: () => void;
    indexLock = new Promise<void>((r) => {
        resolve = r;
    });
    try {
        await prev;
        return await fn();
    } finally {
        resolve!();
    }
}

/**
 * Заполняет глобальный in-memory кэш эвикции и кэш метаданных одним проходом по каталогу.
 * Вызывать только под lock.
 */
async function populateCacheUnlocked(dir: FileSystemDirectoryHandle): Promise<void> {
    if (cachePopulated) {
        return;
    }
    globalEvictionCache.clear();
    const metaCache = getMetadataCache();
    for await (const [fileKey, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            const { metadata } = await readMetadataFromFileFooter(file);
            const key = fileKey as OpfsKey;
            globalEvictionCache.set(key, {
                size: file.size,
                lastAccessed: metadata?.lastAccessed ?? 0,
                evictable: metadata?.evictable !== false,
            });
            const metaEntry: OpfsMetadataCacheEntry = {
                fullSize: file.size,
                type: metadata?.type ?? '',
            };
            if (metadata?.folderName !== undefined) metaEntry.folderName = metadata.folderName;
            if (metadata?.url !== undefined) metaEntry.url = metadata.url;
            if (metadata?.etag !== undefined) metaEntry.etag = metadata.etag;
            if (metadata?.lastModified !== undefined) metaEntry.lastModified = metadata.lastModified;
            if (metadata?.evictable !== undefined) metaEntry.evictable = metadata.evictable;
            metaCache?.set(key, metaEntry);
        } catch {
            // пропускаем битый файл
        }
    }
    cachePopulated = true;
    logCacheEvent(`caches populated: ${globalEvictionCache.size} files`);
}

/**
 * Записывает обновлённый lastAccessed в футер файла (тело не трогает).
 */
async function writeLastAccessedToFileFooter(
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
    lastAccessed: number
): Promise<void> {
    try {
        const handle = await dir.getFileHandle(key, { create: false });
        const file = await handle.getFile();
        const { metadata, bodySize } = await readMetadataFromFileFooter(file);
        if (metadata == null) return;
        const oldMetaLen = file.size - bodySize - OPFS_META_FOOTER_LENGTH;
        metadata.lastAccessed = lastAccessed;
        const newJson = JSON.stringify(metadata);
        const newJsonBytes = new TextEncoder().encode(newJson);
        const newMetaLen = newJsonBytes.length;
        const writable = await handle.createWritable({ keepExistingData: true });
        const startPos = file.size - oldMetaLen - OPFS_META_FOOTER_LENGTH;
        await writable.seek(startPos);
        await writable.write(newJsonBytes);
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, newMetaLen, true);
        await writable.write(lenBuf);
        const newFileSize = startPos + newMetaLen + OPFS_META_FOOTER_LENGTH;
        await writable.truncate(newFileSize);
        await writable.close();
    } catch {
        // ignore
    }
}

function scheduleFooterFlush(): void {
    if (footerFlushTimer !== null) return;
    footerFlushTimer = setTimeout(() => {
        footerFlushTimer = null;
        const d = pendingFooterDir;
        const updates = new Map(pendingFooterWrites);
        pendingFooterDir = null;
        pendingFooterWrites.clear();
        if (d !== null) {
            for (const [k, la] of updates) {
                writeLastAccessedToFileFooter(d, k, la).catch(() => {});
            }
        }
    }, FOOTER_WRITE_THROTTLE_MS);
}

/**
 * Восстанавливает кэши (эвикция + метаданные) сканом плоского store при пустом состоянии.
 */
export async function ensureCachesPopulated(dir: FileSystemDirectoryHandle): Promise<void> {
    return runWithLock(() => populateCacheUnlocked(dir));
}

/**
 * Регистрирует файл в in-memory кэше (после успешной записи, pinned).
 */
export async function registerFileInCache(
    _dir: FileSystemDirectoryHandle,
    _folderName: FolderName,
    key: OpfsKey,
    size: number,
    evictable: boolean,
    lastAccessed: number
): Promise<void> {
    return runWithLock(async () => {
        globalEvictionCache.set(key, { size, lastAccessed, evictable });
    });
}

/**
 * Сбрасывает in-memory кэш эвикции (после clearOpfsCache и т.п.).
 */
export function invalidateCacheForDir(folderName: FolderName): void {
    cachePopulated = false;
    globalEvictionCache.clear();
    logCacheEvent(`cache invalidated for folder: ${folderName}`);
}

export interface GetEntriesForEvictionResult {
    entries: EvictionIndexEntry[];
    totalSize: number;
}

/**
 * Возвращает список evictable-записей и totalSize из глобального кэша.
 * При первом вызове заполняет кэш сканом каталога.
 */
export async function getEntriesForEviction(
    dir: FileSystemDirectoryHandle,
    _folderName: FolderName
): Promise<GetEntriesForEvictionResult> {
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const entries: EvictionIndexEntry[] = [];
        let totalSize = 0;
        for (const [key, entry] of globalEvictionCache.entries()) {
            totalSize += entry.size;
            if (entry.evictable) {
                entries.push({
                    key,
                    size: entry.size,
                    lastAccessed: entry.lastAccessed,
                });
            }
        }
        return { entries, totalSize };
    });
}

/**
 * Обновляет lastAccessed для ключа в in-memory кэше и (с троттлингом 5 с) в футере файла.
 */
export async function updateEvictionIndexLastAccessed(
    dir: FileSystemDirectoryHandle,
    _folderName: FolderName,
    key: OpfsKey,
    lastAccessed: number
): Promise<void> {
    const last = lastAccessedUpdateByKey.get(key);
    if (last !== undefined && lastAccessed - last < LAST_ACCESSED_THROTTLE_MS) {
        return;
    }
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const entry = globalEvictionCache.get(key);
        if (entry === undefined || !entry.evictable) {
            return;
        }
        entry.lastAccessed = lastAccessed;
        lastAccessedUpdateByKey.set(key, lastAccessed);

        pendingFooterWrites.set(key, lastAccessed);
        pendingFooterDir = dir;
        scheduleFooterFlush();
    });
}

/**
 * Добавляет файл в in-memory кэш (после успешной записи, evictable).
 */
export async function addToEvictionIndex(
    _dir: FileSystemDirectoryHandle,
    _folderName: FolderName,
    key: OpfsKey,
    size: number,
    lastAccessed: number
): Promise<void> {
    return runWithLock(async () => {
        globalEvictionCache.set(key, { size, lastAccessed, evictable: true });
    });
}

/**
 * Удаляет ключи из in-memory кэша. Инвалидирует metadata cache и range cache для переданных папок.
 */
export async function removeFromEvictionIndex(
    _dir: FileSystemDirectoryHandle,
    keys: OpfsKey[],
    folderNames: FolderName[]
): Promise<void> {
    if (keys.length === 0) return;
    const set = new Set(keys);
    for (const k of set) {
        lastAccessedUpdateByKey.delete(k);
        pendingFooterWrites.delete(k);
    }
    getMetadataCache()?.invalidateKeys(set);
    for (const fn of folderNames) {
        const rangeCache = getRangeCache(fn);
        if (rangeCache !== null) {
            for (const key of set) {
                rangeCache.invalidateForKey(key);
            }
        }
    }
    return runWithLock(async () => {
        for (const k of set) {
            globalEvictionCache.delete(k);
        }
        logCacheEvent(`eviction: ${set.size} keys removed`);
    });
}
