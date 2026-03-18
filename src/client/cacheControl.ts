/**
 * Запросы к плагину opfsCacheControl: list, has, delete, clear.
 */

import type { FolderName, Pathname, UrlString } from '../types.js';
import {
    OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK,
    OPFS_REQUEST_CLEAR_CACHE,
    OPFS_REQUEST_DELETE_FROM_CACHE,
    OPFS_REQUEST_HAS_IN_CACHE,
    OPFS_REQUEST_LIST_CACHED_RESOURCES,
    OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK,
    OPFS_RESPONSE_CLEAR_CACHE,
    OPFS_RESPONSE_DELETE_FROM_CACHE,
    OPFS_RESPONSE_HAS_IN_CACHE,
    OPFS_RESPONSE_LIST_CACHED_RESOURCES,
} from '../opfsMessages.js';

export interface OpfsCachedResource {
    url: UrlString;
    size: number;
    type: string | undefined;
    lastModified: string | undefined;
}

const CACHE_CONTROL_REQUEST_TIMEOUT_MS = 2000;
const CLEAR_SERVED_FROM_NETWORK_TIMEOUT_MS = 500;

/**
 * Отправляет запрос плагину opfsCacheControl и ждёт ответ с тем же requestId.
 * Таймаут 2 с. При error в ответе — reject с сообщением.
 */
function sendCacheControlRequest(
    requestType: string,
    responseType: string,
    payload: { requestId: string; url?: UrlString; folderName?: FolderName },
    timeoutMs: number = CACHE_CONTROL_REQUEST_TIMEOUT_MS
): Promise<Record<string, unknown>> {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) {
        return Promise.reject(
            new Error('OPFS: service worker not controlling this page')
        );
    }
    const { requestId } = payload;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('message', onMessage);
            reject(new Error('OPFS: cache control request timeout'));
        }, timeoutMs);
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Record<string, unknown> | null;
            if (data?.['type'] !== responseType || data['requestId'] !== requestId) {
                return;
            }
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            const err = data['error'] as string | undefined;
            if (typeof err === 'string' && err) {
                reject(new Error(err));
                return;
            }
            resolve(data);
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        controller.postMessage({ type: requestType, ...payload });
    });
}

export async function listOpfsCachedResources(
    folderName: FolderName
): Promise<OpfsCachedResource[]> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.serviceWorker?.controller == null
    ) {
        return [];
    }
    const requestId = `opfs-list-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    try {
        const data = await sendCacheControlRequest(
            OPFS_REQUEST_LIST_CACHED_RESOURCES,
            OPFS_RESPONSE_LIST_CACHED_RESOURCES,
            { requestId, folderName }
        );
        const resources = data['resources'];
        return Array.isArray(resources) ? (resources as OpfsCachedResource[]) : [];
    } catch {
        return [];
    }
}

export async function hasInOpfsCache(
    url: UrlString,
    folderName: FolderName
): Promise<boolean> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.serviceWorker?.controller == null
    ) {
        return false;
    }
    const requestId = `opfs-has-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    try {
        const data = await sendCacheControlRequest(
            OPFS_REQUEST_HAS_IN_CACHE,
            OPFS_RESPONSE_HAS_IN_CACHE,
            { requestId, url, folderName }
        );
        return data['has'] === true;
    } catch {
        return false;
    }
}

export async function deleteFromOpfsCache(url: UrlString): Promise<void> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.serviceWorker?.controller == null
    ) {
        return;
    }
    const requestId = `opfs-delete-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    await sendCacheControlRequest(
        OPFS_REQUEST_DELETE_FROM_CACHE,
        OPFS_RESPONSE_DELETE_FROM_CACHE,
        { requestId, url }
    );
}

/**
 * Сбрасывает для текущей вкладки учёт «URL отдан из сети» по pathname.
 * Вызывать перед element.load() при переподключении плеера к тому же URL (reconnect),
 * чтобы следующие запросы по этому URL обслуживались из OPFS, если файл в кэше.
 * Возвращает Promise, который резолвится после обработки CLEAR в SW (или по таймауту).
 */
export function clearServedFromNetworkForReconnect(pathname: Pathname): Promise<void> {
    if (
        typeof navigator === 'undefined' ||
        navigator.serviceWorker?.controller == null
    ) {
        return Promise.resolve();
    }
    if (typeof pathname !== 'string' || pathname.length === 0) {
        return Promise.resolve();
    }
    const controller = navigator.serviceWorker.controller;
    const requestId = `opfs-clear-served-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve();
        }, CLEAR_SERVED_FROM_NETWORK_TIMEOUT_MS);
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as Record<string, unknown> | null;
            if (data?.['type'] !== OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK || data['requestId'] !== requestId) {
                return;
            }
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve();
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        controller.postMessage({
            type: OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK,
            pathname,
            requestId,
        });
    });
}

/**
 * Полная очистка папки кэша в OPFS. Шлёт запрос в SW (плагин opfsCacheControl).
 */
export async function clearOpfsCache(folderName: FolderName): Promise<void> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.serviceWorker?.controller == null
    ) {
        throw new Error('OPFS: service worker not controlling this page');
    }
    const requestId = `opfs-clear-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    await sendCacheControlRequest(
        OPFS_REQUEST_CLEAR_CACHE,
        OPFS_RESPONSE_CLEAR_CACHE,
        { requestId, folderName }
    );
}
