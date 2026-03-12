/**
 * Плагин: перехватывает GET с Range и отдаёт диапазон из OPFS.
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Папка задаётся опцией folderName.
 */

import type { Logger, Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { HEADER_RANGE } from '@budarin/http-constants/headers';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import type { FolderName } from './types.js';
import { readMetadataFromFileFooter as readFooter } from './opfsFormat.js';
import {
    emitDroppedPatternWarnings,
    getOpfsDir,
    getRangeCacheMaxEntries,
    getRangeCacheMaxSizeBytes,
    getRoot,
    invalidateAllCachesForFolder,
    isOpfsAvailable,
    normalizePatternList,
    registerFolderConfig,
    shouldProcessFile,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import { getOrCreateRangeCache, getRangeCache } from './opfsRangeCache.js';
import {
    getOrCreateMetadataCache,
    type OpfsMetadataCacheEntry,
} from './opfsMetadataCache.js';
import {
    parseRangeHeader,
    build206Response,
    build206ResponseFromStream,
    createFileRangeStream,
} from './opfsRangeUtil.js';
import { updateEvictionIndexLastAccessed } from './opfsEvictionIndex.js';
import {
    addUrlServedFromNetwork,
    isUrlServedFromNetworkForClient,
} from './opfsPerTabNetworkUrls.js';
import { OPFS_RANGE_LOG_SW } from './opfsLog.js';

const HEADER_IF_RANGE = 'If-Range';

export interface OpfsServeRangeOptions {
    /**
     * Имя папки в OPFS для этого кеша (обязательно). Одна папка — один набор настроек; при повторной регистрации того же имени конфиг должен совпадать.
     */
    folderName: FolderName;
    /**
     * Порядок выполнения плагина (по умолчанию -15).
     */
    order?: number;
    /**
     * Включить логирование (по умолчанию false).
     */
    enableLogging?: boolean;
    /**
     * Логгер для этапа инициализации (например, варнинги по отброшенным паттернам include/exclude).
     * По умолчанию используется console.
     */
    logger?: Logger;
    /**
     * Маски URL для обработки (glob/pathname). Обязательно, непустой массив.
     */
    include: string[];
    /**
     * Маски URL для исключения (glob по pathname).
     */
    exclude?: string[];
    /**
     * Cache-Control для ответов 206 (по умолчанию пустая строка — не кэшировать диапазоны в HTTP-кеше браузера).
     */
    rangeResponseCacheControl?: string;
    /**
     * In-memory кеш 206-ответов: true или {} — лимиты из реестра папки; объект — переопределение maxSizeBytes/maxEntries.
     * При отсутствии или false кеш не используется.
     */
    rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
    /**
     * Доля квоты origin (0…1) для этой папки. При совместном использовании папки с другими плагинами должно совпадать.
     */
    maxCacheFraction?: number;
    /**
     * Макс. размер in-memory кеша диапазонов (байты) для этой папки.
     */
    rangeCacheMaxSizeBytes?: number;
    /**
     * Макс. число записей in-memory кеша диапазонов для этой папки.
     */
    rangeCacheMaxEntries?: number;
}

/** Опции для сборки аргумента opfsServeRange из фабрик (подмножество опций пары плагинов, без pinned). */
export interface ServeOptionsFromFactory {
    folderName: FolderName;
    include: string[];
    exclude?: string[];
    enableLogging?: boolean;
    maxCacheFraction?: number;
    logger?: Logger;
    order?: number;
    rangeResponseCacheControl?: string;
    rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}

function ifRangeMatches(
    ifRangeValue: string,
    meta: { etag?: string; lastModified?: string }
): boolean {
    const value = ifRangeValue.trim();
    if (!value) {
        return false;
    }
    if (meta.lastModified) {
        const ifRangeDate = Date.parse(value);
        if (!Number.isNaN(ifRangeDate)) {
            const storedDate = Date.parse(meta.lastModified);
            return !Number.isNaN(storedDate) && ifRangeDate === storedDate;
        }
    }
    if (meta.etag) {
        const normalizeEtag = (s: string) =>
            s
                .replace(/^\s*W\//i, '')
                .replace(/^"|"$/g, '')
                .trim();
        return normalizeEtag(value) === normalizeEtag(meta.etag);
    }
    return false;
}

/**
 * Плагин: перехватывает GET с Range и отдаёт диапазон из OPFS.
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Папка задаётся опцией folderName. Очистка — clearOpfsCache(folderName).
 */
export function opfsServeRange(options: OpfsServeRangeOptions): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const baseOrigin = typeof self !== 'undefined' ? self.origin : '';
    const {
        folderName,
        order = -15,
        enableLogging = false,
        include,
        exclude,
        logger = console,
        rangeResponseCacheControl = '',
        rangeCache,
        maxCacheFraction,
        rangeCacheMaxSizeBytes,
        rangeCacheMaxEntries,
    } = options;
    if (include == null || !Array.isArray(include) || include.length === 0) {
        throw new Error('opfs: include is required and must be a non-empty array');
    }
    const inc = normalizePatternList(include, baseOrigin);
    const exc = normalizePatternList(exclude, baseOrigin);
    const normalizedInclude = inc.list;
    const normalizedExclude = exc.list;
    if (normalizedInclude == null || normalizedInclude.length === 0) {
        return undefined;
    }
    const droppedForLogger: { crossOrigin: string[]; invalid: string[] } = {
        crossOrigin: [...(inc.dropped.crossOrigin ?? []), ...(exc.dropped.crossOrigin ?? [])],
        invalid: [...(inc.dropped.invalid ?? []), ...(exc.dropped.invalid ?? [])],
    };
    emitDroppedPatternWarnings(droppedForLogger, logger);

    registerFolderConfig(folderName, {
        ...(maxCacheFraction !== undefined && { maxCacheFraction }),
        ...(rangeCacheMaxSizeBytes !== undefined && { rangeCacheMaxSizeBytes }),
        ...(rangeCacheMaxEntries !== undefined && { rangeCacheMaxEntries }),
    });

    const useRangeCache =
        rangeCache === true ||
        (typeof rangeCache === 'object' && rangeCache !== null);
    const rangeCacheLimits: { maxSizeBytes: number; maxEntries: number } | null =
        useRangeCache
            ? {
                  maxSizeBytes:
                      typeof rangeCache === 'object' &&
                      rangeCache?.maxSizeBytes !== undefined
                          ? rangeCache.maxSizeBytes
                          : getRangeCacheMaxSizeBytes(folderName),
                  maxEntries:
                      typeof rangeCache === 'object' &&
                      rangeCache?.maxEntries !== undefined
                          ? rangeCache.maxEntries
                          : getRangeCacheMaxEntries(folderName),
              }
            : null;
    if (useRangeCache && rangeCacheLimits !== null) {
        getOrCreateRangeCache(folderName, rangeCacheLimits);
    }
    getOrCreateMetadataCache(folderName, {
        onEvictKey: (key) => getRangeCache(folderName)?.invalidateForKey(key),
    });

    return {
        name: 'opfs-serve-range',
        order,

        async fetch(
            event: FetchEvent,
            context: PluginContext
        ): Promise<Response | undefined> {
            const logger = context.logger ?? console;
            const request = event.request;
            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                return;
            }
            if (request.method !== 'GET') {
                return;
            }
            if (!shouldProcessFile(request.url, normalizedInclude, normalizedExclude)) {
                if (enableLogging) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}skip ${request.url} (filtered by include/exclude)`
                    );
                }
                return;
            }

            if (!event.clientId) {
                return;
            }

            const pathname = new URL(request.url).pathname;
            const url = request.url;
            let key: string;
            try {
                key = await urlToOpfsKey(url);
            } catch (err) {
                logger.error(`${OPFS_RANGE_LOG_SW}hash failed for ${url}`, err);
                return;
            }

            const root = await getRoot();
            let dir: FileSystemDirectoryHandle;
            try {
                dir = await getOpfsDir(root, false, folderName);
            } catch (err) {
                if (err instanceof Error && err.name === 'NotFoundError') {
                    invalidateAllCachesForFolder(folderName);
                }
                addUrlServedFromNetwork(event.clientId, pathname);
                if (enableLogging) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}no plugin dir in OPFS for ${url}`
                    );
                }
                return;
            }

            const metadataCache = getOrCreateMetadataCache(folderName);
            const rangeCache =
                useRangeCache && rangeCacheLimits !== null
                    ? getOrCreateRangeCache(folderName, rangeCacheLimits)
                    : null;
            let cachedMeta = metadataCache.get(key);
            let file: File | undefined;

            if (cachedMeta === undefined) {
                let fileHandle: FileSystemFileHandle;
                try {
                    fileHandle = await dir.getFileHandle(key);
                } catch {
                    addUrlServedFromNetwork(event.clientId, pathname);
                    if (enableLogging) {
                        logger.debug(`${OPFS_RANGE_LOG_SW}no file in OPFS for ${url}`);
                    }
                    return;
                }
                file = await fileHandle.getFile();
                const { metadata, bodySize } = await readFooter(file);
                const size = metadata?.size ?? bodySize;
                const meta: OpfsMetadataCacheEntry = {
                    fullSize: size,
                    type: metadata?.type ?? MIME_APPLICATION_OCTET_STREAM,
                    ...(metadata?.etag && { etag: metadata.etag }),
                    ...(metadata?.lastModified && {
                        lastModified: metadata.lastModified,
                    }),
                    ...(metadata?.evictable !== undefined && {
                        evictable: metadata.evictable,
                    }),
                };
                metadataCache.set(key, meta);
                cachedMeta = meta;
            }

            const meta = cachedMeta;
            const size = meta.fullSize;
            const type = meta.type;

            if (isUrlServedFromNetworkForClient(event.clientId, pathname)) {
                if (enableLogging) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}${pathname} already served from network for this client, passthrough (Chromium bug workaround)`
                    );
                }
                return;
            }

            const ifRangeHeader = request.headers.get(HEADER_IF_RANGE);
            if (
                ifRangeHeader &&
                !ifRangeMatches(ifRangeHeader, {
                    ...(meta.etag !== undefined && { etag: meta.etag }),
                    ...(meta.lastModified !== undefined && {
                        lastModified: meta.lastModified,
                    }),
                })
            ) {
                addUrlServedFromNetwork(event.clientId, pathname);
                if (enableLogging) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}If-Range mismatch for ${url}, passing through`
                    );
                }
                return;
            }

            try {
                const range = parseRangeHeader(rangeHeader, size);

                if (rangeCache !== null) {
                    const cached = rangeCache.get(key, range.start, range.end);
                    if (cached !== undefined) {
                        const metaForResponse = metadataCache.get(key);
                        if (metaForResponse !== undefined) {
                            const response = build206Response(
                                cached.blob,
                                range,
                                metaForResponse.fullSize,
                                {
                                    type:
                                        metaForResponse.type ??
                                        MIME_APPLICATION_OCTET_STREAM,
                                    ...(metaForResponse.etag && {
                                        etag: metaForResponse.etag,
                                    }),
                                    ...(metaForResponse.lastModified && {
                                        lastModified: metaForResponse.lastModified,
                                    }),
                                    ...(rangeResponseCacheControl && {
                                        cacheControl: rangeResponseCacheControl,
                                    }),
                                }
                            );
                            if (
                                metaForResponse.evictable !== false &&
                                event.waitUntil
                            ) {
                                event.waitUntil(
                                    updateEvictionIndexLastAccessed(
                                        dir,
                                        folderName,
                                        key,
                                        Date.now()
                                    )
                                );
                            }
                            if (enableLogging) {
                                logger.debug(
                                    `${OPFS_RANGE_LOG_SW}206 from rangeCache for ${url} bytes ${range.start}-${range.end}`
                                );
                            }
                            return response;
                        }
                        rangeCache.invalidateForKey(key);
                    }
                    if (file === undefined) {
                        const fileHandle = await dir.getFileHandle(key);
                        file = await fileHandle.getFile();
                    }
                    const blob = file.slice(range.start, range.end + 1);
                    rangeCache.set(key, range.start, range.end, blob);
                    const response = build206Response(
                        blob,
                        range,
                        size,
                        {
                            type,
                            ...(meta.etag && { etag: meta.etag }),
                            ...(meta.lastModified && {
                                lastModified: meta.lastModified,
                            }),
                            ...(rangeResponseCacheControl && {
                                cacheControl: rangeResponseCacheControl,
                            }),
                        }
                    );
                    if (
                        meta.evictable !== false &&
                        event.waitUntil
                    ) {
                        event.waitUntil(
                            updateEvictionIndexLastAccessed(
                                dir,
                                folderName,
                                key,
                                Date.now()
                            )
                        );
                    }
                    if (enableLogging) {
                        logger.debug(
                            `${OPFS_RANGE_LOG_SW}206 for ${url} bytes ${range.start}-${range.end} (cached)`
                        );
                    }
                    return response;
                }

                if (file === undefined) {
                    const fileHandle = await dir.getFileHandle(key);
                    file = await fileHandle.getFile();
                }
                const rangeStream = createFileRangeStream(file, range);
                const response = build206ResponseFromStream(
                    rangeStream,
                    range,
                    size,
                    {
                        type,
                        ...(meta.etag && { etag: meta.etag }),
                        ...(meta.lastModified && {
                            lastModified: meta.lastModified,
                        }),
                        ...(rangeResponseCacheControl && {
                            cacheControl: rangeResponseCacheControl,
                        }),
                    }
                );
                if (
                    meta.evictable !== false &&
                    event.waitUntil
                ) {
                    event.waitUntil(
                        updateEvictionIndexLastAccessed(dir, folderName, key, Date.now())
                    );
                }

                if (enableLogging) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}206 for ${url} bytes ${range.start}-${range.end}`
                    );
                }

                return response;
            } catch (err) {
                if (err instanceof Error && err.name === 'NotFoundError') {
                    invalidateAllCachesForFolder(folderName);
                }
                addUrlServedFromNetwork(event.clientId, pathname);
                logger.error(`${OPFS_RANGE_LOG_SW}error for ${url}`, err);
                return;
            }
        },
    };
}

/**
 * Собирает опции для opfsServeRange из опций фабрики (без pinned и прочих полей, относящихся только к другим плагинам).
 */
export function buildServeOptions(
    options: ServeOptionsFromFactory,
    defaultOrder: number
): OpfsServeRangeOptions {
    const order = options.order ?? defaultOrder;
    return {
        folderName: options.folderName,
        include: options.include,
        order,
        ...(options.exclude !== undefined && { exclude: options.exclude }),
        ...(options.enableLogging !== undefined && { enableLogging: options.enableLogging }),
        ...(options.maxCacheFraction !== undefined && { maxCacheFraction: options.maxCacheFraction }),
        ...(options.logger !== undefined && { logger: options.logger }),
        ...(options.rangeResponseCacheControl !== undefined && {
            rangeResponseCacheControl: options.rangeResponseCacheControl,
        }),
        ...(options.rangeCache !== undefined && { rangeCache: options.rangeCache }),
        ...(options.rangeCacheMaxSizeBytes !== undefined && {
            rangeCacheMaxSizeBytes: options.rangeCacheMaxSizeBytes,
        }),
        ...(options.rangeCacheMaxEntries !== undefined && {
            rangeCacheMaxEntries: options.rangeCacheMaxEntries,
        }),
    };
}
