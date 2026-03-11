/**
 * Тесты для startDownloadAssetsToOpfs с моками messaging и background-fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    OPFS_MSG_BACKGROUND_FETCH_COMPLETED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
    OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
} from '../src/opfsMessages.js';

const handlers: Record<string, (e: MessageEvent) => void> = {};
const mockUnsub = vi.fn();

vi.mock('@budarin/pluggable-serviceworker/client/messaging', () => ({
    onServiceWorkerMessage: (type: string, handler: (e: MessageEvent) => void) => {
        handlers[type] = handler;
        return mockUnsub;
    },
}));

let capturedId: string | null = null;
const fakeBfReg = {
    addEventListener: vi.fn(),
    downloaded: 0,
    downloadTotal: 100,
};

vi.mock('@budarin/pluggable-serviceworker/client/background-fetch', () => ({
    isBackgroundFetchSupported: vi.fn().mockResolvedValue(true),
    startBackgroundFetch: vi.fn().mockImplementation((_reg: unknown, id: string) => {
        capturedId = id;
        return Promise.resolve(fakeBfReg);
    }),
    getBackgroundFetchIds: vi.fn().mockResolvedValue([]),
    getBackgroundFetchRegistration: vi.fn().mockResolvedValue(undefined),
}));

const fakeSwRegistration = {};
const originalLocation = globalThis.location;

/** Ответ SW на запрос фильтра (для тестов «filter»). По умолчанию include ['*'] — все проходят. */
let swFilterResponse: { include?: string[]; exclude?: string[] } = { include: ['*'] };
const messageListeners: Array<{ type: string; fn: (e: MessageEvent) => void }> = [];

beforeEach(() => {
    vi.clearAllMocks();
    capturedId = null;
    swFilterResponse = { include: ['*'] };
    messageListeners.length = 0;
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    Object.defineProperty(globalThis, 'location', {
        value: { origin: 'https://example.com' },
        configurable: true,
        writable: true,
    });
    const active = {
        postMessage: (msg: { type?: string; requestId?: string }) => {
            if (msg?.type === OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER && msg.requestId) {
                setTimeout(() => {
                    messageListeners
                        .filter((l) => l.type === 'message')
                        .forEach((l) =>
                            l.fn({
                                data: {
                                    type: OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
                                    requestId: msg.requestId,
                                    include: swFilterResponse.include,
                                    exclude: swFilterResponse.exclude,
                                },
                            } as MessageEvent)
                        );
                }, 0);
            }
        },
    };
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: {
            ready: Promise.resolve({ active }),
            addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
                messageListeners.push({ type, fn });
            },
            removeEventListener: () => {},
        },
        configurable: true,
        writable: true,
    });
});

afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
        value: originalLocation,
        configurable: true,
        writable: true,
    });
});

async function getModule() {
    const client = await import('../src/client/index.js');
    return client;
}

function fireMessage(type: string, data: Record<string, unknown>) {
    const handler = handlers[type];
    if (handler) {
        handler({ data: { type, ...data } } as MessageEvent);
    }
}

/** Ждёт, пока мок startBackgroundFetch будет вызван и capturedId заполнится (макс. timeoutMs). */
async function waitForCapturedId(timeoutMs = 500): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (capturedId === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
    }
    if (capturedId === null) {
        throw new Error(`capturedId was not set within ${timeoutMs}ms`);
    }
    return capturedId;
}

