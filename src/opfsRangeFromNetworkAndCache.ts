/**
 * Плагин: range-запросы из сети и кеширование в OPFS. При запросах, не обслуженных из OPFS,
 * идёт в сеть, отдаёт ответ клиенту сразу; при range-запросе и ответе 206 запускает
 * фоновую полную загрузку в OPFS (без дублей по URL). В кеш пишет только полные ответы (200).
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';
import { notifyClients } from '@budarin/pluggable-serviceworker/utils';
import { HEADER_RANGE } from '@budarin/http-constants/headers';
import { getOpfsDir, urlToOpfsKey } from './index.js';
import {
    parseRangeHeader,
    build206Response,
    build206ResponseFromStream,
    createRangeExtractTransform,
} from './opfsRangeUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
import { isOpfsAvailable, shouldProcessFile } from './opfsUtil.js';
import { isBlacklisted } from './opfsLru.js';
import { OPFS_MSG_SKIP_QUOTA_EXCEEDED } from './opfsMessages.js';

/** URL, по которым уже идёт фоновая полная загрузка в OPFS. */
const loadingUrls = new Set<string>();

export interface OpfsRangeFromNetworkAndCacheOptions {
    /**
     * Порядок: должен быть после opfsServeRange (например -10).
     */
    order?: number;
    /**
     * Маски URL для кеширования (glob по pathname).
     */
    include?: string[];
    /**
     * Маски URL для исключения.
     */
    exclude?: string[];
    /**
     * Включить логирование.
     */
    enableLogging?: boolean;
}

/**
 * Запускает фоновую полную загрузку URL в OPFS. При завершении (успех или ошибка) удаляет url из loadingUrls.
 */
async function backgroundFullFetchToOpfs(
    url: string,
    logger: Logger,
    enableLogging: boolean
): Promise<void> {
    try {
        if (isBlacklisted(url)) {
            if (enableLogging) {
                logger.debug(
                    `opfsRangeFromNetworkAndCache: skip ${url} (blacklisted, quota exceeded)`
                );
            }
            return;
        }
        const fullRequest = new Request(url, { method: 'GET' });
        const response = await fetch(fullRequest);
        if (!response.ok || !response.body) {
            if (enableLogging) {
                logger.debug(
                    `opfsRangeFromNetworkAndCache: background full GET ${url} -> ${response.status}, skip cache`
                );
            }
            return;
        }
        if (response.status !== 200) {
            if (enableLogging) {
                logger.debug(
                    `opfsRangeFromNetworkAndCache: background full GET ${url} -> ${response.status}, skip cache`
                );
            }
            return;
        }
        const metadata = metadataFromResponse(response);
        const key = await urlToOpfsKey(url);
        const root = await navigator.storage.getDirectory();
        const dir = await getOpfsDir(root, true);
        await writeToOpfs(dir, key, response.body, metadata, {
            url,
            ...(metadata.size > 0 && { knownSize: metadata.size }),
        });
        if (enableLogging) {
            logger.debug(
                `opfsRangeFromNetworkAndCache: background cached ${url} -> ${key} (${metadata.size} bytes)`
            );
        }
    } catch (err) {
        if (enableLogging) {
            logger.error(
                `opfsRangeFromNetworkAndCache: background full GET failed ${url}`,
                err
            );
        }
    } finally {
        loadingUrls.delete(url);
    }
}

export function opfsRangeFromNetworkAndCache(
    options: OpfsRangeFromNetworkAndCacheOptions = {}
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const {
        order = -10,
        include,
        exclude,
        enableLogging = false,
    } = options;

    return {
        name: 'opfs-range-from-network-and-cache',
        order,

        async fetch(
            event: FetchEvent,
            logger: Logger
        ): Promise<Response | undefined> {
            const request = event.request;
            if (request.method !== 'GET') {
                return;
            }

            if (!shouldProcessFile(request.url, include, exclude)) {
                return;
            }

            const url = request.url;
            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                // Полный GET: fetch, при 200 кешируем (tee) и отдаём ответ.
                try {
                    const response = await fetch(request);
                    if (!response.ok || !response.body) {
                        return response;
                    }
                    if (response.status !== 200) {
                        return response;
                    }
                    if (isBlacklisted(url)) {
                        notifyClients(OPFS_MSG_SKIP_QUOTA_EXCEEDED, { url });
                        return new Response(response.body, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    }
                    const metadata = metadataFromResponse(response);
                    const key = await urlToOpfsKey(url);
                    const root = await navigator.storage.getDirectory();
                    const dir = await getOpfsDir(root, true);
                    const [branch1, branch2] = response.body.tee();
                    writeToOpfs(dir, key, branch2, metadata, {
                        url,
                        ...(metadata.size > 0 && { knownSize: metadata.size }),
                    }).catch((err) => {
                        if (enableLogging) {
                            logger.error(
                                `opfsRangeFromNetworkAndCache: write failed ${url}`,
                                err
                            );
                        }
                    });
                    if (enableLogging) {
                        logger.debug(
                            `opfsRangeFromNetworkAndCache: caching full GET ${url} (${metadata.size} bytes)`
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

            // Запрос с Range: если файл уже в OPFS — warn; затем fetch и отдаём ответ.
            try {
                const key = await urlToOpfsKey(url);
                const root = await navigator.storage.getDirectory();
                try {
                    const dir = await getOpfsDir(root, false);
                    await dir.getFileHandle(key);
                    logger.warn(
                        `opfsRangeFromNetworkAndCache: file exists in OPFS for ${url} but request was not served from cache; fetching from network (possible: If-Range mismatch, invalid range, or opfsServeRange order)`
                    );
                } catch {
                    // Файла нет в OPFS — нормально, идём в сеть.
                }

                const response = await fetch(request);
                if (!response.body) {
                    return response;
                }

                if (response.status === 206) {
                    if (!loadingUrls.has(url)) {
                        loadingUrls.add(url);
                        backgroundFullFetchToOpfs(url, logger, enableLogging);
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
                        const metadata = metadataFromResponse(response);
                        const key = await urlToOpfsKey(url);
                        const root = await navigator.storage.getDirectory();
                        const dir = await getOpfsDir(root, true);
                        const [branch1, branch2] = response.body.tee();
                        writeToOpfs(dir, key, branch2, metadata, {
                            url,
                            knownSize: fullSize,
                        }).catch((err) => {
                                if (enableLogging) {
                                    logger.error(
                                        `opfsRangeFromNetworkAndCache: write failed ${url}`,
                                        err
                                    );
                                }
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

                    const blob = await response.blob();
                    const size = blob.size;
                    const range = parseRangeHeader(rangeHeader, size);
                    const rangeBlob = blob.slice(range.start, range.end + 1);
                    return build206Response(rangeBlob, range, size, {
                        type,
                        ...(etag && { etag }),
                        ...(lastModified && { lastModified }),
                    });
                }

                return response;
            } catch {
                return;
            }
        },
    };
}
