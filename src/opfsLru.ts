/**
 * LRU и лимиты кеша OPFS: список файлов, расчёт эвикции, skip list (URL не кешируем повторно).
 * Для эвикции используется индекс _eviction_index.json (только evictable); при отсутствии/повреждении пересобирается.
 */

import { readMetadataFromFileFooter } from './opfsFormat.js';
import { getMaxCacheFraction } from './opfsUtil.js';
import {
    EVICTION_INDEX_FILENAME,
    getEntriesForEviction,
    removeFromEvictionIndex,
    type EvictionIndexEntry,
} from './opfsEvictionIndex.js';

export interface CacheFileEntry {
    key: string;
    /** Размер файла на диске (тело + футер). */
    size: number;
    lastAccessed: number;
    /** Можно ли эвиктить ресурс (по умолчанию true). */
    evictable: boolean;
}

/** Результат оценки хранилища (navigator.storage.estimate). */
export interface StorageEstimate {
    quota: number;
    usage: number;
}

const skipList = new Set<string>();

export function isInSkipList(url: string): boolean {
    return skipList.has(url);
}

export function addToSkipList(url: string): void {
    skipList.add(url);
}

/**
 * Возвращает оценку квоты и использования для origin.
 */
export async function getStorageEstimate(): Promise<StorageEstimate> {
    const est = await navigator.storage.estimate();
    return {
        quota: est.quota ?? 0,
        usage: est.usage ?? 0,
    };
}

/**
 * Лимит кеша в байтах для папки: min(quota × maxCacheFraction, quota − usage).
 */
export function getCacheLimit(estimate: StorageEstimate, folderName: string): number {
    const fraction = getMaxCacheFraction(folderName);
    const byFraction = Math.floor(estimate.quota * fraction);
    const byAvailable = estimate.quota - estimate.usage;
    return Math.max(0, Math.min(byFraction, byAvailable));
}

async function readMetaFromFile(file: File): Promise<{ size: number; lastAccessed: number; evictable: boolean }> {
    const { metadata } = await readMetadataFromFileFooter(file);
    const size = file.size;
    if (!metadata) {
        return { size, lastAccessed: 0, evictable: true };
    }
    return {
        size,
        lastAccessed: metadata.lastAccessed ?? 0,
        evictable: metadata.evictable !== false,
    };
}

/**
 * Сканирует папку кеша и возвращает список файлов с размером и lastAccessed.
 * Файл индекса эвикции (_eviction_index.json) не включается.
 */
export async function listCacheFilesWithMeta(
    dir: FileSystemDirectoryHandle
): Promise<CacheFileEntry[]> {
    const entries: CacheFileEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (name === EVICTION_INDEX_FILENAME) {
            continue;
        }
        if (handle.kind === 'file') {
            try {
                const file = await (handle as FileSystemFileHandle).getFile();
                const { size, lastAccessed, evictable } = await readMetaFromFile(file);
                entries.push({ key: name, size, lastAccessed, evictable });
            } catch {
                // битый или недоступный файл — пропускаем
            }
        }
    }
    return entries;
}

export function getTotalCacheSize(entries: CacheFileEntry[]): number {
    return entries.reduce((sum, e) => sum + e.size, 0);
}

/**
 * Вычисляет минимальный набор ключей для удаления по LRU (сначала самые старые по lastAccessed),
 * чтобы освободить хотя бы needToFree байт. Принимает записи индекса (уже только evictable).
 */
export function computeEvictionSet(
    entries: EvictionIndexEntry[],
    needToFree: number
): string[] {
    if (needToFree <= 0) {
        return [];
    }
    const sorted = [...entries].sort((a, b) => a.lastAccessed - b.lastAccessed);
    const toDelete: string[] = [];
    let freed = 0;
    for (const e of sorted) {
        if (freed >= needToFree) {
            break;
        }
        toDelete.push(e.key);
        freed += e.size;
    }
    return toDelete;
}

/**
 * Удаляет файлы по ключам из папки.
 */
export async function evictFiles(
    dir: FileSystemDirectoryHandle,
    keys: string[]
): Promise<void> {
    await Promise.all(
        keys.map((key) =>
            dir.removeEntry(key).catch(() => {
                // уже удалён или недоступен
            })
        )
    );
}

export type EnsureSpaceResult =
    | { ok: true; evictedKeys?: string[] }
    | { ok: false; reason: string };

export interface EnsureSpaceOptions {
    /** Имя папки — для расчёта лимита квоты (обязательно). */
    folderName: string;
    /** Вызывается после успешной эвикции (список удалённых ключей). */
    onEvicted?: (keys: string[]) => void;
}

/**
 * Проверяет, влезет ли новый файл после эвикции. Если да — выполняет эвикцию по индексу и возвращает ok: true.
 * Если даже после удаления всего кеша не влезет — ok: false, reason для оповещения.
 */
export async function ensureSpaceForWrite(
    dir: FileSystemDirectoryHandle,
    newFileSize: number,
    options: EnsureSpaceOptions
): Promise<EnsureSpaceResult> {
    const { folderName, onEvicted } = options;
    const estimate = await getStorageEstimate();
    const limit = getCacheLimit(estimate, folderName);
    const { entries, totalSize } = await getEntriesForEviction(dir);

    const needToFree = Math.max(
        0,
        totalSize + newFileSize - limit,
        estimate.usage + newFileSize - estimate.quota
    );

    if (needToFree === 0) {
        return { ok: true };
    }

    if (needToFree > totalSize) {
        return {
            ok: false,
            reason: 'File does not fit even after full eviction',
        };
    }

    const keysToDelete = computeEvictionSet(entries, needToFree);
    await evictFiles(dir, keysToDelete);
    await removeFromEvictionIndex(dir, keysToDelete, folderName);
    onEvicted?.(keysToDelete);
    return { ok: true, evictedKeys: keysToDelete };
}
