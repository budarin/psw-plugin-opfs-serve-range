# Project Reference

Project overview: flow, entry points, where things are, key decisions. Use when you need to understand how the project works (e.g. before refactoring core, adding events, or debugging init).

---

## Participants

- **Client** — page/player, sends fetch with Range; can subscribe to OPFS events via `@budarin/psw-plugin-opfs-serve-range/client`.
- **opfsServeRange** — serves 206 from OPFS when file exists; else returns `undefined`. **folderName** (required). Optional in-memory range cache (rangeCache: true | { maxSizeBytes?, maxEntries? }; limits from folder registry when omitted). When cache enabled: lookup by (opfsKey, start, end); hit → response from cache; miss → file.slice, cache.set, response. Updates `lastAccessed` in the eviction index in background (event.waitUntil). Options: folderName, include/exclude, rangeResponseCacheControl (default ''), rangeCache, order, debug, rangeCacheMaxSizeBytes?, rangeCacheMaxEntries?. Dir for serve path: **getFlatStoreDir()** (no per-folder path).
- **opfsRangeFromNetworkAndCache** — runs when opfsServeRange returned `undefined`: uses `context.fetchPassthrough(request)` for network, returns response to client, may start background full GET to OPFS. **folderName** (required). Options: folderName, include/exclude, pinned (glob → evictable: false), order, debug. Before caching without Content-Length checks **skip list** (isInSkipList); if URL in skip list, does not write and notifies clients (OPFS_MSG_SKIP_QUOTA_EXCEEDED).
- **opfsBackgroundFetch** — writes to OPFS on Background Fetch success; uses `context.fetchPassthrough` for requests. **folderName** (required). Same skip list check before write when no Content-Length. Options: folderName, include/exclude, pinned, order, debug.
- **opfsRegisteredFolders** — plugin that on client request (OPFS_REQUEST_GET_REGISTERED_FOLDERS) responds with the list of folder names registered in SW via registerFolderConfig. Used by client getRegisteredFolders() so startDownloadAssetsToOpfs can reject if folderName is not registered.
- **opfsCacheControl** — plugin that on client messages (OPFS_REQUEST_DELETE_FROM_CACHE, OPFS_REQUEST_HAS_IN_CACHE, OPFS_REQUEST_LIST_CACHED_RESOURCES, OPFS_REQUEST_CLEAR_CACHE, **OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK**) performs the operation in OPFS (or per-tab “served from network” state), invalidates in-memory caches as needed, and responds with the matching OPFS_RESPONSE_*. For **OPFS_REQUEST_CLEAR_SERVED_FROM_NETWORK** (pathname, optional requestId): removes pathname from “served from network” for that client; if requestId is present, replies **OPFS_RESPONSE_CLEAR_SERVED_FROM_NETWORK** with that requestId so the client can await before reloading the media element. Only registered folders are accepted for cache ops. Client utilities listOpfsCachedResources, hasInOpfsCache, deleteFromOpfsCache, clearOpfsCache send these requests (2 s timeout); **clearServedFromNetworkForReconnect(pathname)** sends CLEAR with requestId and returns a Promise that resolves when SW has processed it (or after 500 ms timeout).
- **Framework (psw)** — provides `context.fetchPassthrough`; when all plugins return `undefined`, uses it for the request.
- **Server** — origin for the URL.

## Entry points and exports

