/**
 * In-memory кеш 206-ответов по (opfsKey, start, end). Хранит только blob; метаданные — в metadata cache.
 * LRU по lastAccessed. Лимиты maxSizeBytes и maxEntries.
 * Инвалидация по ключу (при эвикции файла из OPFS) и invalidateAll (при clearOpfsCache).
 */

import type { FolderName, OpfsKey } from './types.js';
import { LRUCache } from 'lru-cache';

/** Метаданные для 206 (источник — metadata cache, не range cache). Экспорт для типов. */
export interface RangeCacheEntryMeta {
    fullSize: number;
    type?: string;
    etag?: string;
    lastModified?: string;
}

export interface RangeCacheBlobHit {
    blob: Blob;
}

interface RangeCacheEntry {
    blob: Blob;
    lastAccessed: number;
}

export interface RangeCacheLimits {
    maxSizeBytes: number;
    maxEntries: number;
}

const cacheByFolder = new Map<FolderName, RangeCacheImpl>();

function cacheKey(opfsKey: OpfsKey, start: number, end: number): string {
    return `${opfsKey}|${start}|${end}`;
}

function keyToOpfsKey(cacheKeyStr: string): string {
    const i = cacheKeyStr.indexOf('|');
    return i === -1 ? cacheKeyStr : cacheKeyStr.slice(0, i);
}

export class RangeCacheImpl {
    private readonly cache: LRUCache<string, RangeCacheEntry>;
    /** Reverse index: opfsKey → set of cache keys, for O(1) invalidateForKey. */
    private readonly keysByOpfsKey = new Map<OpfsKey, Set<string>>();

    constructor(limits: RangeCacheLimits) {
        const keysByOpfsKey = this.keysByOpfsKey;
        this.cache = new LRUCache<string, RangeCacheEntry>({
            max: limits.maxEntries,
            maxSize: limits.maxSizeBytes,
            sizeCalculation: (entry) => entry.blob.size,
            dispose: (_value, key) => {
                const opfsK = keyToOpfsKey(key);
                const set = keysByOpfsKey.get(opfsK);
                if (set !== undefined) {
                    set.delete(key);
                    if (set.size === 0) keysByOpfsKey.delete(opfsK);
                }
            },
        });
    }

    get(opfsKey: OpfsKey, start: number, end: number): RangeCacheBlobHit | undefined {
        const key = cacheKey(opfsKey, start, end);
        const entry = this.cache.get(key);
        if (entry === undefined) {
            return undefined;
        }
        return { blob: entry.blob };
    }

    set(opfsKey: OpfsKey, start: number, end: number, blob: Blob): void {
        const key = cacheKey(opfsKey, start, end);
        let set = this.keysByOpfsKey.get(opfsKey);
        if (set === undefined) {
            set = new Set();
            this.keysByOpfsKey.set(opfsKey, set);
        }
        set.add(key);
        this.cache.set(key, {
            blob,
            lastAccessed: Date.now(),
        });
    }

    invalidateForKey(opfsKey: OpfsKey): void {
        const set = this.keysByOpfsKey.get(opfsKey);
        if (set === undefined) return;
        for (const key of set) {
            this.cache.delete(key);
        }
        this.keysByOpfsKey.delete(opfsKey);
    }

    invalidateAll(): void {
        this.cache.clear();
        this.keysByOpfsKey.clear();
    }
}

/**
 * Возвращает кеш range-ответов для папки. При первом вызове для folderName создаёт кеш с указанными limits.
 */
export function getOrCreateRangeCache(
    folderName: FolderName,
    limits: RangeCacheLimits
): RangeCacheImpl {
    let cache = cacheByFolder.get(folderName);
    if (cache === undefined) {
        cache = new RangeCacheImpl(limits);
        cacheByFolder.set(folderName, cache);
    }
    return cache;
}

/**
 * Возвращает кеш range-ответов для папки или null, если плагин с rangeCache для этой папки ещё не создавал кеш.
 */
export function getRangeCache(folderName: FolderName): RangeCacheImpl | null {
    return cacheByFolder.get(folderName) ?? null;
}
