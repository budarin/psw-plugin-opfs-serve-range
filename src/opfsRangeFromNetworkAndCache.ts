/**
 * Плагин: range-запросы из сети и кеширование в OPFS. При запросах, не обслуженных из OPFS,
 * идёт в сеть, отдаёт ответ клиенту сразу; при range-запросе и ответе 206 запускает
 * фоновую полную загрузку в OPFS (без дублей по URL). В кеш пишет только полные ответы (200).
 */

import type { Logger, Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { notifyClients } from '@budarin/pluggable-serviceworker/utils';
import { HEADER_RANGE } from '@budarin/http-constants/headers';
import type { FolderName } from './types.js';
import {
    emitDroppedPatternWarnings,
    getOpfsDir,
    getRoot,
    invalidateAllCachesForFolder,
    normalizePatternList,
    registerFolderConfig,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import {
    parseRangeHeader,
    build206ResponseFromStream,
    createRangeExtractTransform,
} from './opfsRangeUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
import { addUrlServedFromNetwork } from './opfsPerTabNetworkUrls.js';
import { isOpfsAvailable, isEvictable, shouldProcessFile } from './opfsUtil.js';
import { isInSkipList } from './opfsLru.js';
import {
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_RANGE_CACHE_FETCH_STARTED,
    OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE,
} from './opfsMessages.js';
import { OPFS_RANGE_LOG_SW } from './opfsLog.js';

/** URL, по которым уже идёт фоновая полная загрузка в OPFS. */
const loadingUrls = new Set<string>();
/** Число активных фоновых загрузок в кеш (для оповещения клиента STARTED/ALL_DONE). */
let activeRangeCacheFetchCount = 0;

export interface OpfsRangeFromNetworkAndCacheOptions {
    /**
     * Имя папки в OPFS для этого кеша (обязательно). Должно совпадать с folderName в opfsServeRange/opfsBackgroundFetch, если они обслуживают тот же кеш.
     */
    folderName: FolderName;
    /**
     * Порядок: должен быть после opfsServeRange (например -10).
     */
    order?: number;
    /**
     * Маски URL для кеширования (glob/pathname). Обязательно, непустой массив.
     */
    include: string[];
    /**
     * Маски URL для исключения.
     */
    exclude?: string[];
    /**
     * Включить логирование.
     */
    enableLogging?: boolean;
    /**
     * Логгер для этапа инициализации (например, варнинги по отброшенным паттернам include/exclude/pinned).
     * По умолчанию используется console.
     */
    logger?: Logger;
    /**
     * Glob-паттерны URL, которые нельзя эвиктить (pinned). По умолчанию все ресурсы эвиктабельны.
     */
    pinned?: string[];
    /**
     * Доля квоты origin (0…1) для этой папки. При совместном использовании папки должно совпадать с другими плагинами.
     */
    maxCacheFraction?: number;
}

/**
 * Запускает фоновую полную загрузку URL в OPFS. При завершении (успех или ошибка) удаляет url из loadingUrls.
 */
async function backgroundFullFetchToOpfs(
    url: string,
    folderName: FolderName,
    logger: Logger,
    enableLogging: boolean,
    fetchPassthrough: (request: Request) => Promise<Response>,
    pinned?: string[]
): Promise<void> {
    try {
        if (isInSkipList(url)) {
            if (enableLogging) {
                logger.debug(
                    `${OPFS_RANGE_LOG_SW}skip ${url} (in skip list, quota exceeded)`
                );
            }
            return;
        }
        const fullRequest = new Request(url, { method: 'GET' });
        const response = await fetchPassthrough(fullRequest);
        if (!response.ok || !response.body) {
            if (enableLogging) {
                logger.debug(
                    `${OPFS_RANGE_LOG_SW}background full GET ${url} -> ${response.status}, skip cache`
                );
            }
            return;
        }
        if (response.status !== 200) {
            if (enableLogging) {
                logger.debug(
                    `${OPFS_RANGE_LOG_SW}background full GET ${url} -> ${response.status}, skip cache`
                );
            }
            return;
        }
        const baseMetadata = metadataFromResponse(response, url);
        const evictable = isEvictable(url, pinned);
        const metadata = { ...baseMetadata, evictable };
        const key = await urlToOpfsKey(url);
        const root = await getRoot();
        const dir = await getOpfsDir(root, true, folderName);
        await writeToOpfs(dir, key, response.body, metadata, {
            folderName,
            url,
            ...(metadata.size > 0 && { knownSize: metadata.size }),
        });
        if (enableLogging) {
            logger.debug(
                `${OPFS_RANGE_LOG_SW}background cached ${url} -> ${key} (${metadata.size} bytes)`
            );
        }
    } catch (err) {
        logger.error(
            `${OPFS_RANGE_LOG_SW}background full GET failed ${url}`,
            err
        );
    } finally {
        loadingUrls.delete(url);
        activeRangeCacheFetchCount -= 1;
        if (activeRangeCacheFetchCount === 0) {
            notifyClients(OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE, {});
        }
    }
}

export function opfsRangeFromNetworkAndCache(
    options: OpfsRangeFromNetworkAndCacheOptions
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const baseOrigin = typeof self !== 'undefined' ? self.origin : '';
    const {
        folderName,
        order = -10,
        include,
        exclude,
        enableLogging = false,
        pinned,
        maxCacheFraction,
        logger = console,
    } = options;
    if (include == null || !Array.isArray(include) || include.length === 0) {
        throw new Error('opfs: include is required and must be a non-empty array');
    }
    const nInc = normalizePatternList(include, baseOrigin);
    const nExc = normalizePatternList(exclude, baseOrigin);
    const nPin = normalizePatternList(pinned, baseOrigin);
    const normalizedInclude = nInc.list;
    const normalizedExclude = nExc.list;
    const normalizedPinned = nPin.list;
    if (normalizedInclude == null || normalizedInclude.length === 0) {
        return undefined;
    }
    const droppedForLogger = {
        crossOrigin: [...nInc.dropped.crossOrigin, ...nExc.dropped.crossOrigin, ...nPin.dropped.crossOrigin],
        invalid: [...nInc.dropped.invalid, ...nExc.dropped.invalid, ...nPin.dropped.invalid],
    };
    emitDroppedPatternWarnings(droppedForLogger, logger);

    registerFolderConfig(folderName, {
        ...(maxCacheFraction !== undefined && { maxCacheFraction }),
    });

    return {
        name: 'opfs-range-from-network-and-cache',
        order,

        async fetch(
            event: FetchEvent,
            context: PluginContext
        ): Promise<Response | undefined> {
            const logger = context.logger ?? console;
            const request = event.request;
            if (request.method !== 'GET') {
                return;
            }

            if (!shouldProcessFile(request.url, normalizedInclude, normalizedExclude)) {
                return;
            }

            const url = request.url;
            const pathname = new URL(url).pathname;
            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                // Полный GET: fetch, при 200 кешируем (tee) и отдаём ответ.
                try {
                    const response = await context.fetchPassthrough(request);
                    addUrlServedFromNetwork(event.clientId ?? '', pathname);
                    if (!response.ok || !response.body) {
                        return response;
                    }
                    if (response.status !== 200) {
                        return response;
                    }
                    if (isInSkipList(url)) {
                        notifyClients(OPFS_MSG_SKIP_QUOTA_EXCEEDED, { url });
                        return new Response(response.body, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    }
                    const baseMetadata = metadataFromResponse(response, url);
                    const evictable = isEvictable(url, normalizedPinned);
                    const metadata = { ...baseMetadata, evictable };
                    const key = await urlToOpfsKey(url);
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, true, folderName);
                    const [branch1, branch2] = response.body.tee();
                    writeToOpfs(dir, key, branch2, metadata, {
                        folderName,
                        url,
                        ...(metadata.size > 0 && { knownSize: metadata.size }),
                    }).catch((err) => {
                        logger.error(
                            `${OPFS_RANGE_LOG_SW}write failed ${url}`,
                            err
                        );
                    });
                    if (enableLogging) {
                        logger.debug(
                            `${OPFS_RANGE_LOG_SW}caching full GET ${url} (${metadata.size} bytes)`
                        );
                    }
                    return new Response(branch1, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                } catch {
                    return;
                }
            }

            // Запрос с Range: при enableLogging проверяем, есть ли файл в OPFS (для предупреждения); затем fetch.
            try {
                if (enableLogging) {
                    try {
                        const key = await urlToOpfsKey(url);
                        const root = await getRoot();
                        const dir = await getOpfsDir(root, false, folderName);
                        await dir.getFileHandle(key);
                        logger.warn(
                            `${OPFS_RANGE_LOG_SW}file exists in OPFS for ${url} but request was not served from cache; fetching from network (possible: If-Range mismatch, invalid range, or opfsServeRange order)`
                        );
                    } catch (err) {
                        if (err instanceof Error && err.name === 'NotFoundError') {
                            invalidateAllCachesForFolder(folderName);
                        }
                        // Файла нет в OPFS — нормально, идём в сеть.
                    }
                }

                const response = await context.fetchPassthrough(request);
                addUrlServedFromNetwork(event.clientId ?? '', pathname);
                if (!response.body) {
                    return response;
                }

                if (response.status === 206) {
                    if (!loadingUrls.has(url)) {
                        loadingUrls.add(url);
                        activeRangeCacheFetchCount += 1;
                        notifyClients(OPFS_MSG_RANGE_CACHE_FETCH_STARTED, { url });
                        backgroundFullFetchToOpfs(url, folderName, logger, enableLogging, context.fetchPassthrough, normalizedPinned);
                    }
                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    });
                }

                if (response.status === 416) {
                    return response;
                }

                if (response.status === 200) {
                    const contentLength = response.headers.get('Content-Length');
                    const fullSize = contentLength
                        ? parseInt(contentLength, 10)
                        : 0;
                    const type =
                        response.headers.get('Content-Type') ??
                        'application/octet-stream';
                    const etag = response.headers.get('ETag') ?? undefined;
                    const lastModified =
                        response.headers.get('Last-Modified') ?? undefined;

                    if (
                        fullSize > 0 &&
                        Number.isInteger(fullSize)
                    ) {
                        const range = parseRangeHeader(rangeHeader, fullSize);
                        const baseMetadata = metadataFromResponse(response, url);
                        const evictable = isEvictable(url, normalizedPinned);
                        const metadata = { ...baseMetadata, evictable };
                        const key = await urlToOpfsKey(url);
                        const root = await getRoot();
                        const dir = await getOpfsDir(root, true, folderName);
                        const [branch1, branch2] = response.body.tee();
                        writeToOpfs(dir, key, branch2, metadata, {
                            folderName,
                            url,
                            knownSize: fullSize,
                        }).catch((err) => {
                                logger.error(
                                    `opfsRangeFromNetworkAndCache: write failed ${url}`,
                                    err
                                );
                            });
                        const rangeStream = branch1.pipeThrough(
                            createRangeExtractTransform(range)
                        );
                        return build206ResponseFromStream(
                            rangeStream,
                            range,
                            fullSize,
                            {
                                type,
                                ...(etag && { etag }),
                                ...(lastModified && { lastModified }),
                            }
                        );
                    }

                    // 200 без валидного Content-Length: не буферизуем (риск OOM), пробрасываем ответ клиенту
                    return response;
                }

                return response;
            } catch (err) {
                logger.error(
                    `${OPFS_RANGE_LOG_SW}fetch failed`,
                    url,
                    err
                );
                return;
            }
        },
    };
}
