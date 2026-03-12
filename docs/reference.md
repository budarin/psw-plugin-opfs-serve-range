# Project Reference

Project overview: flow, entry points, where things are, key decisions. Use when you need to understand how the project works (e.g. before refactoring core, adding events, or debugging init).

---

## Participants

- **Client** — page/player, sends fetch with Range; can subscribe to OPFS events via `@budarin/psw-plugin-opfs-serve-range/client`.
- **opfsServeRange** — serves 206 from OPFS when file exists; else returns `undefined`. **folderName** (required). Optional in-memory range cache (rangeCache: true | { maxSizeBytes?, maxEntries? }; limits from folder registry when omitted). When cache enabled: lookup by (opfsKey, start, end); hit → response from cache; miss → file.slice, cache.set, response. Updates `lastAccessed` in the eviction index in background (event.waitUntil). Options: folderName, include/exclude, rangeResponseCacheControl (default ''), rangeCache, order, enableLogging, maxCacheFraction?, rangeCacheMaxSizeBytes?, rangeCacheMaxEntries?.
- **opfsRangeFromNetworkAndCache** — runs when opfsServeRange returned `undefined`: uses `context.fetchPassthrough(request)` for network, returns response to client, may start background full GET to OPFS. **folderName** (required). Options: folderName, include/exclude, pinned (glob → evictable: false), order, enableLogging, maxCacheFraction?. Before caching without Content-Length checks **skip list** (isInSkipList); if URL in skip list, does not write and notifies clients (OPFS_MSG_SKIP_QUOTA_EXCEEDED).
- **opfsBackgroundFetch** — writes to OPFS on Background Fetch success; uses `context.fetchPassthrough` for requests. **folderName** (required). Same skip list check before write when no Content-Length. Options: folderName, include/exclude, pinned, order, enableLogging, maxCacheFraction?.
- **Framework (psw)** — provides `context.fetchPassthrough`; when all plugins return `undefined`, uses it for the request.
- **Server** — origin for the URL.

## Entry points and exports

- **Main** (`package.json` exports `.`): opfsServeRange, urlToOpfsKey, opfsRangeFromNetworkAndCache, opfsBackgroundFetch; **createOpfsServeAndBackgroundFetchPlugins(options)** (returns [opfsServeRange, opfsBackgroundFetch]), **createOpfsServeAndNetworkCachePlugins(options)** (returns [opfsServeRange, opfsRangeFromNetworkAndCache]); re-exports from opfsFormat (OPFS_FOLDER_NAME, KILOBYTE, MEGABYTE, GIGABYTE, readMetadataFromFileFooter, OpfsMetadata, …), opfsUtil (getRoot, registerFolderConfig, getOpfsDir(root, create, folderName), clearOpfsCache(folderName), isOpfsAvailable, getMaxCacheFraction(folderName), getGlobalMaxCacheFraction(), setGlobalMaxCacheFraction(fraction), getRangeCacheMaxSizeBytes(folderName), getRangeCacheMaxEntries(folderName), isEvictable, OpfsConfigOptions, FolderCacheConfig), opfsKey (urlToOpfsKey), opfsRangeCache (getOrCreateRangeCache(folderName, limits), getRangeCache(folderName); types RangeCacheLimits, RangeCacheEntryMeta, RangeCacheBlobHit — get() returns { blob } only; metadata for 206 comes from metadata cache; uses lru-cache), opfsLru (isInSkipList, addToSkipList, getStorageEstimate, getCacheLimit(estimate, folderName); types StorageEstimate, CacheFileEntry, EnsureSpaceResult), opfsMessages (message type constants, OpfsMessageType), opfsRangeUtil (parseRangeHeader, build206Response, build206ResponseFromStream, createRangeExtractTransform; RangeSpec, Build206Options), opfsWrite (writeToOpfs, metadataFromResponse, WriteToOpfsOptions with folderName).
- **Client** (`./client`): message type constants; handlers onOPFSQuotaExceeded, onOPFSWriteSkipped, onOPFSCacheLimitReached, onOPFSEvictionCompleted, onOPFSWriteFailed, onOPFSSkipQuotaExceeded, onOPFSBackgroundFetchFailed, onOPFSBackgroundFetchAborted, onOPFSBackgroundFetchCompleted, onOPFSBackgroundFetchFileWritten, onOPFSRangeCacheFetchStarted, onOPFSRangeCacheFetchAllDone; listOpfsCachedResources(folderName), hasInOpfsCache(url, folderName), deleteFromOpfsCache(url, folderName); getBackgroundFetchFilter, filterAssetsForOpfs, startDownloadAssetsToOpfs (options include folderName); useDownloadAssetsToOpfs (hook); OpfsMessagePayload, OpfsCachedResource.

## OPFS format

