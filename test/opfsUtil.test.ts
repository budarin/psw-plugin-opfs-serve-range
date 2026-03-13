import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    emitDroppedPatternWarnings,
    getGlobalMaxCacheFraction,
    setGlobalMaxCacheFraction,
    getMaxCacheFraction,
    normalizePatternList,
    registerFolderConfig,
    resetFolderRegistryForTests,
    shouldProcessFile,
} from '../src/opfsUtil.ts';

beforeEach(() => {
    resetFolderRegistryForTests();
});

describe('global max cache fraction', () => {
    it('defaults to 0.5', () => {
        expect(getGlobalMaxCacheFraction()).toBe(0.5);
    });

    it('allows setting valid value in (0, 1]', () => {
        setGlobalMaxCacheFraction(0.8);
        expect(getGlobalMaxCacheFraction()).toBe(0.8);
        setGlobalMaxCacheFraction(1);
        expect(getGlobalMaxCacheFraction()).toBe(1);
    });

    it('throws on invalid value', () => {
        expect(() => setGlobalMaxCacheFraction(0)).toThrow('globalMaxCacheFraction');
        expect(() => setGlobalMaxCacheFraction(1.5)).toThrow('globalMaxCacheFraction');
        expect(() => setGlobalMaxCacheFraction(-0.1)).toThrow('globalMaxCacheFraction');
    });
});

describe('getMaxCacheFraction (global limit)', () => {
    it('returns global fraction (same as getGlobalMaxCacheFraction)', () => {
        expect(getMaxCacheFraction()).toBe(0.5);
        setGlobalMaxCacheFraction(0.3);
        expect(getMaxCacheFraction()).toBe(0.3);
        expect(getMaxCacheFraction()).toBe(getGlobalMaxCacheFraction());
    });
});

describe('normalizePatternList', () => {
    const baseOrigin = 'https://example.com';

    it('returns undefined/empty list and empty dropped for undefined/empty input', () => {
        const r1 = normalizePatternList(undefined, baseOrigin);
        expect(r1.list).toBeUndefined();
        expect(r1.dropped).toEqual({ crossOrigin: [], invalid: [] });
        const r2 = normalizePatternList([], baseOrigin);
        expect(r2.list).toEqual([]);
        expect(r2.dropped).toEqual({ crossOrigin: [], invalid: [] });
    });

    it('leaves pathnames and globs as-is', () => {
        const r = normalizePatternList(['/video/*', '*.mp4'], baseOrigin);
        expect(r.list).toEqual(['/video/*', '*.mp4']);
        expect(r.dropped.crossOrigin).toHaveLength(0);
    });

    it('converts same-origin full URL to pathname', () => {
        const r = normalizePatternList(['https://example.com/assets/video.mp4'], baseOrigin);
        expect(r.list).toEqual(['/assets/video.mp4']);
    });

    it('drops cross-origin full URLs into dropped.crossOrigin', () => {
        const r = normalizePatternList(['https://other.com/video.mp4'], baseOrigin);
        expect(r.list).toEqual([]);
        expect(r.dropped.crossOrigin).toEqual(['https://other.com/video.mp4']);
    });

    it('keeps pathnames and same-origin, drops cross-origin into dropped', () => {
        const r = normalizePatternList(
            ['/local/*', 'https://example.com/a', 'https://evil.com/b', '*.mp4'],
            baseOrigin
        );
        expect(r.list).toEqual(['/local/*', '/a', '*.mp4']);
        expect(r.dropped.crossOrigin).toEqual(['https://evil.com/b']);
    });

    it('puts invalid URLs into dropped.invalid', () => {
        const r = normalizePatternList(['https://other.com/x', 'http://['], baseOrigin);
        expect(r.dropped.crossOrigin).toEqual(['https://other.com/x']);
        expect(r.dropped.invalid).toContain('http://[');
    });

    it('trims pattern whitespace', () => {
        const r = normalizePatternList(['  /video/*  ', ' *.mp4 '], baseOrigin);
        expect(r.list).toEqual(['/video/*', '*.mp4']);
    });

    it('returns list unchanged when baseOrigin is empty (no cross-origin filtering)', () => {
        const r = normalizePatternList(['https://example.com/a', '/b'], '');
        expect(r.list).toEqual(['https://example.com/a', '/b']);
        expect(r.dropped.crossOrigin).toHaveLength(0);
    });
});

describe('emitDroppedPatternWarnings', () => {
    it('calls logger.warn for each dropped cross-origin and invalid, then clears arrays', () => {
        const warn = vi.fn();
        const dropped = {
            crossOrigin: ['https://other.com/a'],
            invalid: ['bad://url'],
        };
        emitDroppedPatternWarnings(dropped, { warn });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped cross-origin'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped invalid URL'));
        expect(dropped.crossOrigin).toHaveLength(0);
        expect(dropped.invalid).toHaveLength(0);
    });
});

describe('shouldProcessFile', () => {
    const origin = 'https://example.com';
    let originalSelf: typeof globalThis.self;

    beforeEach(() => {
        originalSelf = globalThis.self;
        (globalThis as unknown as { self: { origin: string } }).self = { origin };
    });
    afterEach(() => {
        (globalThis as unknown as { self: typeof originalSelf }).self = originalSelf;
    });

    function runWithSelfRestore(fn: () => void): void {
        try {
            fn();
        } finally {
            (globalThis as unknown as { self: typeof originalSelf }).self = originalSelf;
        }
    }

    it('returns false for cross-origin URL (full URL from other origin)', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://evil.com/video/1.mp4', ['/video/*'], undefined)).toBe(false);
            expect(shouldProcessFile('https://evil.com/video/1.mp4', undefined, undefined)).toBe(false);
        });
    });

    it('returns true for same-origin URL matching include', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/video/1.mp4', ['/video/*'], undefined)).toBe(true);
        });
    });

    it('returns false for same-origin URL matching exclude', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/private/x', ['*'], ['/private/*'])).toBe(false);
        });
    });

    it('returns false when include is empty or undefined', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/video/1.mp4', [], undefined)).toBe(false);
            expect(shouldProcessFile('https://example.com/video/1.mp4', undefined, undefined)).toBe(false);
        });
    });

    it('returns true when URL matches any include pattern', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/assets/video.mp4', ['/assets/*', '/static/*'], undefined)).toBe(true);
            expect(shouldProcessFile('https://example.com/static/x', ['/assets/*', '/static/*'], undefined)).toBe(true);
        });
    });

    it('returns false when URL matches no include pattern', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/other/x', ['/video/*', '*.mp4'], undefined)).toBe(false);
        });
    });

    it('exclude takes precedence over include', () => {
        runWithSelfRestore(() => {
            expect(shouldProcessFile('https://example.com/video/secret.mp4', ['/video/*'], ['/video/secret*'])).toBe(false);
        });
    });
});
