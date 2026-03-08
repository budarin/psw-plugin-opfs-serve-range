/**
 * Плагин Service Worker: отдаёт HTTP Range-запросы из OPFS (Origin Private File System).
 * Ключ файла: key = hex(SHA-256(URL)). Один файл на ресурс: [тело][4 байта длина мета][JSON мета].
 * Очистка = удалить один файл, мусора нет.
 */

import type { Plugin, PluginContext } from '@budarin/pluggable-serviceworker';

import { HEADER_RANGE } from '@budarin/http-constants/headers';

import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import { readMetadataFromFileFooter as readFooter } from './opfsFormat.js';
import {
    getOpfsDir,
    getRoot,
    isOpfsAvailable,
    shouldProcessFile,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import {
    parseRangeHeader,
    build206ResponseFromStream,
    createFileRangeStream,
} from './opfsRangeUtil.js';
import { updateEvictionIndexLastAccessed } from './opfsEvictionIndex.js';

export {
    OPFS_META_FOOTER_LENGTH,
    OPFS_FOLDER_NAME,
    KILOBYTE,
    MEGABYTE,
    GIGABYTE,
    readMetadataFromFileFooter,
    type OpfsMetadata,
} from './opfsFormat.js';

export {
    getOpfsDir,
    getRoot,
    clearOpfsCache,
    configureOpfs,
    isOpfsAvailable,
    getMaxCacheFraction,
    isEvictable,
    type OpfsConfigOptions,
} from './opfsUtil.js';
export { urlToOpfsKey } from './opfsKey.js';

export {
    isBlocklisted,
    addToBlocklist,
    getStorageEstimate,
    getCacheLimit,
} from './opfsLru.js';
export type {
    StorageEstimate,
    CacheFileEntry,
    EnsureSpaceResult,
} from './opfsLru.js';
export {
    OPFS_MSG_QUOTA_EXCEEDED,
    OPFS_MSG_WRITE_SKIPPED_SIZE,
    OPFS_MSG_CACHE_LIMIT_REACHED,
    OPFS_MSG_EVICTION_COMPLETED,
    OPFS_MSG_WRITE_FAILED,
    OPFS_MSG_SKIP_QUOTA_EXCEEDED,
    OPFS_MSG_BACKGROUND_FETCH_FAILED,
    OPFS_MSG_BACKGROUND_FETCH_ABORTED,
} from './opfsMessages.js';
export type { OpfsMessageType } from './opfsMessages.js';
export type { WriteToOpfsOptions } from './opfsWrite.js';

const HEADER_IF_RANGE = 'If-Range';

export interface OpfsServeRangeOptions {
    /**
     * Порядок выполнения плагина (по умолчанию -15).
     */
    order?: number;
    /**
     * Включить логирование (по умолчанию false).
     */
    enableLogging?: boolean;
    /**
     * Маски URL для обработки (glob по pathname). Если задано — обрабатываются только совпадения.
     */
    include?: string[];
    /**
     * Маски URL для исключения (glob по pathname).
     */
    exclude?: string[];
    /**
     * Cache-Control для ответов 206 (по умолчанию `max-age=31536000, immutable`).
     */
    rangeResponseCacheControl?: string;
}

function ifRangeMatches(
    ifRangeValue: string,
    meta: { etag?: string; lastModified?: string }
): boolean {
    const value = ifRangeValue.trim();
    if (!value) {
        return false;
    }
    if (meta.lastModified) {
        const ifRangeDate = Date.parse(value);
        if (!Number.isNaN(ifRangeDate)) {
            const storedDate = Date.parse(meta.lastModified);
            return !Number.isNaN(storedDate) && ifRangeDate === storedDate;
        }
    }
    if (meta.etag) {
        const normalizeEtag = (s: string) =>
            s
                .replace(/^\s*W\//i, '')
                .replace(/^"|"$/g, '')
                .trim();
        return normalizeEtag(value) === normalizeEtag(meta.etag);
    }
    return false;
}

/**
 * Плагин: перехватывает GET с Range и отдаёт диапазон из OPFS.
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Все файлы — в папке OPFS_FOLDER_NAME. Очистка — clearOpfsCache().
 */
export function opfsServeRange(
    options: OpfsServeRangeOptions = {}
): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const {
        order = -15,
        enableLogging = false,
        include,
        exclude,
        rangeResponseCacheControl = 'max-age=31536000, immutable',
    } = options;

    return {
        name: 'opfs-serve-range',
        order,

        async fetch(
            event: FetchEvent,
            context: PluginContext
        ): Promise<Response | undefined> {
            const logger = context.logger ?? console;
            const request = event.request;
            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                return;
            }
            if (request.method !== 'GET') {
                return;
            }
            if (!shouldProcessFile(request.url, include, exclude)) {
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: skip ${request.url} (filtered by include/exclude)`
                    );
                }
                return;
            }

            const url = request.url;
            let key: string;
            try {
                key = await urlToOpfsKey(url);
            } catch (err) {
                if (enableLogging) {
                    logger.error(`opfsServeRange: hash failed for ${url}`, err);
                }
                return;
            }

            const root = await getRoot();
            let dir: FileSystemDirectoryHandle;
            try {
                dir = await getOpfsDir(root, false);
            } catch {
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: no plugin dir in OPFS for ${url}`
                    );
                }
                return;
            }

            let fileHandle: FileSystemFileHandle;
            try {
                fileHandle = await dir.getFileHandle(key);
            } catch {
                if (enableLogging) {
                    logger.debug(`opfsServeRange: no file in OPFS for ${url}`);
                }
                return;
            }

            const file = await fileHandle.getFile();
            const { metadata, bodySize } = await readFooter(file);
            const size = metadata?.size ?? bodySize;
            const type = metadata?.type ?? MIME_APPLICATION_OCTET_STREAM;

            const ifRangeHeader = request.headers.get(HEADER_IF_RANGE);
            if (
                ifRangeHeader &&
                metadata &&
                !ifRangeMatches(ifRangeHeader, metadata)
            ) {
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: If-Range mismatch for ${url}, passing through`
                    );
                }
                return;
            }

            try {
                const range = parseRangeHeader(rangeHeader, size);

                const rangeStream = createFileRangeStream(file, range);
                const response = build206ResponseFromStream(
                    rangeStream,
                    range,
                    size,
                    {
                        type,
                        ...(metadata?.etag && { etag: metadata.etag }),
                        ...(metadata?.lastModified && {
                            lastModified: metadata.lastModified,
                        }),
                        ...(rangeResponseCacheControl && {
                            cacheControl: rangeResponseCacheControl,
                        }),
                    }
                );
                if (
                    metadata?.evictable !== false &&
                    event.waitUntil
                ) {
                    event.waitUntil(
                        updateEvictionIndexLastAccessed(dir, key, Date.now())
                    );
                }

                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: 206 for ${url} bytes ${range.start}-${range.end}`
                    );
                }

                return response;
            } catch (err) {
                if (enableLogging) {
                    logger.error(`opfsServeRange: error for ${url}`, err);
                }
                return;
            }
        },
    };
}

export {
    parseRangeHeader,
    build206Response,
    build206ResponseFromStream,
    createFileRangeStream,
    createRangeExtractTransform,
} from './opfsRangeUtil.js';
export type { RangeSpec, Build206Options } from './opfsRangeUtil.js';
export { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
export { opfsRangeFromNetworkAndCache } from './opfsRangeFromNetworkAndCache.js';
export type { OpfsRangeFromNetworkAndCacheOptions } from './opfsRangeFromNetworkAndCache.js';
export { opfsBackgroundFetch } from './opfsBackgroundFetch.js';
export type { OpfsBackgroundFetchOptions } from './opfsBackgroundFetch.js';
