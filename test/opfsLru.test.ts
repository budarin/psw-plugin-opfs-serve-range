import { describe, it, expect } from 'vitest';
import { getCacheLimit, computeEvictionSet, type StorageEstimate } from '../src/opfsLru.ts';

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
        const entries = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
        ];
        const keys = computeEvictionSet(entries, 0);
        expect(keys).toEqual([]);
    });

    it('evicts oldest entries first until enough space is freed', () => {
        const entries = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
            { key: 'c', size: 300, lastAccessed: 30 },
        ];
        const keys = computeEvictionSet(entries, 250);
        expect(keys).toEqual(['a', 'b']);
    });

    it('can evict all entries when needToFree is large', () => {
        const entries = [
            { key: 'a', size: 100, lastAccessed: 10 },
            { key: 'b', size: 200, lastAccessed: 20 },
        ];
        const keys = computeEvictionSet(entries, 1000);
        expect(keys).toEqual(['a', 'b']);
    });
});
