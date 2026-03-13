/**
 * Загрузка assets в OPFS через Background Fetch: запросы к SW (filter, folders),
 * фильтрация, startDownloadAssetsToOpfs, оценка размера.
 */

import type { Logger } from '@budarin/pluggable-serviceworker';
import {
    startBackgroundFetch,
    isBackgroundFetchSupported,
    getBackgroundFetchIds,
    getBackgroundFetchRegistration,
} from '@budarin/pluggable-serviceworker/client/background-fetch';
import type { FolderName, Pathname } from '../types.js';
import { shouldProcessFile } from '../opfsUtil.js';
import { getOpfsBackgroundFetchId } from './opfsBackgroundFetchId.js';
import {
    OPFS_BACKGROUND_FETCH_ID_PREFIX,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
    OPFS_REQUEST_GET_REGISTERED_FOLDERS,
    OPFS_RESPONSE_REGISTERED_FOLDERS,
} from '../opfsMessages.js';
import type { OpfsMessagePayload } from './messageHandlers.js';
import {
    onOPFSBackgroundFetchCompleted,
    onOPFSBackgroundFetchFailed,
    onOPFSBackgroundFetchAborted,
    onOPFSBackgroundFetchFileWritten,
} from './messageHandlers.js';
import { OPFS_RANGE_LOG_CLIENT } from '../opfsLog.js';
import { listOpfsCachedResources } from './cacheControl.js';