- **Main** (`package.json` exports `.`): opfsServeRange, urlToOpfsKey, opfsRangeFromNetworkAndCache, opfsBackgroundFetch, **opfsRegisteredFolders**, **opfsCacheControl**; **createOpfsServeAndBackgroundFetchPlugins(options)** (returns [opfsServeRange, opfsBackgroundFetchFilter, opfsRegisteredFolders, opfsCacheControl, opfsBackgroundFetch]), **createOpfsServeAndNetworkCachePlugins(options)** (returns [opfsServeRange, opfsCacheControl, opfsRangeFromNetworkAndCache]); re-exports from opfsFormat (OPFS_META_FOOTER_LENGTH, KILOBYTE, MEGABYTE, GIGABYTE, readMetadataFromFileFooter, OpfsMetadata, …), opfsUtil (getRoot, getFlatStoreDir, registerFolderConfig, getRegisteredFolderNames, getOpfsDir(root, create, folderName), clearOpfsCache(folderName), isOpfsAvailable, **getMaxCacheFraction()** (no arg; returns global fraction), getGlobalMaxCacheFraction(), setGlobalMaxCacheFraction(fraction), getRangeCacheMaxSizeBytes(folderName), getRangeCacheMaxEntries(folderName), isEvictable, OpfsConfigOptions, FolderCacheConfig), opfsKey (urlToOpfsKey), opfsRangeCache (getOrCreateRangeCache(folderName, limits), getRangeCache(folderName); **invalidateForKey** uses reverse index; types RangeCacheLimits, RangeCacheEntryMeta, RangeCacheBlobHit), opfsLru (isInSkipList, addToSkipList, getStorageEstimate, **getCacheLimit(estimate)**; types StorageEstimate, CacheFileEntry, EnsureSpaceResult), opfsMessages (message type constants, OpfsMessageType), opfsRangeUtil (parseRangeHeader, build206Response, build206ResponseFromStream, createRangeExtractTransform; RangeSpec, Build206Options), opfsWrite (writeToOpfs, metadataFromResponse, WriteToOpfsOptions with folderName).
- **Client** (`./client`): message type constants; handlers onOPFSQuotaExceeded, onOPFSWriteSkipped, onOPFSCacheLimitReached, onOPFSEvictionCompleted, onOPFSWriteFailed, onOPFSSkipQuotaExceeded, onOPFSBackgroundFetchFailed, onOPFSBackgroundFetchAborted, onOPFSBackgroundFetchCompleted, onOPFSBackgroundFetchFileWritten, onOPFSRangeCacheFetchStarted, onOPFSRangeCacheFetchAllDone; **listOpfsCachedResources(folderName)**, **hasInOpfsCache(url, folderName)**, **deleteFromOpfsCache(url)**, **clearOpfsCache(folderName)** — send requests to SW (opfsCacheControl), 2 s timeout; getBackgroundFetchFilter, **getRegisteredFolders**, filterAssetsForOpfs, **estimateAssetsSizeInBytes(assets)** (best-effort HEAD + `Content-Length` size estimation for same-origin URLs; missing/invalid header → size `0`, promise still resolves), startDownloadAssetsToOpfs (options include folderName; before starting checks folderName against SW-registered folders via getRegisteredFolders, rejects with OPFS_ERROR_FOLDER_NOT_REGISTERED or OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE); **reconnectPlayerOnFileLoadedIntoOpfs(element, payload, folderName, options?)** (call from onOPFSBackgroundFetchFileWritten to reconnect player when its source file is written to OPFS). Reconnect flow: **clearServedFromNetworkForReconnect(pathname)** (async, waits for SW ack), then sets element src to a cache-bust URL (`?opfs_reconnect=<timestamp>`) so Edge/Chromium request from the start; asset vs current src compared by normalized URL (no query/hash). Options: **ReconnectPlayerOnFileLoadedIntoOpfsOptions** with optional logger, debug. **FileWrittenPayload**, **ReconnectPlayerOnFileLoadedIntoOpfsOptions**; useDownloadAssetsToOpfs (hook); **OPFS_ERROR_FOLDER_NOT_REGISTERED**, **OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE**; OpfsMessagePayload, OpfsCachedResource.
- **Client React** (`./client/react`): useDownloadAssetsToOpfs; **useReconnectPlayerOnFileLoadedIntoOpfs(mediaRef, { folderName })**, **UseReconnectPlayerOnFileLoadedIntoOpfsOptions**.

## OPFS format

