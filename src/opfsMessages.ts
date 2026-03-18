/**
 * Типы сообщений для оповещения клиентов (notifyClients).
 * Используются в SW и в клиентских обработчиках.
 */

export const OPFS_MSG_QUOTA_EXCEEDED = 'OPFS_MSG_QUOTA_EXCEEDED';
export const OPFS_MSG_WRITE_SKIPPED_SIZE = 'OPFS_MSG_WRITE_SKIPPED_SIZE';
export const OPFS_MSG_CACHE_LIMIT_REACHED = 'OPFS_MSG_CACHE_LIMIT_REACHED';
export const OPFS_MSG_EVICTION_COMPLETED = 'OPFS_MSG_EVICTION_COMPLETED';
export const OPFS_MSG_WRITE_FAILED = 'OPFS_MSG_WRITE_FAILED';
/** Повторный запрос к URL из skip list (не кешируем, квота была превышена ранее). */
export const OPFS_MSG_SKIP_QUOTA_EXCEEDED = 'OPFS_MSG_SKIP_QUOTA_EXCEEDED';
/** Background Fetch завершился с ошибкой. */
export const OPFS_MSG_BACKGROUND_FETCH_FAILED = 'OPFS_MSG_BACKGROUND_FETCH_FAILED';
/** Background Fetch был отменён. */
export const OPFS_MSG_BACKGROUND_FETCH_ABORTED = 'OPFS_MSG_BACKGROUND_FETCH_ABORTED';
/** Background Fetch успешно завершён, ресурсы записаны в OPFS. */
export const OPFS_MSG_BACKGROUND_FETCH_COMPLETED = 'OPFS_MSG_BACKGROUND_FETCH_COMPLETED';
/** Один файл из Background Fetch записан в OPFS (прогресс по файлам). */
export const OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN = 'OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN';

/** Плагин opfsRangeFromNetworkAndCache начал фоновую загрузку ресурса в кеш (сценарий «кеш при первом запросе»). В payload — url. */
export const OPFS_MSG_RANGE_CACHE_FETCH_STARTED = 'OPFS_MSG_RANGE_CACHE_FETCH_STARTED';
/** Все фоновые загрузки в кеш (opfsRangeFromNetworkAndCache) завершены — активных больше нет. */
export const OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE = 'OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE';

/** Запрос клиента к SW: вернуть include/exclude плагина opfsBackgroundFetch (requestId в data, ответ — OPFS_RESPONSE_BACKGROUND_FETCH_FILTER). */
export const OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER = 'OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER';
/** Ответ SW на OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER (requestId, include?, exclude?). */
export const OPFS_RESPONSE_BACKGROUND_FETCH_FILTER = 'OPFS_RESPONSE_BACKGROUND_FETCH_FILTER';

/** Запрос клиента к SW: вернуть список зарегистрированных папок (requestId в data, ответ — OPFS_RESPONSE_REGISTERED_FOLDERS). */
export const OPFS_REQUEST_GET_REGISTERED_FOLDERS = 'OPFS_REQUEST_GET_REGISTERED_FOLDERS';
/** Ответ SW на OPFS_REQUEST_GET_REGISTERED_FOLDERS (requestId, folderNames: string[]). */
export const OPFS_RESPONSE_REGISTERED_FOLDERS = 'OPFS_RESPONSE_REGISTERED_FOLDERS';

/** Запрос клиента: удалить ресурс из кэша (requestId, url, folderName). Ответ — OPFS_RESPONSE_DELETE_FROM_CACHE. */
export const OPFS_REQUEST_DELETE_FROM_CACHE = 'OPFS_REQUEST_DELETE_FROM_CACHE';
/** Ответ SW (requestId, ok: boolean, error?: string). */
export const OPFS_RESPONSE_DELETE_FROM_CACHE = 'OPFS_RESPONSE_DELETE_FROM_CACHE';

/** Запрос клиента: есть ли URL в кэше (requestId, url, folderName). Ответ — OPFS_RESPONSE_HAS_IN_CACHE. */
export const OPFS_REQUEST_HAS_IN_CACHE = 'OPFS_REQUEST_HAS_IN_CACHE';
/** Ответ SW (requestId, has: boolean, error?: string). */
export const OPFS_RESPONSE_HAS_IN_CACHE = 'OPFS_RESPONSE_HAS_IN_CACHE';

/** Запрос клиента: список ресурсов в кэше (requestId, folderName). Ответ — OPFS_RESPONSE_LIST_CACHED_RESOURCES. */
export const OPFS_REQUEST_LIST_CACHED_RESOURCES = 'OPFS_REQUEST_LIST_CACHED_RESOURCES';
/** Ответ SW (requestId, resources: OpfsCachedResource[], error?: string). */
export const OPFS_RESPONSE_LIST_CACHED_RESOURCES = 'OPFS_RESPONSE_LIST_CACHED_RESOURCES';

/** Запрос клиента: полная очистка папки кэша (requestId, folderName). Ответ — OPFS_RESPONSE_CLEAR_CACHE. */
export const OPFS_REQUEST_CLEAR_CACHE = 'OPFS_REQUEST_CLEAR_CACHE';
/** Ответ SW (requestId, ok: boolean, error?: string). */
export const OPFS_RESPONSE_CLEAR_CACHE = 'OPFS_RESPONSE_CLEAR_CACHE';

/** Запрос клиента: сбросить для вкладки учёт «URL отдан из сети» по pathname (перед reconnect плеера). При наличии requestId в запросе SW отвечает OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK. */
export const OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK = 'OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK';

/** Ответ SW на CLEAR_SERVED_FROM_NETWORK (requestId). Отправляется после сброса учёта, чтобы клиент мог дождаться перед load(). */
export const OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK = 'OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK';

/** Префикс идентификатора загрузки Background Fetch: плагин opfsBackgroundFetch обрабатывает только события с id, начинающимся с этой строки. */
export const OPFS_BACKGROUND_FETCH_ID_PREFIX = 'opfs-ranges-';

export type OpfsMessageType =
    | typeof OPFS_MSG_QUOTA_EXCEEDED
    | typeof OPFS_MSG_WRITE_SKIPPED_SIZE
    | typeof OPFS_MSG_CACHE_LIMIT_REACHED
    | typeof OPFS_MSG_EVICTION_COMPLETED
    | typeof OPFS_MSG_WRITE_FAILED
    | typeof OPFS_MSG_SKIP_QUOTA_EXCEEDED
    | typeof OPFS_MSG_BACKGROUND_FETCH_FAILED
    | typeof OPFS_MSG_BACKGROUND_FETCH_ABORTED
    | typeof OPFS_MSG_BACKGROUND_FETCH_COMPLETED
    | typeof OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN
    | typeof OPFS_MSG_RANGE_CACHE_FETCH_STARTED
    | typeof OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE;
