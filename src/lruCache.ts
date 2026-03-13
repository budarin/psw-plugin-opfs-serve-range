/**
 * Minimal in-memory LRU cache (doubly-linked list + Map).
 * Used instead of the `lru-cache` package (~17 KB) to keep the bundle small;
 * this implementation covers only the needed API (max entries, optional byte limit, dispose).
 */

export interface LRUCacheOptions<Key, Value> {
    /** Maximum number of entries. */
    max: number;
    /** Optional maximum total size in custom units; requires sizeCalculation. */
    maxSize?: number;
    /** Function to get entry size for maxSize eviction. */
    sizeCalculation?: (value: Value) => number;
    /** Called when an entry is evicted (capacity or size limit). */
    dispose?: (value: Value, key: Key) => void;
}

interface Node<Key, Value> {
    key: Key;
    value: Value;
    size: number;
    prev: Node<Key, Value> | null;
    next: Node<Key, Value> | null;
}

export class LRUCache<Key, Value> {
    private readonly map = new Map<Key, Node<Key, Value>>();
    private head: Node<Key, Value> | null = null;
    private tail: Node<Key, Value> | null = null;
    private readonly max: number;
    private readonly maxSize: number;
    private readonly getSize: (value: Value) => number;
    private readonly dispose: ((value: Value, key: Key) => void) | undefined;
    private totalSize = 0;

    constructor(options: LRUCacheOptions<Key, Value>) {
        this.max = Math.max(1, options.max);
        this.maxSize = options.maxSize ?? Infinity;
        this.getSize = options.sizeCalculation ?? (() => 1);
        this.dispose = options.dispose;
    }

    get(key: Key): Value | undefined {
        const node = this.map.get(key);
        if (node === undefined) return undefined;
        this.moveToHead(node);
        return node.value;
    }

    set(key: Key, value: Value): void {
        const size = this.getSize(value);
        const existing = this.map.get(key);
        if (existing !== undefined) {
            this.totalSize -= existing.size;
            existing.value = value;
            existing.size = size;
            this.totalSize += size;
            this.moveToHead(existing);
            this.evict();
            return;
        }
        const node: Node<Key, Value> = {
            key,
            value,
            size,
            prev: null,
            next: this.head,
        };
        this.map.set(key, node);
        this.totalSize += size;
        if (this.head !== null) {
            this.head.prev = node;
        }
        this.head = node;
        if (this.tail === null) {
            this.tail = node;
        }
        this.evict();
    }

    delete(key: Key): boolean {
        const node = this.map.get(key);
        if (node === undefined) return false;
        this.unlink(node);
        this.map.delete(key);
        this.totalSize -= node.size;
        return true;
    }

    clear(): void {
        if (this.dispose !== undefined) {
            for (const node of this.map.values()) {
                this.dispose(node.value, node.key);
            }
        }
        this.map.clear();
        this.head = null;
        this.tail = null;
        this.totalSize = 0;
    }

    *entries(): IterableIterator<[Key, Value]> {
        let node = this.head;
        while (node !== null) {
            yield [node.key, node.value];
            node = node.next;
        }
    }

    private moveToHead(node: Node<Key, Value>): void {
        if (node === this.head) return;
        this.unlink(node);
        node.prev = null;
        node.next = this.head;
        if (this.head !== null) {
            this.head.prev = node;
        }
        this.head = node;
        if (this.tail === null) {
            this.tail = node;
        }
    }

    private unlink(node: Node<Key, Value>): void {
        if (node.prev !== null) node.prev.next = node.next;
        else this.head = node.next;
        if (node.next !== null) node.next.prev = node.prev;
        else this.tail = node.prev;
    }

    private evict(): void {
        while (
            this.tail !== null &&
            (this.map.size > this.max || this.totalSize > this.maxSize)
        ) {
            const node = this.tail;
            this.unlink(node);
            this.map.delete(node.key);
            this.totalSize -= node.size;
            this.dispose?.(node.value, node.key);
        }
    }
}
