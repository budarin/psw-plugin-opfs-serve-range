/**
 * In-memory LRU-кеш метаданных файлов OPFS по opfsKey.
 * Используется в opfsServeRange, чтобы не читать футер при повторных запросах к тому же ресурсу.
 * Инвалидация при эвикции (removeFromEvictionIndex) и при clearOpfsCache.
 */

export interface OpfsMetadataCacheEntry {
    fullSize: number;
    type: string;
    etag?: string;
    lastModified?: string;
    evictable?: boolean;
}

const DEFAULT_MAX_ENTRIES = 500;

interface LruNode {
    key: string;
    prev: LruNode | null;
    next: LruNode | null;
}

export interface MetadataCacheLimits {
    maxEntries?: number;
    /** Вызывается при эвикции ключа из кеша (например, инвалидация range cache для этого ключа). */
    onEvictKey?: (key: string) => void;
}

const cacheByFolder = new Map<string, MetadataCacheImpl>();

export class MetadataCacheImpl {
    private readonly maxEntries: number;
    private readonly onEvictKey: ((key: string) => void) | undefined;
    private readonly entries = new Map<string, OpfsMetadataCacheEntry>();
    private readonly keyToNode = new Map<string, LruNode>();
    private head: LruNode | null = null;
    private tail: LruNode | null = null;

    constructor(limits: MetadataCacheLimits = {}) {
        this.maxEntries = Math.max(
            1,
            limits.maxEntries ?? DEFAULT_MAX_ENTRIES
        );
        this.onEvictKey = limits.onEvictKey ?? undefined;
    }

    get(key: string): OpfsMetadataCacheEntry | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        const node = this.keyToNode.get(key);
        if (node !== undefined) {
            this.unlink(node);
            this.addToTail(node);
        }
        return entry;
    }

    set(key: string, entry: OpfsMetadataCacheEntry): void {
        const existingNode = this.keyToNode.get(key);
        if (existingNode !== undefined) {
            this.unlink(existingNode);
            this.addToTail(existingNode);
        } else {
            const node: LruNode = { key, prev: null, next: null };
            this.keyToNode.set(key, node);
            this.addToTail(node);
        }
        this.entries.set(key, entry);
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
        while (this.head !== null && this.entries.size > this.maxEntries) {
            const oldest = this.head;
            this.unlink(oldest);
            this.keyToNode.delete(oldest.key);
            this.entries.delete(oldest.key);
            this.onEvictKey?.(oldest.key);
        }
    }

    invalidateKeys(keys: Iterable<string>): void {
        for (const key of keys) {
            const node = this.keyToNode.get(key);
            if (node !== undefined) {
                this.unlink(node);
                this.keyToNode.delete(key);
            }
            this.entries.delete(key);
        }
    }

    invalidateAll(): void {
        this.entries.clear();
        this.keyToNode.clear();
        this.head = null;
        this.tail = null;
    }
}

export function getOrCreateMetadataCache(
    folderName: string,
    limits: MetadataCacheLimits = {}
): MetadataCacheImpl {
    let cache = cacheByFolder.get(folderName);
    if (cache === undefined) {
        cache = new MetadataCacheImpl(limits);
        cacheByFolder.set(folderName, cache);
    }
    return cache;
}

export function getMetadataCache(folderName: string): MetadataCacheImpl | null {
    return cacheByFolder.get(folderName) ?? null;
}
