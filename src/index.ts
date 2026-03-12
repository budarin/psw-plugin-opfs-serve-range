/**
 * Плагин Service Worker: отдаёт HTTP Range-запросы из OPFS (Origin Private File System).
 * Ключ файла: key = hex(SHA-256(URL)). Один файл на ресурс: [тело][4 байта длина мета][JSON мета].
 * Очистка = удалить один файл, мусора нет.
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';

import type { FolderName } from './types.js';
import { opfsServeRange, buildServeOptions } from './opfsServeRange.js';
import { opfsBackgroundFetch, opfsBackgroundFetchFilter } from './opfsBackgroundFetch.js';
import { opfsRegisteredFolders } from './opfsRegisteredFolders.js';
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
    invalidateAllCachesForFolder,
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
} from './opfsMessages.js';
export type { OpfsMessageType } from './opfsMessages.js';
export type { WriteToOpfsOptions } from './opfsWrite.js';

export { opfsServeRange, buildServeOptions } from './opfsServeRange.js';
export type { OpfsServeRangeOptions, ServeOptionsFromFactory } from './opfsServeRange.js';
export type { Pathname, UrlString, OpfsKey, FolderName } from './types.js';

/** Общие опции для пары плагинов (serve + BF или serve + network+cache). */
export interface CreateOpfsServeAndBackgroundFetchPluginsOptions {
    folderName: FolderName;
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
    folderName: FolderName;
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
    const filterPlugin = opfsBackgroundFetchFilter({
        include,
        ...(exclude !== undefined && { exclude }),
        ...(logger !== undefined && { logger }),
    });
    const registeredFoldersPlugin = opfsRegisteredFolders();
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
    return [serve, filterPlugin, registeredFoldersPlugin, bf].filter((p): p is Plugin => p !== undefined);
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
export { opfsRegisteredFolders } from './opfsRegisteredFolders.js';
export type {
    OpfsBackgroundFetchOptions,
    OpfsBackgroundFetchFilterOptions,
} from './opfsBackgroundFetch.js';
