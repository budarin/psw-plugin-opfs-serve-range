# Changelog

## 4.0.6 - 2026-03-13

- **Logging:** Removed `[opfs-range]` prefixes from `logger.error` and `logger.warn` messages (both SW and client). Prefixes are kept only for debug/info diagnostics; public API and behavior are unchanged.

## 4.0.5 - 2026-03-13

- Version bump.

## 4.0.4 - 2026-03-13

- **Reference and API:** Project reference (`.cursor/rules/reference.mdc`) updated to match current implementation: in-memory eviction index, single physical OPFS directory, logical folderName in metadata, skip list, cache control request/response. **CreateOpfsServePluginsBaseOptions** — shared base type for **CreateOpfsServeAndBackgroundFetchPluginsOptions** and **CreateOpfsServeAndNetworkCachePluginsOptions** to avoid duplication.
- **Client structure:** `src/client/index.ts` split by responsibility: **messageHandlers.ts** (onOPFS* subscriptions, OpfsMessagePayload), **cacheControl.ts** (listOpfsCachedResources, hasInOpfsCache, deleteFromOpfsCache, clearOpfsCache), **reconnectPlayer.ts** (reconnectPlayerOnFileLoadedIntoOpfs + helper), **backgroundFetch.ts** (getBackgroundFetchFilter, getRegisteredFolders, filterAssetsForOpfs, startDownloadAssetsToOpfs, estimateAssetsSizeInBytes, OPFS_ERROR_*). Public API unchanged; `index.ts` re-exports from these modules.
- **Serve and cache:** In **opfsServeRange**, any error from **getFlatStoreDir()** (not only NotFoundError) now triggers **invalidateAllCachesAndPluginRoot()**. **opfsCacheControl** — JSDoc added for LIST_CACHED_RESOURCES (list from in-memory metadata cache after ensureCachesPopulated).
- **Background Fetch UI:** **OpfsBackgroundFetchOptions** — new optional **messages**: `{ fetchFailed?: string; fetchAborted?: string }` for **event.updateUI** titles on fail/abort; defaults remain "Ошибка при загрузке" and "Загрузка отменена". Empty string disables updateUI for that event.
- **Docs and logging:** **writeToOpfs** JSDoc — explicit note that existing file by key causes early return (idempotent). All SW and client log messages now use **OPFS_RANGE_LOG_SW** / **OPFS_RANGE_LOG_CLIENT** prefix (including opfsRangeFromNetworkAndCache write-failed and client startDownload errors). **OPFS_FOLDER_NAME** removed from opfsFormat and package exports (actual plugin root is **OPFS_PLUGIN_ROOT_DIR_NAME** in opfsUtil). **reconnectPlayer** — JSDoc added for module and **reconnectPlayerOnFileLoadedIntoOpfs** (assumptions: element in DOM; video wrapper/overlay may be fragile with complex layout).
- **Tests:** New **opfsRangeUtil.test.ts** (parseRangeHeader, build206Response). New **opfsFormat.test.ts** (readMetadataFromFileFooter). **opfsLru.test.ts** extended (computeEvictionSet edge cases, getTotalCacheSize). **opfsUtil.test.ts** extended (normalizePatternList trim/empty origin, shouldProcessFile empty include, multiple patterns, exclude precedence).

## 4.0.3 - 2026-03-13

- **OPFS robustness:** `getRoot()` and `getPluginRoot()` no longer cache rejected promises — on failure the cached promise is cleared so the next call retries `navigator.storage.getDirectory()` / `getDirectoryHandle()`. `invalidateAllCachesAndPluginRoot()` now resets both the OPFS root and the plugin root promises, so after a `NotFoundError` new handles are obtained instead of keeping a broken state. In `writeToOpfs` and `opfsServeRange.fetch`, a `NotFoundError` on the cache directory or file triggers `invalidateAllCachesAndPluginRoot()`, which clears in-memory caches and lets subsequent requests fall back to the network.
- **Client reconnect logging:** `reconnectPlayerOnFileLoadedIntoOpfs` and the React hook `useReconnectPlayerOnFileLoadedIntoOpfs` now gate their internal logging behind the `debug` flag: they only emit reconnect diagnostics when `debug: true`, keeping the default client console output quiet.

## 4.0.2 - 2026-03-13

- **Logging:** Debug logs now use the **logger** passed in options (e.g. `logger: console`), not `context.logger` from the framework, so `debug: true` actually produces output. Optional chaining (`logger.debug?.()`) used so any logger shape works.
- **API:** **enableLogging** renamed to **debug** everywhere (opts, types, factories, README, reference). Single flag for all debug logging; when **debug: true** and **logger** is set, cache event logging (logCacheEvents) is also enabled. **logCacheEvents** remains for backward compatibility.

## 4.0.1 - 2026-03-13

- **Bundle size:** Replaced the `lru-cache` dependency (~17 KB) with a minimal in-house LRU implementation (`src/lruCache.ts`): doubly-linked list + Map, supporting max entries, optional byte limit (maxSize + sizeCalculation), and dispose callback. Same API surface for metadata and range caches; no breaking changes.

