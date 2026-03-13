/**
 * Учёт «один источник на URL на вкладку» для обхода Chromium bug #1026867:
 * если вкладка уже получала ответ по URL из сети, не переключать на кеш (OPFS) до перезагрузки.
 * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
 * @see https://github.com/budarin/psw-plugin-serve-range-requests
 */

import type { Pathname } from './types.js';

const MAX_PATHNAMES_PER_CLIENT = 512;

/** По clientId — pathname'ы, по которым этому клиенту уже отдавали ответ из сети (passthrough). */
const urlsServedFromNetworkByClient = new Map<string, Set<Pathname>>();

function getOrCreateSetForClient(clientId: string): Set<Pathname> {
    let set = urlsServedFromNetworkByClient.get(clientId);
    if (!set) {
        set = new Set<Pathname>();
        urlsServedFromNetworkByClient.set(clientId, set);
    }
    if (set.size >= MAX_PATHNAMES_PER_CLIENT) {
        const first = set.values().next().value;
        if (first !== undefined) {
            set.delete(first);
        }
    }
    return set;
}

/**
 * Отмечает, что для данной вкладки (clientId) по pathname уже отдан ответ из сети.
 * Вызывать при возврате клиенту ответа, полученного через fetch (network).
 */
export function addUrlServedFromNetwork(clientId: string, pathname: Pathname): void {
    if (!clientId) {
        return;
    }
    getOrCreateSetForClient(clientId).add(pathname);
}

/**
 * Возвращает true, если для данной вкладки по pathname уже отдавали ответ из сети.
 * В этом случае не отдавать из OPFS (passthrough), чтобы не переключать источник (Chromium bug).
 */
export function isUrlServedFromNetworkForClient(clientId: string, pathname: Pathname): boolean {
    if (!clientId) {
        return false;
    }
    return urlsServedFromNetworkByClient.get(clientId)?.has(pathname) ?? false;
}

/**
 * Удаляет pathname из учёта «отдавали из сети» для данной вкладки.
 * Вызывать при явном переподключении плеера (reconnect), чтобы следующие запросы по этому URL
 * обслуживались из OPFS, если файл в кэше, либо из сети при passthrough.
 */
export function removeUrlServedFromNetwork(clientId: string, pathname: Pathname): void {
    if (!clientId) {
        return;
    }
    urlsServedFromNetworkByClient.get(clientId)?.delete(pathname);
}
