/**
 * Плагин для @budarin/pluggable-serviceworker: при успешном завершении Background Fetch
 * записывает ответы в OPFS (range cache). Дальнейшие range-запросы к этим URL обслуживает opfsServeRange.
 */

import type { Plugin } from '@budarin/pluggable-serviceworker';
import { notifyClients } from '@budarin/pluggable-serviceworker/utils';
import { getOpfsDir, getRoot, urlToOpfsKey } from './index.js';
import { isOpfsAvailable, shouldProcessFile } from './opfsUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
import { isBlacklisted } from './opfsLru.js';
import { OPFS_MSG_SKIP_QUOTA_EXCEEDED } from './opfsMessages.js';

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

    return {
        name: 'opfs-background-fetch',
        order,

        async backgroundfetchsuccess(event, logger): Promise<void> {
            const root = await getRoot();
            const dir = await getOpfsDir(root, true);
            const records = await event.registration.matchAll();

            for (const record of records) {
                const url = record.request.url;
                if (!shouldProcessFile(url, include, exclude)) {
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: skip ${url} (filtered by include/exclude)`
                        );
                    }
                    continue;
                }
                if (isBlacklisted(url)) {
                    notifyClients(OPFS_MSG_SKIP_QUOTA_EXCEEDED, { url });
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: skip ${url} (blacklisted, quota exceeded)`
                        );
                    }
                    continue;
                }
                const response = await record.responseReady;
                if (!response.ok || !response.body) {
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
                    const evictable = pinned ? !shouldProcessFile(url, pinned) : true;
                    const metadata = { ...baseMetadata, evictable };
                    await writeToOpfs(dir, key, response.body, metadata, {
                        url,
                        ...(metadata.size > 0 && { knownSize: metadata.size }),
                    });
                    if (enableLogging) {
                        logger.debug(
                            `opfsBackgroundFetch: cached ${url} -> ${key} (${metadata.size} bytes)`
                        );
                    }
                } catch (err) {
                    if (enableLogging) {
                        logger.error(
                            `opfsBackgroundFetch: write failed ${record.request.url}`,
                            err
                        );
                    }
                }
            }
        },

        async backgroundfetchfail(event, logger): Promise<void> {
            if (enableLogging) {
                logger.warn(
                    `opfsBackgroundFetch: background fetch failed, id=${event.registration.id}`
                );
            }
        },

        async backgroundfetchabort(event, logger): Promise<void> {
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: background fetch aborted, id=${event.registration.id}`
                );
            }
        },

        async backgroundfetchclick(event, logger): Promise<void> {
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: user clicked download UI, id=${event.registration.id}`
                );
            }
        },
    };
}
