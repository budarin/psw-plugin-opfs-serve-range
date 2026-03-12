/**
 * Индекс для LRU-эвикции: только evictable-записи (key, size, lastAccessed) пишутся на диск.
 * В памяти хранится полный список файлов (evictable + pinned) для totalSize без второго прохода по каталогу.
 * Все операции с индексом сериализованы через in-memory lock.
 */

import type { FolderName, OpfsKey } from './types.js';
import { readMetadataFromFileFooter } from './opfsFormat.js';
import { getRangeCache } from './opfsRangeCache.js';
import { getMetadataCache } from './opfsMetadataCache.js';

export const EVICTION_INDEX_FILENAME = '_eviction_index.json';

const LAST_ACCESSED_THROTTLE_MS = 5000;
/** Минимальный интервал между записями индекса на диск (батчинг для снижения I/O). */
const INDEX_WRITE_THROTTLE_MS = 5000;

const lastAccessedUpdateByKey = new Map<string, number>();
/** Время последней записи индекса по dir.name (для троттлинга записи). */
const lastIndexWriteByDirName = new Map<string, number>();
/** Таймер отложенной записи индекса по dir.name. */
const indexFlushTimerByDirName = new Map<string, ReturnType<typeof setTimeout>>();

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
    const evictableEntries = getEvictableEntriesFromCache(cache);
    const shouldPersistIndex =
        indexEntries === null ||
        evictableEntries.length > (indexEntries?.length ?? 0);
    if (shouldPersistIndex) {
        await writeIndexRaw(dir, evictableEntries);
    }
    cachePopulatedByDir.add(name);
}

/**
 * Регистрирует файл в in-memory кеше (для pinned: не пишем в индекс на диск).
 * Вызывать после успешной записи в OPFS, когда evictable === false.
 */
export async function registerFileInCache(
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
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
export function invalidateCacheForDir(folderName: FolderName): void {
    const timer = indexFlushTimerByDirName.get(folderName);
    if (timer !== undefined) {
        clearTimeout(timer);
        indexFlushTimerByDirName.delete(folderName);
    }
    lastIndexWriteByDirName.delete(folderName);
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
 * Обновляет lastAccessed для ключа в кеше и (с троттлингом) в индексе на диске (только evictable).
 * Троттлинг 5 с на ключ; запись на диск — не чаще раза в INDEX_WRITE_THROTTLE_MS, иначе отложенная запись через 5 с.
 */
export async function updateEvictionIndexLastAccessed(
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
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
        lastAccessedUpdateByKey.set(key, lastAccessed);

        const dirName = dir.name;
        const now = Date.now();
        const lastWrite = lastIndexWriteByDirName.get(dirName) ?? 0;

        if (now - lastWrite >= INDEX_WRITE_THROTTLE_MS) {
            const timer = indexFlushTimerByDirName.get(dirName);
            if (timer !== undefined) {
                clearTimeout(timer);
                indexFlushTimerByDirName.delete(dirName);
            }
            await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
            lastIndexWriteByDirName.set(dirName, now);
        } else if (!indexFlushTimerByDirName.has(dirName)) {
            const timer = setTimeout(() => {
                indexFlushTimerByDirName.delete(dirName);
                runWithLock(async () => {
                    await populateCacheUnlocked(dir);
                    const c = getCache(dir);
                    await writeIndexRaw(dir, getEvictableEntriesFromCache(c));
                    lastIndexWriteByDirName.set(dirName, Date.now());
                });
            }, INDEX_WRITE_THROTTLE_MS);
            indexFlushTimerByDirName.set(dirName, timer);
        }
    });
}

/**
 * Добавляет файл в in-memory кеш и в индекс на диске (вызов после успешной записи, только если evictable).
 */
export async function addToEvictionIndex(
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
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
 * Инвалидирует записи range-кеша для удалённых opfs-ключей.
 */
export async function removeFromEvictionIndex(
    dir: FileSystemDirectoryHandle,
    keys: OpfsKey[],
    folderName: FolderName
): Promise<void> {
    if (keys.length === 0) {
        return;
    }
    const set = new Set(keys);
    for (const k of set) {
        lastAccessedUpdateByKey.delete(k);
    }
    getMetadataCache(folderName)?.invalidateKeys(set);
    const rangeCache = getRangeCache(folderName);
    if (rangeCache !== null) {
        for (const key of set) {
            rangeCache.invalidateForKey(key);
        }
    }
    return runWithLock(async () => {
        await populateCacheUnlocked(dir);
        const cache = getCache(dir);
        for (const k of set) {
            cache.delete(k);
        }
        await writeIndexRaw(dir, getEvictableEntriesFromCache(cache));
    });
}
