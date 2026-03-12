/**
 * In-memory LRU-кеш метаданных файлов OPFS по opfsKey.
 * Используется в opfsServeRange, чтобы не читать футер при повторных запросах к тому же ресурсу.
 * Инвалидация при эвикции (removeFromEvictionIndex) и при clearOpfsCache.
 */

import type { FolderName, OpfsKey } from './types.js';
import { LRUCache } from 'lru-cache';

export interface OpfsMetadataCacheEntry {
    fullSize: number;
    type: string;
    etag?: string;
    lastModified?: string;
    evictable?: boolean;
}

const DEFAULT_MAX_ENTRIES = 500;

export interface MetadataCacheLimits {
    maxEntries?: number;
    /** Вызывается при эвикции ключа из кеша (например, инвалидация range cache для этого ключа). */
    onEvictKey?: (key: OpfsKey) => void;
}

const cacheByFolder = new Map<FolderName, MetadataCacheImpl>();

export class MetadataCacheImpl {
    private readonly cache: LRUCache<string, OpfsMetadataCacheEntry>;

    constructor(limits: MetadataCacheLimits = {}) {
        const maxEntries = Math.max(1, limits.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.cache = new LRUCache<OpfsKey, OpfsMetadataCacheEntry>({
            max: maxEntries,
            ...(limits.onEvictKey !== undefined && {
                dispose: (_value, key) => limits.onEvictKey!(key),
            }),
        });
    }

    get(key: OpfsKey): OpfsMetadataCacheEntry | undefined {
        return this.cache.get(key);
    }

    set(key: OpfsKey, entry: OpfsMetadataCacheEntry): void {
        this.cache.set(key, entry);
    }

    invalidateKeys(keys: Iterable<OpfsKey>): void {
        for (const key of keys) {
            this.cache.delete(key);
        }
    }

    invalidateAll(): void {
        this.cache.clear();
    }
}

export function getOrCreateMetadataCache(
    folderName: FolderName,
    limits: MetadataCacheLimits = {}
): MetadataCacheImpl {
    let cache = cacheByFolder.get(folderName);
    if (cache === undefined) {
        cache = new MetadataCacheImpl(limits);
        cacheByFolder.set(folderName, cache);
    }
    return cache;
}

export function getMetadataCache(folderName: FolderName): MetadataCacheImpl | null {
    return cacheByFolder.get(folderName) ?? null;
}
