/**
 * Плагин: перехватывает GET с Range и отдаёт диапазон из OPFS.
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Папка задаётся опцией folderName.
 */

import type { Logger, Plugin, PluginContext } from '@budarin/pluggable-serviceworker';
import { HEADER_RANGE } from '@budarin/http-constants/headers';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

import type { FolderName, OpfsKey, UrlString } from './types.js';
import { readMetadataFromFileFooter as readFooter } from './opfsFormat.js';
import {
    emitDroppedPatternWarnings,
    getFlatStoreDir,
    invalidateAllCachesAndPluginRoot,
    invalidateCachesForFileKeyOnError,
    isOpfsAvailable,
    normalizePatternList,
    registerFolderConfig,
    shouldProcessFile,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import {
    getOrCreateMetadataCache,
    type MetadataCacheImpl,
    type OpfsMetadataCacheEntry,
} from './opfsMetadataCache.js';
import {
    parseRangeHeader,
    build206ResponseFromStream,
    createFileRangeStream,
} from './opfsRangeUtil.js';
import { updateEvictionIndexLastAccessed } from './opfsEvictionIndex.js';
import {
    addUrlServedFromNetwork,
    isUrlServedFromNetworkForClient,
} from './opfsPerTabNetworkUrls.js';
import { OPFS_RANGE_LOG_SW } from './opfsLog.js';

const HEADER_IF_RANGE = 'If-Range';

/** Параллельные fetch с одним opfsKey до появления записи в metadata cache — одно чтение футера. */
const metadataFooterInflight = new Map<
    OpfsKey,
    Promise<{ meta: OpfsMetadataCacheEntry; file: File }>
>();

class OpfsMetadataInflightError extends Error {
    readonly code: 'no_file' | 'read_error' | 'folder_mismatch';

    constructor(code: 'no_file' | 'read_error' | 'folder_mismatch') {
        super(code);
        this.name = 'OpfsMetadataInflightError';
        this.code = code;
    }
}

function startMetadataFooterInflight(
    metadataCache: MetadataCacheImpl,
    dir: FileSystemDirectoryHandle,
    key: OpfsKey,
    folderName: FolderName
): Promise<{ meta: OpfsMetadataCacheEntry; file: File }> {
    const p = (async () => {
        try {
            let fileHandle: FileSystemFileHandle;
            try {
                fileHandle = await dir.getFileHandle(key);
            } catch {
                throw new OpfsMetadataInflightError('no_file');
            }
            let file: File;
            let footer: Awaited<ReturnType<typeof readFooter>>;
            try {
                file = await fileHandle.getFile();
                footer = await readFooter(file);
            } catch {
                throw new OpfsMetadataInflightError('read_error');
            }
            const { metadata, bodySize } = footer;
            if (metadata?.folderName !== folderName) {
                throw new OpfsMetadataInflightError('folder_mismatch');
            }
            const size = metadata?.size ?? bodySize;
            const meta: OpfsMetadataCacheEntry = {
                fullSize: size,
                type: metadata?.type ?? MIME_APPLICATION_OCTET_STREAM,
                folderName: metadata?.folderName,
                url: metadata?.url,
                ...(metadata?.etag && { etag: metadata.etag }),
                ...(metadata?.lastModified && {
                    lastModified: metadata.lastModified,
                }),
                ...(metadata?.evictable !== undefined && {
                    evictable: metadata.evictable,
                }),
            };
            metadataCache.set(key, meta);
            return { meta, file };
        } finally {
            metadataFooterInflight.delete(key);
        }
    })();
    return p;
}

export interface OpfsServeRangeOptions {
    /**
     * Имя папки в OPFS для этого кеша (обязательно). Одна папка — одна регистрация в реестре.
     */
    folderName: FolderName;
    /**
     * Порядок выполнения плагина (по умолчанию -15).
     */
    order?: number;
    /**
     * Включить отладочное логирование (по умолчанию false).
     */
    debug?: boolean;
    /**
     * Логгер для этапа инициализации (например, варнинги по отброшенным паттернам include/exclude).
     * По умолчанию используется console.
     */
    logger?: Logger;
    /**
     * Маски URL для обработки (glob/pathname). Обязательно, непустой массив.
     */
    include: string[];
    /**
     * Маски URL для исключения (glob по pathname).
     */
    exclude?: string[];
    /**
     * Cache-Control для ответов 206 (по умолчанию пустая строка — не кэшировать диапазоны в HTTP-кеше браузера).
     */
    rangeResponseCacheControl?: string;
}

/** Опции для сборки аргумента opfsServeRange из фабрик (подмножество опций пары плагинов, без pinned). */
export interface ServeOptionsFromFactory {
    folderName: FolderName;
    include: string[];
    exclude?: string[];
    debug?: boolean;
    logger?: Logger;
    order?: number;
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
 * Один файл на URL: [тело][4 байта длина][JSON мета]. Папка задаётся опцией folderName. Очистка — clearOpfsCache(folderName).
 */
export function opfsServeRange(options: OpfsServeRangeOptions): Plugin | undefined {
    if (!isOpfsAvailable()) {
        return undefined;
    }
    const baseOrigin = typeof self !== 'undefined' ? self.origin : '';
    const {
        folderName,
        order = -15,
        debug = false,
        include,
        exclude,
        logger = console,
        rangeResponseCacheControl = '',
    } = options;
    if (include == null || !Array.isArray(include) || include.length === 0) {
        throw new Error('opfs: include is required and must be a non-empty array');
    }
    const inc = normalizePatternList(include, baseOrigin);
    const exc = normalizePatternList(exclude, baseOrigin);
    const normalizedInclude = inc.list;
    const normalizedExclude = exc.list;
    if (normalizedInclude == null || normalizedInclude.length === 0) {
        return undefined;
    }
    const droppedForLogger: { crossOrigin: string[]; invalid: string[] } = {
        crossOrigin: [...(inc.dropped.crossOrigin ?? []), ...(exc.dropped.crossOrigin ?? [])],
        invalid: [...(inc.dropped.invalid ?? []), ...(exc.dropped.invalid ?? [])],
    };
    emitDroppedPatternWarnings(droppedForLogger, logger);

    registerFolderConfig(folderName);
    getOrCreateMetadataCache(folderName);

    return {
        name: 'opfs-serve-range',
        order,

        async fetch(
            event: FetchEvent,
            context: PluginContext
        ): Promise<Response | undefined> {
            const { logger } = context;
            const request = event.request;
            const rangeHeader = request.headers.get(HEADER_RANGE);

            if (!rangeHeader) {
                return;
            }
            if (request.method !== 'GET') {
                return;
            }
            if (!shouldProcessFile(request.url, normalizedInclude, normalizedExclude)) {
                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}skip ${request.url} (filtered by include/exclude)`
                    );
                }
                return;
            }

            if (!event.clientId) {
                return;
            }

            const pathname = new URL(request.url).pathname;
            const url = request.url;
            const urlForOpfsKey = ((): UrlString => {
                const u = new URL(request.url);
                u.search = '';
                u.hash = '';
                return u.href as UrlString;
            })();
            let key: string;
            try {
                key = await urlToOpfsKey(urlForOpfsKey);
            } catch (err) {
                logger.error(`hash failed for ${url}`, err);
                return;
            }

            let dir: FileSystemDirectoryHandle;
            try {
                dir = await getFlatStoreDir();
            } catch {
                invalidateAllCachesAndPluginRoot();
                addUrlServedFromNetwork(event.clientId, pathname);
                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}no plugin dir in OPFS for ${url}`
                    );
                }
                return;
            }

            const metadataCache = getOrCreateMetadataCache(folderName);
            let cachedMeta = metadataCache.get(key);
            let file: File | undefined;

            if (cachedMeta === undefined) {
                let inflight = metadataFooterInflight.get(key);
                if (inflight === undefined) {
                    inflight = startMetadataFooterInflight(
                        metadataCache,
                        dir,
                        key,
                        folderName
                    );
                    metadataFooterInflight.set(key, inflight);
                }
                try {
                    const loaded = await inflight;
                    cachedMeta = loaded.meta;
                    file = loaded.file;
                } catch (err) {
                    if (err instanceof OpfsMetadataInflightError) {
                        if (err.code === 'folder_mismatch') {
                            addUrlServedFromNetwork(event.clientId, pathname);
                            if (debug) {
                                logger.debug(
                                    `${OPFS_RANGE_LOG_SW}file in OPFS but folderName mismatch for ${url}`
                                );
                            }
                            return;
                        }
                        await invalidateCachesForFileKeyOnError(
                            dir,
                            folderName,
                            key
                        );
                        addUrlServedFromNetwork(event.clientId, pathname);
                        if (debug) {
                            logger.debug(
                                err.code === 'no_file'
                                    ? `${OPFS_RANGE_LOG_SW}no file in OPFS for ${url}`
                                    : `${OPFS_RANGE_LOG_SW}file read error for ${url}`
                            );
                        }
                        return;
                    }
                    throw err;
                }
            }

            const meta = cachedMeta;
            if (meta.folderName !== folderName) {
                addUrlServedFromNetwork(event.clientId, pathname);
                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}cached file folderName mismatch for ${url}`
                    );
                }
                return;
            }
            const size = meta.fullSize;
            const type = meta.type;

            if (isUrlServedFromNetworkForClient(event.clientId, pathname)) {
                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}${pathname} already served from network for this client, passthrough (Chromium bug workaround)`
                    );
                }
                return;
            }

            const ifRangeHeader = request.headers.get(HEADER_IF_RANGE);
            if (
                ifRangeHeader &&
                !ifRangeMatches(ifRangeHeader, {
                    ...(meta.etag !== undefined && { etag: meta.etag }),
                    ...(meta.lastModified !== undefined && {
                        lastModified: meta.lastModified,
                    }),
                })
            ) {
                addUrlServedFromNetwork(event.clientId, pathname);
                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}If-Range mismatch for ${url}, passing through`
                    );
                }
                return;
            }

            try {
                const range = parseRangeHeader(rangeHeader, size);

                if (file === undefined) {
                    const fileHandle = await dir.getFileHandle(key);
                    file = await fileHandle.getFile();
                }
                const rangeStream = createFileRangeStream(file, range);
                const response = build206ResponseFromStream(
                    rangeStream,
                    range,
                    size,
                    {
                        type,
                        ...(meta.etag && { etag: meta.etag }),
                        ...(meta.lastModified && {
                            lastModified: meta.lastModified,
                        }),
                        ...(rangeResponseCacheControl && {
                            cacheControl: rangeResponseCacheControl,
                        }),
                    }
                );
                if (
                    meta.evictable !== false &&
                    event.waitUntil
                ) {
                    event.waitUntil(
                        updateEvictionIndexLastAccessed(dir, folderName, key, Date.now())
                    );
                }

                if (debug) {
                    logger.debug(
                        `${OPFS_RANGE_LOG_SW}206 for ${url} bytes ${range.start}-${range.end}`
                    );
                }

                return response;
            } catch (err) {
                await invalidateCachesForFileKeyOnError(dir, folderName, key);
                addUrlServedFromNetwork(event.clientId, pathname);
                logger.error(`error for ${url}`, err);
                return;
            }
        },
    };
}

/**
 * Собирает опции для opfsServeRange из опций фабрики (без pinned и прочих полей, относящихся только к другим плагинам).
 */
export function buildServeOptions(
    options: ServeOptionsFromFactory,
    defaultOrder: number
): OpfsServeRangeOptions {
    const order = options.order ?? defaultOrder;
    return {
        folderName: options.folderName,
        include: options.include,
        order,
        ...(options.exclude !== undefined && { exclude: options.exclude }),
        ...(options.debug !== undefined && { debug: options.debug }),
        ...(options.logger !== undefined && { logger: options.logger }),
        ...(options.rangeResponseCacheControl !== undefined && {
            rangeResponseCacheControl: options.rangeResponseCacheControl,
        }),
    };
}
