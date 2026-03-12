/**
 * Плагин для @budarin/pluggable-serviceworker: при успешном завершении Background Fetch
 * записывает ответы в OPFS (range cache). Дальнейшие range-запросы к этим URL обслуживает opfsServeRange.
 */

import type { Logger, Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { notifyClients } from '@budarin/pluggable-serviceworker/utils';
import type { FolderName } from './types.js';
import {
    emitDroppedPatternWarnings,
    getOpfsDir,
    getRoot,
    normalizePatternList,
    registerFolderConfig,
} from './opfsUtil.js';
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
     * Маски URL (glob/pathname). Обязательно, непустой массив. После нормализации может быть пустым — клиенту уйдёт пустой список.
     */
    include: string[];
    /**
     * Маски URL для исключения.
     */
    exclude?: string[];
    /**
     * Логгер для этапа инициализации (например, варнинги по отброшенным паттернам include/exclude).
     * По умолчанию используется console.
     */
    logger?: Logger;
}

/**
 * Плагин только для обработки message: на OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER
 * отвечает include/exclude. Независимый — для кастомного SW можно регистрировать один этот плагин.
 * Клиентскому getBackgroundFetchFilter() соответствует именно этот плагин (или вызов его из opfsBackgroundFetch).
 */
export function opfsBackgroundFetchFilter(options: OpfsBackgroundFetchFilterOptions): Plugin | undefined {
    if (options.include == null || !Array.isArray(options.include) || options.include.length === 0) {
        throw new Error('opfs: include is required and must be a non-empty array');
    }
    const { logger = console } = options;
    const baseOrigin = typeof self !== 'undefined' ? self.origin : '';
    const inc = normalizePatternList(options.include, baseOrigin);
    const exc = normalizePatternList(options.exclude, baseOrigin);
    const include = inc.list ?? [];
    const exclude = exc.list ?? [];
    const droppedForLogger = {
        crossOrigin: [...inc.dropped.crossOrigin, ...exc.dropped.crossOrigin],
        invalid: [...inc.dropped.invalid, ...exc.dropped.invalid],
    };
    emitDroppedPatternWarnings(droppedForLogger, logger);
    return {
        name: 'opfs-background-fetch-filter',
        order: 0,

        message(event): void {
            const data = event.data as { type?: string; requestId?: string } | null;
            if (
                data?.type !== OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER ||
                data.requestId == null
            ) {
                return;
            }
            const source = event.source;
            if (source == null) {
                return;
            }
            if (typeof (source as Client).postMessage === 'function') {
                (source as Client).postMessage({
                    type: OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
                    requestId: data.requestId,
                    include,
                    exclude,
                });
            }
        },
    };
}

export interface OpfsBackgroundFetchOptions {
    /**
     * Имя папки в OPFS для этого кеша (обязательно). Должно совпадать с folderName в opfsServeRange/opfsRangeFromNetworkAndCache, если они обслуживают тот же кеш.
     */
    folderName: FolderName;
    /**
     * Порядок выполнения (по умолчанию 0).
     */
    order?: number;
    /**
     * Маски URL для записи в range cache (glob/pathname). Обязательно, непустой массив.
     */
    include: string[];
    /**
     * Маски URL для исключения из записи.
     */
    exclude?: string[];
    /**
     * Включить логирование (fail/abort/click и отладочные сообщения success).
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
 * Плагин: обрабатывает все события Background Fetch в рамках одного процесса (загрузка в range cache).
 * - backgroundfetchsuccess: по каждому запросу, проходящему include/exclude, пишет ответ в OPFS.
 * - backgroundfetchfail / backgroundfetchabort / backgroundfetchclick: при enableLogging логирует.
 * Требуется Content-Length в ответе для записи. Без include/exclude в success пишет все ответы.
 */
export function opfsBackgroundFetch(
    options: OpfsBackgroundFetchOptions
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const baseOrigin = typeof self !== 'undefined' ? self.origin : '';
    const { folderName, order = 0, include, exclude, enableLogging = false, pinned, maxCacheFraction, logger = console } = options;
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

    const filterPlugin = opfsBackgroundFetchFilter({
        include: normalizedInclude,
        ...(normalizedExclude !== undefined && { exclude: normalizedExclude }),
        logger,
    });

    return {
        name: 'opfs-background-fetch',
        order,

        message(event, context): void {
            filterPlugin?.message?.(event, context);
        },

        async backgroundfetchsuccess(event, context: PluginContext): Promise<void> {
            if (!event.registration.id.startsWith(OPFS_BACKGROUND_FETCH_ID_PREFIX)) {
                return;
            }
            const logger = context.logger ?? console;
            const root = await getRoot();
            const dir = await getOpfsDir(root, true, folderName);
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
                if (!shouldProcessFile(url, normalizedInclude, normalizedExclude)) {
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
                    const evictable = isEvictable(url, normalizedPinned);
                    const metadata = { ...baseMetadata, evictable };
                    await writeToOpfs(dir, key, response.body, metadata, {
                        folderName,
                        url,
                        excludeKeyFromEviction: key,
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
                    logger.error(
                        `opfsBackgroundFetch: write failed ${record.request.url}`,
                        err
                    );
                }
            }
            const assets = records.map((record: { request: Request }) => toPathname(record));
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, {
                registrationId: event.registration.id,
                assets,
                written: writtenPathnames,
                failedOrSkipped: failedOrSkippedPathnames,
            });
            if (typeof event.updateUI === 'function') {
                await event.updateUI({
                    title: 'Загрузка завершена',
                });
            }
        },

        async backgroundfetchfail(event, context: PluginContext): Promise<void> {
            const logger = context.logger;
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_FAILED, {
                registrationId: event.registration.id,
            });
            logger.warn(
                `opfsBackgroundFetch: background fetch failed, id=${event.registration.id}`
            );
            if (typeof event.updateUI === 'function') {
                await event.updateUI({
                    title: 'Ошибка при загрузке',
                });
            }
        },

        async backgroundfetchabort(event, context: PluginContext): Promise<void> {
            const logger = context.logger;
            notifyClients(OPFS_MSG_BACKGROUND_FETCH_ABORTED, {
                registrationId: event.registration.id,
            });
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: background fetch aborted, id=${event.registration.id}`
                );
            }
            if (typeof event.updateUI === 'function') {
                await event.updateUI({
                    title: 'Загрузка отменена',
                });
            }
        },

        async backgroundfetchclick(event, context: PluginContext): Promise<void> {
            const logger = context.logger;
            if (enableLogging) {
                logger.debug(
                    `opfsBackgroundFetch: user clicked download UI, id=${event.registration.id}`
                );
            }
            const windowClients = await self.clients.matchAll({ type: 'window' });
            const targetClient = windowClients[0] as WindowClient | undefined;
            if (targetClient) {
                await targetClient.focus();
                return;
            }
            try {
                await self.clients.openWindow('/');
            } catch (err) {
                logger.error(
                    'opfsBackgroundFetch: failed to open window on backgroundfetchclick',
                    err
                );
            }
        },
    };
}
