/**
 * Префиксы для логов пакета: пакет + окружение (sw / client).
 * Единый формат: [opfs-range] [sw] <сообщение> | [opfs-range] [client] <сообщение>.
 */

/** Префикс для логов в коде сервис-воркера. */
export const OPFS_RANGE_LOG_SW = '[opfs-range] [sw] ';

/** Префикс для логов в клиентском коде (страница). */
export const OPFS_RANGE_LOG_CLIENT = '[opfs-range] [client] ';