## 4.0.0 - 2026-03-13

**Breaking:** Storage structure refactored to a **flat store**; global storage limit only; API signature changes. No migration from the previous layout — caches are not converted automatically.

**Storage structure (flat store)**

- **Single directory:** All cached files live in one directory under the plugin root (OPFS root → **OPFS_PLUGIN_ROOT_DIR_NAME** → one dir). No subdirectories per folderName. File name = key = `hex(SHA-256(url))`; one file per URL.
- **folderName is logical only:** Stored in each file’s metadata (footer). Used for filtering on serve (plugin serves only when `metadata.folderName === folderName`), for **listOpfsCachedResources** / **clearOpfsCache** (list/clear by folder), and for plugin config grouping. **getFlatStoreDir()** returns this single directory; **getOpfsDir** is a compatibility wrapper.
- **Eviction index in memory only:** No `_eviction_index.json` on disk. Evictable entries (key, size, lastAccessed) are kept in memory and repopulated by a directory scan when needed (e.g. on first **ensureSpaceForWrite** or **listOpfsCachedResources**). **lastAccessed** is still written to the file footer in the background (throttled).

**API and config**

- **getMaxCacheFraction()** — no argument. Returns the global fraction (same as getGlobalMaxCacheFraction()). **Removed:** getMaxCacheFraction(folderName). Set the limit via **setGlobalMaxCacheFraction(fraction)** only.
- **getCacheLimit(estimate)** — single argument. **Removed:** second argument folderName. Limit is computed from the global fraction only.
- **FolderCacheConfig** (registerFolderConfig) — **removed** **maxCacheFraction**. Config now only has rangeCacheMaxSizeBytes?, rangeCacheMaxEntries?.
- **Plugin options** — **removed** **maxCacheFraction** from OpfsServeRangeOptions, ServeOptionsFromFactory, OpfsBackgroundFetchOptions, OpfsRangeFromNetworkAndCacheOptions, CreateOpfsServeAndBackgroundFetchPluginsOptions, CreateOpfsServeAndNetworkCachePluginsOptions. Use setGlobalMaxCacheFraction() before registering plugins to set the cache limit.
- **getMetadataCache()** (opfsMetadataCache) — no argument. Returns the global metadata cache or null. **Removed:** parameter folderName. Internal; multiple folders can register onEvictKey via getOrCreateMetadataCache(folderName, { onEvictKey }); all callbacks run when a key is evicted.
- **opfsServeRange** — serve path uses **getFlatStoreDir()** directly (no getRoot + getOpfsDir). Common 206 + lastAccessed update extracted to **build206FromBlobAndScheduleLastAccessed**.
- **Range cache** — **RangeCacheImpl.invalidateForKey(opfsKey)** now uses a reverse index (opfsKey → set of cache keys) so invalidation is O(entries for that key) instead of O(all entries). dispose callback keeps the index in sync on LRU eviction.
- **Docs:** reference.md — global limit, getMaxCacheFraction(), getCacheLimit(estimate), getFlatStoreDir, metadata cache and range cache behavior, FolderCacheConfig without maxCacheFraction. README and README.ru — flat store and storage format section, global quota only, getMaxCacheFraction()/getCacheLimit(estimate), getFlatStoreDir, FolderCacheConfig and plugin options without maxCacheFraction.

## 3.11.0 - 2026-03-13

- **Docs:** README and README.ru — clarified behavior when **folderName** is not registered in the SW: **listOpfsCachedResources** and **hasInOpfsCache** return `[]` and `false`; **deleteFromOpfsCache** and **clearOpfsCache** reject the promise with `opfs: folder not registered`.

## 3.10.0 - 2026-03-13

