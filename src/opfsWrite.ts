/**
 * Утилиты записи в OPFS в формате, совместимом с opfsServeRange.
 * Один файл: [тело][4 байта длина JSON (uint32 LE)][JSON мета].
 */

import { notifyClients } from '@budarin/pluggable-serviceworker/utils';

import type { FolderName, OpfsKey, UrlString } from './types.js';
import {
    OPFS_META_FOOTER_LENGTH,
    MEGABYTE,
    type OpfsMetadata,
} from './opfsFormat.js';
import {
    ensureSpaceForWrite,
    computeEvictionSet,
    evictFiles,
    getCacheLimit,
    getStorageEstimate,
    addToSkipList,
} from './opfsLru.js';
import {
    addToEvictionIndex,
    getEntriesForEviction,
    registerFileInCache,
    removeFromEvictionIndex,
} from './opfsEvictionIndex.js';
import { invalidateAllCachesForFolder } from './opfsUtil.js';
import {
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
} from './opfsMessages.js';

export interface WriteToOpfsOptions {
    /** Имя папки OPFS — для расчёта лимита при ensureSpaceForWrite и при QuotaExceeded (обязательно). */
    folderName: FolderName;
    /** URL ресурса — для оповещений и skip list при потоке без размера. */
    url?: UrlString;
    /** Известный размер тела (Content-Length). Если задан, перед записью проверяется лимит и при необходимости выполняется LRU-эвикция. */
    knownSize?: number;
    /** Ключ файла в OPFS — при эвикции не удалять этот ключ (перезапись; иначе можно удалить источник response.body). */
    excludeKeyFromEviction?: OpfsKey;
}

/**
 * Записывает в OPFS файл по ключу: тело (потоком), затем футер с метаданными.
 * Метаданные должны содержать size (размер тела в байтах); при записи футера используется он.
 * При knownSize перед записью выполняется проверка лимита и при необходимости эвикция по LRU.
 * При ошибке QuotaExceeded частичный файл удаляется; при bytesWritten >= totalCacheSize URL добавляется в skip list.
 *
 * @param dir — папка плагина в OPFS (getOpfsDir(root, true))
 * @param key — ключ файла (например, из urlToOpfsKey(url))
 * @param bodyStream — поток тела ресурса
 * @param metadata — url и size обязательны; type, etag, lastModified — по желанию
 * @param options — url и/или knownSize для лимитов и оповещений
 */
export async function writeToOpfs(
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
    bodyStream: ReadableStream<Uint8Array>,
    metadata: OpfsMetadata,
    options: WriteToOpfsOptions
): Promise<void> {
    const { folderName, url, knownSize, excludeKeyFromEviction } = options;

    if (knownSize !== undefined && knownSize > 0) {
        const result = await ensureSpaceForWrite(dir, knownSize, {
            folderName,
            ...(excludeKeyFromEviction != null && { excludeKeyFromEviction }),
            onEvicted(keys) {
                if (keys.length > 0) {
                    notifyClients(OPFS_MSG_EVICTION_COMPLETED, { count: keys.length });
                }
            },
        });
        if (!result.ok) {
            notifyClients(OPFS_MSG_WRITE_SKIPPED_SIZE, {
                url,
                size: knownSize,
                reason: result.reason,
            });
            throw new Error(result.reason);
        }
    }

    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();

    let bodySize = 0;

    const wrapper = new WritableStream<Uint8Array>({
        async write(chunk) {
            bodySize += chunk.byteLength;
            await writable.write(
                chunk as Parameters<FileSystemWritableFileStream['write']>[0]
            );
        },
        async close() {
            const meta: OpfsMetadata = {
                ...metadata,
                size: bodySize,
                lastAccessed: Date.now(),
            };
            const metaJson = JSON.stringify(meta);
            const metaBytes = new TextEncoder().encode(metaJson);
            const lengthBuf = new ArrayBuffer(OPFS_META_FOOTER_LENGTH);
            new DataView(lengthBuf).setUint32(0, metaBytes.length, true);
            const lengthBytes = new Uint8Array(lengthBuf);

            await writable.seek(bodySize);
            await writable.write(
                metaBytes as Parameters<FileSystemWritableFileStream['write']>[0]
            );
            await writable.write(lengthBytes);
            await writable.close();
        },
    });

    try {
        await bodyStream.pipeTo(wrapper);
        const file = await handle.getFile();
        const now = Date.now();
        if (metadata.evictable !== false) {
            await addToEvictionIndex(dir, key, file.size, now);
        } else {
            await registerFileInCache(dir, key, file.size, false, now);
        }
    } catch (err) {
        if (err instanceof Error && err.name === 'NotFoundError') {
            invalidateAllCachesForFolder(folderName);
        }
        const isQuotaExceeded =
            err instanceof Error &&
            (err.name === 'QuotaExceededError' || err.name === 'QuotaExceeded');
        try {
            await dir.removeEntry(key);
        } catch {
            // ignore
        }
        if (isQuotaExceeded && url !== undefined) {
            const { entries, totalSize: totalCacheSize } = await getEntriesForEviction(dir);
            const bytesWritten = bodySize;
            if (bytesWritten >= totalCacheSize) {
                addToSkipList(url);
                notifyClients(OPFS_MSG_QUOTA_EXCEEDED, { url });
            } else {
                const estimate = await getStorageEstimate();
                const limit = getCacheLimit(estimate, folderName);
                const headroom = Math.min(MEGABYTE, Math.max(0, Math.floor(limit * 0.1)));
                const needToFree = bytesWritten + headroom;
                const keysToDelete = computeEvictionSet(entries, needToFree);
                await evictFiles(dir, keysToDelete);
                await removeFromEvictionIndex(dir, keysToDelete, folderName);
            }
        }
        notifyClients(OPFS_MSG_WRITE_FAILED, { url, reason: err instanceof Error ? err.message : String(err) });
        throw err;
    }
}

/**
 * Собирает метаданные для OPFS из заголовков HTTP-ответа.
 * Если Content-Length отсутствует или невалиден, возвращает size: 0 — при записи через writeToOpfs
 * фактический размер подставится из подсчитанного тела (bodySize).
 */
export function metadataFromResponse(response: Response, url: UrlString): OpfsMetadata {
    const contentLength = response.headers.get('Content-Length');
    const parsed = contentLength ? parseInt(contentLength, 10) : 0;
    const size =
        parsed > 0 && Number.isInteger(parsed) ? parsed : 0;
    const type =
        response.headers.get('Content-Type') ?? 'application/octet-stream';
    const etag = response.headers.get('ETag') ?? undefined;
    const lastModified = response.headers.get('Last-Modified') ?? undefined;

    return {
        url,
        size,
        type,
        ...(etag && { etag }),
        ...(lastModified && { lastModified }),
    };
}
