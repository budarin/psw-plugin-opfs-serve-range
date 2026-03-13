import { describe, it, expect } from 'vitest';
import {
    getCacheLimit,
    computeEvictionSet,
    getTotalCacheSize,
    type StorageEstimate,
    type CacheFileEntry,
} from '../src/opfsLru.ts';
import type { EvictionIndexEntry } from '../src/opfsEvictionIndex.ts';

describe('getCacheLimit', () => {
    it('respects global maxCacheFraction and available space', () => {
        const estimate: StorageEstimate = { quota: 1000, usage: 400 };
        const limit = getCacheLimit(estimate);
        expect(limit).toBe(500);
    });

    it('limits by available space when usage is high', () => {
        const estimate: StorageEstimate = { quota: 1000, usage: 950 };
        const limit = getCacheLimit(estimate);
        expect(limit).toBe(50);
    });

    it('returns zero when quota is zero', () => {
        const estimate: StorageEstimate = { quota: 0, usage: 0 };
        const limit = getCacheLimit(estimate);
        expect(limit).toBe(0);
    });
});

describe('computeEvictionSet', () => {
    it('returns empty array when needToFree <= 0', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
        ];
        const keys = computeEvictionSet(entries, 0);
        expect(keys).toEqual([]);
    });

    it('evicts oldest entries first until enough space is freed', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
            { key: 'c', size: 300, lastAccessed: 30 },
        ];
        const keys = computeEvictionSet(entries, 250);
        expect(keys).toEqual(['a', 'b']);
    });

    it('can evict all entries when needToFree is large', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
        ];
        const keys = computeEvictionSet(entries, 1000);
        expect(keys).toEqual(['a', 'b']);
    });

    it('uses only entries passed (index contains evictable only; pinned are not in index)', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'c', size: 300, lastAccessed: 30 },
        ];
        const keys = computeEvictionSet(entries, 250);
        expect(keys).toEqual(['a', 'c']);
    });

    it('returns empty array when entries array is empty', () => {
        const entries: EvictionIndexEntry[] = [];
        const keys = computeEvictionSet(entries, 1000);
        expect(keys).toEqual([]);
    });

    it('evicts minimal set when needToFree exactly matches one entry', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
        ];
        const keys = computeEvictionSet(entries, 100);
        expect(keys).toEqual(['a']);
    });

    it('evicts in LRU order (oldest first)', () => {
        const entries: EvictionIndexEntry[] = [
            { key: 'new', size: 50, lastAccessed: 100 },
            { key: 'old', size: 50, lastAccessed: 10 },
        ];
        const keys = computeEvictionSet(entries, 50);
        expect(keys).toEqual(['old']);
    });
});

describe('getTotalCacheSize', () => {
    it('sums sizes of all entries', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 0, evictable: true },
            { key: 'b', size: 200, lastAccessed: 0, evictable: true },
        ];
        expect(getTotalCacheSize(entries)).toBe(300);
    });

    it('returns 0 for empty array', () => {
        expect(getTotalCacheSize([])).toBe(0);
    });
});
