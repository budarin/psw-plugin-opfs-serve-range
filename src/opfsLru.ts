/**
 * LRU и лимиты кеша OPFS: список файлов, расчёт эвикции, чёрный список.
 * Без индексного файла — данные из метаданных в футере каждого файла.
 */

import {
    OPFS_META_FOOTER_LENGTH,
    MAX_META_JSON_BYTES,
    type OpfsMetadata,
} from './opfsFormat.js';
import { getMaxCacheFraction } from './opfsUtil.js';

export interface CacheFileEntry {
    key: string;
    /** Размер файла на диске (тело + футер). */
    size: number;
    lastAccessed: number;
}

/** Результат оценки хранилища (navigator.storage.estimate). */
export interface StorageEstimate {
    quota: number;
    usage: number;
}

const blacklist = new Set<string>();

export function isBlacklisted(url: string): boolean {
    return blacklist.has(url);
}

export function addToBlacklist(url: string): void {
    blacklist.add(url);
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
 * Лимит кеша в байтах: min(quota × maxCacheFraction, quota − usage).
 */
export function getCacheLimit(estimate: StorageEstimate): number {
    const fraction = getMaxCacheFraction();
    const byFraction = Math.floor(estimate.quota * fraction);
    const byAvailable = estimate.quota - estimate.usage;
    return Math.max(0, Math.min(byFraction, byAvailable));
}

/**
 * Читает из футера файла только lastAccessed (и размер из metadata.size для совместимости).
 * Возвращает размер файла на диске (file.size) и lastAccessed (0 если нет).
 */
async function readMetaFromFile(file: File): Promise<{ size: number; lastAccessed: number }> {
    const size = file.size;
    if (size < OPFS_META_FOOTER_LENGTH) {
        return { size, lastAccessed: 0 };
    }
    const footerBlob = file.slice(size - OPFS_META_FOOTER_LENGTH, size);
    const footerBuf = await footerBlob.arrayBuffer();
    const metaLen = new DataView(footerBuf).getUint32(0, true);
    if (
        metaLen === 0 ||
        metaLen > MAX_META_JSON_BYTES ||
        metaLen > size - OPFS_META_FOOTER_LENGTH
    ) {
        return { size, lastAccessed: 0 };
    }
    try {
        const jsonBlob = file.slice(
            size - OPFS_META_FOOTER_LENGTH - metaLen,
            size - OPFS_META_FOOTER_LENGTH
        );
        const text = await jsonBlob.text();
        const metadata = JSON.parse(text) as OpfsMetadata;
        return {
            size,
            lastAccessed: metadata.lastAccessed ?? 0,
        };
    } catch {
        return { size, lastAccessed: 0 };
    }
}

/**
 * Сканирует папку кеша и возвращает список файлов с размером и lastAccessed.
 */
export async function listCacheFilesWithMeta(
    dir: FileSystemDirectoryHandle
): Promise<CacheFileEntry[]> {
    const entries: CacheFileEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
            try {
                const file = await (handle as FileSystemFileHandle).getFile();
                const { size, lastAccessed } = await readMetaFromFile(file);
                entries.push({ key: name, size, lastAccessed });
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
 * чтобы освободить хотя бы needToFree байт.
 */
export function computeEvictionSet(
    entries: CacheFileEntry[],
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
    for (const key of keys) {
        try {
            await dir.removeEntry(key);
        } catch {
            // уже удалён или недоступен
        }
    }
}

export type EnsureSpaceResult =
    | { ok: true; evictedKeys?: string[] }
    | { ok: false; reason: string };

export interface EnsureSpaceOptions {
    /** Вызывается после успешной эвикции (список удалённых ключей). */
    onEvicted?: (keys: string[]) => void;
}

/**
 * Проверяет, влезет ли новый файл после эвикции. Если да — выполняет эвикцию и возвращает ok: true.
 * Если даже после удаления всего кеша не влезет — ok: false, reason для оповещения.
 */
export async function ensureSpaceForWrite(
    dir: FileSystemDirectoryHandle,
    newFileSize: number,
    options: EnsureSpaceOptions = {}
): Promise<EnsureSpaceResult> {
    const { onEvicted } = options;
    const estimate = await getStorageEstimate();
    const limit = getCacheLimit(estimate);
    const entries = await listCacheFilesWithMeta(dir);
    const totalSize = getTotalCacheSize(entries);

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
    onEvicted?.(keysToDelete);
    return { ok: true, evictedKeys: keysToDelete };
}