- **Key:** `hex(SHA-256(URL))`, one file per URL. Cached in worker via urlToOpfsKey(). **Serve path:** the key is computed from the request URL **without query and hash** (origin + pathname only) so cache-busted URLs (e.g. `?opfs_reconnect=<ts>` on reconnect) resolve to the same OPFS file.
- **File layout:** `[body][4 bytes meta length LE][JSON meta]`. Meta: url, size, type?, etag?, lastModified?, **lastAccessed?** (timestamp for LRU), **evictable?** (false = pinned, not evicted by LRU), **folderName?** (logical folder; used for serve/list/clear filtering).

**Storage structure (flat store, v4)**

- **Single directory:** All cached files live in one directory. Path: OPFS root → **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) → one dir. No subdirectories per folderName; file name = key (hex hash of URL).
- **folderName is logical only:** Stored in each file’s footer metadata. Determines which plugin serves the file (metadata.folderName must match plugin’s folderName), and which entries **listOpfsCachedResources** / **clearOpfsCache** return or delete. registerFolderConfig(folderName, config) at plugin creation; same folderName ⇒ same config (throw if different).
- **getFlatStoreDir()** returns that single dir (cached). **getOpfsDir(root, create, folderName)** is compatibility and returns the same dir. **getPluginRoot()** returns the plugin root handle.

**Eviction index** — in-memory only (no `_eviction_index.json` on disk). Only evictable entries (key, size, lastAccessed). Populated by directory scan when needed (e.g. first ensureSpaceForWrite or list/has); **lastAccessed** is written to the file footer in the background (throttled).

## Config (per-folder registerFolderConfig; global storage limit)

- **folderName** — required in each plugin's options. One logical folder = one config; same folderName in multiple plugins = shared config (must match or registerFolderConfig throws).
- **Global storage limit:** **getGlobalMaxCacheFraction()** (default 0.5), **setGlobalMaxCacheFraction(fraction)**. **getMaxCacheFraction()** (no args) returns this global value. **getCacheLimit(estimate)** uses it: limit = min(quota × fraction, quota − usage). No per-folder quota fraction; one limit for the whole cache.
- **FolderCacheConfig** (registerFolderConfig): **rangeCacheMaxSizeBytes** / **rangeCacheMaxEntries** only (no maxCacheFraction). getRangeCacheMaxSizeBytes(folderName), getRangeCacheMaxEntries(folderName).

## opfsUtil

- **isOpfsAvailable()** — sync check (navigator.storage.getDirectory). When false, plugin factories return **undefined**.
- **getRoot()** — cached OPFS root (navigator.storage.getDirectory).
- **getFlatStoreDir()** — returns the single cache directory (same as getPluginRoot() for flat store); cached. Used by serve path and cache control.
- **registerFolderConfig(folderName, config)** — called by plugin factories; config: rangeCacheMaxSizeBytes?, rangeCacheMaxEntries? (no maxCacheFraction). Throws if same folderName registered with different config.
- **getGlobalMaxCacheFraction()**, **setGlobalMaxCacheFraction(fraction)** — global storage limit (0…1); default 0.5.
- **getMaxCacheFraction()** — no args; returns global fraction (same as getGlobalMaxCacheFraction()).
- **OPFS_PLUGIN_ROOT_DIR_NAME** — plugin root folder name in OPFS (default `.opfs-serve-range`). **getPluginRoot()** — returns plugin root handle (cached). **getOpfsDir(root, create, folderName)** — compatibility; returns same dir as getFlatStoreDir(). **invalidateAllCachesAndPluginRoot()** — clears plugin root cache and invalidates all registered folders’ caches. **clearOpfsCache(folderName)** — deletes files whose metadata.folderName matches, then invalidates caches. **getRangeCacheMaxSizeBytes(folderName)**, **getRangeCacheMaxEntries(folderName)**.
- **shouldProcessFile(url, include?, exclude?)** — cross-origin URL → false; else glob on pathname; exclude wins; if include empty/missing or no match → false. In SW uses self.origin; in other environments (e.g. Node tests) mock globalThis.self = { origin }.
- **matchesGlob(url, pattern)** — pathname glob (\*, ?).
- Plugin factories normalize include/exclude/pinned at init (same-origin full URLs → pathnames; cross-origin/invalid dropped). If include becomes empty after normalization, the factory returns `undefined` and the plugin is not created.

