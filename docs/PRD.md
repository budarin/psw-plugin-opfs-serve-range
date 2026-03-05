# Product Requirements Document (PRD)

## @budarin/psw-plugin-opfs-serve-range

Product requirements for the OPFS Range-serving plugin: purpose, stakeholders, use cases, functional and non-functional requirements, and success criteria. Used to align features and implementation with intended product behavior.

---

## 1. Context and problem

Large media and heavy assets are typically requested in chunks via **HTTP Range** rather than as a single download. When such resources are stored in the **Cache API**, the service worker often has to read and process the entire file to serve a small range, which is wasteful in memory and CPU and hits storage limits on low-end devices.

**This package** uses the **Origin Private File System (OPFS)** as primary storage for range-served resources. Files are stored in OPFS (one file per URL, custom format with metadata footer); ranges are read with **random access** from the file system. The package provides plugins for: serving range requests from OPFS, fetching from network and caching, precaching at install, and writing from Background Fetch. Quota sharing, LRU eviction, pinned resources, and client notifications are supported.

**Ecosystem:** The plugin targets [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker) (PSW). When OPFS is not available, plugin factories return `undefined` and the app falls back to normal network/framework behavior.

---

## 2. Goals

- **Serve Range requests from OPFS** when the resource is already cached, with minimal read (only the requested bytes) and optional Cache-Control for 206 responses.
- **Cache full responses (200 only)** into OPFS from network or Background Fetch; support **one background full GET per URL** when serving 206 from network so that the full file is eventually cached.
- **Respect quota and limits:** use a configurable fraction of origin quota; evict by **LRU** (lastAccessed) among **evictable** entries only; support **pinned** URLs that are never evicted.
- **Notify the client** about quota exceeded, write skipped, eviction completed, write failed, and blacklist (skip) so the UI can inform the user.
- **Support precache** at SW install and **Background Fetch** so that “download for offline” and “preload critical assets” are first-class scenarios.
- **Expose utilities** for custom OPFS read/write plugins (same format, key, metadata) and for client-side cache listing/deletion.

---

## 3. Non-goals / Out of scope

- **Do not cache 206 responses** into OPFS; only full responses (200) are stored.
- **Do not replace CDN or origin**; the plugin sits in front of the network and uses `fetch`/passthrough when the resource is not in OPFS.
- **No index file** for the cache; listing and size are computed by scanning the OPFS directory when needed.
- **No automatic retry** of the same stream after QuotaExceeded; the next request for the same URL starts a new download.
- **No guarantee** that a single very large file will fit on low-quota devices; the limit is derived from quota and existing usage.
- **No support for browsers without OPFS:** in such environments the plugin is not used (factories return `undefined`); the app relies on normal network/framework behavior. No polyfill or alternative storage (e.g. Cache API) is provided by this package.

---

## 4. Users and stakeholders

| Role | Description |
|------|-------------|
| **Integrator (primary)** | Developer who adds the plugin to a PSW-based app. Configures plugins, `configureOpfs`, include/exclude, pinned; consumes client utilities and notifications. |
| **End user** | User of the app: benefits from faster range playback, offline playback, and predictable cache behavior; may see UI driven by notifications (e.g. “could not save for offline”). |

---

## 5. Use cases and scenarios

Below are the main usage scenarios. They are not ordered by priority; the plugin is designed so that all of them work with the same cache format and limits.

