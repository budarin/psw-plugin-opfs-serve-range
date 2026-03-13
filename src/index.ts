/**
 * Плагин Service Worker: отдаёт HTTP Range-запросы из OPFS (Origin Private File System).
 * Ключ файла: key = hex(SHA-256(URL)). Один файл на ресурс: [тело][4 байта длина мета][JSON мета].
 * Очистка = удалить один файл, мусора нет.
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';

import type { FolderName } from './types.js';
import { getFlatStoreDir } from './opfsUtil.js';
import { ensureCachesPopulated } from './opfsEvictionIndex.js';
import { setCacheEventLogging } from './opfsCacheEventLog.js';
import { opfsServeRange, buildServeOptions } from './opfsServeRange.js';
import { opfsBackgroundFetch, opfsBackgroundFetchFilter } from './opfsBackgroundFetch.js';
import { opfsRegisteredFolders } from './opfsRegisteredFolders.js';
import { opfsCacheControl } from './opfsCacheControl.js';
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
    getFlatStoreDir,
    getPluginRoot,
    getRoot,
    OPFS_PLUGIN_ROOT_DIR_NAME,
    clearOpfsCache,
    invalidateAllCachesForFolder,
    invalidateAllCachesAndPluginRoot,
    invalidateCachesForFileKeyOnError,
    isOpfsAvailable,
    normalizePatternList,
    registerFolderConfig,
    getRegisteredFolderNames,
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
    getOpfsBackgroundFetchId,
    getOpfsBackgroundFetchIdPrefixForFolder,
} from './opfsBackgroundFetchId.js';

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
    OPFS_REQUEST_GET_REGISTERED_FOLDERS,
    OPFS_RESPONSE_REGISTERED_FOLDERS,
    OPFS_REQUEST_DELETE_FROM_CACHE,
    OPFS_RESPONSE_DELETE_FROM_CACHE,
    OPFS_REQUEST_HAS_IN_CACHE,
    OPFS_RESPONSE_HAS_IN_CACHE,
    OPFS_REQUEST_LIST_CACHED_RESOURCES,
    OPFS_RESPONSE_LIST_CACHED_RESOURCES,
    OPFS_REQUEST_CLEAR_CACHE,
    OPFS_RESPONSE_CLEAR_CACHE,
} from './opfsMessages.js';
export type { OpfsMessageType } from './opfsMessages.js';
export type { WriteToOpfsOptions } from './opfsWrite.js';

export { opfsServeRange, buildServeOptions } from './opfsServeRange.js';
export type { OpfsServeRangeOptions, ServeOptionsFromFactory } from './opfsServeRange.js';
export type { Pathname, UrlString, OpfsKey, FolderName } from './types.js';

/** Базовые опции для фабрик пары плагинов (serve + BF или serve + network+cache). */
export interface CreateOpfsServePluginsBaseOptions {
    folderName: FolderName;
    include: string[];
    exclude?: string[];
    /** Включить отладочное логирование (используется переданный logger). При true также включаются события кэша (logCacheEvents). */
    debug?: boolean;
    pinned?: string[];
    /**
     * Логгер для этапа инициализации фабрик (по умолчанию console).
     */
    logger?: Logger;
    /**
     * Логировать события кэша (заполнение, очистка, эвикция). По умолчанию при debug: true. Работает только при переданном logger.
     */
    logCacheEvents?: boolean;
    /** Порядок пары плагинов: первый получает order (по умолчанию 0), второй — order + 1. */
    order?: number;
    rangeResponseCacheControl?: string;
    rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}

/** Опции для пары плагинов serve + Background Fetch. */
export interface CreateOpfsServeAndBackgroundFetchPluginsOptions
    extends CreateOpfsServePluginsBaseOptions {}

/** Опции для пары плагинов serve + network+cache. */
export interface CreateOpfsServeAndNetworkCachePluginsOptions
    extends CreateOpfsServePluginsBaseOptions {}

function scheduleOpfsCacheWarmup(): void {
    queueMicrotask(() => {
        getFlatStoreDir()
            .then((dir) => ensureCachesPopulated(dir))
            .catch(() => {});
    });
}

/**
 * Возвращает пару плагинов для сценария «отдача из кеша + запись по Background Fetch»: opfsServeRange и opfsBackgroundFetch с общими folderName, include, exclude и т.д.
 * Результат можно развернуть в массив плагинов: initServiceWorker([...createOpfsServeAndBackgroundFetchPlugins({ folderName, include }), ...], ...).
 */
export function createOpfsServeAndBackgroundFetchPlugins(
    options: CreateOpfsServeAndBackgroundFetchPluginsOptions
): Plugin[] {
    const logger = options.logger ?? console;
    setCacheEventLogging(
        options.debug === true || options.logCacheEvents === true,
        logger
    );
    scheduleOpfsCacheWarmup();
    const { folderName, include, exclude, debug, pinned, order = 0 } =
        options;
    const serve = opfsServeRange(buildServeOptions({ ...options, logger }, order));
    const filterPlugin = opfsBackgroundFetchFilter({
        include,
        ...(exclude !== undefined && { exclude }),
        logger,
    });
    const registeredFoldersPlugin = opfsRegisteredFolders();
    const bf = opfsBackgroundFetch({
        folderName,
        include,
        order: order + 1,
        ...(exclude !== undefined && { exclude }),
        ...(debug !== undefined && { debug }),
        ...(pinned !== undefined && { pinned }),
        logger,
    });
    const cacheControl = opfsCacheControl();
    return [serve, filterPlugin, registeredFoldersPlugin, cacheControl, bf].filter((p): p is Plugin => p !== undefined);
}

/**
 * Возвращает пару плагинов для сценария «кеш при первом запросе»: opfsServeRange и opfsRangeFromNetworkAndCache с общими folderName, include, exclude и т.д.
 */
export function createOpfsServeAndNetworkCachePlugins(
    options: CreateOpfsServeAndNetworkCachePluginsOptions
): Plugin[] {
    const logger = options.logger ?? console;
    setCacheEventLogging(
        options.debug === true || options.logCacheEvents === true,
        logger
    );
    scheduleOpfsCacheWarmup();
    const { folderName, include, exclude, debug, pinned, order = 0 } =
        options;
    const serve = opfsServeRange(buildServeOptions({ ...options, logger }, order));
    const networkCache = opfsRangeFromNetworkAndCache({
        folderName,
        include,
        order: order + 1,
        ...(exclude !== undefined && { exclude }),
        ...(debug !== undefined && { debug }),
        ...(pinned !== undefined && { pinned }),
        logger,
    });
    const cacheControl = opfsCacheControl();
    return [serve, cacheControl, networkCache].filter((p): p is Plugin => p !== undefined);
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
export { opfsRegisteredFolders } from './opfsRegisteredFolders.js';
export { opfsCacheControl } from './opfsCacheControl.js';
export type {
    OpfsBackgroundFetchOptions,
    OpfsBackgroundFetchFilterOptions,
} from './opfsBackgroundFetch.js';