describe('startDownloadAssetsToOpfs', () => {
    it('resolves immediately when assets is empty', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const result = await startDownloadAssetsToOpfs({ folderName: 'test-cache', assets: [] });
        expect(result).toEqual({
            registrationId: '',
            assets: [],
            written: [],
            failedOrSkipped: [],
        });
    });

    it('resolves with assets, written, failedOrSkipped when COMPLETED received', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const assets = ['/video.mp4', '//audio.mp3'];
        const p = startDownloadAssetsToOpfs({ folderName: 'test-cache', assets });
        const id = await waitForCapturedId();
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, {
            registrationId: id,
            assets: ['/video.mp4', '/audio.mp3'],
            written: ['/video.mp4', '/audio.mp3'],
            failedOrSkipped: [],
        });
        const result = await p;
        expect(result.registrationId).toBe(id);
        expect(result.assets).toEqual(['/video.mp4', '/audio.mp3']);
        expect(result.written).toEqual(['/video.mp4', '/audio.mp3']);
        expect(result.failedOrSkipped).toEqual([]);
    });

    it('rejects with reason "fail" when FAILED message received', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const p = startDownloadAssetsToOpfs({ folderName: 'test-cache', assets: ['/a'] });
        const id = await waitForCapturedId();
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_FAILED, { registrationId: id });
        await expect(p).rejects.toEqual({ registrationId: id, reason: 'fail' });
    });

    it('rejects with reason "abort" when ABORTED message received', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const p = startDownloadAssetsToOpfs({ folderName: 'test-cache', assets: ['/a'] });
        const id = await waitForCapturedId();
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_ABORTED, { registrationId: id });
        await expect(p).rejects.toEqual({ registrationId: id, reason: 'abort' });
    });

    it('rejects when AbortSignal fires', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const controller = new AbortController();
        const p = startDownloadAssetsToOpfs({ folderName: 'test-cache', assets: ['/a'], signal: controller.signal });
        controller.abort();
        await expect(p).rejects.toMatchObject({ reason: 'abort' });
    });

    it('rejects when Background Fetch is not supported', async () => {
        const bf = await import('@budarin/pluggable-serviceworker/client/background-fetch');
        vi.mocked(bf.isBackgroundFetchSupported).mockResolvedValueOnce(false);
        const { startDownloadAssetsToOpfs } = await getModule();
        await expect(startDownloadAssetsToOpfs({ folderName: 'test-cache', assets: ['/a'] })).rejects.toThrow(
            'Background Fetch API is not supported'
        );
    });

    it('filters assets by include/exclude from SW before starting BF', async () => {
        const bf = await import('@budarin/pluggable-serviceworker/client/background-fetch');
        const startBf = vi.mocked(bf.startBackgroundFetch);
        swFilterResponse = { include: ['*.mp4'] };
        const { startDownloadAssetsToOpfs } = await getModule();
        const p = startDownloadAssetsToOpfs({
            folderName: 'test-cache',
            assets: ['/a.mp4', '/b.txt', '/c.mp4'],
        });
        const id = await waitForCapturedId();
        expect(startBf).toHaveBeenCalledTimes(1);
        const [, , urls] = startBf.mock.calls[0];
        expect(urls).toEqual(['https://example.com/a.mp4', 'https://example.com/c.mp4']);
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, {
            registrationId: id,
            assets: ['/a.mp4', '/c.mp4'],
            written: ['/a.mp4', '/c.mp4'],
            failedOrSkipped: [],
        });
        await p;
    });

    it('resolves immediately when all assets filtered out', async () => {
        swFilterResponse = { include: ['*.mp4'] };
        const { startDownloadAssetsToOpfs } = await getModule();
        const result = await startDownloadAssetsToOpfs({
            folderName: 'test-cache',
            assets: ['/a.txt', '/b.txt'],
        });
        expect(result).toEqual({
            registrationId: '',
            assets: [],
            written: [],
            failedOrSkipped: [],
            filteredOut: ['/a.txt', '/b.txt'],
        });
    });

    it('calls onFileWritten when FILE_WRITTEN message received', async () => {
        const { startDownloadAssetsToOpfs } = await getModule();
        const onFileWritten = vi.fn();
        const p = startDownloadAssetsToOpfs({
            folderName: 'test-cache',
            assets: ['/a', '/b', '/c'],
            onFileWritten,
        });
        const id = await waitForCapturedId();
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, {
            registrationId: id,
            asset: '/a',
            loadedAssets: ['/a'],
            totalCount: 3,
        });
        expect(onFileWritten).toHaveBeenCalledWith(['/a'], 3);
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, {
            registrationId: id,
            asset: '/b',
            loadedAssets: ['/a', '/b'],
            totalCount: 3,
        });
        expect(onFileWritten).toHaveBeenCalledWith(['/a', '/b'], 3);
        fireMessage(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, {
            registrationId: id,
            assets: ['/a', '/b', '/c'],
            written: ['/a', '/b', '/c'],
            failedOrSkipped: [],
        });
        await p;
        expect(onFileWritten).toHaveBeenCalledTimes(2);
    });
});
