/**
 * Клиентские утилиты: типизированные обработчики сообщений OPFS от сервис-воркера,
 * загрузка assets в OPFS через Background Fetch.
 */

import { onServiceWorkerMessage } from '@budarin/pluggable-serviceworker/client/messaging';
import {
    startBackgroundFetch,
    isBackgroundFetchSupported,
    getBackgroundFetchIds,
    getBackgroundFetchRegistration,
} from '@budarin/pluggable-serviceworker/client/background-fetch';

import {
    OPFS_BACKGROUND_FETCH_ID_PREFIX,
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
    OPFS_MSG_BACKGROUND_FETCH_COMPLETED,
    OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN,
    OPFS_MSG_RANGE_CACHE_FETCH_STARTED,
    OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
} from '../opfsMessages.js';
import { getOpfsDir, getRoot, shouldProcessFile } from '../opfsUtil.js';
import { getOpfsBackgroundFetchId } from './opfsBackgroundFetchId.js';
import { readMetadataFromFileFooter, type OpfsMetadata } from '../opfsFormat.js';
import { urlToOpfsKey } from '../opfsKey.js';

export {
    OPFS_BACKGROUND_FETCH_ID_PREFIX,
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
    OPFS_MSG_BACKGROUND_FETCH_COMPLETED,
    OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN,
    OPFS_MSG_RANGE_CACHE_FETCH_STARTED,
    OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
} from '../opfsMessages.js';
export type { OpfsMessageType } from '../opfsMessages.js';
export { getOpfsBackgroundFetchId } from './opfsBackgroundFetchId.js';

export interface OpfsMessagePayload {
    url?: string;
    size?: number;
    limit?: number;
    reason?: string;
    /** ID регистрации Background Fetch (для COMPLETED/FAILED/ABORTED). */
    registrationId?: string;
    /** Assets (pathname'ы) всех записей (для COMPLETED). */
    assets?: string[];
    /** Успешно записанные в OPFS assets (для COMPLETED). */
    written?: string[];
    /** Пропущенные или с ошибкой записи assets (для COMPLETED). */
    failedOrSkipped?: string[];
    /** Один записанный asset (pathname) (для FILE_WRITTEN). */
    asset?: string;
    /** Накопленный список записанных assets (для FILE_WRITTEN). */
    loadedAssets?: string[];
    /** Общее число файлов в загрузке (для FILE_WRITTEN). */
    totalCount?: number;
}

export interface OpfsCachedResource {
    url: string;
    size: number;
    type: string | undefined;
    lastModified: string | undefined;
}

