/**
 * Типы сообщений для оповещения клиентов (notifyClients).
 * Используются в SW и в клиентских обработчиках.
 */

export const OPFS_MSG_QUOTA_EXCEEDED = 'OPFS_MSG_QUOTA_EXCEEDED';
export const OPFS_MSG_WRITE_SKIPPED_SIZE = 'OPFS_MSG_WRITE_SKIPPED_SIZE';
export const OPFS_MSG_CACHE_LIMIT_REACHED = 'OPFS_MSG_CACHE_LIMIT_REACHED';
export const OPFS_MSG_EVICTION_COMPLETED = 'OPFS_MSG_EVICTION_COMPLETED';
export const OPFS_MSG_WRITE_FAILED = 'OPFS_MSG_WRITE_FAILED';
/** Повторный запрос к URL из blocklist (не кешируем, квота была превышена ранее). */
export const OPFS_MSG_SKIP_QUOTA_EXCEEDED = 'OPFS_MSG_SKIP_QUOTA_EXCEEDED';
/** Background Fetch завершился с ошибкой. */
export const OPFS_MSG_BACKGROUND_FETCH_FAILED = 'OPFS_MSG_BACKGROUND_FETCH_FAILED';
/** Background Fetch был отменён. */
export const OPFS_MSG_BACKGROUND_FETCH_ABORTED = 'OPFS_MSG_BACKGROUND_FETCH_ABORTED';

export type OpfsMessageType =
    | typeof OPFS_MSG_QUOTA_EXCEEDED
    | typeof OPFS_MSG_WRITE_SKIPPED_SIZE
    | typeof OPFS_MSG_CACHE_LIMIT_REACHED
    | typeof OPFS_MSG_EVICTION_COMPLETED
    | typeof OPFS_MSG_WRITE_FAILED
    | typeof OPFS_MSG_SKIP_QUOTA_EXCEEDED
    | typeof OPFS_MSG_BACKGROUND_FETCH_FAILED
    | typeof OPFS_MSG_BACKGROUND_FETCH_ABORTED;
