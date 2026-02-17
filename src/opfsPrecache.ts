/**
 * Плагин предкеша в OPFS: при установке SW загружает список URL и записывает файлы в OPFS.
 * Использует общие утилиты и формат из этого пакета.
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';
import { getOpfsDir, urlToOpfsKey } from './index.js';
import { isOpfsAvailable } from './opfsUtil.js';
import { writeToOpfs, metadataFromResponse } from './opfsWrite.js';

export interface OpfsPrecacheOptions {
    /**
     * Список URL для предкеша или функция, возвращающая его (например, из манифеста).
     */
    urls: string[] | (() => Promise<string[]>);
    /**
     * Порядок выполнения (по умолчанию 0 — выполняется при install).
     */
    order?: number;
    /**
     * Включить логирование.
     */
    enableLogging?: boolean;
}

/**
 * Плагин: при install запрашивает каждый URL из списка и записывает ответ в OPFS
 * (ключ = urlToOpfsKey(url), формат с футером). Не блокирует активацию SW — запись идёт в фоне.
 */
export function opfsPrecache(
    options: OpfsPrecacheOptions
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const { urls, order = 0, enableLogging = false } = options;

    return {
        name: 'opfs-precache',
        order,

        async install(_event: ExtendableEvent, logger: Logger): Promise<void> {
            const list =
                typeof urls === 'function' ? await urls() : urls;
            if (list.length === 0) {
                return;
            }

            const root = await navigator.storage.getDirectory();
            const dir = await getOpfsDir(root, true);

            for (const url of list) {
                try {
                    const response = await fetch(url);
                    if (!response.ok || !response.body) {
                        if (enableLogging) {
                            logger.warn(
                                `opfsPrecache: skip ${url} (status ${response.status} or no body)`
                            );
                        }
                        continue;
                    }
                    const metadata = metadataFromResponse(response, url);
                    const key = await urlToOpfsKey(url);
                    await writeToOpfs(dir, key, response.body, metadata, {
                        url,
                        ...(metadata.size > 0 && { knownSize: metadata.size }),
                    });

                    if (enableLogging) {
                        logger.debug(
                            `opfsPrecache: cached ${url} -> ${key} (${metadata.size} bytes)`
                        );
                    }
                } catch (err) {
                    if (enableLogging) {
                        logger.error(`opfsPrecache: failed ${url}`, err);
                    }
                }
            }
        },
    };
}