/** Подписка на сообщение «квота исчерпана при записи». Возвращает функцию отписки. */
export function onOPFSQuotaExceeded(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «запись не начата — файл не влезает». */
export function onOPFSWriteSkipped(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_SKIPPED_SIZE, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «достигнут лимит кеша». */
export function onOPFSCacheLimitReached(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_CACHE_LIMIT_REACHED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «эвикция завершена». */
export function onOPFSEvictionCompleted(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_EVICTION_COMPLETED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «ошибка записи». */
export function onOPFSWriteFailed(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_FAILED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «повторный запрос к URL из blocklist (не кешируем)». */
export function onOPFSSkipQuotaExceeded(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_SKIP_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch завершился с ошибкой». */
export function onOPFSBackgroundFetchFailed(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_FAILED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch отменён». */
export function onOPFSBackgroundFetchAborted(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_ABORTED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch успешно завершён, ресурсы в OPFS». */
export function onOPFSBackgroundFetchCompleted(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «один файл из Background Fetch записан в OPFS» (прогресс по файлам). */
export function onOPFSBackgroundFetchFileWritten(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «плагин opfsRangeFromNetworkAndCache начал фоновую загрузку в кеш» (сценарий «кеш при первом запросе»). По нему можно включить индикатор «идёт фоновая загрузка». */
export function onOPFSRangeCacheFetchStarted(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_RANGE_CACHE_FETCH_STARTED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «все фоновые загрузки в кеш (opfsRangeFromNetworkAndCache) завершены». По нему можно выключить индикатор. */
export function onOPFSRangeCacheFetchAllDone(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE, handler as (e: MessageEvent) => void);
}

/**
 * Запрашивает у SW текущие include/exclude плагина opfsBackgroundFetch.
 * В SW должен быть зарегистрирован плагин opfsBackgroundFetch (он обрабатывает message для ответа с фильтром).
 */
export async function getBackgroundFetchFilter(): Promise<{
    include?: string[];
    exclude?: string[];
}> {
    const reg = await navigator.serviceWorker.ready;
    const controller = reg.active;
    if (!controller) {
        return {};
    }
    const requestId = `opfs-filter-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({}), 5000);
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as { type?: string; requestId?: string; include?: string[]; exclude?: string[] };
            if (data?.type !== OPFS_RESPONSE_BACKGROUND_FETCH_FILTER || data.requestId !== requestId) {
                return;
            }
            clearTimeout(timeout);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            const result: { include?: string[]; exclude?: string[] } = {};
            if (data.include !== undefined) result.include = data.include;
            if (data.exclude !== undefined) result.exclude = data.exclude;
            resolve(result);
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        controller.postMessage({
            type: OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
            requestId,
        });
    });
}

/**
 * Фильтрует assets (pathname'ы) по include/exclude (те же правила, что в opfsBackgroundFetch).
 * Origin для построения полного URL (по умолчанию location.origin).
 */
export function filterAssetsForOpfs(
    assets: string[],
    include?: string[],
    exclude?: string[],
    origin?: string
): string[] {
    const base = origin ?? (typeof location !== 'undefined' ? location.origin : 'https://example.com');
    return assets.filter((p) => shouldProcessFile(new URL(p, base).href, include, exclude));
}

async function getOpfsCacheDirOrUndefined(): Promise<FileSystemDirectoryHandle | undefined> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.storage == null ||
        typeof navigator.storage.getDirectory !== 'function'
    ) {
        return undefined;
    }
    const root = await getRoot();
    try {
        return await getOpfsDir(root, false);
    } catch {
        return undefined;
    }
}

async function readMetadataFromFile(
    file: File
): Promise<OpfsMetadata | undefined> {
    const { metadata } = await readMetadataFromFileFooter(file);
    return metadata ?? undefined;
}

export async function listOpfsCachedResources(): Promise<OpfsCachedResource[]> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return [];
    }
    const fileHandles: FileSystemFileHandle[] = [];
    for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'file') {
            fileHandles.push(handle as FileSystemFileHandle);
        }
    }
    const results = await Promise.all(
        fileHandles.map(async (handle): Promise<OpfsCachedResource | null> => {
            try {
                const file = await handle.getFile();
                const metadata = await readMetadataFromFile(file);
                if (!metadata || !metadata.url) {
                    return null;
                }
                return {
                    url: metadata.url,
                    size: metadata.size,
                    type: metadata.type,
                    lastModified: metadata.lastModified,
                };
            } catch {
                return null;
            }
        })
    );
    return results.filter((r): r is OpfsCachedResource => r !== null);
}

export async function hasInOpfsCache(url: string): Promise<boolean> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return false;
    }
    const key = await urlToOpfsKey(url);
    try {
        await dir.getFileHandle(key);
        return true;
    } catch {
        return false;
    }
}

export async function deleteFromOpfsCache(url: string): Promise<void> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return;
    }
    const key = await urlToOpfsKey(url);
    try {
        await dir.removeEntry(key);
    } catch {
        // нет файла — не ошибка
    }
}

/** Результат успешной загрузки assets в OPFS. */
export interface DownloadAssetsToOpfsResult {
    registrationId: string;
    /** Assets (pathname'ы) всех записей загрузки. */
    assets?: string[];
    /** Успешно записанные в OPFS assets. */
    written?: string[];
    /** Пропущенные или с ошибкой записи assets. */
    failedOrSkipped?: string[];
    /** Assets, не попавшие в загрузку из-за фильтра include/exclude. */
    filteredOut?: string[];
}

/** Причина отклонения при загрузке (fail или abort). */
export interface DownloadAssetsToOpfsRejected {
    registrationId: string;
    reason: 'fail' | 'abort';
}

/** Опции для startDownloadAssetsToOpfs. */
export interface StartDownloadAssetsToOpfsOptions {
    /** Assets (pathname'ы same-origin). Полные URL строятся от location.origin. Фильтр include/exclude запрашивается у SW. */
    assets: string[];
    /** Заголовок для UI Background Fetch. */
    title?: string;
    /** Ожидаемый суммарный размер (байты) для отображения прогресса. */
    downloadTotal?: number;
    /** Колбек прогресса по байтам (downloaded, total). */
    onProgress?: (downloaded: number, total: number) => void;
    /** Колбек после записи каждого файла в OPFS (loadedAssets, totalCount). */
    onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
    /** При abort отписки снимаются, промис отклоняется с reason: 'abort'. */
    signal?: AbortSignal;
}

/**
 * Запускает загрузку assets в OPFS через Background Fetch.
 * Запрашивает у SW include/exclude, фильтрует assets, в загрузку идут только подходящие.
 * Возвращает промис: resolve при COMPLETED, reject при FAILED/ABORTED или при signal.abort.
 */
export function startDownloadAssetsToOpfs(
    options: StartDownloadAssetsToOpfsOptions
): Promise<DownloadAssetsToOpfsResult> {
    const { assets, title, downloadTotal, onProgress, onFileWritten, signal } = options;
    const filteredOut: string[] = [];

    return getBackgroundFetchFilter().then(async (filter) => {
        const assetsToUse = filterAssetsForOpfs(
            assets,
            filter.include,
            filter.exclude,
            typeof location !== 'undefined' ? location.origin : undefined
        );
        assets.forEach((p) => {
            if (!assetsToUse.includes(p)) {
                filteredOut.push(p);
            }
        });
        if (assetsToUse.length === 0) {
            return {
                registrationId: '',
                assets: [],
                written: [],
                failedOrSkipped: [],
                ...(filteredOut.length > 0 && { filteredOut }),
            };
        }
        const id = await getOpfsBackgroundFetchId(assetsToUse);
        const runOptions: {
            title?: string;
            downloadTotal?: number;
            onProgress?: (downloaded: number, total: number) => void;
            onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
            signal?: AbortSignal;
        } = {};
        if (title !== undefined) runOptions.title = title;
        if (downloadTotal !== undefined) runOptions.downloadTotal = downloadTotal;
        if (onProgress !== undefined) runOptions.onProgress = onProgress;
        if (onFileWritten !== undefined) runOptions.onFileWritten = onFileWritten;
        if (signal !== undefined) runOptions.signal = signal;

        const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration;
        const activeIds = await getBackgroundFetchIds(reg);
        const ourActiveIds = activeIds.filter((i) => i.startsWith(OPFS_BACKGROUND_FETCH_ID_PREFIX));
        if (ourActiveIds.includes(id)) {
            const bfReg = await getBackgroundFetchRegistration(reg, id);
            if (bfReg) {
                return runBackgroundFetch(id, assetsToUse, filteredOut, runOptions, { attachOnly: true });
            }
        }
        return runBackgroundFetch(id, assetsToUse, filteredOut, runOptions);
    });
}

function runBackgroundFetch(
    id: string,
    assetsToUse: string[],
    filteredOut: string[],
    options: {
        title?: string;
        downloadTotal?: number;
        onProgress?: (downloaded: number, total: number) => void;
        onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
        signal?: AbortSignal;
    },
    runOptions?: { attachOnly?: boolean }
): Promise<DownloadAssetsToOpfsResult> {
    const { title, downloadTotal, onProgress, onFileWritten, signal } = options;
    const attachOnly = runOptions?.attachOnly === true;
    const origin = typeof location !== 'undefined' ? location.origin : 'https://example.com';
    const urls = assetsToUse.map((p) => new URL(p, origin).href);

    return new Promise((resolve, reject) => {
        const unsubCompleted = onOPFSBackgroundFetchCompleted((event) => {
            const data = event.data as OpfsMessagePayload & {
                registrationId?: string;
                assets?: string[];
                written?: string[];
                failedOrSkipped?: string[];
            };
            if (data.registrationId !== id) return;
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            resolve({
                registrationId: id,
                assets: data.assets ?? assetsToUse,
                written: data.written ?? [],
                failedOrSkipped: data.failedOrSkipped ?? [],
                ...(filteredOut.length > 0 && { filteredOut }),
            });
        });
        const unsubFailed = onOPFSBackgroundFetchFailed((event) => {
            const data = event.data as OpfsMessagePayload & { registrationId?: string };
            if (data.registrationId !== id) return;
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            reject({ registrationId: id, reason: 'fail' as const });
        });
        const unsubAborted = onOPFSBackgroundFetchAborted((event) => {
            const data = event.data as OpfsMessagePayload & { registrationId?: string };
            if (data.registrationId !== id) return;
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            reject({ registrationId: id, reason: 'abort' as const });
        });
        const unsubFileWritten = onOPFSBackgroundFetchFileWritten((event) => {
            const data = event.data as OpfsMessagePayload & {
                registrationId?: string;
                loadedAssets?: string[];
                totalCount?: number;
            };
            if (data.registrationId !== id) return;
            onFileWritten?.(data.loadedAssets ?? [], data.totalCount ?? 0);
        });

        const onAbort = (): void => {
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            signal?.removeEventListener('abort', onAbort);
            reject({ registrationId: id, reason: 'abort' as const });
        };
        const cleanup = (): void => {
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            signal?.removeEventListener('abort', onAbort);
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        if (attachOnly) {
            return;
        }

        isBackgroundFetchSupported()
            .then((supported) => {
                if (!supported) {
                    cleanup();
                    signal?.removeEventListener('abort', onAbort);
                    reject(new Error('Background Fetch API is not supported'));
                    return;
                }
                return navigator.serviceWorker.ready;
            })
            .then((reg) => {
                if (!reg) return;
                return startBackgroundFetch(reg as ServiceWorkerRegistration, id, urls, { title, downloadTotal }).then(
                    (bfReg: unknown) => {
                        if (
                            bfReg &&
                            typeof (bfReg as { addEventListener: unknown }).addEventListener === 'function' &&
                            typeof (bfReg as { downloaded: unknown }).downloaded === 'number'
                        ) {
                            const r = bfReg as { addEventListener: (type: string, fn: () => void) => void; downloaded: number; downloadTotal: number };
                            r.addEventListener('progress', () => {
                                onProgress?.(r.downloaded, r.downloadTotal);
                            });
                        }
                    }
                );
            })
            .catch((err) => {
                cleanup();
                signal?.removeEventListener('abort', onAbort);
                reject(err);
            });
    });
}
