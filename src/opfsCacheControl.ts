/**
 * Плагин управления кэшем по сообщениям от клиента: delete, has, list, clear.
 * Клиент шлёт request с requestId; плагин выполняет операцию в OPFS и инвалидирует кэши, отвечает response.
 */

import type { Plugin } from '@budarin/pluggable-serviceworker';
import type { FolderName, UrlString } from './types.js';
import {
    getRegisteredFolderNames,
    getOpfsDir,
    clearOpfsCache,
    getRoot,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import { removeFromEvictionIndex } from './opfsEvictionIndex.js';
import { getMetadataCache } from './opfsMetadataCache.js';
import { readMetadataFromFileFooter } from './opfsFormat.js';
import { EVICTION_INDEX_FILENAME } from './opfsEvictionIndex.js';
import {
    OPFS_REQUEST_DELETE_FROM_CACHE,
    OPFS_RESPONSE_DELETE_FROM_CACHE,
    OPFS_REQUEST_HAS_IN_CACHE,
    OPFS_RESPONSE_HAS_IN_CACHE,
    OPFS_REQUEST_LIST_CACHED_RESOURCES,
    OPFS_RESPONSE_LIST_CACHED_RESOURCES,
    OPFS_REQUEST_CLEAR_CACHE,
    OPFS_RESPONSE_CLEAR_CACHE,
} from './opfsMessages.js';

interface CacheControlPayload {
    type?: string;
    requestId?: string;
    url?: UrlString;
    folderName?: FolderName;
}

interface ListResource {
    url: UrlString;
    size: number;
    type?: string | undefined;
    lastModified?: string | undefined;
}

function sendResponse(
    source: Client | ServiceWorker | MessagePort | null,
    type: string,
    payload: Record<string, unknown>
): void {
    const target = source as { postMessage?(msg: unknown): void } | null;
    if (target?.postMessage != null) {
        target.postMessage({ type, ...payload });
    }
}

function isFolderRegistered(folderName: string): boolean {
    return getRegisteredFolderNames().includes(folderName);
}

/**
 * Плагин: на сообщения OPFS_REQUEST_*_CACHE выполняет операцию и отвечает OPFS_RESPONSE_*.
 */
export function opfsCacheControl(): Plugin | undefined {
    return {
        name: 'opfs-cache-control',
        order: 0,

        async message(event): Promise<void> {
            const data = event.data as CacheControlPayload | null;
            if (data?.requestId == null) {
                return;
            }
            const source = event.source;
            const { requestId, folderName } = data;

            if (typeof folderName !== 'string' || folderName.trim() === '') {
                const err = 'opfs: folderName required';
                if (data.type === OPFS_REQUEST_DELETE_FROM_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_DELETE_FROM_CACHE, {
                        requestId,
                        ok: false,
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_HAS_IN_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                        requestId,
                        has: false,
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_LIST_CACHED_RESOURCES) {
                    sendResponse(source, OPFS_RESPONSE_LIST_CACHED_RESOURCES, {
                        requestId,
                        resources: [],
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_CLEAR_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_CLEAR_CACHE, {
                        requestId,
                        ok: false,
                        error: err,
                    });
                }
                return;
            }

            if (!isFolderRegistered(folderName)) {
                const err = 'opfs: folder not registered';
                if (data.type === OPFS_REQUEST_DELETE_FROM_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_DELETE_FROM_CACHE, {
                        requestId,
                        ok: false,
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_HAS_IN_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                        requestId,
                        has: false,
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_LIST_CACHED_RESOURCES) {
                    sendResponse(source, OPFS_RESPONSE_LIST_CACHED_RESOURCES, {
                        requestId,
                        resources: [],
                        error: err,
                    });
                } else if (data.type === OPFS_REQUEST_CLEAR_CACHE) {
                    sendResponse(source, OPFS_RESPONSE_CLEAR_CACHE, {
                        requestId,
                        ok: false,
                        error: err,
                    });
                }
                return;
            }

            const folder = folderName as FolderName;

            if (data.type === OPFS_REQUEST_DELETE_FROM_CACHE) {
                const url = data.url;
                if (typeof url !== 'string' || url.trim() === '') {
                    sendResponse(source, OPFS_RESPONSE_DELETE_FROM_CACHE, {
                        requestId,
                        ok: false,
                        error: 'opfs: url required',
                    });
                    return;
                }
                try {
                    const key = await urlToOpfsKey(url as UrlString);
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, false, folder);
                    try {
                        await dir.removeEntry(key);
                    } catch {
                        // файла нет — не ошибка
                    }
                    await removeFromEvictionIndex(dir, [key], folder);
                    sendResponse(source, OPFS_RESPONSE_DELETE_FROM_CACHE, {
                        requestId,
                        ok: true,
                    });
                } catch (err) {
                    sendResponse(source, OPFS_RESPONSE_DELETE_FROM_CACHE, {
                        requestId,
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                return;
            }

            if (data.type === OPFS_REQUEST_HAS_IN_CACHE) {
                const url = data.url;
                if (typeof url !== 'string' || url.trim() === '') {
                    sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                        requestId,
                        has: false,
                        error: 'opfs: url required',
                    });
                    return;
                }
                try {
                    const key = await urlToOpfsKey(url as UrlString);
                    const metaCache = getMetadataCache(folder);
                    if (metaCache?.get(key) !== undefined) {
                        sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                            requestId,
                            has: true,
                        });
                        return;
                    }
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, false, folder);
                    try {
                        await dir.getFileHandle(key);
                        sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                            requestId,
                            has: true,
                        });
                    } catch {
                        sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                            requestId,
                            has: false,
                        });
                    }
                } catch (err) {
                    sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                        requestId,
                        has: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                return;
            }

            if (data.type === OPFS_REQUEST_LIST_CACHED_RESOURCES) {
                try {
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, false, folder);
                    const resources: ListResource[] = [];
                    for await (const [name, handle] of dir.entries()) {
                        if (
                            name === EVICTION_INDEX_FILENAME ||
                            handle.kind !== 'file'
                        ) {
                            continue;
                        }
                        try {
                            const file = await (handle as FileSystemFileHandle).getFile();
                            const { metadata } = await readMetadataFromFileFooter(file);
                            if (metadata?.url) {
                                resources.push({
                                    url: metadata.url,
                                    size: metadata.size ?? file.size,
                                    type: metadata.type,
                                    lastModified: metadata.lastModified,
                                });
                            }
                        } catch {
                            // пропустить битый файл
                        }
                    }
                    sendResponse(source, OPFS_RESPONSE_LIST_CACHED_RESOURCES, {
                        requestId,
                        resources,
                    });
                } catch (err) {
                    sendResponse(source, OPFS_RESPONSE_LIST_CACHED_RESOURCES, {
                        requestId,
                        resources: [],
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                return;
            }

            if (data.type === OPFS_REQUEST_CLEAR_CACHE) {
                try {
                    await clearOpfsCache(folder);
                    sendResponse(source, OPFS_RESPONSE_CLEAR_CACHE, {
                        requestId,
                        ok: true,
                    });
                } catch (err) {
                    sendResponse(source, OPFS_RESPONSE_CLEAR_CACHE, {
                        requestId,
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        },
    };
}
