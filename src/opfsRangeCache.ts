/**
 * In-memory кеш 206-ответов по (opfsKey, start, end). Хранит только blob; метаданные — в metadata cache.
 * LRU по lastAccessed. Лимиты maxSizeBytes и maxEntries.
 * Инвалидация по ключу (при эвикции файла из OPFS) и invalidateAll (при clearOpfsCache).
 */

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

const cacheByFolder = new Map<string, RangeCacheImpl>();

function cacheKey(opfsKey: string, start: number, end: number): string {
    return `${opfsKey}|${start}|${end}`;
}

function keyToOpfsKey(cacheKeyStr: string): string {
    const i = cacheKeyStr.indexOf('|');
    return i === -1 ? cacheKeyStr : cacheKeyStr.slice(0, i);
}

/** Узел двусвязного списка для LRU: порядок = от самого старого (head) к самому новому (tail). */
interface LruNode {
    key: string;
    prev: LruNode | null;
    next: LruNode | null;
}

export class RangeCacheImpl {
    private readonly limits: RangeCacheLimits;
    private readonly entries = new Map<string, RangeCacheEntry>();
    private readonly keyToNode = new Map<string, LruNode>();
    private totalSizeBytes = 0;
    private head: LruNode | null = null;
    private tail: LruNode | null = null;

    constructor(limits: RangeCacheLimits) {
        this.limits = limits;
    }

    get(opfsKey: string, start: number, end: number): RangeCacheBlobHit | undefined {
        const key = cacheKey(opfsKey, start, end);
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        entry.lastAccessed = Date.now();
        const node = this.keyToNode.get(key);
        if (node !== undefined) {
            this.unlink(node);
            this.addToTail(node);
        }
        return { blob: entry.blob };
    }

    set(opfsKey: string, start: number, end: number, blob: Blob): void {
        const key = cacheKey(opfsKey, start, end);
        const size = blob.size;
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.totalSizeBytes -= existing.blob.size;
            const node = this.keyToNode.get(key)!;
            this.unlink(node);
            this.addToTail(node);
        } else {
            const node: LruNode = { key, prev: null, next: null };
            this.keyToNode.set(key, node);
            this.addToTail(node);
        }
        this.entries.set(key, {
            blob,
            lastAccessed: Date.now(),
        });
        this.totalSizeBytes += size;
        this.evictUntilWithinLimits();
    }

    private unlink(node: LruNode): void {
        if (node.prev !== null) {
            node.prev.next = node.next;
        } else {
            this.head = node.next;
        }
        if (node.next !== null) {
            node.next.prev = node.prev;
        } else {
            this.tail = node.prev;
        }
        node.prev = null;
        node.next = null;
    }

    private addToTail(node: LruNode): void {
        node.prev = this.tail;
        node.next = null;
        if (this.tail !== null) {
            this.tail.next = node;
        } else {
            this.head = node;
        }
        this.tail = node;
    }

    private evictUntilWithinLimits(): void {
        while (this.head !== null) {
            const overSize = this.totalSizeBytes > this.limits.maxSizeBytes;
            const overCount = this.entries.size > this.limits.maxEntries;
            if (!overSize && !overCount) {
                break;
            }
            const oldest = this.head;
            this.unlink(oldest);
            this.keyToNode.delete(oldest.key);
            const entry = this.entries.get(oldest.key);
            if (entry !== undefined) {
                this.totalSizeBytes -= entry.blob.size;
                this.entries.delete(oldest.key);
            }
        }
    }

    invalidateForKey(opfsKey: string): void {
        for (const key of this.entries.keys()) {
            if (keyToOpfsKey(key) === opfsKey) {
                const entry = this.entries.get(key)!;
                const node = this.keyToNode.get(key);
                if (node !== undefined) {
                    this.unlink(node);
                    this.keyToNode.delete(key);
                }
                this.totalSizeBytes -= entry.blob.size;
                this.entries.delete(key);
            }
        }
    }

    invalidateAll(): void {
        this.entries.clear();
        this.keyToNode.clear();
        this.head = null;
        this.tail = null;
        this.totalSizeBytes = 0;
    }
}

/**
 * Возвращает кеш range-ответов для папки. При первом вызове для folderName создаёт кеш с указанными limits.
 */
export function getOrCreateRangeCache(
    folderName: string,
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
export function getRangeCache(folderName: string): RangeCacheImpl | null {
    return cacheByFolder.get(folderName) ?? null;
}