- **Key:** `hex(SHA-256(URL))`, one file per URL. Cached in worker via urlToOpfsKey().
- **File layout:** `[body][4 bytes meta length LE][JSON meta]`. Meta: url, size, type?, etag?, lastModified?, **lastAccessed?** (timestamp for LRU), **evictable?** (false = pinned, not evicted by LRU).
- **Folder:** each plugin instance has **folderName** (required in options). registerFolderConfig(folderName, config) at plugin creation; same folderName ⇒ same config (throw if different). getOpfsDir(root, create, folderName). Multiple plugins can share one folder (e.g. serve + network+cache + BF) with same folderName and consistent config.
- **Eviction index** — `_eviction_index.json` in the same folder: only evictable entries (key, size, lastAccessed). Used for LRU; when missing/corrupt it is rebuilt from file footers; also rewritten when a directory scan finds more evictable entries than the on-disk index (e.g. empty index but cache has files). listCacheFilesWithMeta skips this file.

## Config (per-folder, registerFolderConfig; global limit)

- **folderName** — required in each plugin's options. One folder = one cache; same folderName in multiple plugins = shared cache (config must match or registerFolderConfig throws).
- **Global limit:** getGlobalMaxCacheFraction() (default 0.5), setGlobalMaxCacheFraction(fraction). Sum of effective folder fractions is capped at this value: when sum of registered maxCacheFraction > global limit, getMaxCacheFraction(folderName) returns proportionally scaled value so that sum(effective) = global limit.
- **maxCacheFraction** — requested share of origin quota (0…1) for that folder; default 0.5. Effective value may be scaled down when total requested > global limit. getCacheLimit(estimate, folderName) uses effective fraction.
- **rangeCacheMaxSizeBytes** / **rangeCacheMaxEntries** — per-folder in-memory range cache limits; getRangeCacheMaxSizeBytes(folderName), getRangeCacheMaxEntries(folderName).

## opfsUtil

- **isOpfsAvailable()** — sync check (navigator.storage.getDirectory). When false, plugin factories return **undefined**.
- **getRoot()** — cached OPFS root (navigator.storage.getDirectory); use before getOpfsDir to avoid repeated getDirectory calls.
- **registerFolderConfig(folderName, config)** — called by plugin factories; throws if same folderName registered with different config.
- **getGlobalMaxCacheFraction()**, **setGlobalMaxCacheFraction(fraction)** — global cap for sum of folder fractions; default 0.5.
- **getOpfsDir(root, create, folderName)** — result cached per folderName; cleared in clearOpfsCache so the handle is not reused after folder removal. **clearOpfsCache(folderName)** — also clears metadata cache, range cache, and dir cache for that folder. **getMaxCacheFraction(folderName)** (effective, may be scaled), **getRangeCacheMaxSizeBytes(folderName)**, **getRangeCacheMaxEntries(folderName)**.
- **shouldProcessFile(url, include?, exclude?)** — cross-origin URL → false; else glob on pathname; exclude wins; if include empty/missing or no match → false. In SW uses self.origin; in other environments (e.g. Node tests) mock globalThis.self = { origin }.
- **matchesGlob(url, pattern)** — pathname glob (\*, ?).
- Plugin factories normalize include/exclude/pinned at init (same-origin full URLs → pathnames; cross-origin/invalid dropped). If include becomes empty after normalization, the factory returns `undefined` and the plugin is not created.

## LRU and limits (opfsLru, opfsEvictionIndex)

