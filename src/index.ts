/**
 * Плагин Service Worker: отдаёт HTTP Range-запросы из OPFS (Origin Private File System).
 * Ключ файла: key = hex(SHA-256(URL)). Один файл на ресурс: [тело][4 байта длина мета][JSON мета].
 * Очистка = удалить один файл, мусора нет.
 */

import type { Logger, Plugin } from '@budarin/pluggable-serviceworker';

import {
    HEADER_RANGE,
    HEADER_CONTENT_TYPE,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_LENGTH,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';

import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import {
    OPFS_META_FOOTER_LENGTH,
    MAX_META_JSON_BYTES,
    type OpfsMetadata,
} from './opfsFormat.js';
import { getOpfsDir, shouldProcessFile } from './opfsUtil.js';

export {
    OPFS_META_FOOTER_LENGTH,
    OPFS_FOLDER_NAME,
    type OpfsMetadata,
} from './opfsFormat.js';
export { getOpfsDir, clearOpfsCache, configureOpfs } from './opfsUtil.js';

const HEADER_ACCEPT_RANGES = 'Accept-Ranges';
const HEADER_IF_RANGE = 'If-Range';

interface Range {
    start: number;
    end: number;
}

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

const urlToKeyCache = new Map<string, string>();

/**
 * Вычисляет ключ файла в OPFS по URL: hex(SHA-256(URL)).
 * Результат кешируется в памяти на время жизни воркера — повторные запросы по одному URL не пересчитывают хеш.
 * Плагин кеширования в OPFS должен использовать ту же функцию для записи.
 */
export async function urlToOpfsKey(url: string): Promise<string> {
    const cached = urlToKeyCache.get(url);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = new TextEncoder().encode(url);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const key = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    urlToKeyCache.set(url, key);
    return key;
}

function parseRangeHeader(rangeHeader: string, fullSize: number): Range {
    const trimmed = rangeHeader.trim();

    const suffixMatch = /^bytes=-(\d+)$/.exec(trimmed);
    if (suffixMatch) {
        const suffixLength = parseInt(suffixMatch[1]!, 10);
        if (isNaN(suffixLength) || suffixLength <= 0) {
            throw new Error('Invalid suffix range value');
        }
        const start = Math.max(0, fullSize - suffixLength);
        const end = fullSize - 1;
        return { start, end };
    }

    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(trimmed);
    if (!rangeMatch) {
        throw new Error('Invalid or unsupported range header format');
    }

    const start = parseInt(rangeMatch[1]!, 10);
    const end = rangeMatch[2]
        ? parseInt(rangeMatch[2], 10)
        : fullSize - 1;

    if (isNaN(start) || isNaN(end)) {
        throw new Error('Invalid range values');
    }
    if (start < 0 || start >= fullSize) {
        throw new Error('Range start is out of bounds');
    }
    if (end < start || end >= fullSize) {
        throw new Error('Range end is out of bounds');
    }

    return { start, end };
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
            return (
                !Number.isNaN(storedDate) && ifRangeDate === storedDate
            );
        }
    }
    if (meta.etag) {
        const normalizeEtag = (s: string) =>
            s.replace(/^\s*W\//i, '').replace(/^"|"$/g, '').trim();
        return normalizeEtag(value) === normalizeEtag(meta.etag);
    }
    return false;
}

/**
 * Читает метаданные из конца файла: последние 4 байта = длина JSON (uint32 LE), перед ними — JSON.
 * Если футер отсутствует или невалиден, возвращаем bodySize = file.size, metadata = undefined.
 */
async function getMetadataFromFileFooter(
    file: File
): Promise<{ metadata: OpfsMetadata | undefined; bodySize: number }> {
    const size = file.size;
    if (size < OPFS_META_FOOTER_LENGTH) {
        return { metadata: undefined, bodySize: size };
    }
    const footerBlob = file.slice(size - OPFS_META_FOOTER_LENGTH, size);
    const footerBuf = await footerBlob.arrayBuffer();
    const metaLen = new DataView(footerBuf).getUint32(0, true);
    if (
        metaLen === 0 ||
        metaLen > MAX_META_JSON_BYTES ||
        metaLen > size - OPFS_META_FOOTER_LENGTH
    ) {
        return { metadata: undefined, bodySize: size };
    }
    try {
        const jsonBlob = file.slice(
            size - OPFS_META_FOOTER_LENGTH - metaLen,
            size - OPFS_META_FOOTER_LENGTH
        );
        const text = await jsonBlob.text();
        const metadata = JSON.parse(text) as OpfsMetadata;
        const bodySize = size - OPFS_META_FOOTER_LENGTH - metaLen;
        return { metadata, bodySize };
    } catch {
        return { metadata: undefined, bodySize: size };
    }
}

/**
 * Плагин: перехватывает GET с Range и отдаёт диапазон из OPFS.
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Все файлы — в папке OPFS_FOLDER_NAME. Очистка — clearOpfsCache().
 */
export function opfsServeRange(
    options: OpfsServeRangeOptions = {}
): Plugin {
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
            logger: Logger
        ): Promise<Response | undefined> {
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

            const root = await navigator.storage.getDirectory();
            let dir: FileSystemDirectoryHandle;
            try {
                dir = await getOpfsDir(root, false);
            } catch {
                if (enableLogging) {
                    logger.debug(`opfsServeRange: no plugin dir in OPFS for ${url}`);
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
            const { metadata, bodySize } =
                await getMetadataFromFileFooter(file);
            const size = metadata?.size ?? bodySize;
            const type =
                metadata?.type ?? MIME_APPLICATION_OCTET_STREAM;

            const ifRangeHeader = request.headers.get(HEADER_IF_RANGE);
            if (ifRangeHeader && metadata && !ifRangeMatches(ifRangeHeader, metadata)) {
                if (enableLogging) {
                    logger.debug(
                        `opfsServeRange: If-Range mismatch for ${url}, passing through`
                    );
                }
                return;
            }

            try {
                const range = parseRangeHeader(rangeHeader, size);

                // Blob.slice(start, end): end exclusive → для [start, end] inclusive используем end + 1
                const blob = file.slice(range.start, range.end + 1);

                const contentRange = `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`;
                const headers = new Headers({
                    [HEADER_CONTENT_RANGE]: contentRange,
                    [HEADER_CONTENT_LENGTH]: String(blob.size),
                    [HEADER_CONTENT_TYPE]: type,
                    [HEADER_ACCEPT_RANGES]: 'bytes',
                });
                if (rangeResponseCacheControl) {
                    headers.set('Cache-Control', rangeResponseCacheControl);
                }
                if (metadata?.etag) {
                    headers.set(HEADER_ETAG, metadata.etag);
                }
                if (metadata?.lastModified) {
                    headers.set(HEADER_LAST_MODIFIED, metadata.lastModified);
                }

                const response = new Response(blob, {
                    status: HTTP_STATUS_PARTIAL_CONTENT,
                    headers,
                });

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

export { writeToOpfs, metadataFromResponse } from './opfsWrite.js';
export { opfsPrecache } from './opfsPrecache.js';
export type { OpfsPrecacheOptions } from './opfsPrecache.js';
export { opfsCacheOnFetch } from './opfsCacheOnFetch.js';
export type { OpfsCacheOnFetchOptions } from './opfsCacheOnFetch.js';