- **Plugin root directory:** All cache folders now live under a single plugin root **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) in the OPFS root. Path: OPFS root → `.opfs-serve-range` → folderName. This keeps plugin data separate from other apps’ folders; the leading dot marks a reserved folder. **getPluginRoot()** returns the plugin root handle (cached). **getOpfsDir** and **clearOpfsCache** resolve paths under this root.
- **Three-level cache invalidation on errors:** On file read errors (getFileHandle, getFile, footer) the plugin runs **invalidateCachesForFileKeyOnError** (per-key invalidation). If that throws (e.g. folder removed), **invalidateAllCachesForFolder(folderName)** runs. When opening a cache folder under the plugin root fails, **invalidateAllCachesAndPluginRoot()** runs (clears plugin root cache and all registered folders’ caches, then one retry). Exported: **invalidateCachesForFileKeyOnError**, **invalidateAllCachesAndPluginRoot**. Docs: opfs-cache-behavior (EN/RU), reference.md.
- **Background Fetch id includes folderName:** **getOpfsBackgroundFetchId(assets, folderName)** now takes folderName; the id is unique per (folderName, assets), so the same asset set in different folders no longer collides. **getOpfsBackgroundFetchIdPrefixForFolder(folderName)** returns the id prefix for a folder; the SW plugin **opfsBackgroundFetch** only handles events whose registration id starts with that prefix. Exported from main and used by startDownloadAssetsToOpfs.
- **opfsCacheControl plugin:** New standalone plugin that handles client messages for cache operations. Request/response pairs: **OPFS_REQUEST_DELETE_FROM_CACHE** / **OPFS_RESPONSE_DELETE_FROM_CACHE**, **OPFS_REQUEST_HAS_IN_CACHE** / **OPFS_RESPONSE_HAS_IN_CACHE**, **OPFS_REQUEST_LIST_CACHED_RESOURCES** / **OPFS_RESPONSE_LIST_CACHED_RESOURCES**, **OPFS_REQUEST_CLEAR_CACHE** / **OPFS_RESPONSE_CLEAR_CACHE**. Only registered folders are accepted. **createOpfsServeAndBackgroundFetchPlugins** and **createOpfsServeAndNetworkCachePlugins** now include **opfsCacheControl()** in the plugin list.
- **Client cache utilities via SW:** **listOpfsCachedResources(folderName)**, **hasInOpfsCache(url, folderName)**, **deleteFromOpfsCache(url, folderName)** no longer access OPFS directly; they send the corresponding request to the service worker (opfsCacheControl) and wait for the response. Request timeout 2 s. **clearOpfsCache(folderName)** (client) sends CLEAR and rejects on error or missing SW controller. Client no longer uses getRoot/getOpfsDir for cache list/has/delete; SW performs the operation and invalidates its in-memory caches (metadata, range, eviction index) on delete/clear.
- **Docs:** reference.md — opfsCacheControl, plugin root and invalidation helpers, BF id with folderName, client cache via messages. README/README.ru — brief notes on plugin root and cache control via SW.

## 3.9.0 - 2026-03-12

- **Background Fetch system UI on success:** On **backgroundfetchsuccess** the plugin no longer calls **event.updateUI({ title: 'Загрузка завершена' })**. The system download list keeps the **title** passed to **startDownloadAssetsToOpfs({ title })**, so completed entries are distinguishable (e.g. "Урок 1", "Плейлист офлайн") instead of many identical "Загрузка завершена". On **backgroundfetchfail** and **backgroundfetchabort** the title is still updated ("Ошибка при загрузке", "Загрузка отменена").

## 3.8.0 - 2026-03-12

- **Video reconnect — layout and overlay:** Wrapper now copies margin, boxSizing, display, and verticalAlign from the video so it occupies the same space in the flow (no jump when replacing the node). When the video has `display: inline`, the wrapper uses `inline-block` so fixed width/height apply. Wrapper has `overflow: hidden` and `isolation: isolate`; its `position: relative` is set with `!important` so it stays the containing block. Video inside the wrapper is `position: absolute` with `z-index: 0`; the snapshot canvas is inserted as the first child with `position: absolute`, `top: 0`, `left: 0`, explicit pixel dimensions, and `z-index: 1` (all with `!important`) so the snapshot reliably overlays the video and is not pushed below in the flow. Cleanup restores the video’s position, top, left, and zIndex. Styles are applied in batches via `Object.assign` where multiple properties are set.

## 3.7.0 - 2026-03-12

- **Switch player to OPFS when file is loaded:** **reconnectPlayerOnFileLoadedIntoOpfs(element, payload, folderName, options?)** — call from **onOPFSBackgroundFetchFileWritten** so that when the currently playing file is written to OPFS, the player reconnects to the same URL (served from cache) and restores playback state (position, paused, playbackRate, volume, muted). Optional **options**: `logger`, `debug` for diagnostics. **useReconnectPlayerOnFileLoadedIntoOpfs(mediaRef, options)** — React hook that subscribes to **onOPFSBackgroundFetchFileWritten** and calls the helper. Types: **FileWrittenPayload**, **ReconnectPlayerOnFileLoadedIntoOpfsOptions**.
- **Video UX on reconnect:** For video, reconnecting no longer flashes a black frame: current frame is captured to a canvas overlay, source is switched, overlay is removed only after **playing** or **seeked** (when the new source is actually displaying). If the video had no explicit dimensions, they are fixed during switch and then cleared. Audio is unchanged (no overlay).
- **Unified log format:** All package logs use **\[opfs-range] [sw]** (service worker) or **\[opfs-range] [client]** (page). Constants **OPFS_RANGE_LOG_SW** and **OPFS_RANGE_LOG_CLIENT** in **opfsLog.ts** (internal). Eases filtering and debugging when multiple OPFS plugins are used.
- **Docs:** README and README.ru — section “Switch player to OPFS when file is loaded” with **reconnectPlayerOnFileLoadedIntoOpfs** and examples (vanilla TS and React). reference.md — client exports and Client React entry updated.

## 3.6.0 - 2026-03-12

- **Background Fetch click behavior:** `opfsBackgroundFetch.backgroundfetchclick` now focuses an existing window client for the origin when the user clicks the system Background Fetch UI (download notification) or opens a new window via `clients.openWindow('/')` when no windows are open. This makes the default behavior on mobile/desktop consistent with user expectations: tapping the system download UI brings the user back into the PWA/app where the custom download UI can show final status.

## 3.5.0 - 2026-03-12

