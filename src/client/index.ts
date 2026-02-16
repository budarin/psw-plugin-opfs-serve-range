/**
 * Клиентские утилиты: типизированные обработчики сообщений OPFS от сервис-воркера.
 */

import { onServiceWorkerMessage } from '@budarin/pluggable-serviceworker/client/messaging';

import {
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
} from '../opfsMessages.js';

export {
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
} from '../opfsMessages.js';
export type { OpfsMessageType } from '../opfsMessages.js';

export interface OpfsMessagePayload {
    url?: string;
    size?: number;
    limit?: number;
    reason?: string;
}

/** Подписка на сообщение «квота исчерпана при записи». Возвращает функцию отписки. */
export function onOPFSQuotaExceeded(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «запись не начата — файл не влезает». */
export function onOPFSWriteSkipped(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_SKIPPED_SIZE, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «достигнут лимит кеша». */
export function onOPFSCacheLimitReached(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_CACHE_LIMIT_REACHED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «эвикция завершена». */
export function onOPFSEvictionCompleted(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_EVICTION_COMPLETED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «ошибка записи». */
export function onOPFSWriteFailed(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_FAILED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «повторный запрос к URL из чёрного списка (не кешируем)». */
export function onOPFSSkipQuotaExceeded(
    handler: (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void
): () => void {
    return onServiceWorkerMessage(OPFS_MSG_SKIP_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}
