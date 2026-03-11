/**
 * Плагин Service Worker: отдаёт HTTP Range-запросы из OPFS (Origin Private File System).
 * Ключ файла: key = hex(SHA-256(URL)). Один файл на ресурс: [тело][4 байта длина мета][JSON мета].
 * Очистка = удалить один файл, мусора нет.
 */

import type { Logger, Plugin, PluginContext } from '@budarin/pluggable-serviceworker';

import { HEADER_RANGE } from '@budarin/http-constants/headers';

import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import { readMetadataFromFileFooter as readFooter } from './opfsFormat.js';
import {
    emitDroppedPatternWarnings,
    getOpfsDir,
    getRangeCacheMaxEntries,
    getRangeCacheMaxSizeBytes,
    getRoot,
    isOpfsAvailable,
    normalizePatternList,
    registerFolderConfig,
    shouldProcessFile,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import {
    getOrCreateRangeCache,
    getRangeCache,
} from './opfsRangeCache.js';
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
import { opfsBackgroundFetch } from './opfsBackgroundFetch.js';
import { opfsRangeFromNetworkAndCache } from './opfsRangeFromNetworkAndCache.js';

export {
    OPFS_META_FOOTER_LENGTH,
    OPFS_FOLDER_NAME,
    KILOBYTE,
    MEGABYTE,
    GIGABYTE,
    readMetadataFromFileFooter,
    type OpfsMetadata,
} from './opfsFormat.js';

export {
    emitDroppedPatternWarnings,
    getOpfsDir,
    getRoot,
    clearOpfsCache,
    isOpfsAvailable,
    normalizePatternList,
    registerFolderConfig,
    getMaxCacheFraction,
    getGlobalMaxCacheFraction,
    setGlobalMaxCacheFraction,
    getRangeCacheMaxSizeBytes,
    getRangeCacheMaxEntries,
    isEvictable,
    type OpfsConfigOptions,
    type FolderCacheConfig,
    type NormalizePatternListDropped,
} from './opfsUtil.js';
export {
    getOrCreateRangeCache,
    getRangeCache,
    type RangeCacheLimits,
    type RangeCacheEntryMeta,
    type RangeCacheBlobHit,
} from './opfsRangeCache.js';
export { urlToOpfsKey } from './opfsKey.js';

export {
    isInSkipList,
    addToSkipList,
    getStorageEstimate,
    getCacheLimit,
} from './opfsLru.js';
export type {
    StorageEstimate,
    CacheFileEntry,
    EnsureSpaceResult,
} from './opfsLru.js';
export {
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
    OPFS_MSG_BACKGROUND_FETCH_COMPLETED,
    OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN,
    OPFS_MSG_RANGE_CACHE_FETCH_STARTED,
    OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE,
    OPFS_BACKGROUND_FETCH_ID_PREFIX,
    OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER,
    OPFS_RESPONSE_BACKGROUND_FETCH_FILTER,
} from './opfsMessages.js';
export type { OpfsMessageType } from './opfsMessages.js';
export type { WriteToOpfsOptions } from './opfsWrite.js';

const HEADER_IF_RANGE = 'If-Range';

export interface OpfsServeRangeOptions {
    /**
     * Имя папки в OPFS для этого кеша (обязательно). Одна папка — один набор настроек; при повторной регистрации того же имени конфиг должен совпадать.
     */
    folderName: string;
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
                        `opfsServeRange: skip ${request.url} (filtered by include/exclude)`
                    );
                }
                return;
            }

            const url = request.url;
            let key: string;
            try {
                key = await urlToOpfsKey(url);
            } catch (err) {
                if (enableLogging) {
                    logger.error(`opfsServeRange: hash failed for ${url}`, err);
                }
                return;
            }

            const root = await getRoot();
            let dir: FileSystemDirectoryHandle;
            try {
                dir = await getOpfsDir(root, false, folderName);
            } catch {
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: no plugin dir in OPFS for ${url}`
                    );
                }
                return;
            }

            const metadataCache = getOrCreateMetadataCache(folderName);
            let cachedMeta = metadataCache.get(key);
            let file: File | undefined;

            if (cachedMeta === undefined) {
                let fileHandle: FileSystemFileHandle;
                try {
                    fileHandle = await dir.getFileHandle(key);
                } catch {
                    if (enableLogging) {
                        logger.debug(`opfsServeRange: no file in OPFS for ${url}`);
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
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: If-Range mismatch for ${url}, passing through`
                    );
                }
                return;
            }

            try {
                const range = parseRangeHeader(rangeHeader, size);

                if (useRangeCache && rangeCacheLimits !== null) {
                    const cache = getOrCreateRangeCache(folderName, rangeCacheLimits);
                    const cached = cache.get(key, range.start, range.end);
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
                                        key,
                                        Date.now()
                                    )
                                );
                            }
                            if (enableLogging) {
                                logger.debug(
                                    `opfsServeRange: 206 from rangeCache for ${url} bytes ${range.start}-${range.end}`
                                );
                            }
                            return response;
                        }
                        getRangeCache(folderName)?.invalidateForKey(key);
                    }
                    if (file === undefined) {
                        const fileHandle = await dir.getFileHandle(key);
                        file = await fileHandle.getFile();
                    }
                    const blob = file.slice(range.start, range.end + 1);
                    cache.set(key, range.start, range.end, blob);
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
                                key,
                                Date.now()
                            )
                        );
                    }
                    if (enableLogging) {
                        logger.debug(
                            `opfsServeRange: 206 for ${url} bytes ${range.start}-${range.end} (cached)`
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
                        updateEvictionIndexLastAccessed(dir, key, Date.now())
                    );
                }

                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: 206 for ${url} bytes ${range.start}-${range.end}`
                    );
                }

                return response;
            } catch (err) {
                if (enableLogging) {
                    logger.error(`opfsServeRange: error for ${url}`, err);
                }
                return;
            }
        },
    };
}

/** Внутренние опции для сборки аргумента opfsServeRange из фабрик (без pinned — он не для serve). */
interface ServeOptionsFromFactory {
    folderName: string;
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

function buildServeOptions(
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

/** Общие опции для пары плагинов (serve + BF или serve + network+cache). */
export interface CreateOpfsServeAndBackgroundFetchPluginsOptions {
    folderName: string;
    include: string[];
    exclude?: string[];
    enableLogging?: boolean;
    maxCacheFraction?: number;
    pinned?: string[];
    /**
     * Логгер для этапа инициализации фабрик (по умолчанию console).
     */
    logger?: Logger;
    /** Порядок пары плагинов: первый получает order (по умолчанию 0), второй — order + 1. */
    order?: number;
    rangeResponseCacheControl?: string;
    rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}

/** Общие опции для пары плагинов (serve + network+cache). */
export interface CreateOpfsServeAndNetworkCachePluginsOptions {
    folderName: string;
    include: string[];
    exclude?: string[];
    enableLogging?: boolean;
    maxCacheFraction?: number;
    pinned?: string[];
    /**
     * Логгер для этапа инициализации фабрик (по умолчанию console).
     */
    logger?: Logger;
    /** Порядок пары плагинов: первый получает order (по умолчанию 0), второй — order + 1. */
    order?: number;
    rangeResponseCacheControl?: string;
    rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}

/**
 * Возвращает пару плагинов для сценария «отдача из кеша + запись по Background Fetch»: opfsServeRange и opfsBackgroundFetch с общими folderName, include, exclude и т.д.
 * Результат можно развернуть в массив плагинов: initServiceWorker([...createOpfsServeAndBackgroundFetchPlugins({ folderName, include }), ...], ...).
 */
export function createOpfsServeAndBackgroundFetchPlugins(
    options: CreateOpfsServeAndBackgroundFetchPluginsOptions
): Plugin[] {
    const { folderName, include, exclude, enableLogging, maxCacheFraction, pinned, logger, order = 0 } =
        options;
    const serve = opfsServeRange(buildServeOptions(options, order));
    const bf = opfsBackgroundFetch({
        folderName,
        include,
        order: order + 1,
        ...(exclude !== undefined && { exclude }),
        ...(enableLogging !== undefined && { enableLogging }),
        ...(pinned !== undefined && { pinned }),
        ...(maxCacheFraction !== undefined && { maxCacheFraction }),
        ...(logger !== undefined && { logger }),
    });
    return [serve, bf].filter((p): p is Plugin => p !== undefined);
}

/**
 * Возвращает пару плагинов для сценария «кеш при первом запросе»: opfsServeRange и opfsRangeFromNetworkAndCache с общими folderName, include, exclude и т.д.
 */
export function createOpfsServeAndNetworkCachePlugins(
    options: CreateOpfsServeAndNetworkCachePluginsOptions
): Plugin[] {
    const { folderName, include, exclude, enableLogging, maxCacheFraction, pinned, logger, order = 0 } =
        options;
    const serve = opfsServeRange(buildServeOptions(options, order));
    const networkCache = opfsRangeFromNetworkAndCache({
        folderName,
        include,
        order: order + 1,
        ...(exclude !== undefined && { exclude }),
        ...(enableLogging !== undefined && { enableLogging }),
        ...(pinned !== undefined && { pinned }),
        ...(maxCacheFraction !== undefined && { maxCacheFraction }),
        ...(logger !== undefined && { logger }),
    });
    return [serve, networkCache].filter((p): p is Plugin => p !== undefined);
}

export {
    parseRangeHeader,
    build206Response,
    build206ResponseFromStream,
    createFileRangeStream,
    createRangeExtractTransform,
} from './opfsRangeUtil.js';
export type { RangeSpec, Build206Options } from './opfsRangeUtil.js';
export { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
export { opfsRangeFromNetworkAndCache } from './opfsRangeFromNetworkAndCache.js';
export type { OpfsRangeFromNetworkAndCacheOptions } from './opfsRangeFromNetworkAndCache.js';
export { opfsBackgroundFetch, opfsBackgroundFetchFilter } from './opfsBackgroundFetch.js';
export type {
    OpfsBackgroundFetchOptions,
    OpfsBackgroundFetchFilterOptions,
} from './opfsBackgroundFetch.js';
