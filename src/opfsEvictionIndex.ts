/**
 * Индекс для LRU-эвикции: только evictable-записи (key, size, lastAccessed) пишутся на диск.
 * В памяти хранится полный список файлов (evictable + pinned) для totalSize без второго прохода по каталогу.
 * Все операции с индексом сериализованы через in-memory lock.
 */

import { readMetadataFromFileFooter } from './opfsFormat.js';

export const EVICTION_INDEX_FILENAME = '_eviction_index.json';

const LAST_ACCESSED_THROTTLE_MS = 5000;
const lastAccessedUpdateByKey = new Map<string, number>();

export interface EvictionIndexEntry {
    key: string;
    size: number;
    lastAccessed: number;
}

interface FileCacheEntry {
    size: number;
    lastAccessed: number;
    evictable: boolean;
}

/** Полный список файлов по dir.name: key → { size, lastAccessed, evictable }. */
const cacheByDirName = new Map<string, Map<string, FileCacheEntry>>();
/** Для каких каталогов кеш уже заполнен (один проход после старта SW). */
const cachePopulatedByDir = new Set<string>();

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

async function readIndexRaw(
    dir: FileSystemDirectoryHandle
): Promise<EvictionIndexEntry[] | null> {
    try {
        const handle = await dir.getFileHandle(EVICTION_INDEX_FILENAME, {
            create: false,
        });
        const file = await handle.getFile();
        const text = await file.text();
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed)) {
            return null;
        }
        const entries: EvictionIndexEntry[] = [];
        for (const item of parsed) {
            if (
                item &&
                typeof item === 'object' &&
                typeof (item as EvictionIndexEntry).key === 'string' &&
                typeof (item as EvictionIndexEntry).size === 'number' &&
                typeof (item as EvictionIndexEntry).lastAccessed === 'number'
            ) {
                entries.push({
                    key: (item as EvictionIndexEntry).key,
                    size: (item as EvictionIndexEntry).size,
                    lastAccessed: (item as EvictionIndexEntry).lastAccessed,
                });
            }
        }
        return entries;
    } catch {
        return null;
    }
}

async function writeIndexRaw(
    dir: FileSystemDirectoryHandle,
    entries: EvictionIndexEntry[]
): Promise<void> {
    const handle = await dir.getFileHandle(EVICTION_INDEX_FILENAME, {
        create: true,
    });
    const writable = await handle.createWritable({ keepExistingData: false });
    const json = JSON.stringify(entries);
    await writable.write(new TextEncoder().encode(json));
    await writable.close();
}

function getCache(dir: FileSystemDirectoryHandle): Map<string, FileCacheEntry> {
    const name = dir.name;
    let cache = cacheByDirName.get(name);
    if (cache === undefined) {
        cache = new Map();
        cacheByDirName.set(name, cache);
    }
    return cache;
}

function getEvictableEntriesFromCache(
    cache: Map<string, FileCacheEntry>
): EvictionIndexEntry[] {
    const entries: EvictionIndexEntry[] = [];
    for (const [key, entry] of cache.entries()) {
        if (entry.evictable) {
            entries.push({
                key,
                size: entry.size,
                lastAccessed: entry.lastAccessed,
            });
        }
    }
    return entries;
}

/**
 * Заполняет in-memory кеш для каталога: читает индекс и обходит dir (pinned), или пересобирает с нуля.
 * Вызывать только под lock.
 */
async function populateCacheUnlocked(
    dir: FileSystemDirectoryHandle
): Promise<void> {
    const name = dir.name;
    if (cachePopulatedByDir.has(name)) {
        return;
    }
    const cache = getCache(dir);
    cache.clear();
    const indexEntries = await readIndexRaw(dir);
    const indexMap =
        indexEntries !== null
            ? new Map(indexEntries.map((e) => [e.key, e]))
            : null;

    for await (const [fileKey, handle] of dir.entries()) {
        if (fileKey === EVICTION_INDEX_FILENAME || handle.kind !== 'file') {
            continue;
        }
        const indexEntry = indexMap?.get(fileKey);
        if (indexEntry !== undefined) {
            cache.set(fileKey, {
                size: indexEntry.size,
                lastAccessed: indexEntry.lastAccessed,
                evictable: true,
            });
            continue;
        }
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            const { metadata } = await readMetadataFromFileFooter(file);
            cache.set(fileKey, {
                size: file.size,
                lastAccessed: metadata?.lastAccessed ?? 0,
                evictable: metadata?.evictable !== false,
            });
        } catch {
            // пропускаем битый файл
        }
    }
    if (indexEntries === null) {
        await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
    }
    cachePopulatedByDir.add(name);
}

/**
 * Регистрирует файл в in-memory кеше (для pinned: не пишем в индекс на диск).
 * Вызывать после успешной записи в OPFS, когда evictable === false.
 */
export async function registerFileInCache(
    dir: FileSystemDirectoryHandle,
    key: string,
    size: number,
    evictable: boolean,
    lastAccessed: number
): Promise<void> {
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        getCache(dir).set(key, { size, lastAccessed, evictable });
    });
}

/**
 * Сбрасывает in-memory кеш для каталога (после clearOpfsCache).
 */
export function invalidateCacheForDir(folderName: string): void {
    cacheByDirName.delete(folderName);
    cachePopulatedByDir.delete(folderName);
}

export interface GetEntriesForEvictionResult {
    entries: EvictionIndexEntry[];
    totalSize: number;
}

/**
 * Возвращает список evictable-записей и totalSize из in-memory кеша.
 * При первом вызове после старта заполняет кеш одним проходом (индекс + pinned или пересборка).
 */
export async function getEntriesForEviction(
    dir: FileSystemDirectoryHandle
): Promise<GetEntriesForEvictionResult> {
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const cache = getCache(dir);
        const entries: EvictionIndexEntry[] = [];
        let totalSize = 0;
        for (const [key, entry] of cache.entries()) {
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
 * Обновляет lastAccessed для ключа в кеше и в индексе на диске (только evictable).
 * Троттлинг 5 с на ключ: при перемотке не пишем в индекс чаще раза в 5 с.
 */
export async function updateEvictionIndexLastAccessed(
    dir: FileSystemDirectoryHandle,
    key: string,
    lastAccessed: number
): Promise<void> {
    const last = lastAccessedUpdateByKey.get(key);
    if (last !== undefined && lastAccessed - last < LAST_ACCESSED_THROTTLE_MS) {
        return;
    }
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const cache = getCache(dir);
        const entry = cache.get(key);
        if (entry === undefined || !entry.evictable) {
            return;
        }
        entry.lastAccessed = lastAccessed;
        await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
        lastAccessedUpdateByKey.set(key, lastAccessed);
    });
}

/**
 * Добавляет файл в in-memory кеш и в индекс на диске (вызов после успешной записи, только если evictable).
 */
export async function addToEvictionIndex(
    dir: FileSystemDirectoryHandle,
    key: string,
    size: number,
    lastAccessed: number
): Promise<void> {
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const cache = getCache(dir);
        cache.set(key, { size, lastAccessed, evictable: true });
        await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
    });
}

/**
 * Удаляет ключи из in-memory кеша и из индекса на диске после эвикции.
 */
export async function removeFromEvictionIndex(
    dir: FileSystemDirectoryHandle,
    keys: string[]
): Promise<void> {
    if (keys.length === 0) {
        return;
    }
    const set = new Set(keys);
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const cache = getCache(dir);
        for (const k of set) {
            cache.delete(k);
        }
        await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
    });
}
