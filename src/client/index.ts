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
import { getOpfsDir, getRoot } from '../opfsUtil.js';
import { readMetadataFromFileFooter, type OpfsMetadata } from '../opfsFormat.js';
import { urlToOpfsKey } from '../opfsKey.js';

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

export interface OpfsCachedResource {
    url: string;
    size: number;
    type: string | undefined;
    lastModified: string | undefined;
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

async function getOpfsCacheDirOrUndefined(): Promise<FileSystemDirectoryHandle | undefined> {
    if (
        typeof navigator === 'undefined' ||
        navigator?.storage == null ||
        typeof navigator.storage.getDirectory !== 'function'
    ) {
        return undefined;
    }
    const root = await getRoot();
    try {
        return await getOpfsDir(root, false);
    } catch {
        return undefined;
    }
}

async function readMetadataFromFile(
    file: File
): Promise<OpfsMetadata | undefined> {
    const { metadata } = await readMetadataFromFileFooter(file);
    return metadata ?? undefined;
}

export async function listOpfsCachedResources(): Promise<OpfsCachedResource[]> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return [];
    }
    const fileHandles: FileSystemFileHandle[] = [];
    for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'file') {
            fileHandles.push(handle as FileSystemFileHandle);
        }
    }
    const results = await Promise.all(
        fileHandles.map(async (handle): Promise<OpfsCachedResource | null> => {
            try {
                const file = await handle.getFile();
                const metadata = await readMetadataFromFile(file);
                if (!metadata || !metadata.url) {
                    return null;
                }
                return {
                    url: metadata.url,
                    size: metadata.size,
                    type: metadata.type,
                    lastModified: metadata.lastModified,
                };
            } catch {
                return null;
            }
        })
    );
    return results.filter((r): r is OpfsCachedResource => r !== null);
}

export async function hasInOpfsCache(url: string): Promise<boolean> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return false;
    }
    const key = await urlToOpfsKey(url);
    try {
        await dir.getFileHandle(key);
        return true;
    } catch {
        return false;
    }
}

export async function deleteFromOpfsCache(url: string): Promise<void> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return;
    }
    const key = await urlToOpfsKey(url);
    try {
        await dir.removeEntry(key);
    } catch {
        // нет файла — не ошибка
    }
}
