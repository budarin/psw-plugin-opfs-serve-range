/**
 * Плагин управления кэшем по сообщениям от клиента: delete, has, list, clear.
 * Клиент шлёт request с requestId; плагин выполняет операцию в OPFS и инвалидирует кэши, отвечает response.
 */

import type { Plugin } from '@budarin/pluggable-serviceworker';
import type { FolderName, Pathname, UrlString } from './types.js';
import {
    getRegisteredFolderNames,
    getOpfsDir,
    getFlatStoreDir,
    clearOpfsCache,
    getRoot,
} from './opfsUtil.js';
import { urlToOpfsKey } from './opfsKey.js';
import { ensureCachesPopulated, removeFromEvictionIndex } from './opfsEvictionIndex.js';
import { getMetadataCache } from './opfsMetadataCache.js';
import { readMetadataFromFileFooter } from './opfsFormat.js';
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
} from './opfsMessages.js';
import { removeUrlServedFromNetwork } from './opfsPerTabNetworkUrls.js';

interface CacheControlPayload {
    type?: string;
    requestId?: string;
    url?: UrlString;
    folderName?: FolderName;
    pathname?: Pathname;
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
            const source = event.source;

            if (data?.type === OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK) {
                const pathname = data.pathname;
                const requestId = data.requestId;
                const clientId = (source as Client | undefined)?.id;
                if (
                    typeof pathname === 'string' &&
                    pathname.length > 0 &&
                    typeof clientId === 'string'
                ) {
                    removeUrlServedFromNetwork(clientId, pathname as Pathname);
                }
                if (typeof requestId === 'string') {
                    sendResponse(source, OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK, {
                        requestId,
                    });
                }
                return;
            }

            if (data?.requestId == null) {
                return;
            }
            const { requestId, folderName } = data;

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
                    const dir = await getFlatStoreDir();
                    try {
                        await dir.removeEntry(key);
                    } catch {
                        // файла нет — не ошибка
                    }
                    await removeFromEvictionIndex(dir, [key], getRegisteredFolderNames());
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

            if (typeof folderName !== 'string' || folderName.trim() === '') {
                const err = 'opfs: folderName required';
                if (data.type === OPFS_REQUEST_HAS_IN_CACHE) {
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
                if (data.type === OPFS_REQUEST_HAS_IN_CACHE) {
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
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, false, folder);
                    await ensureCachesPopulated(dir);
                    const metaCache = getMetadataCache();
                    const entry = metaCache?.get(key);
                    if (entry !== undefined && entry.folderName === folder) {
                        sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                            requestId,
                            has: true,
                        });
                        return;
                    }
                    try {
                        const fileHandle = await dir.getFileHandle(key);
                        const file = await fileHandle.getFile();
                        const { metadata } = await readMetadataFromFileFooter(file);
                        sendResponse(source, OPFS_RESPONSE_HAS_IN_CACHE, {
                            requestId,
                            has: metadata?.folderName === folder,
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

            /** LIST: список строится из in-memory metadata cache; перед этим вызывается ensureCachesPopulated(dir), при первом запросе после старта SW выполняется скан каталога. */
            if (data.type === OPFS_REQUEST_LIST_CACHED_RESOURCES) {
                try {
                    const root = await getRoot();
                    const dir = await getOpfsDir(root, false, folder);
                    await ensureCachesPopulated(dir);
                    const metaCache = getMetadataCache();
                    const resources: ListResource[] = [];
                    for (const [, entry] of metaCache?.getEntriesByFolder(folder) ?? []) {
                        if (entry.url != null) {
                            resources.push({
                                url: entry.url,
                                size: entry.fullSize,
                                type: entry.type,
                                lastModified: entry.lastModified,
                            });
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
