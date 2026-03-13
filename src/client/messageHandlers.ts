/**
 * Типизированные подписки на сообщения OPFS от сервис-воркера.
 */

import { onServiceWorkerMessage } from '@budarin/pluggable-serviceworker/client/messaging';
import {
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
} from '../opfsMessages.js';
import type { Pathname, UrlString } from '../types.js';

export interface OpfsMessagePayload {
    url?: UrlString;
    size?: number;
    limit?: number;
    reason?: string;
    /** ID регистрации Background Fetch (для COMPLETED/FAILED/ABORTED). */
    registrationId?: string;
    /** Assets (pathname'ы) всех записей (для COMPLETED). */
    assets?: Pathname[];
    /** Успешно записанные в OPFS assets (для COMPLETED). */
    written?: Pathname[];
    /** Пропущенные или с ошибкой записи assets (для COMPLETED). */
    failedOrSkipped?: Pathname[];
    /** Один записанный asset (pathname) (для FILE_WRITTEN). */
    asset?: Pathname;
    /** Накопленный список записанных assets (для FILE_WRITTEN). */
    loadedAssets?: Pathname[];
    /** Общее число файлов в загрузке (для FILE_WRITTEN). */
    totalCount?: number;
}

type OpfsMessageHandler = (
    event: MessageEvent & { data: { type: string } & OpfsMessagePayload }
) => void;

/** Подписка на сообщение «квота исчерпана при записи». Возвращает функцию отписки. */
export function onOPFSQuotaExceeded(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «запись не начата — файл не влезает». */
export function onOPFSWriteSkipped(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_SKIPPED_SIZE, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «достигнут лимит кеша». */
export function onOPFSCacheLimitReached(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_CACHE_LIMIT_REACHED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «эвикция завершена». */
export function onOPFSEvictionCompleted(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_EVICTION_COMPLETED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «ошибка записи». */
export function onOPFSWriteFailed(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_WRITE_FAILED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «повторный запрос к URL из skip list (не кешируем)». */
export function onOPFSSkipQuotaExceeded(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_SKIP_QUOTA_EXCEEDED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch завершился с ошибкой». */
export function onOPFSBackgroundFetchFailed(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_FAILED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch отменён». */
export function onOPFSBackgroundFetchAborted(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_ABORTED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «Background Fetch успешно завершён, ресурсы в OPFS». */
export function onOPFSBackgroundFetchCompleted(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «один файл из Background Fetch записан в OPFS» (прогресс по файлам). */
export function onOPFSBackgroundFetchFileWritten(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «плагин opfsRangeFromNetworkAndCache начал фоновую загрузку в кеш». */
export function onOPFSRangeCacheFetchStarted(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_RANGE_CACHE_FETCH_STARTED, handler as (e: MessageEvent) => void);
}

/** Подписка на сообщение «все фоновые загрузки в кеш (opfsRangeFromNetworkAndCache) завершены». */
export function onOPFSRangeCacheFetchAllDone(handler: OpfsMessageHandler): () => void {
    return onServiceWorkerMessage(OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE, handler as (e: MessageEvent) => void);
}
