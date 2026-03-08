/**
 * Индекс для LRU-эвикции: только evictable-записи (key, size, lastAccessed).
 * Хранится в том же каталоге кеша; при отсутствии или повреждении пересобирается из футеров.
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

/**
 * Пересобирает индекс по футерам файлов в каталоге. Включает только evictable.
 */
async function rebuildIndex(
    dir: FileSystemDirectoryHandle
): Promise<EvictionIndexEntry[]> {
    const entries: EvictionIndexEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (name === EVICTION_INDEX_FILENAME) {
            continue;
        }
        if (handle.kind !== 'file') {
            continue;
        }
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            const { metadata } = await readMetadataFromFileFooter(file);
            const evictable = metadata?.evictable !== false;
            if (!evictable) {
                continue;
            }
            entries.push({
                key: name,
                size: file.size,
                lastAccessed: metadata?.lastAccessed ?? 0,
            });
        } catch {
            // пропускаем битый файл
        }
    }
    await writeIndexRaw(dir, entries);
    return entries;
}

/**
 * Возвращает список записей индекса для эвикции. При отсутствии или повреждении индекса пересобирает его.
 */
export async function getEntriesForEviction(
    dir: FileSystemDirectoryHandle
): Promise<EvictionIndexEntry[]> {
    return runWithLock(async () => {
        const entries = await readIndexRaw(dir);
        if (entries === null) {
            return rebuildIndex(dir);
        }
        return entries;
    });
}

/**
 * Обновляет lastAccessed для ключа в индексе. Если индекса нет — пересобирает его из папки, затем обновляет запись (чтобы индекс появился при первом просмотре после обновления плагина).
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
        let entries = await readIndexRaw(dir);
        if (entries === null) {
            entries = await rebuildIndex(dir);
        }
        const idx = entries.findIndex((e) => e.key === key);
        if (idx === -1) {
            return;
        }
        entries[idx]!.lastAccessed = lastAccessed;
        await writeIndexRaw(dir, entries);
        lastAccessedUpdateByKey.set(key, lastAccessed);
    });
}

/**
 * Добавляет запись в индекс (вызов после успешной записи файла в кеш, только если evictable).
 */
export async function addToEvictionIndex(
    dir: FileSystemDirectoryHandle,
    key: string,
    size: number,
    lastAccessed: number
): Promise<void> {
    return runWithLock(async () => {
        let entries = await readIndexRaw(dir);
        if (entries === null) {
            entries = [];
        }
        const existing = entries.findIndex((e) => e.key === key);
        if (existing >= 0) {
            entries[existing]!.size = size;
            entries[existing]!.lastAccessed = lastAccessed;
        } else {
            entries.push({ key, size, lastAccessed });
        }
        await writeIndexRaw(dir, entries);
    });
}

/**
 * Удаляет ключи из индекса после эвикции.
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
        const entries = await readIndexRaw(dir);
        if (entries === null) {
            return;
        }
        const next = entries.filter((e) => !set.has(e.key));
        await writeIndexRaw(dir, next);
    });
}
