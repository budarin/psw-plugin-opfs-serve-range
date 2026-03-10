/**
 * In-memory кеш 206-ответов по (opfsKey, start, end).
 * LRU по lastAccessed. Лимиты maxSizeBytes и maxEntries.
 * Инвалидация по ключу (при эвикции файла из OPFS) и invalidateAll (при clearOpfsCache).
 */

export interface RangeCacheEntryMeta {
    fullSize: number;
    type?: string;
    etag?: string;
    lastModified?: string;
}

interface RangeCacheEntry {
    blob: Blob;
    meta: RangeCacheEntryMeta;
    lastAccessed: number;
}

export interface RangeCacheLimits {
    maxSizeBytes: number;
    maxEntries: number;
}

let cacheInstance: RangeCacheImpl | null = null;

function cacheKey(opfsKey: string, start: number, end: number): string {
    return `${opfsKey}|${start}|${end}`;
}

function keyToOpfsKey(cacheKeyStr: string): string {
    const i = cacheKeyStr.indexOf('|');
    return i === -1 ? cacheKeyStr : cacheKeyStr.slice(0, i);
}

export class RangeCacheImpl {
    private readonly limits: RangeCacheLimits;
    private readonly entries = new Map<string, RangeCacheEntry>();
    private totalSizeBytes = 0;

    constructor(limits: RangeCacheLimits) {
        this.limits = limits;
    }

    get(opfsKey: string, start: number, end: number): RangeCacheEntry | undefined {
        const key = cacheKey(opfsKey, start, end);
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        entry.lastAccessed = Date.now();
        return entry;
    }

    set(
        opfsKey: string,
        start: number,
        end: number,
        blob: Blob,
        meta: RangeCacheEntryMeta
    ): void {
        const key = cacheKey(opfsKey, start, end);
        const size = blob.size;
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.totalSizeBytes -= existing.blob.size;
        }
        this.entries.set(key, {
            blob,
            meta,
            lastAccessed: Date.now(),
        });
        this.totalSizeBytes += size;
        this.evictUntilWithinLimits();
    }

    private evictUntilWithinLimits(): void {
        while (this.entries.size > 0) {
            const overSize = this.totalSizeBytes > this.limits.maxSizeBytes;
            const overCount = this.entries.size > this.limits.maxEntries;
            if (!overSize && !overCount) {
                break;
            }
            let oldestKey: string | null = null;
            let oldestTime = Infinity;
            for (const [k, e] of this.entries.entries()) {
                if (e.lastAccessed < oldestTime) {
                    oldestTime = e.lastAccessed;
                    oldestKey = k;
                }
            }
            if (oldestKey === null) {
                break;
            }
            const entry = this.entries.get(oldestKey)!;
            this.entries.delete(oldestKey);
            this.totalSizeBytes -= entry.blob.size;
        }
    }

    invalidateForKey(opfsKey: string): void {
        for (const key of this.entries.keys()) {
            if (keyToOpfsKey(key) === opfsKey) {
                const entry = this.entries.get(key)!;
                this.totalSizeBytes -= entry.blob.size;
                this.entries.delete(key);
            }
        }
    }

    invalidateAll(): void {
        this.entries.clear();
        this.totalSizeBytes = 0;
    }
}

/**
 * Возвращает singleton кеша range-ответов. При первом вызове с limits создаёт кеш с этими лимитами.
 * Последующие вызовы возвращают тот же экземпляр (limits не меняются).
 */
export function getOrCreateRangeCache(limits: RangeCacheLimits): RangeCacheImpl {
    if (cacheInstance === null) {
        cacheInstance = new RangeCacheImpl(limits);
    }
    return cacheInstance;
}

/**
 * Возвращает текущий экземпляр кеша или undefined, если кеш не создан (плагин с rangeCache не использовался).
 */
export function getRangeCache(): RangeCacheImpl | null {
    return cacheInstance;
}
