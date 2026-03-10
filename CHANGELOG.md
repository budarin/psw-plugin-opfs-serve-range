# Changelog

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
    - In `opfsRangeFromNetworkAndCache`: file existence check (for warning log) now runs only when `enableLogging === true`, avoiding unnecessary OPFS operations in production.
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
