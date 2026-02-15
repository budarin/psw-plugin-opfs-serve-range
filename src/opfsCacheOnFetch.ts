/**
 * Плагин динамического кеширования в OPFS: при первом запросе по сети сохраняет ответ в OPFS.
 * Следующие запросы (с Range) будет обслуживать opfsServeRange.
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';
import { getOpfsDir, urlToOpfsKey } from './index.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
import { shouldProcessFile } from './opfsUtil.js';

export interface OpfsCacheOnFetchOptions {
    /**
     * Порядок: должен быть после opfsServeRange (например -10), чтобы при отсутствии в OPFS мы делали fetch и кеш.
     */
    order?: number;
    /**
     * Маски URL для кеширования (glob по pathname). Если задано — кешируем только совпадения.
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
 * Плагин: для запросов, не обслуженных из OPFS, выполняет fetch, сохраняет ответ в OPFS (tee потока)
 * и отдаёт ответ клиенту. При следующих запросах opfsServeRange отдаст из OPFS.
 */
export function opfsCacheOnFetch(
    options: OpfsCacheOnFetchOptions = {}
): Plugin {
    const {
        order = -10,
        include,
        exclude,
        enableLogging = false,
    } = options;

    return {
        name: 'opfs-cache-on-fetch',
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

            try {
                const response = await fetch(request);
                if (!response.ok || !response.body) {
                    return response;
                }

                const url = request.url;
                const metadata = metadataFromResponse(response);
                const key = await urlToOpfsKey(url);
                const root = await navigator.storage.getDirectory();
                const dir = await getOpfsDir(root, true);

                const [branch1, branch2] = response.body.tee();

                writeToOpfs(dir, key, branch2, metadata).catch((err) => {
                    if (enableLogging) {
                        logger.error(`opfsCacheOnFetch: write failed ${url}`, err);
                    }
                });

                if (enableLogging) {
                    logger.debug(
                        `opfsCacheOnFetch: caching ${url} -> ${key} (${metadata.size} bytes)`
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
        },
    };
}