- **Background Fetch UI (system):** `startDownloadAssetsToOpfs` now accepts `icons` in options (forwarded to `BackgroundFetchUIOptions.icons`) so the browser’s built-in Background Fetch UI can use custom icons alongside `title` and `downloadTotal`. The service worker plugin `opfsBackgroundFetch` calls `event.updateUI()` on `backgroundfetchsuccess`, `backgroundfetchfail`, and `backgroundfetchabort` with neutral Russian titles ("Загрузка завершена", "Ошибка при загрузке", "Загрузка отменена") when the API is available, so the system UI reflects the final state of the download.
- **Docs:** README.ru.md — explained coexistence of system Background Fetch UI (notifications) and custom client UI, documented the new `icons` field in `StartDownloadAssetsToOpfsOptions`.

## 3.4.0 - 2026-03-12

- **New plugin opfsRegisteredFolders:** Standalone plugin that answers client request **OPFS_REQUEST_GET_REGISTERED_FOLDERS** with the list of folder names registered in the service worker via **registerFolderConfig**. **createOpfsServeAndBackgroundFetchPlugins** now includes it (returns `[opfsServeRange, opfsBackgroundFetchFilter, opfsRegisteredFolders, opfsBackgroundFetch]`). For custom SW, register **opfsRegisteredFolders()** so that **getRegisteredFolders()** and folder validation in **startDownloadAssetsToOpfs** work.
- **Client getRegisteredFolders():** Returns `Promise<FolderName[]>`; requests the list from SW. Used by **startDownloadAssetsToOpfs** before starting a download.
- **startDownloadAssetsToOpfs** — folder validation: Before starting a background download, the client requests registered folders from SW. If the list is empty (timeout or plugin not registered), the promise rejects with **OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE**. If **folderName** is not in the list, the promise rejects with **OPFS_ERROR_FOLDER_NOT_REGISTERED**. Enables the UI to show a clear message when the folder is not registered in the SW.
- **Error codes (client):** **OPFS_ERROR_FOLDER_NOT_REGISTERED**, **OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE** exported from the client entry. **StartDownloadError** type: `(Error & { code?: string }) | DownloadAssetsToOpfsRejected` for typing errors in the UI (check `error?.code`).
- **useDownloadAssetsToOpfs:** **startDownload** now rejects the promise when an error occurs (same errors as above); the error is also stored in **error** state. Type **UseDownloadAssetsToOpfsState.error** is **StartDownloadError | null**. UI can display errors from state or from `startDownload(opts).catch(err => ...)`.
- **opfsUtil:** **getRegisteredFolderNames()** — returns folder names from the SW folder registry; used by **opfsRegisteredFolders** plugin.
- **opfsMessages:** **OPFS_REQUEST_GET_REGISTERED_FOLDERS**, **OPFS_RESPONSE_REGISTERED_FOLDERS** for client ↔ SW folder list request/response.
- **Docs:** README and reference.md — opfsRegisteredFolders, getRegisteredFolders, error codes, StartDownloadError, hook rejection and error display. README.ru.md aligned.

## 3.3.0 - 2026-03-11

- **Renamed:** **StartDownloadAssetsToOpfsOptions.downloadTotal** → **totalDownloadSizeInBytes**. Same meaning (total size of the download in bytes, for progress display); clearer name. Update call sites and options objects.
- **Docs:** README and README.ru — removed inline type comments; added proper TypeScript interface blocks below the relevant sections: handler and **OpfsMessagePayload** for subscription functions; **DownloadAssetsToOpfsResult** and reject type for startDownloadAssetsToOpfs; **OpfsCachedResource** for listOpfsCachedResources; **FolderCacheConfig** for registerFolderConfig; **OpfsMetadata** and **WriteToOpfsOptions** for the custom plugin section. getBackgroundFetchFilter and utility-section behavior notes moved from comments to prose.

## 3.2.0 - 2026-03-11

- **Range cache:** LRU eviction is O(1) (doubly linked list). Each entry stores only the response **blob**; metadata (fullSize, type, etag, lastModified) for building the 206 response is taken from the **metadata cache**. **get(key, start, end)** returns **RangeCacheBlobHit** (`{ blob }`). **set(key, start, end, blob)** no longer takes a meta argument. Exported type **RangeCacheBlobHit**.
- **Metadata cache:** In-memory LRU cache of file metadata (fullSize, type, etag?, lastModified?, evictable?) by opfsKey (per folder). Avoids reading the file footer on repeat requests for the same file. Default max 500 entries. When a key is evicted from the metadata cache, all range cache entries for that key are invalidated (**onEvictKey** callback). Invalidated on **removeFromEvictionIndex** and **clearOpfsCache**. Internal (not exported).
- **lastAccessedUpdateByKey:** Entries for evicted keys are removed when **removeFromEvictionIndex** runs, so the map does not grow unbounded.
- **Eviction index writes:** Disk writes are throttled to at most once per 5 seconds (**INDEX_WRITE_THROTTLE_MS**). If the index was updated recently, a deferred flush is scheduled (setTimeout 5 s); when it runs, the index is written once under lock. Reduces I/O when many keys are updated (e.g. seeking).
- **readMetadataFromFileFooter:** Single read of the file tail (4 + **MAX_META_JSON_BYTES** = 3004 bytes, or the whole file if smaller). **MAX_META_JSON_BYTES** increased to 3000. If the stored metadata length exceeds the read tail, a second read is performed for the full JSON so parsing never uses partial data.
- **getOpfsDir:** Return value is cached per folderName; **clearOpfsCache(folderName)** clears the cached handle so it is not reused after the folder is removed.
- **Factory helpers:** Internal **buildServeOptions(options, defaultOrder)** used by **createOpfsServeAndBackgroundFetchPlugins** and **createOpfsServeAndNetworkCachePlugins** to build opfsServeRange options; removes duplication.
- **Docs:** reference.mdc updated (range cache returns blob only, metadata cache, dir cache). opfs-cache-behavior (EN/RU) — new section describing all in-memory caches (range, metadata, dir, eviction index, and auxiliary caches).

