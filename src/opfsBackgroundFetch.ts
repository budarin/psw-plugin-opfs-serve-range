/**
 * Плагин для @budarin/pluggable-serviceworker: при успешном завершении Background Fetch
 * записывает ответы в OPFS (range cache). Дальнейшие range-запросы к этим URL обслуживает opfsServeRange.
 */

import type { Plugin } from '@budarin/pluggable-serviceworker';
import { getOpfsDir, urlToOpfsKey } from './index.js';
import { isOpfsAvailable, shouldProcessFile } from './opfsUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';

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
    const { order = 0, include, exclude, enableLogging = false } = options;

    return {
        name: 'opfs-background-fetch',
        order,

        async backgroundfetchsuccess(event, logger): Promise<void> {
            const root = await navigator.storage.getDirectory();
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
                    const metadata = metadataFromResponse(response);
                    await writeToOpfs(dir, key, response.body, metadata);
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
