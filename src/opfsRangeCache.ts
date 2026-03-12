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

    constructor(limits: RangeCacheLimits) {
        this.cache = new LRUCache<string, RangeCacheEntry>({
            max: limits.maxEntries,
            maxSize: limits.maxSizeBytes,
            sizeCalculation: (entry) => entry.blob.size,
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
        this.cache.set(key, {
            blob,
            lastAccessed: Date.now(),
        });
    }

    invalidateForKey(opfsKey: OpfsKey): void {
        for (const key of this.cache.keys()) {
            if (keyToOpfsKey(key) === opfsKey) {
                this.cache.delete(key);
            }
        }
    }

    invalidateAll(): void {
        this.cache.clear();
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