## 3.1.0 - 2026-03-11

- **Global cache limit:** **getGlobalMaxCacheFraction()** (default 0.5) and **setGlobalMaxCacheFraction(fraction)**. The sum of effective folder fractions is capped at this value. When the sum of registered per-folder `maxCacheFraction` exceeds the global limit, **getMaxCacheFraction(folderName)** returns a proportionally scaled value so that the sum of effective fractions equals the global limit (no throw; quotas are normalized).
- **High-level helpers:** **createOpfsServeAndBackgroundFetchPlugins(options)** returns `[opfsServeRange, opfsBackgroundFetch]` with shared folderName, include, exclude, etc. **createOpfsServeAndNetworkCachePlugins(options)** returns `[opfsServeRange, opfsRangeFromNetworkAndCache]` for the “cache on first request” scenario. **initServiceWorker** (pluggable-serviceworker) flattens the plugins array, so you can pass the factory result directly without spread. One **order** option (default 0): first plugin gets order, second gets order + 1. Types: **CreateOpfsServeAndBackgroundFetchPluginsOptions**, **CreateOpfsServeAndNetworkCachePluginsOptions**.
- **Tests:** opfsUtil.test.ts for global limit and proportional scaling.

## 3.0.0 - 2026-03-11

**Breaking:** Per-instance folder and config. One folder per cache; multiple plugins can share the same folder with the same config.

- **folderName required:** Each of **opfsServeRange**, **opfsRangeFromNetworkAndCache**, and **opfsBackgroundFetch** now requires **folderName: string** in options. No global default folder.
- **configureOpfs removed:** Global `configureOpfs()` is removed. Cache settings (maxCacheFraction, rangeCacheMaxSizeBytes, rangeCacheMaxEntries) are passed per plugin and stored in a folder registry. When the same folderName is used by several plugins (e.g. serve + network+cache + BF), the config must match or **registerFolderConfig** throws.
- **registerFolderConfig:** Called internally by plugin factories. Exported for advanced use. **FolderCacheConfig** type exported.
- **getOpfsDir(root, create, folderName):** Third argument **folderName** is required.
- **clearOpfsCache(folderName):** Now requires **folderName: string** (clears only that folder).
- **getMaxCacheFraction(folderName)**, **getRangeCacheMaxSizeBytes(folderName)**, **getRangeCacheMaxEntries(folderName):** Take **folderName**; return value from registry or default.
- **getCacheLimit(estimate, folderName)** (opfsLru): Second argument **folderName** required.
- **ensureSpaceForWrite(dir, size, options):** **options.folderName** required.
- **writeToOpfs(..., options):** **options.folderName** required.
- **getOrCreateRangeCache(folderName, limits)**, **getRangeCache(folderName):** Range cache is per folder.
- **removeFromEvictionIndex(dir, keys, folderName):** Third argument **folderName** for range cache invalidation.
- **Client API:** **listOpfsCachedResources(folderName)**, **hasInOpfsCache(url, folderName)**, **deleteFromOpfsCache(url, folderName)** — **folderName** required. **startDownloadAssetsToOpfs({ folderName, assets, ... })** — **folderName** required.
- **Docs:** README, README.ru, reference.mdc, opfs-cache-behavior (EN/RU) updated for per-folder API and examples.

## 2.3.0 - 2026-03-10

- **opfsServeRange — in-memory range cache:** New option **rangeCache** (`true` or `{ maxSizeBytes?, maxEntries? }`). When set, 206 responses are cached in memory by (opfsKey, start, end); repeated requests for the same range are served from cache without reading OPFS. Limits default to **configureOpfs** values **rangeCacheMaxSizeBytes** (default 5 MB) and **rangeCacheMaxEntries** (default 300); plugin options override. LRU eviction when limits are exceeded. Cache is invalidated when a file is evicted from OPFS and on **clearOpfsCache()**. Useful for maps and documents with many parallel or repeated range requests.
- **configureOpfs:** New options **rangeCacheMaxSizeBytes** and **rangeCacheMaxEntries** — defaults for the in-memory range cache when **opfsServeRange** is used with **rangeCache: true** or **rangeCache: {}**.
- **rangeResponseCacheControl:** Default changed from `max-age=31536000, immutable` to **empty string** — 206 responses are no longer cached in the browser HTTP cache by default (avoids caching millions of range responses for video).
- **Exports:** **getRangeCacheMaxSizeBytes**, **getRangeCacheMaxEntries**, **getOrCreateRangeCache**, **getRangeCache**, **RangeCacheLimits**, **RangeCacheEntryMeta** from the main entry.
- **Docs:** README and README.ru — rangeResponseCacheControl default, rangeCache and configureOpfs range cache options; reference.mdc and opfs-cache-behavior (EN/RU) updated.

