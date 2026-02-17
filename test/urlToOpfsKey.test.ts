import { describe, it, expect } from 'vitest';
import { urlToOpfsKey } from '../src/index.ts';

describe('urlToOpfsKey', () => {
    it('returns the same key for the same URL', async () => {
        const url = 'https://example.com/video.mp4';
        const key1 = await urlToOpfsKey(url);
        const key2 = await urlToOpfsKey(url);
        expect(key1).toBe(key2);
    });

    it('returns different keys for different URLs', async () => {
        const url1 = 'https://example.com/video1.mp4';
        const url2 = 'https://example.com/video2.mp4';
        const key1 = await urlToOpfsKey(url1);
        const key2 = await urlToOpfsKey(url2);
        expect(key1).not.toBe(key2);
    });
});