| # | Scenario | Who | What happens | Result |
|---|----------|-----|--------------|--------|
| **UC-1** | **First request (resource not in cache)** | Client (e.g. player) | Sends GET with `Range`. `opfsServeRange` does not find the file → returns `undefined`. `opfsRangeFromNetworkAndCache` fetches from network, streams the response to the client (206 or 200→206), and may start a background full GET to write the full file to OPFS. | Client gets the range; on next request for the same URL the file may already be in OPFS. |
| **UC-2** | **Repeat request (resource in cache)** | Client | Sends GET with `Range`. `opfsServeRange` finds the file in OPFS, reads only the requested bytes, returns 206, and updates `lastAccessed` in the file footer in the background. | Fast response from disk; no network. |
| **UC-3** | **Precache at install** | Integrator / SW | At SW install, `opfsPrecache` runs: fetches a configured list of URLs and writes 200 responses to OPFS (with optional `pinned`). | Critical assets are in cache before the user opens the app. Large files can make install slow; only resources that are expected to fit should be listed. |
| **UC-4** | **Download for offline (Background Fetch)** | User / app | User triggers “download for offline”. App starts a Background Fetch. When it completes, `opfsBackgroundFetch` writes the responses to OPFS. | Later, Range requests for those URLs are served by `opfsServeRange` without network. |
| **UC-5** | **Cache full, need space for new file** | SW (plugin) | A new 200 response must be cached. If size is known: `ensureSpaceForWrite` runs first, evicts a minimal LRU set (evictable only), then write. If size unknown: stream write; on QuotaExceeded, partial file is removed and LRU eviction frees space (or URL is blacklisted if eviction would not help). | New file is cached; pinned entries are never evicted. |
| **UC-6** | **Quota exceeded, URL blacklisted** | SW (plugin) | Stream write fails with QuotaExceeded; `bytesWritten ≥ totalCacheSize`. URL is added to blacklist; clients are notified. On later requests for this URL, the plugin does not attempt to cache again and notifies (skip). | UI can inform the user; no repeated failed writes. |

---

## 6. Functional requirements

### 6.1 Core behavior

- **FR-1** Plugin **opfsServeRange** MUST handle only GET requests with a Range header; for matching URLs (include/exclude) and when the file exists in OPFS, return 206 with the requested byte range; otherwise return `undefined`.
- **FR-2** When serving from OPFS, **lastAccessed** in the file footer MUST be updated in the background (e.g. `event.waitUntil`) and MUST NOT block the 206 response.
- **FR-3** Plugin **opfsRangeFromNetworkAndCache** MUST run only when `opfsServeRange` has returned `undefined`; MUST use network (e.g. `context.fetchPassthrough`); MAY stream response to client and MAY start a background full GET to cache the resource; only **200** responses MUST be written to OPFS (never 206).
- **FR-4** At most **one** concurrent background full GET per URL (e.g. tracked via `loadingUrls`); duplicate Range requests for the same URL must not start multiple full downloads.

### 6.2 Caching and limits

- **FR-5** Cache limit MUST be computed as `min(quota × maxCacheFraction, quota − usage)` from `navigator.storage.estimate()`; `maxCacheFraction` and `folderName` MUST be configurable via `configureOpfs`.
- **FR-6** Eviction MUST be LRU by `lastAccessed`; only entries with `evictable !== false` MUST be considered for eviction; the set of files to remove MUST be minimal (enough to free required space).
- **FR-7** When writing with **known size**, MUST run `ensureSpaceForWrite` before write; if it is impossible to free enough space, MUST NOT start the write and MUST notify clients (e.g. write skipped).
- **FR-8** When writing without known size (stream) and QuotaExceeded: MUST remove the partial file; if `bytesWritten ≥ totalCacheSize` MUST add URL to blacklist and MUST NOT evict; otherwise MUST evict (e.g. bytesWritten + headroom) by LRU and MUST notify clients as specified.

### 6.3 Pinned and blacklist

- **FR-9** Plugins that write to OPFS (opfsRangeFromNetworkAndCache, opfsPrecache, opfsBackgroundFetch) MUST support a **pinned** option (glob patterns); URLs matching pinned MUST be stored with `evictable: false` and MUST NOT be included in the eviction set.
- **FR-10** Before starting a cache write without Content-Length, if the URL is **blacklisted**, MUST NOT write and MUST notify clients (e.g. OPFS_MSG_SKIP_QUOTA_EXCEEDED).

### 6.4 Precache and Background Fetch

- **FR-11** **opfsPrecache** MUST run at SW install; MUST fetch given URLs (list or async function) and write 200 responses to OPFS; MUST support `pinned` and include/exclude; behavior when OPFS write fails during install (e.g. whole install fails) is as per platform.
- **FR-12** **opfsBackgroundFetch** MUST, on Background Fetch success, for each record passing include/exclude, write to OPFS (same format and options as other writers); MUST support pinned and blacklist check.