## 2.2.0 - 2025-03-10

- **Eviction index:** When populating the cache from a directory scan, the index is now persisted not only when it was missing or corrupted, but also when the scan finds **more evictable entries** than the on-disk index contains (e.g. index was empty `[]` but the cache directory already has evictable files). This fixes the case where after a reload or when the service worker was killed before a previous index write completed, `_eviction_index.json` stayed empty and LRU eviction could not see cached files.
- **Docs:** reference.mdc aligned with current code (skip list API names, client exports, eviction index flow, BF id format). opfs-cache-behavior: clarified when the eviction index is (re)written.

## 2.1.0 - 2025-03-08

- **Terminology:** Replaced “blacklist” with “blocklist” in code and docs (opfsLru, opfsMessages, opfsWrite, opfsRangeFromNetworkAndCache, README, opfs-cache-behavior, PRD). Renamed blocklist to **skip list** (API: **isInSkipList**, **addToSkipList**) for consistency with onOPFSWriteSkipped / onOPFSSkipQuotaExceeded. (In Russian docs this is described as “cancelled list”.) Added client subscriptions **onOPFSBackgroundFetchFailed** and **onOPFSBackgroundFetchAborted** (and corresponding message types) for Background Fetch fail/abort.
- **New:** **opfsBackgroundFetchFilter** — standalone plugin that only handles `message` and responds with include/exclude to `getBackgroundFetchFilter()`. **opfsBackgroundFetch** composes it internally (no separate registration needed for full stack); for custom SW you can register only **opfsBackgroundFetchFilter** with your own filter.
- **New:** Idempotent Background Fetch id from asset list: **getOpfsBackgroundFetchId(assets)** (hash of sorted pathnames). **startDownloadAssetsToOpfs** uses it; if the same set is already loading, the client attaches to that registration instead of starting a duplicate.
- **New:** **OPFS_MSG_RANGE_CACHE_FETCH_STARTED** / **OPFS_MSG_RANGE_CACHE_FETCH_ALL_DONE** — SW notifies when opfsRangeFromNetworkAndCache starts/finishes background cache fetches (“cache on first request”). Client can subscribe via **onOPFSRangeCacheFetchStarted** and **onOPFSRangeCacheFetchAllDone** to show a “background download in progress” indicator.
- **startDownloadAssetsToOpfs:** Before starting a BF, excludes assets that are already in an active BF (pathnames from each registration’s `matchAll()`) and assets already in OPFS (one call to **listOpfsCachedResources()**). Order: first active BFs, then OPFS cache (so a just-finished download is not missed). If nothing remains to fetch, returns immediately with `written: assetsToUse`.
- **useDownloadAssetsToOpfs:** No longer aborts the download on component unmount; only **reset()** cancels. Download continues in the background when the user leaves the page.
- **Docs:** README/README.ru — stated that third-party (cross-origin) resources are not supported (opaque response; body cannot be read or written to OPFS). Added a note about onOPFSRangeCacheFetchStarted/AllDone for the “cache on first request” scenario. Hook description updated (no cancel on unmount; cancel via reset()). Clarified that storage quota is shared within the origin (maxCacheFraction); leave free space for Cache API, IndexedDB, etc. Documented **writeToOpfs** fifth argument `options` (`url`, `knownSize`) for cache limits; size when Content-Length omitted: by counting bytes in body. Cache utilities section; EN and RU README aligned.

## 2.0.0 - 2025-03-08

- **Breaking:** Removed **opfsPrecache** plugin and `OpfsPrecacheOptions` type. The package is focused on range requests and OPFS for large files; precaching at install was redundant for small assets (use Cache API) and unsuitable for large ones. Use **opfsServeRange** + **opfsRangeFromNetworkAndCache** for on-demand caching, or **opfsBackgroundFetch** for explicit “download for offline” flows.
- **Docs:** README.md, README.ru.md, reference.mdc, and docs/PRD.md updated (opfsPrecache removed from descriptions, plugin list, use cases, and requirements).

## 1.5.1 - 2025-03-08

- **Eviction index:** When index is missing on serve, it is rebuilt from the cache dir so `_eviction_index.json` appears on first watch after plugin update. **lastAccessed** updates on serve are throttled to at most once per 5 seconds per key (reduces index writes during seeking).

## 1.5.0 - 2025-03-08

