/**
 * Клиентские утилиты: типизированные обработчики сообщений OPFS от сервис-воркера,
 * управление кэшем (list/has/delete/clear), переподключение плеера, загрузка assets через Background Fetch.
 * Точка входа: re-export из модулей по зонам ответственности.
 */

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
    OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK,
    OPFS_RESPONSE_CLEAR_CACHE,
} from '../opfsMessages.js';
export type { OpfsMessageType } from '../opfsMessages.js';

export type { Pathname, UrlString, FolderName } from '../types.js';
export { getOpfsBackgroundFetchId } from './opfsBackgroundFetchId.js';

export type { OpfsMessagePayload } from './messageHandlers.js';
export {
    onOPFSQuotaExceeded,
    onOPFSWriteSkipped,
    onOPFSCacheLimitReached,
    onOPFSEvictionCompleted,
    onOPFSWriteFailed,
    onOPFSSkipQuotaExceeded,
    onOPFSBackgroundFetchFailed,
    onOPFSBackgroundFetchAborted,
    onOPFSBackgroundFetchCompleted,
    onOPFSBackgroundFetchFileWritten,
    onOPFSRangeCacheFetchStarted,
    onOPFSRangeCacheFetchAllDone,
} from './messageHandlers.js';

export type { OpfsCachedResource } from './cacheControl.js';
export {
    clearOpfsCache,
    clearServedFromNetworkForReconnect,
    deleteFromOpfsCache,
    hasInOpfsCache,
    listOpfsCachedResources,
} from './cacheControl.js';

export type {
    FileWrittenPayload,
    ReconnectPlayerOnFileLoadedIntoOpfsOptions,
} from './reconnectPlayer.js';
export { reconnectPlayerOnFileLoadedIntoOpfs } from './reconnectPlayer.js';

export {
    OPFS_ERROR_FOLDER_NOT_REGISTERED,
    OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE,
    getBackgroundFetchFilter,
    getRegisteredFolders,
    filterAssetsForOpfs,
    startDownloadAssetsToOpfs,
    estimateAssetsSizeInBytes,
} from './backgroundFetch.js';
export type {
    DownloadAssetsToOpfsResult,
    DownloadAssetsToOpfsRejected,
    StartDownloadError,
    StartDownloadAssetsToOpfsOptions,
} from './backgroundFetch.js';