## LRU and limits (opfsLru, opfsEvictionIndex)

- **Eviction index** (opfsEvictionIndex): in-memory only (no file on disk). Entries `{ key, size, lastAccessed }` for evictable files. All index ops serialized via in-memory lock. **ensureCachesPopulated(dir)** / first **getEntriesForEviction** populates the index by scanning the dir and reading file footers. **getEntriesForEviction(dir)** → `{ entries, totalSize }`. **updateEvictionIndexLastAccessed(dir, key, lastAccessed)** — on serve (throttled 5 s per key); schedules write of lastAccessed to file footer (batch every 5 s). **lastAccessedUpdateByKey** cleared for evicted keys in removeFromEvictionIndex. **addToEvictionIndex(dir, key, size, lastAccessed)** — after write. **removeFromEvictionIndex(dir, keys, folderNames)** — after eviction. **registerFileInCache(dir, key, size, evictable, lastAccessed)** — in-memory only for pinned (evictable: false). **invalidateCacheForDir(folderName)** — after clearOpfsCache.
- **Skip list** — in-memory Set of URLs we do not try to cache again (stream write failed with QuotaExceeded and bytesWritten ≥ totalCacheSize). `isInSkipList(url)`, `addToSkipList(url)`.
- **listCacheFilesWithMeta(dir)** → CacheFileEntry[] (key, size, lastAccessed, evictable). **getTotalCacheSize(entries)**. **computeEvictionSet(entries, needToFree)** — entries are EvictionIndexEntry[] (from index; already evictable only), returns keys to delete by LRU.
- **ensureSpaceForWrite(dir, newFileSize, { folderName, onEvicted })**: getCacheLimit(estimate), getEntriesForEviction (gets totalSize from result), needToFree; if needToFree > totalSize returns `{ ok: false, reason }`; else computeEvictionSet(index entries), evictFiles, removeFromEvictionIndex, onEvicted(keys), returns `{ ok: true, evictedKeys? }`.
- **writeToOpfs** with **knownSize**: ensureSpaceForWrite first; on success writes, then addToEvictionIndex if evictable (else registerFileInCache for pinned).
- **writeToOpfs** without knownSize (stream): on QuotaExceeded deletes partial file; if bytesWritten ≥ totalCacheSize add to skip list and notify; else getEntriesForEviction, evict, removeFromEvictionIndex. Always notifies OPFS_MSG_WRITE_FAILED. On success addToEvictionIndex if evictable.
- **getStorageEstimate()**, **getCacheLimit(estimate)**. **Constants:** KILOBYTE, MEGABYTE, GIGABYTE from opfsFormat.

## Notifications (opfsMessages, notifyClients)

- SW uses `notifyClients(messageType, data)` from `@budarin/pluggable-serviceworker/utils`.
- Types: OPFS_MSG_QUOTA_EXCEEDED, OPFS_MSG_WRITE_SKIPPED_SIZE, OPFS_MSG_CACHE_LIMIT_REACHED, OPFS_MSG_EVICTION_COMPLETED, OPFS_MSG_WRITE_FAILED, OPFS_MSG_SKIP_QUOTA_EXCEEDED.
- Client entry: `@budarin/psw-plugin-opfs-serve-range/client` — typed handlers (onOPFSQuotaExceeded, onOPFSWriteSkipped, onOPFSSkipQuotaExceeded, etc.) and exported message type constants.

## Shared range utilities (opfsRangeUtil)

- `parseRangeHeader(rangeHeader, fullSize)` → `{ start, end }` (suffix and bytes=start-end).
- `build206Response(blob, range, fullSize, options)` — 206 from Blob.
- `build206ResponseFromStream(stream, range, fullSize, options)` — 206 from stream.
- `createRangeExtractTransform(range)` — TransformStream that outputs only bytes in range.

