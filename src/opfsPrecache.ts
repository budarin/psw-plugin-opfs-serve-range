/**
 * Плагин предкеша в OPFS: при установке SW загружает список URL и записывает файлы в OPFS.
 * Использует общие утилиты и формат из этого пакета.
 */

import type { Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { getOpfsDir, getRoot } from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import { isOpfsAvailable, isEvictable } from './opfsUtil.js';
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
    /**
     * Glob-паттерны URL, которые нельзя эвиктить (pinned). По умолчанию все ресурсы эвиктабельны.
     */
    pinned?: string[];
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
    const { urls, order = 0, enableLogging = false, pinned } = options;

    return {
        name: 'opfs-precache',
        order,

        async install(_event: ExtendableEvent, context: PluginContext): Promise<void> {
            const logger = context.logger ?? console;
            const list =
                typeof urls === 'function' ? await urls() : urls;
            if (list.length === 0) {
                return;
            }

            const root = await getRoot();
            const dir = await getOpfsDir(root, true);

            for (const url of list) {
                try {
                    const response = await context.fetchPassthrough(new Request(url));
                    if (!response.ok || !response.body) {
                        if (enableLogging) {
                            logger.warn(
                                `opfsPrecache: skip ${url} (status ${response.status} or no body)`
                            );
                        }
                        continue;
                    }
                    const baseMetadata = metadataFromResponse(response, url);
                    const evictable = isEvictable(url, pinned);
                    const metadata = { ...baseMetadata, evictable };
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