### 6.5 Client and notifications

- **FR-13** Service worker MUST notify clients (e.g. via `notifyClients`) for: quota exceeded, write skipped (size), cache limit reached, eviction completed, write failed, skip (blacklisted URL). Message types MUST be documented and client helpers MUST be provided for subscription.
- **FR-14** Client MUST be able to: list cached resources (from metadata), check by URL, delete by URL; and subscribe to the notification types above with typed handlers and unsubscribe.

### 6.6 Format and compatibility

- **FR-15** OPFS key MUST be `hex(SHA-256(URL))`; one file per URL. File layout MUST be `[body][4 bytes meta length LE][JSON meta]`; metadata MUST include at least url, size, type?, etag?, lastModified?, lastAccessed?, evictable?.
- **FR-16** When OPFS is not available (e.g. `isOpfsAvailable()` false), plugin factories MUST return `undefined`.

---

## 7. Non-functional requirements and constraints

- **NFR-1** Dependencies: PSW (pluggable-serviceworker), browser with OPFS support and secure context (HTTPS). No polyfill for OPFS; graceful degradation by returning `undefined`.
- **NFR-2** All cache files MUST live under a single configurable OPFS directory; no index file; listing/size by scanning when needed.
- **NFR-3** Range parsing and 206 building MUST support exactly the following **Range** header forms (see section **Supported Range header formats** below). If-Range / validator handling for OPFS-served responses: mismatch → `undefined` (pass through to network).
- **NFR-4** Stream write without Content-Length: when serving 200 to client (e.g. range slice), if body is buffered (e.g. `blob()`), memory usage should be considered; avoid unbounded buffering for very large responses without Content-Length.

### Supported Range header formats

The plugin parses the `Range` request header and supports **only** these forms (unit `bytes`; single range per request):

| Format | Example | Meaning |
|--------|---------|---------|
| **Start and end** | `bytes=0-1023` | Bytes from position 0 to 1023 (inclusive). |
| **Start only (open end)** | `bytes=1024-` | From position 1024 to the end of the resource. |
| **Suffix** | `bytes=-512` | Last 512 bytes of the resource. |

- **Supported:** exactly one range per header; values non-negative integers; bounds checked against resource size (`fullSize`); invalid or out-of-bounds → error (e.g. throw / pass through).
- **Not supported:** multiple ranges (e.g. `bytes=0-1,2-3`), other units, negative start.

---

## 8. Success criteria

- **SC-1** Range requests for a cached URL are served from OPFS with correct 206 (correct byte range and Content-Range); no footer bytes are sent to the client.
- **SC-2** Eviction is predictable: only evictable entries, LRU by lastAccessed, minimal set; pinned entries are never evicted.
- **SC-3** Clients receive notifications for all specified events (quota exceeded, write skipped, eviction completed, write failed, skip/blacklist) so the UI can react.
- **SC-4** Integrators can combine opfsServeRange, opfsRangeFromNetworkAndCache, opfsPrecache, opfsBackgroundFetch with include/exclude/pinned and get consistent behavior; custom plugins can use the same format and utilities.
- **SC-5** In environments without OPFS, the app continues to work without the plugin (no throw); with OPFS, cache stays within the configured limit and does not grow unbounded.

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| **OPFS** | Origin Private File System; per-origin file storage in the browser. |
| **LRU** | Least recently used; eviction by `lastAccessed` (oldest first). |
| **Evictable** | Metadata flag; `false` = pinned, never evicted by LRU. |
| **Pinned** | URL matches a `pinned` glob; stored with `evictable: false`. |
| **Blacklist** | In-memory set of URLs not to try caching again (after stream write QuotaExceeded when bytesWritten ≥ totalCacheSize). |
| **Background Fetch** | Browser API for long-running downloads that can outlive the page. |
| **PSW** | @budarin/pluggable-serviceworker. |

---

*Document version: 1.1. Source: reference.mdc, README, opfs-cache-behavior, opfsRangeUtil. For implementation details see reference.mdc and code.*