Used by opfsServeRange (from OPFS file) and opfsRangeFromNetworkAndCache (from 200 response body).

## opfsServeRange

- Handles GET with Range header only. If no Range or method !== GET → `undefined`. If !shouldProcessFile(url, include, exclude) → `undefined`.
- **Lookup key:** OPFS key is computed from request URL **without search and hash** (origin + pathname) so URLs with query params (e.g. cache-bust on reconnect) map to the same file.
- If file not in OPFS (no dir, no file, If-Range mismatch, parse error) → `undefined`.
- **Metadata:** first try **metadata cache** get(key); on miss, concurrent requests for the same opfsKey share one **in-flight** promise (single getFile + readFooter + set metadata cache). Size/type/etag/lastModified for 206 and If-Range come from metadata cache (or from that load on first request).
- If file in OPFS: when **rangeCache** enabled, try range cache get(key, start, end) → RangeCacheBlobHit | undefined; on hit get meta from metadata cache, return 206 from cached blob + meta; on miss (or metadata cache miss for that key) invalidate range entries for key; if requested range length (bytes) **>** `maxSizeBytes` for that folder’s range cache, **createFileRangeStream** and return 206 **without** cache.set (single large range cannot fit the cache budget); else slice file, cache.set(key, start, end, blob), return 206. When rangeCache disabled: get file only when needed (stream path), createFileRangeStream, return 206. If evictable **event.waitUntil(updateEvictionIndexLastAccessed(dir, key, Date.now()))**.
- **Metadata cache** (internal, global): single LRU of opfsKey → { fullSize, type, folderName?, etag?, lastModified?, evictable? }. **getMetadataCache()** (no args) returns it. **getOrCreateMetadataCache(folderName, limits)** registers onEvictKey per folder; when a key is evicted, all registered callbacks run (each invalidates that folder’s range cache). **Range cache** invalidateForKey(opfsKey) uses a reverse index (opfsKey → set of cache keys) for O(1) invalidation.

## opfsRangeFromNetworkAndCache

- **loadingUrls** — Set of URLs currently being full-fetched in background. Remove in `finally`.
- **Skip list:** before starting cache write without Content-Length, if isInSkipList(url) → notify OPFS_MSG_SKIP_QUOTA_EXCEEDED, do not write.
- **No Range (full GET):** fetch; if 200, if not in skip list tee → one branch to OPFS (writeToOpfs with options `{ url, knownSize }` when metadata.size > 0), one to client. Metadata evictable: URL matching pinned → evictable: false (isEvictable(url, pinned)).
- **With Range:** If file exists in OPFS → logger.warn (possible If-Range mismatch or order). Then fetch(request). Then:
    - **206:** return response; if url not in loadingUrls and not in skip list → add to loadingUrls, start background full GET; on 200 write to OPFS with `{ url, knownSize }` when available.
    - **200:** if Content-Length and fullSize valid, tee → writeToOpfs with knownSize: fullSize, branch2 → range transform → 206. If no Content-Length: blob(), slice, 206; do not cache.
    - **416:** pass through.
- Only **200** responses are ever written to OPFS (never 206).

## OPFS availability

- **isOpfsAvailable()** (opfsUtil) — sync check. When false, plugin factories return **undefined**.

## Key decisions

- Cache only full responses (200). One background full GET per URL at a time.
- Limits: single global cap **getMaxCacheFraction()** / **setGlobalMaxCacheFraction(fraction)** (default 0.5). **getCacheLimit(estimate)** — one arg. limit = min(quota × fraction, quota − usage). Eviction by LRU using in-memory eviction index: only evictable entries; index populated by directory scan when needed; lastAccessed updated in memory on serve, throttled 5 s per key; footer write batched every 5 s; minimal set computed from index, then evict and remove from index.
- Stream write without size: on QuotaExceeded delete partial; if bytesWritten ≥ totalCacheSize add URL to skip list and do not evict; else evict bytesWritten + headroom. Notify clients on skip/quota/fail/eviction.
- writeToOpfs signature: (dir, key, bodyStream, metadata, options?: { url?, knownSize? }). Metadata may include evictable; gets lastAccessed on write; serve updates lastAccessed in background on read.
- Pinned: plugins (opfsRangeFromNetworkAndCache, opfsBackgroundFetch) accept **pinned** (glob patterns); URL matching pinned → metadata.evictable = false; LRU skips these in computeEvictionSet.