- **LRU eviction index:** Added `_eviction_index.json` in the cache directory. It stores only evictable entries (`key`, `size`, `lastAccessed`) and is used for LRU eviction. When missing or corrupted, the index is rebuilt from file footers. All index operations are serialized with an in-memory lock.
- **lastAccessed on serve:** When serving a range from OPFS, `lastAccessed` is now updated in the eviction index only (in background via `event.waitUntil`), not in the file footer. This avoids concurrent read/write on the same file and prevents `NotReadableError` when seeking (e.g. video rewind).
- **New file in index:** After a successful write, evictable files are added to the eviction index (`addToEvictionIndex`). Eviction removes entries from the index after deleting files.
- **ensureSpaceForWrite / QuotaExceeded path:** Eviction now uses the index (getEntriesForEviction, getTotalCacheSizeWithIndex, computeEvictionSet on index entries, removeFromEvictionIndex). `listCacheFilesWithMeta` skips the index file.
- **Docs:** reference.mdc, opfs-cache-behavior.md and .ru updated (eviction index, index-only lastAccessed updates).

## 1.4.2 - 2025-03-05

- Version bump.

## 1.4.1 - 2025-03-02

- Require `@budarin/pluggable-serviceworker@^1.17.0` (peer and dev). No API changes in the plugin; compatible with 1.17.x.

## 1.4.0 - 2026-02-25

- **Breaking:** Require `@budarin/pluggable-serviceworker@^1.16.0`. The framework passes `fetchPassthrough` in `context` to each plugin. This plugin now uses `context.fetchPassthrough(request)` instead of `fetch(request)` for all network requests (opfsRangeFromNetworkAndCache, opfsPrecache). No changes required in `initServiceWorker(plugins, options)` — the framework injects `fetchPassthrough` into the context.

## 1.3.0 - 2026-02-25

- **Breaking:** Migrated to `@budarin/pluggable-serviceworker@^1.11.0`: plugin handlers now receive `context: PluginContext` (with `logger`, `base`) instead of `logger: Logger` as the second argument. Use `context.logger ?? console` when a logger is needed.
- **Architecture:** Extracted `urlToOpfsKey` into `opfsKey.ts` to eliminate circular dependencies (opfsRangeFromNetworkAndCache, opfsPrecache, opfsBackgroundFetch no longer import from index).
- **New:** Added `isEvictable(url, pinned)` helper in opfsUtil; replaced duplicated `pinned ? !shouldProcessFile(url, pinned) : true` across plugins.
- **Performance:** Parallelized `listOpfsCachedResources()` — file reads now run concurrently via `Promise.all`.
- **Docs:** Documented limitation when server returns 200 for Range request without Content-Length (full body buffered in memory).

## 1.2.1 - 2026-02-18

- Upgrade deps `@budarin/pluggable-serviceworker` to `1.10.9`

## 1.2.0 - 2026-02-18

- **Performance optimizations:**
    - Added `getRoot()` utility that caches OPFS root handle (`navigator.storage.getDirectory()`) to avoid repeated calls on frequent requests. All plugins and utilities now use `getRoot()` internally.
    - Optimized `urlToOpfsKey()` hex conversion: replaced `Array.from().map().join()` with a single loop using `charAt()` for better performance.
    - Added RegExp cache in `matchesGlob()` (up to 64 patterns, FIFO eviction) to avoid recompiling glob patterns on repeated calls.
    - Parallelized file eviction in `evictFiles()`: uses `Promise.all()` instead of sequential `await` for faster deletion of multiple files.
    - Added shared `readMetadataFromFileFooter()` function in `opfsFormat` to eliminate code duplication; used by `opfsServeRange`, LRU logic, and client utilities.
    - In `opfsRangeFromNetworkAndCache`: file existence check (for warning log) now runs only when `debug === true`, avoiding unnecessary OPFS operations in production.
- **New exports:**
    - `getRoot()` — cached OPFS root handle (exported from main entry point).
    - `readMetadataFromFileFooter()` — shared footer reader (exported from main entry point).
- **Documentation:**
    - Updated README/README.ru examples to use `getRoot()` instead of direct `navigator.storage.getDirectory()` calls.
    - Added `getRoot` to the list of utilities in documentation.
    - Updated `.cursor/rules/reference.mdc` with `getRoot()` and `readMetadataFromFileFooter()`.

## 1.1.11 - 2025-02-18

- Documentation: for `listOpfsCachedResources`, one ts block (interface `OpfsCachedResource`, then signature); removed the label and second block "Each array element". Removed subsection "Message payload" in README/README.ru (duplicated description under each subscription).

## 1.1.10 - 2025-02-18

- Documentation: subsection "Cache management and types" renamed to "Cache management utilities", added intro sentence (where called, purpose). Rules in `.cursor/rules/main.mdc`: tightened §1 — explicitly stated that stating the correct solution is not consent; added checklist before editing (three questions) and rule "when in doubt, do not edit".

## 1.1.9 - 2025-02-18

- Documentation: functions and plugins in README/README.ru formatted as list items (`- **\`name\`\*\* — purpose`); code blocks (signatures, OpfsCachedResource type) under list items indented by 4 spaces to render as item content in preview. Rules in `.cursor/rules/docs.mdc`: API reference section rewritten (short bullets, all in English), added explicit rule about indenting blocks under list items and "Do not" bullet — do not leave blocks at column 0.

