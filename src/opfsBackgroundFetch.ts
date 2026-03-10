/**
 * Плагин для @budarin/pluggable-serviceworker: при успешном завершении Background Fetch
 * записывает ответы в OPFS (range cache). Дальнейшие range-запросы к этим URL обслуживает opfsServeRange.
 */

import type { Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { notifyClients } from '@budarin/pluggable-serviceworker/utils';
import { getOpfsDir, getRoot } from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import { isOpfsAvailable, isEvictable, shouldProcessFile } from './opfsUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
import { isInSkipList } from './opfsLru.js';
import {
    OPFS_BACKGROUND_FETCH_ID_PREFIX,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
    OPFS_MSG_BACKGROUND_FETCH_COMPLETED,
    OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
} from './opfsMessages.js';

export interface OpfsBackgroundFetchFilterOptions {
    /**
     * Маски URL (glob по pathname), передаются клиенту по запросу getBackgroundFetchFilter().
     */
    include?: string[];
    /**
     * Маски URL для исключения.
     */
    exclude?: string[];
}

/**
 * Плагин только для обработки message: на OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER
 * отвечает include/exclude. Независимый — для кастомного SW можно регистрировать один этот плагин.
 * Клиентскому getBackgroundFetchFilter() соответствует именно этот плагин (или вызов его из opfsBackgroundFetch).
 */
export function opfsBackgroundFetchFilter(
    options: OpfsBackgroundFetchFilterOptions = {}
): Plugin {
    const { include, exclude } = options;
    return {
        name: 'opfs-background-fetch-filter',
        order: 0,

        message(event, _context): void {
            const data = event.data as { type?: string; requestId?: string } | null;
            if (
                data?.type !== OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER ||
                data.requestId == null
            ) {
                return;
            }
            const source = event.source;
            if (source == null || typeof (source as Client).postMessage !== 'function') {
                return;
            }
            (source as Client).postMessage({
                type: OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
                requestId: data.requestId,
                include,
                exclude,
            });
        },
    };
}

export interface OpfsBackgroundFetchOptions {
    /**
     * Порядок выполнения (по умолчанию 0).
     */
    order?: number;
    /**
     * Маски URL для записи в range cache (glob по pathname). Если задано — пишем только совпадения.
     */
    include?: string[];
    /**
     * Маски URL для исключения из записи.
     */
    exclude?: string[];
    /**
     * Включить логирование (fail/abort/click и отладочные сообщения success).
     */
    enableLogging?: boolean;
    /**
     * Glob-паттерны URL, которые нельзя эвиктить (pinned). По умолчанию все ресурсы эвиктабельны.
     */
    pinned?: string[];
}

/**
 * Плагин: обрабатывает все события Background Fetch в рамках одного процесса (загрузка в range cache).
 * - backgroundfetchsuccess: по каждому запросу, проходящему include/exclude, пишет ответ в OPFS.
 * - backgroundfetchfail / backgroundfetchabort / backgroundfetchclick: при enableLogging логирует.
 * Требуется Content-Length в ответе для записи. Без include/exclude в success пишет все ответы.
 */
export function opfsBackgroundFetch(
    options: OpfsBackgroundFetchOptions = {}
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const { order = 0, include, exclude, enableLogging = false, pinned } = options;
    const filterPlugin = opfsBackgroundFetchFilter({
        ...(include !== undefined && { include }),
        ...(exclude !== undefined && { exclude }),
    });

    return {
        name: 'opfs-background-fetch',
        order,

        message(event, context): void {
            filterPlugin.message?.(event, context);
        },

        async backgroundfetchsuccess(event, context: PluginContext): Promise<void> {
            if (!event.registration.id.startsWith(OPFS_BACKGROUND_FETCH_ID_PREFIX)) {
                return;
            }
            const logger = context.logger ?? console;
            const root = await getRoot();
            const dir = await getOpfsDir(root, true);
            const records = await event.registration.matchAll();
            const totalCount = records.length;
            const writtenPathnames: string[] = [];
            const failedOrSkippedPathnames: string[] = [];

            const toPathname = (record: { request: Request }): string => {
                try {
                    return new URL(record.request.url).pathname;
                } catch {
                    return record.request.url;
                }
            };

            for (const record of records) {
                const url = record.request.url;
                const pathname = toPathname(record);
                if (!shouldProcessFile(url, include, exclude)) {
                    failedOrSkippedPathnames.push(pathname);
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: skip ${url} (filtered by include/exclude)`
                        );
                    }
                    continue;
                }
                if (isInSkipList(url)) {
                    failedOrSkippedPathnames.push(pathname);
                    notifyClients(OPFS_MSG_SKIP_QUOTA_EXCEEDED, { url });
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: skip ${url} (in skip list, quota exceeded)`
                        );
                    }
                    continue;
                }
                const response = await record.responseReady;
                if (!response.ok || !response.body) {
                    failedOrSkippedPathnames.push(pathname);
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: skip ${url} (not ok or no body)`
                        );
                    }
                    continue;
                }
                try {
                    const key = await urlToOpfsKey(url);
                    const baseMetadata = metadataFromResponse(response, url);
                    const evictable = isEvictable(url, pinned);
                    const metadata = { ...baseMetadata, evictable };
                    await writeToOpfs(dir, key, response.body, metadata, {
                        url,
                        ...(metadata.size > 0 && { knownSize: metadata.size }),
                    });
                    writtenPathnames.push(pathname);
                    notifyClients(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, {
                        registrationId: event.registration.id,
                        asset: pathname,
                        loadedAssets: [...writtenPathnames],
                        totalCount,
                    });
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: cached ${url} -> ${key} (${metadata.size} bytes)`
                        );
                    }
                } catch (err) {
                    failedOrSkippedPathnames.push(pathname);
                    if (enableLogging) {
                        logger.error(
                            `opfsBackgroundFetch: write failed ${record.request.url}`,
                            err
                        );
                    }
                }
            }
            const assets = records.map((record: { request: Request }) => toPathname(record));
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, {
                registrationId: event.registration.id,
                assets,
                written: writtenPathnames,
                failedOrSkipped: failedOrSkippedPathnames,
            });
        },

        async backgroundfetchfail(event, context: PluginContext): Promise<void> {
            const logger = context.logger ?? console;
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_FAILED, {
                registrationId: event.registration.id,
            });
            if (enableLogging) {
                logger.warn(
                    `opfsBackgroundFetch: background fetch failed, id=${event.registration.id}`
                );
            }
        },

        async backgroundfetchabort(event, context: PluginContext): Promise<void> {
            const logger = context.logger ?? console;
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_ABORTED, {
                registrationId: event.registration.id,
            });
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: background fetch aborted, id=${event.registration.id}`
                );
            }
        },

        async backgroundfetchclick(event, context: PluginContext): Promise<void> {
            const logger = context.logger ?? console;
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: user clicked download UI, id=${event.registration.id}`
                );
            }
        },
    };
}