## writeToOpfs / metadataFromResponse

- **metadataFromResponse(response, url):** from response headers; size 0 if no valid Content-Length; writeToOpfs sets size from counted body in close().
- **writeToOpfs:** optional fifth argument options: url (for notifications/skip list), knownSize (triggers ensureSpaceForWrite before write). Footer includes lastAccessed: Date.now(); metadata may include evictable.

## opfsBackgroundFetch

- backgroundfetchsuccess: for each record, pathname = toPathname(record). If not shouldProcessFile → failedOrSkippedPathnames.push(pathname), continue. If in skip list / !response.ok / write error → same. On successful write: writtenPathnames.push(pathname), notifyClients(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, { registrationId, pathname, loadedPathnames, totalCount }). At end notifyClients(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, { registrationId, pathnames, written, failedOrSkipped }). backgroundfetchfail/abort: notifyClients(OPFS_MSG_BACKGROUND_FETCH_FAILED/ABORTED with registrationId).

## Client (entry ./client)

- **Building blocks / client–plugin pairing:** The package provides SW plugins and client utilities as paired building blocks. The client **getBackgroundFetchFilter()** asks the SW for the current include/exclude; the SW must register a plugin that answers that request — **opfsBackgroundFetchFilter** (standalone) or **opfsBackgroundFetch** (which handles the filter internally). So opfsBackgroundFetchFilter is the plugin counterpart to getBackgroundFetchFilter(); you can register it alone in a custom SW or use it implicitly via opfsBackgroundFetch.
- **Notifications:** message type constants; handlers onOPFSQuotaExceeded, onOPFSWriteSkipped, onOPFSCacheLimitReached, onOPFSEvictionCompleted, onOPFSWriteFailed, onOPFSSkipQuotaExceeded, onOPFSBackgroundFetchFailed, onOPFSBackgroundFetchAborted, onOPFSBackgroundFetchCompleted, onOPFSBackgroundFetchFileWritten, onOPFSRangeCacheFetchStarted, onOPFSRangeCacheFetchAllDone. Each subscribes via onServiceWorkerMessage and returns unsubscribe function.
- **Cache management:** listOpfsCachedResources(folderName), hasInOpfsCache(url, folderName), deleteFromOpfsCache(url), clearOpfsCache(folderName) — client sends OPFS_REQUEST_* to SW (opfsCacheControl), waits for OPFS_RESPONSE_* (2 s timeout). SW performs the op and invalidates caches. OpfsMessagePayload (url?, size?, limit?, reason?, registrationId?, pathnames?).
- **Download to OPFS:** getBackgroundFetchFilter() (client asks SW for include/exclude), filterAssetsForOpfs(assets, include?, exclude?, origin?). startDownloadAssetsToOpfs({ assets, title?, ... }) calls getBackgroundFetchFilter(), filters with filterAssetsForOpfs, then runs BF. Resolves { registrationId, assets, written, failedOrSkipped, filteredOut? }. Registration id: **getOpfsBackgroundFetchId(assets, folderName)** → prefix + encoded folder + '-' + hex(SHA-256([folderName, ...assets])). **getOpfsBackgroundFetchIdPrefixForFolder(folderName)** returns the prefix for a folder so the SW only handles events for its folder (no collisions between folders). Prefix `opfs-ranges-`. **SW:** handleOpfsBackgroundFetchMessage(event) — call from addEventListener('message'); responds to OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER with { include, exclude }. **Client/react:** useDownloadAssetsToOpfs() → { startDownload, status, progress, fileProgress, error, data, reset }; reset() aborts in-flight and clears state.
