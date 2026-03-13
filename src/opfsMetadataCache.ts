/**
 * In-memory LRU-кеш метаданных файлов OPFS по opfsKey (один глобальный кэш для плоского хранилища).
 * Запись содержит folderName для фильтра при serve/list/clear.
 * Инвалидация при эвикции (removeFromEvictionIndex) и при clearOpfsCache.
 */

import { LRUCache } from './lruCache.js';
import type { FolderName, OpfsKey } from './types.js';

export interface OpfsMetadataCacheEntry {
    fullSize: number;
    type: string;
    /** Логическая папка файла (для фильтра при serve/list/clear). */
    folderName?: string;
    /** URL ресурса (для list без чтения файла). */
    url?: string;
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

let globalMetadataCache: MetadataCacheImpl | null = null;

/** Callbacks to run when a key is evicted from the global cache (one per folder). */
const evictCallbacksByFolder = new Map<FolderName, (key: OpfsKey) => void>();

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

    invalidateEntriesByFolder(folderName: FolderName): void {
        for (const [key, entry] of this.cache.entries()) {
            if (entry.folderName === folderName) {
                this.cache.delete(key);
            }
        }
    }

    *getEntriesByFolder(folderName: FolderName): IterableIterator<[OpfsKey, OpfsMetadataCacheEntry]> {
        for (const [key, entry] of this.cache.entries()) {
            if (entry.folderName === folderName) {
                yield [key, entry];
            }
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
    if (limits.onEvictKey !== undefined) {
        evictCallbacksByFolder.set(folderName, limits.onEvictKey);
    }
    if (globalMetadataCache === null) {
        const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
        globalMetadataCache = new MetadataCacheImpl({
            maxEntries,
            onEvictKey: (key) => {
                for (const cb of evictCallbacksByFolder.values()) {
                    cb(key);
                }
            },
        });
    }
    return globalMetadataCache;
}

/** Returns the global metadata cache or null if not yet created. */
export function getMetadataCache(): MetadataCacheImpl | null {
    return globalMetadataCache;
}
