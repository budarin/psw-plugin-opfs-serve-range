import { describe, it, expect } from 'vitest';
import {
    parseRangeHeader,
    build206Response,
    type RangeSpec,
} from '../src/opfsRangeUtil.ts';
import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { HEADER_CONTENT_RANGE, HEADER_CONTENT_LENGTH, HEADER_CONTENT_TYPE } from '@budarin/http-constants/headers';

describe('parseRangeHeader', () => {
    const fullSize = 1000;

    it('parses bytes=start-end range', () => {
        const r = parseRangeHeader('bytes=0-499', fullSize);
        expect(r).toEqual({ start: 0, end: 499 });
    });

    it('parses bytes=start- (open end) as fullSize-1', () => {
        const r = parseRangeHeader('bytes=100-', fullSize);
        expect(r).toEqual({ start: 100, end: 999 });
    });

    it('parses suffix range bytes=-N', () => {
        const r = parseRangeHeader('bytes=-100', fullSize);
        expect(r).toEqual({ start: 900, end: 999 });
    });

    it('suffix range with N > fullSize starts at 0', () => {
        const r = parseRangeHeader('bytes=-2000', fullSize);
        expect(r).toEqual({ start: 0, end: 999 });
    });

    it('trims whitespace', () => {
        const r = parseRangeHeader('  bytes=10-20  ', fullSize);
        expect(r).toEqual({ start: 10, end: 20 });
    });

    it('throws on invalid format', () => {
        expect(() => parseRangeHeader('bytes=abc-20', fullSize)).toThrow('Invalid');
        expect(() => parseRangeHeader('invalid', fullSize)).toThrow('Invalid or unsupported');
        expect(() => parseRangeHeader('bytes=10', fullSize)).toThrow();
    });

    it('throws on invalid suffix value', () => {
        expect(() => parseRangeHeader('bytes=-0', fullSize)).toThrow('Invalid suffix');
        expect(() => parseRangeHeader('bytes=-abc', fullSize)).toThrow();
    });

    it('throws when start out of bounds', () => {
        expect(() => parseRangeHeader('bytes=1000-1001', fullSize)).toThrow('out of bounds');
        expect(() => parseRangeHeader('bytes=1001-1010', fullSize)).toThrow('out of bounds');
    });

    it('throws when end out of bounds or end < start', () => {
        expect(() => parseRangeHeader('bytes=10-1000', fullSize)).toThrow('out of bounds');
        expect(() => parseRangeHeader('bytes=20-10', fullSize)).toThrow('out of bounds');
    });
});

describe('build206Response', () => {
    it('returns 206 with correct headers', () => {
        const range: RangeSpec = { start: 0, end: 99 };
        const blob = new Blob([new Uint8Array(100)]);
        const res = build206Response(blob, range, 1000);
        expect(res.status).toBe(HTTP_STATUS_PARTIAL_CONTENT);
        expect(res.headers.get(HEADER_CONTENT_RANGE)).toBe('bytes 0-99/1000');
        expect(res.headers.get(HEADER_CONTENT_LENGTH)).toBe('100');
        expect(res.headers.get(HEADER_CONTENT_TYPE)).toBeDefined();
    });

    it('applies optional etag and lastModified', () => {
        const range: RangeSpec = { start: 0, end: 9 };
        const blob = new Blob([new Uint8Array(10)]);
        const res = build206Response(blob, range, 100, {
            etag: '"abc"',
            lastModified: 'Wed, 01 Jan 2020 00:00:00 GMT',
        });
        expect(res.status).toBe(HTTP_STATUS_PARTIAL_CONTENT);
        expect(res.headers.get('ETag')).toBe('"abc"');
        expect(res.headers.get('Last-Modified')).toBe('Wed, 01 Jan 2020 00:00:00 GMT');
    });

    it('applies cacheControl when provided', () => {
        const range: RangeSpec = { start: 0, end: 0 };
        const blob = new Blob([new Uint8Array(1)]);
        const res = build206Response(blob, range, 1, { cacheControl: 'no-store' });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
});
