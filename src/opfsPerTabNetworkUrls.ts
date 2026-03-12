/**
 * Учёт «один источник на URL на вкладку» для обхода Chromium bug #1026867:
 * если вкладка уже получала ответ по URL из сети, не переключать на кеш (OPFS) до перезагрузки.
 * @see https://bugs.chromium.org/p/chromium/issues/detail?id=1026867
 * @see https://github.com/budarin/psw-plugin-serve-range-requests
 */

const MAX_PATHNAMES_PER_CLIENT = 512;

/** По clientId — pathname'ы, по которым этому клиенту уже отдавали ответ из сети (passthrough). */
const urlsServedFromNetworkByClient = new Map<string, Set<string>>();

function getOrCreateSetForClient(clientId: string): Set<string> {
    let set = urlsServedFromNetworkByClient.get(clientId);
    if (!set) {
        set = new Set<string>();
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
export function addUrlServedFromNetwork(clientId: string, pathname: string): void {
    if (!clientId) {
        return;
    }
    getOrCreateSetForClient(clientId).add(pathname);
}

/**
 * Возвращает true, если для данной вкладки по pathname уже отдавали ответ из сети.
 * В этом случае не отдавать из OPFS (passthrough), чтобы не переключать источник (Chromium bug).
 */
export function isUrlServedFromNetworkForClient(clientId: string, pathname: string): boolean {
    if (!clientId) {
        return false;
    }
    return urlsServedFromNetworkByClient.get(clientId)?.has(pathname) ?? false;
}