- **Eviction index** (opfsEvictionIndex): `_eviction_index.json` in cache dir; entries `{ key, size, lastAccessed }` for evictable files only. All index ops serialized via in-memory lock. Index is persisted when missing/corrupt (rebuild from footers) or when scan finds more evictable entries than on-disk index. **getEntriesForEviction(dir)** → `{ entries, totalSize }` (read index or rebuild from footers if missing/corrupt). **updateEvictionIndexLastAccessed(dir, key, lastAccessed)** — on serve (throttled 5 s per key). Index disk write throttled to at most once per 5 s; deferred flush via setTimeout. **lastAccessedUpdateByKey** cleared for evicted keys in removeFromEvictionIndex. **addToEvictionIndex(dir, key, size, lastAccessed)** — after write. **removeFromEvictionIndex(dir, keys)** — after eviction. **registerFileInCache(dir, key, size, evictable, lastAccessed)** — in-memory only for pinned (evictable: false). **invalidateCacheForDir(folderName)** — after clearOpfsCache.
- **Skip list** — in-memory Set of URLs we do not try to cache again (stream write failed with QuotaExceeded and bytesWritten ≥ totalCacheSize). `isInSkipList(url)`, `addToSkipList(url)`.
- **listCacheFilesWithMeta(dir)** → CacheFileEntry[] (key, size, lastAccessed, evictable); skips `_eviction_index.json`. **getTotalCacheSize(entries)**. **computeEvictionSet(entries, needToFree)** — entries are EvictionIndexEntry[] (from index; already evictable only), returns keys to delete by LRU.
- **ensureSpaceForWrite(dir, newFileSize, { folderName, onEvicted })**: getCacheLimit(estimate, folderName), getEntriesForEviction (gets totalSize from result), needToFree; if needToFree > totalSize returns `{ ok: false, reason }`; else computeEvictionSet(index entries), evictFiles, removeFromEvictionIndex, onEvicted(keys), returns `{ ok: true, evictedKeys? }`.
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
- If file not in OPFS (no dir, no file, If-Range mismatch, parse error) → `undefined`.
- **Metadata:** first try **metadata cache** get(key); on miss read file + readFooter, then set metadata cache. Size/type/etag/lastModified for 206 and If-Range come from metadata cache (or from readFooter on first request).
- If file in OPFS: when **rangeCache** enabled, try range cache get(key, start, end) → RangeCacheBlobHit | undefined; on hit get meta from metadata cache, return 206 from cached blob + meta; on miss (or metadata cache miss for that key) invalidate range entries for key, then slice file, cache.set(key, start, end, blob), return 206. When rangeCache disabled: get file only when needed (stream path), createFileRangeStream, return 206. If evictable **event.waitUntil(updateEvictionIndexLastAccessed(dir, key, Date.now()))**.
- **Metadata cache** (internal, per folder): LRU of opfsKey → { fullSize, type, etag?, lastModified?, evictable? }. onEvictKey callback invalidates range cache entries for that key. **Dir cache** (opfsUtil): folderName → FileSystemDirectoryHandle; getOpfsDir uses it; clearOpfsCache deletes entry.

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
- Limits: global cap getGlobalMaxCacheFraction() (default 0.5); per-folder maxCacheFraction; when sum of folder fractions > global cap, effective fraction = proportional scale so sum = cap. limit = min(quota × effectiveFraction, quota − usage). Eviction by LRU using eviction index (_eviction_index.json): only evictable entries; index rebuilt when missing/corrupt; lastAccessed updated in index on serve (not in file), throttled 5 s per key, to avoid concurrent read/write; minimal set computed from index, then evict and remove from index.
- Stream write without size: on QuotaExceeded delete partial; if bytesWritten ≥ totalCacheSize add URL to skip list and do not evict; else evict bytesWritten + headroom. Notify clients on skip/quota/fail/eviction.
- writeToOpfs signature: (dir, key, bodyStream, metadata, options?: { url?, knownSize? }). Metadata may include evictable; gets lastAccessed on write; serve updates lastAccessed in background on read.
- Pinned: plugins (opfsRangeFromNetworkAndCache, opfsBackgroundFetch) accept **pinned** (glob patterns); URL matching pinned → metadata.evictable = false; LRU skips these in computeEvictionSet.

## writeToOpfs / metadataFromResponse

- **metadataFromResponse(response, url):** from response headers; size 0 if no valid Content-Length; writeToOpfs sets size from counted body in close().
- **writeToOpfs:** optional fifth argument options: url (for notifications/skip list), knownSize (triggers ensureSpaceForWrite before write). Footer includes lastAccessed: Date.now(); metadata may include evictable.

## opfsBackgroundFetch

- backgroundfetchsuccess: for each record, pathname = toPathname(record). If not shouldProcessFile → failedOrSkippedPathnames.push(pathname), continue. If in skip list / !response.ok / write error → same. On successful write: writtenPathnames.push(pathname), notifyClients(OPFS_MSG_BACKGROUND_FETCH_FILE_WRITTEN, { registrationId, pathname, loadedPathnames, totalCount }). At end notifyClients(OPFS_MSG_BACKGROUND_FETCH_COMPLETED, { registrationId, pathnames, written, failedOrSkipped }). backgroundfetchfail/abort: notifyClients(OPFS_MSG_BACKGROUND_FETCH_FAILED/ABORTED with registrationId).

## Client (entry ./client)

- **Notifications:** message type constants; handlers onOPFSQuotaExceeded, onOPFSWriteSkipped, onOPFSCacheLimitReached, onOPFSEvictionCompleted, onOPFSWriteFailed, onOPFSSkipQuotaExceeded, onOPFSBackgroundFetchFailed, onOPFSBackgroundFetchAborted, onOPFSBackgroundFetchCompleted, onOPFSBackgroundFetchFileWritten, onOPFSRangeCacheFetchStarted, onOPFSRangeCacheFetchAllDone. Each subscribes via onServiceWorkerMessage and returns unsubscribe function.
- **Cache management:** listOpfsCachedResources() → OpfsCachedResource[] (url, size, type, lastModified); hasInOpfsCache(url); deleteFromOpfsCache(url). OpfsMessagePayload (url?, size?, limit?, reason?, registrationId?, pathnames?).
- **Download to OPFS:** getBackgroundFetchFilter() (client asks SW for include/exclude), filterAssetsForOpfs(assets, include?, exclude?, origin?). startDownloadAssetsToOpfs({ assets, title?, ... }) calls getBackgroundFetchFilter(), filters with filterAssetsForOpfs, then runs BF. Resolves { registrationId, assets, written, failedOrSkipped, filteredOut? }. Registration id: getOpfsBackgroundFetchId(assets) → OPFS_BACKGROUND_FETCH_ID_PREFIX + hex(SHA-256(canonical)); prefix `opfs-ranges-`. **SW:** handleOpfsBackgroundFetchMessage(event) — call from addEventListener('message'); responds to OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER with { include, exclude }. **Client/react:** useDownloadAssetsToOpfs() → { startDownload, status, progress, fileProgress, error, data, reset }; reset() aborts in-flight and clears state.