## 1.1.8 - 2025-02-18

- Documentation: in README/README.ru, headings `###` only for logical groups (Message subscriptions, Cache management and types, Plugin specifications); function and plugin descriptions — **`name`** — purpose, no heading level. Message subscriptions: one ts block per function — message type (`type EventData`) and signature with `MessageEvent<EventData>`; field comments — inline (`//` at end of line). Added block with `OpfsCachedResource` type next to `listOpfsCachedResources`. Removed list markers from `event.data` descriptions. Rules in `.cursor/rules/docs.mdc` updated to this API format.

## 1.1.7 - 2025-02-18

- Documentation: restructured README/README.ru — client utilities and subscriptions formatted as specifications (heading + purpose in one line, full TypeScript signature, `event.data` types in multi-line blocks with comments for non-obvious fields); plugins section renamed to "Plugin specifications", plugin descriptions aligned with wording from intro list at start of file; plugin options — only in signature block with inline comments for non-obvious parameters; added API formatting rules in `.cursor/rules/docs.mdc`.

## 1.1.6 - 2026-02-17

- **Breaking:** message type constants (`OPFS_MSG_*`) aligned so name equals string value: value now equals name (e.g., `OPFS_MSG_QUOTA_EXCEEDED = 'OPFS_MSG_QUOTA_EXCEEDED'`). Previously `event.data.type` contained strings like `'OPFS_QUOTA_EXCEEDED'` — now contains `'OPFS_MSG_QUOTA_EXCEEDED'`. Code checking type by string must be updated.
- Documentation: README/README.ru lists all six message type constants, states that name equals value in `event.data.type`.

## 1.1.5 - 2026-02-17

- Documentation: in "Client utilities" section README/README.ru — table lists exact `event.data` fields per message type; removed subscription for non-sent message; explicitly stated that table contains only actually sent messages. Project rules (.cursor/rules/main.mdc): tightened §1 — edits only after explicit consent, examples of what does not count as consent.

## 1.1.4 - 2026-02-17

- Documentation: in "Client utilities" section README/README.ru added subscription signatures, description of `event.data` fields (OpfsMessagePayload), table per function (when called, what in payload), example with typing and unsubscribe.

## 1.1.3 - 2026-02-17

- Documentation: rewritten comparison paragraph with `@budarin/psw-plugin-serve-range-requests` in README/README.ru — explicitly stated advantage of random access to file parts (OPFS vs sequential reading in Cache API) and listed other package advantages (quota/eviction control, LRU, pinned, Background Fetch, precache, utilities).

## 1.1.2 - 2026-02-17

- Documentation: fixed examples of `pinned` option usage in README/README.ru — replaced vector map examples with media file (video) examples, matching Range request context.

## 1.1.0 - 2026-02-17

- New: added support for "pinned" resources in OPFS cache.
    - Added field `evictable` to OPFS file metadata (default `true`); when `false`, resource does not participate in LRU eviction.
    - Added option `pinned` to plugins `opfsPrecache`, `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch` (array of glob patterns for URLs that cannot be evicted).
    - LRU logic (`computeEvictionSet`) updated to never remove pinned resources.
- Tests: extended unit tests for `computeEvictionSet` to check behavior with `evictable: false`.
- Documentation: README/README.ru updated — described `pinned` option, `evictable` field in metadata footer, and configuration examples for non-evictable (pinned) resources.

## 1.0.6 - 2026-02-17

- Documentation: all links to `docs/opfs-cache-behavior*.md` in README changed to absolute GitHub URLs so they open correctly on npmjs.com.

## 1.0.3 - 2026-02-17

- Documentation: added explicit "Client utilities" section in README, cross-links from `docs/opfs-cache-behavior*.md`, and updated client entry point reference in `.cursor/rules/reference.mdc`.

## 1.0.2 - 2026-02-17

- Documentation: added English README and OPFS cache behavior docs (`docs/opfs-cache-behavior.md`); updated Russian README and `docs/opfs-cache-behavior.ru.md` (tone, terminology, structure).
- README: added and aligned badges (CI, npm, bundlephobia, license), links to Russian and English documentation.

## 1.0.1 - 2026-02-17

- First public release of `@budarin/psw-plugin-opfs-serve-range`.
- Plugins for HTTP Range requests from OPFS: `opfsServeRange`, `opfsPrecache`, `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch`.
- Single OPFS storage format: one file per URL (`hex(SHA-256(URL))`), metadata with `url`, `size`, `type`, `etag`, `lastAccessed` in file footer.
- Client entry point `@budarin/psw-plugin-opfs-serve-range/client`: quota/eviction events and utilities `listOpfsCachedResources`, `hasInOpfsCache`, `deleteFromOpfsCache` for cache management from UI.
- Basic Node (Vitest) unit tests for `urlToOpfsKey` and LRU logic (`getCacheLimit`, `computeEvictionSet`); added `pnpm test` script and test run in CI.
