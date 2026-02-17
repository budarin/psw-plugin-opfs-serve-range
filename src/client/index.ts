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
import { getOpfsDir } from '../opfsUtil.js';
import {
    MAX_META_JSON_BYTES,
    OPFS_META_FOOTER_LENGTH,
    type OpfsMetadata,
} from '../opfsFormat.js';
import { urlToOpfsKey } from '../index.js';

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
    const root = await navigator.storage.getDirectory();
    try {
        return await getOpfsDir(root, false);
    } catch {
        return undefined;
    }
}

async function readMetadataFromFile(
    file: File
): Promise<OpfsMetadata | undefined> {
    const size = file.size;
    if (size < OPFS_META_FOOTER_LENGTH) {
        return undefined;
    }
    const footerBlob = file.slice(size - OPFS_META_FOOTER_LENGTH, size);
    const footerBuf = await footerBlob.arrayBuffer();
    const metaLen = new DataView(footerBuf).getUint32(0, true);
    if (
        metaLen === 0 ||
        metaLen > MAX_META_JSON_BYTES ||
        metaLen > size - OPFS_META_FOOTER_LENGTH
    ) {
        return undefined;
    }
    try {
        const jsonBlob = file.slice(
            size - OPFS_META_FOOTER_LENGTH - metaLen,
            size - OPFS_META_FOOTER_LENGTH
        );
        const text = await jsonBlob.text();
        const metadata = JSON.parse(text) as OpfsMetadata;
        return metadata;
    } catch {
        return undefined;
    }
}

export async function listOpfsCachedResources(): Promise<OpfsCachedResource[]> {
    const dir = await getOpfsCacheDirOrUndefined();
    if (!dir) {
        return [];
    }
    const result: OpfsCachedResource[] = [];
    for await (const [, handle] of dir.entries()) {
        if (handle.kind !== 'file') {
            continue;
        }
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            const metadata = await readMetadataFromFile(file);
            if (!metadata || !metadata.url) {
                continue;
            }
            result.push({
                url: metadata.url,
                size: metadata.size,
                type: metadata.type,
                lastModified: metadata.lastModified,
            });
        } catch {
            // битый или недоступный файл — пропускаем
        }
    }
    return result;
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