/** Код ошибки: папка не зарегистрирована в SW (startDownloadAssetsToOpfs отказывает в старте). */
export const OPFS_ERROR_FOLDER_NOT_REGISTERED = 'OPFS_FOLDER_NOT_REGISTERED';
/** Код ошибки: SW не вернул список папок (таймаут или плагин opfsRegisteredFolders не подключён). */
export const OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE =
    'OPFS_SERVICE_WORKER_UNAVAILABLE';

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
            const data = event.data as {
                type?: string;
                requestId?: string;
                include?: string[];
                exclude?: string[];
            };
            if (
                data?.type !== OPFS_RESPONSE_BACKGROUND_FETCH_FILTER ||
                data.requestId !== requestId
            ) {
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
 * Запрашивает у SW список папок, зарегистрированных через registerFolderConfig.
 * В SW должен быть зарегистрирован плагин opfsRegisteredFolders. При таймауте или отсутствии ответа возвращает [].
 */
export async function getRegisteredFolders(): Promise<FolderName[]> {
    const reg = await navigator.serviceWorker.ready;
    const controller = reg.active;
    if (!controller) {
        return [];
    }
    const requestId = `opfs-folders-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve([]), 5000);
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as {
                type?: string;
                requestId?: string;
                folderNames?: string[];
            };
            if (
                data?.type !== OPFS_RESPONSE_REGISTERED_FOLDERS ||
                data.requestId !== requestId
            ) {
                return;
            }
            clearTimeout(timeout);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve(Array.isArray(data.folderNames) ? data.folderNames : []);
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        controller.postMessage({
            type: OPFS_REQUEST_GET_REGISTERED_FOLDERS,
            requestId,
        });
    });
}

/**
 * Фильтрует assets (pathname'ы) по include/exclude (те же правила, что в opfsBackgroundFetch).
 */
export function filterAssetsForOpfs(
    assets: Pathname[],
    include?: string[],
    exclude?: string[]
): Pathname[] {
    const origin = location.origin;
    return assets.filter((p) =>
        shouldProcessFile(new URL(p, origin).href, include, exclude)
    );
}

/** Результат успешной загрузки assets в OPFS. */
export interface DownloadAssetsToOpfsResult {
    registrationId: string;
    /** Assets (pathname'ы) всех записей загрузки. */
    assets?: Pathname[];
    /** Успешно записанные в OPFS assets. */
    written?: Pathname[];
    /** Пропущенные или с ошибкой записи assets. */
    failedOrSkipped?: Pathname[];
    /** Assets, не попавшие в загрузку из-за фильтра include/exclude. */
    filteredOut?: Pathname[];
}

/** Причина отклонения при загрузке (fail или abort). */
export interface DownloadAssetsToOpfsRejected {
    registrationId: string;
    reason: 'fail' | 'abort';
}

/** Ошибка старта загрузки: Error (возможно с code: OPFS_ERROR_*) или DownloadAssetsToOpfsRejected. Для отображения в UI проверяйте error?.code. */
export type StartDownloadError =
    | (Error & { code?: string })
    | DownloadAssetsToOpfsRejected;

/** Опции для startDownloadAssetsToOpfs. */
export interface StartDownloadAssetsToOpfsOptions {
    /** Имя папки в OPFS (обязательно). Должно совпадать с folderName в opfsBackgroundFetch. */
    folderName: FolderName;
    /** Список pathname'ов ресурсов для загрузки. Фильтр include/exclude запрашивается у SW. */
    assets: Pathname[];
    /** Заголовок для системного UI Background Fetch (например, уведомление на Android). */
    title?: string;
    /**
     * Иконки для системного UI Background Fetch (например, для уведомления на Android).
     * Формат соответствует BackgroundFetchUIOptions.icons. Опционально.
     */
    icons?: {
        src: string;
        sizes?: string;
        type?: string;
    }[];
    /**
     * Суммарный размер загрузки в байтах (всех assets в этой пачке).
     * Опционально. Нужен только для отображения прогресса: в onProgress второй аргумент total
     * и системный UI смогут показать «X из Y байт» или процент. Без него total будет 0.
     */
    totalDownloadSizeInBytes?: number;
    /** Колбек прогресса: (уже скачано байт, всего байт). Вызывается при каждом progress Background Fetch. */
    onProgress?: (downloaded: number, total: number) => void;
    /** Колбек после записи каждого файла в OPFS: (уже записанные pathname'ы, общее число файлов). */
    onFileWritten?: (loadedAssets: Pathname[], totalCount: number) => void;
    /** AbortSignal для отмены. При abort отписки снимаются, промис отклоняется с reason: 'abort'. */
    signal?: AbortSignal;
    /** Логгер для ошибок/диагностики (по умолчанию console). */
    logger?: Logger;
}

function runBackgroundFetch(
    id: string,
    assetsToUse: string[],
    filteredOut: string[],
    options: {
        title?: string;
        icons?: {
            src: string;
            sizes?: string;
            type?: string;
        }[];
        totalDownloadSizeInBytes?: number;
        onProgress?: (downloaded: number, total: number) => void;
        onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
        signal?: AbortSignal;
    },
    runOptions?: { attachOnly?: boolean }
): Promise<DownloadAssetsToOpfsResult> {
    const {
        title,
        icons,
        totalDownloadSizeInBytes,
        onProgress,
        onFileWritten,
        signal,
    } = options;
    const attachOnly = runOptions?.attachOnly === true;
    if (typeof location === 'undefined' || !location.origin) {
        throw new Error('OPFS: location.origin is not available');
    }
    const origin = location.origin;
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
            const data = event.data as OpfsMessagePayload & {
                registrationId?: string;
            };
            if (data.registrationId !== id) return;
            unsubCompleted();
            unsubFailed();
            unsubAborted();
            unsubFileWritten();
            reject({ registrationId: id, reason: 'fail' as const });
        });
        const unsubAborted = onOPFSBackgroundFetchAborted((event) => {
            const data = event.data as OpfsMessagePayload & {
                registrationId?: string;
            };
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
                return startBackgroundFetch(
                    reg as ServiceWorkerRegistration,
                    id,
                    urls,
                    {
                        title,
                        icons,
                        downloadTotal: totalDownloadSizeInBytes,
                    }
                ).then((bfReg: unknown) => {
                    if (
                        bfReg &&
                        typeof (bfReg as { addEventListener: unknown })
                            .addEventListener === 'function' &&
                        typeof (bfReg as { downloaded: unknown }).downloaded ===
                            'number'
                    ) {
                        const r = bfReg as {
                            addEventListener: (
                                type: string,
                                fn: () => void
                            ) => void;
                            downloaded: number;
                            downloadTotal: number;
                        };
                        r.addEventListener('progress', () => {
                            onProgress?.(r.downloaded, r.downloadTotal);
                        });
                    }
                });
            })
            .catch((err) => {
                cleanup();
                signal?.removeEventListener('abort', onAbort);
                reject(err);
            });
    });
}

/**
 * Запускает загрузку assets в OPFS через Background Fetch.
 * Запрашивает у SW include/exclude, фильтрует assets, в загрузку идут только подходящие.
 * Возвращает промис: resolve при COMPLETED, reject при FAILED/ABORTED или при signal.abort.
 */
export async function startDownloadAssetsToOpfs(
    options: StartDownloadAssetsToOpfsOptions
): Promise<DownloadAssetsToOpfsResult> {
    const {
        folderName,
        assets,
        title,
        icons,
        totalDownloadSizeInBytes,
        onProgress,
        onFileWritten,
        signal,
        logger = console,
    } = options;
    const filteredOut: string[] = [];

    const filter = await getBackgroundFetchFilter();
    const registeredFolders = await getRegisteredFolders();
    if (registeredFolders.length === 0) {
        const err = new Error(
            'OPFS: service worker did not report registered folders'
        );
        (err as Error & { code: string }).code =
            OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE;
        logger.error(`${OPFS_RANGE_LOG_CLIENT}${err.message}`);
        throw err;
    }
    if (!registeredFolders.includes(folderName)) {
        const err_1 = new Error(
            `OPFS: folder "${folderName}" is not registered in the service worker`
        );
        (err_1 as Error & { code: string }).code =
            OPFS_ERROR_FOLDER_NOT_REGISTERED;
        logger.error(`${OPFS_RANGE_LOG_CLIENT}${err_1.message}`);
        throw err_1;
    }
    const assetsToUse = filterAssetsForOpfs(
        assets,
        filter.include,
        filter.exclude
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
    const runOptions: {
        title?: string;
        icons?: {
            src: string;
            sizes?: string;
            type?: string;
        }[];
        totalDownloadSizeInBytes?: number;
        onProgress?: (downloaded: number, total: number) => void;
        onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
        signal?: AbortSignal;
    } = {};
    if (title !== undefined) runOptions.title = title;
    if (icons !== undefined) runOptions.icons = icons;
    if (totalDownloadSizeInBytes !== undefined)
        runOptions.totalDownloadSizeInBytes = totalDownloadSizeInBytes;
    if (onProgress !== undefined) runOptions.onProgress = onProgress;
    if (onFileWritten !== undefined) runOptions.onFileWritten = onFileWritten;
    if (signal !== undefined) runOptions.signal = signal;
    const reg = (await navigator.serviceWorker
        .ready) as ServiceWorkerRegistration;
    const activeIds = await getBackgroundFetchIds(reg);
    const ourActiveIds = activeIds.filter((i) =>
        i.startsWith(OPFS_BACKGROUND_FETCH_ID_PREFIX)
    );
    const pathnamesInProgress = new Set<string>();
    for (const activeId of ourActiveIds) {
        try {
            const bfReg = await getBackgroundFetchRegistration(reg, activeId);
            if (bfReg && typeof bfReg.matchAll === 'function') {
                const records = await bfReg.matchAll();
                for (const record of records) {
                    if (record?.request?.url) {
                        pathnamesInProgress.add(
                            new URL(record.request.url).pathname
                        );
                    }
                }
            }
        } catch {}
    }
    const assetsAfterProgress = assetsToUse.filter(
        (p_1) => !pathnamesInProgress.has(p_1)
    );
    const cached = await listOpfsCachedResources(folderName);
    const cachedPathnames = new Set(cached.map((r) => new URL(r.url).pathname));
    const assetsToFetch = assetsAfterProgress.filter(
        (p_2) => !cachedPathnames.has(p_2)
    );
    if (assetsToFetch.length === 0) {
        return {
            registrationId: '',
            assets: assetsToUse,
            written: assetsToUse,
            failedOrSkipped: [],
            ...(filteredOut.length > 0 && { filteredOut }),
        };
    }
    const id = await getOpfsBackgroundFetchId(assetsToFetch, folderName);
    if (ourActiveIds.includes(id)) {
        const bfReg_1 = await getBackgroundFetchRegistration(reg, id);
        if (bfReg_1) {
            return runBackgroundFetch(
                id,
                assetsToFetch,
                filteredOut,
                runOptions,
                { attachOnly: true }
            );
        }
    }
    return await runBackgroundFetch(id, assetsToFetch, filteredOut, runOptions);
}

export async function estimateAssetsSizeInBytes(
    assets: Pathname[]
): Promise<{ totalSize: number; sizes: Record<Pathname, number> }> {
    const origin = location.origin;

    const entries = await Promise.all(
        assets.map(async (asset): Promise<[Pathname, number]> => {
            try {
                const url = new URL(asset, origin).href;
                const response = await fetch(url, { method: 'HEAD' });
                if (!response.ok) {
                    return [asset, 0];
                }
                const headerValue =
                    response.headers.get('Content-Length') ??
                    response.headers.get('content-length');
                if (!headerValue) {
                    return [asset, 0];
                }
                const size = Number(headerValue);
                if (!Number.isFinite(size) || size < 0) {
                    return [asset, 0];
                }
                return [asset, size];
            } catch {
                return [asset, 0];
            }
        })
    );

    const sizes: Record<Pathname, number> = {} as Record<Pathname, number>;
    let totalSize = 0;
    for (const [asset, size] of entries) {
        sizes[asset] = size;
        totalSize += size;
    }

    return { totalSize, sizes };
}
