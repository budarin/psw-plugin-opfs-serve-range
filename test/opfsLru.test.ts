import { describe, it, expect } from 'vitest';
import { getCacheLimit, computeEvictionSet, type StorageEstimate, type CacheFileEntry } from '../src/opfsLru.ts';

describe('getCacheLimit', () => {
    it('respects maxCacheFraction and available space', () => {
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
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: true },
            { key: 'b', size: 200, lastAccessed: 20, evictable: true },
        ];
        const keys = computeEvictionSet(entries, 0);
        expect(keys).toEqual([]);
    });

    it('evicts oldest entries first until enough space is freed', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: true },
            { key: 'b', size: 200, lastAccessed: 20, evictable: true },
            { key: 'c', size: 300, lastAccessed: 30, evictable: true },
        ];
        const keys = computeEvictionSet(entries, 250);
        expect(keys).toEqual(['a', 'b']);
    });

    it('can evict all entries when needToFree is large', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: true },
            { key: 'b', size: 200, lastAccessed: 20, evictable: true },
        ];
        const keys = computeEvictionSet(entries, 1000);
        expect(keys).toEqual(['a', 'b']);
    });

    it('skips pinned entries (evictable: false)', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: true },
            { key: 'b', size: 200, lastAccessed: 20, evictable: false }, // pinned
            { key: 'c', size: 300, lastAccessed: 30, evictable: true },
        ];
        const keys = computeEvictionSet(entries, 250);
        // Should evict 'a' and 'c', but not 'b' (pinned)
        expect(keys).toEqual(['a', 'c']);
    });

    it('evicts only evictable entries even if pinned are oldest', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: false }, // pinned, oldest
            { key: 'b', size: 200, lastAccessed: 20, evictable: true },
            { key: 'c', size: 300, lastAccessed: 30, evictable: true },
        ];
        const keys = computeEvictionSet(entries, 250);
        // Should evict 'b' and 'c', but not 'a' (pinned)
        expect(keys).toEqual(['b', 'c']);
    });

    it('returns empty array when all entries are pinned', () => {
        const entries: CacheFileEntry[] = [
            { key: 'a', size: 100, lastAccessed: 10, evictable: false },
            { key: 'b', size: 200, lastAccessed: 20, evictable: false },
        ];
        const keys = computeEvictionSet(entries, 1000);
        expect(keys).toEqual([]);
    });
});
