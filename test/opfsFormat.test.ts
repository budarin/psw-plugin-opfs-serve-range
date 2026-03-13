import { describe, it, expect } from 'vitest';
import {
    readMetadataFromFileFooter,
    MAX_META_JSON_BYTES,
} from '../src/opfsFormat.ts';

function buildFileWithFooter(
    bodyBytes: number,
    metadata: Record<string, unknown>
): File {
    const metaJson = JSON.stringify(metadata);
    const metaBytes = new TextEncoder().encode(metaJson);
    const body = new Uint8Array(bodyBytes);
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, metaBytes.length, true);
    const blob = new Blob([body, metaBytes, lenBuf]);
    return new File([blob], 'test');
}

describe('readMetadataFromFileFooter', () => {
    it('returns undefined metadata and bodySize when file is too small', async () => {
        const file = new File([new Uint8Array(2)], 'x');
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeUndefined();
        expect(r.bodySize).toBe(2);
    });

    it('reads valid footer and returns metadata and bodySize', async () => {
        const meta = { url: 'https://example.com/a.mp4', size: 100 };
        const file = buildFileWithFooter(100, meta);
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeDefined();
        expect(r.metadata?.url).toBe(meta.url);
        expect(r.metadata?.size).toBe(meta.size);
        expect(r.bodySize).toBe(100);
    });

    it('returns undefined when metaLen is 0', async () => {
        const body = new Uint8Array(50);
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, 0, true);
        const file = new File([body, lenBuf], 'x');
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeUndefined();
        expect(r.bodySize).toBe(54);
    });

    it('returns undefined when metaLen exceeds max', async () => {
        const body = new Uint8Array(10);
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, MAX_META_JSON_BYTES + 1, true);
        const file = new File([body, lenBuf], 'x');
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeUndefined();
        expect(r.bodySize).toBe(14);
    });

    it('returns undefined when metaLen > size - 4', async () => {
        const body = new Uint8Array(10);
        const metaBytes = new TextEncoder().encode('{"url":"x","size":1}');
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, 100, true);
        const file = new File([body, metaBytes, lenBuf], 'x');
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeUndefined();
        expect(r.bodySize).toBe(10 + metaBytes.length + 4);
    });

    it('returns undefined for invalid JSON in footer', async () => {
        const body = new Uint8Array(10);
        const metaBytes = new TextEncoder().encode('not json at all');
        const lenBuf = new ArrayBuffer(4);
        new DataView(lenBuf).setUint32(0, metaBytes.length, true);
        const file = new File([body, metaBytes, lenBuf], 'x');
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata).toBeUndefined();
        expect(r.bodySize).toBe(10 + metaBytes.length + 4);
    });

    it('parses metadata with optional fields', async () => {
        const meta = {
            url: 'https://a.com/v',
            size: 200,
            type: 'video/mp4',
            etag: '"x"',
            lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
            lastAccessed: 12345,
            evictable: false,
            folderName: 'my-cache',
        };
        const file = buildFileWithFooter(200, meta);
        const r = await readMetadataFromFileFooter(file);
        expect(r.metadata?.url).toBe(meta.url);
        expect(r.metadata?.size).toBe(meta.size);
        expect(r.metadata?.type).toBe(meta.type);
        expect(r.metadata?.etag).toBe(meta.etag);
        expect(r.metadata?.lastModified).toBe(meta.lastModified);
        expect(r.metadata?.lastAccessed).toBe(meta.lastAccessed);
        expect(r.metadata?.evictable).toBe(meta.evictable);
        expect(r.metadata?.folderName).toBe(meta.folderName);
        expect(r.bodySize).toBe(200);
    });
});
