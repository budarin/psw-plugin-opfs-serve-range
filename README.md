# @budarin/psw-plugin-opfs-serve-range

[Русская версия](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/README.ru.md)

[![CI](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@budarin/psw-plugin-opfs-serve-range?color=cb0000)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![npm](https://img.shields.io/npm/dt/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![bundle](https://img.shields.io/bundlephobia/minzip/@budarin/psw-plugin-opfs-serve-range)](https://bundlephobia.com/result?p=@budarin/psw-plugin-opfs-serve-range)
[![license](https://img.shields.io/npm/l/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)

Service Worker plugins and utilities for [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker). Large files are stored in the Origin Private File System (OPFS), and byte-range (HTTP Range) requests are served directly from those files: you can read any part of a file without reading from the start, unlike with the Cache API. You configure quota limits, eviction (LRU), and pinned resources. The package supports "download in the background and use offline" via the Background Fetch API.

**Third-party resources are not supported:** loading and caching are same-origin only. For cross-origin requests the browser returns an [opaque response](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque); the response body cannot be read or written to OPFS, so the plugins do not download such resources.

Detailed cache behavior (limits, LRU, eviction, notifications): [docs/opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md) (Russian: [docs/opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md)).

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Usage scenarios](#usage-scenarios)
    - [Cache on first request](#cache-on-first-request)
    - [Download for offline (Background Fetch)](#download-for-offline-background-fetch)
- [Reference: Service worker plugins](#reference-service-worker-plugins)
- [Reference: Client API](#reference-client-api)
- [OPFS storage format](#opfs-storage-format)
- [Writing your own OPFS plugin](#writing-your-own-opfs-plugin)
- [Requirements](#requirements)
- [License](#license)

---

## Install

```bash
pnpm add @budarin/psw-plugin-opfs-serve-range
```

---

## Quick start

Typical case: the user explicitly chooses what to download (e.g. "Download for offline"). You register **opfsServeRange** (serve byte ranges from OPFS when the file is in cache) and **opfsBackgroundFetch** (write to OPFS when a Background Fetch completes). Use **different folderName** for different caches (e.g. video vs audio).

- **opfsServeRange** — serves requested byte ranges from OPFS when the file is already in cache.
- **opfsBackgroundFetch** — when the user starts a download via the Background Fetch API (e.g. from the page with `startDownloadAssetsToOpfs`), completed responses are written to OPFS; later requests are then served from cache by opfsServeRange.

Example with **separate caches** for video and audio (two plugins per folder):

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { createOpfsServeAndBackgroundFetchPlugins } from '@budarin/psw-plugin-opfs-serve-range';

initServiceWorker(
    [
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'video-cache',
            include: ['*.mp4', '*.webm'],
        }),
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'audio-cache',
            include: ['*.mp3', '*.m4a'],
        }),
    ],
    { version: '1.0.0' }
);
```

Plugins that use the **same** cache (same folder) must use the same **folderName** and consistent options. On the page, use `startDownloadAssetsToOpfs({ folderName, assets, title })` to start a download; when it finishes, those URLs are served from cache. See [Download for offline](#download-for-offline-background-fetch) for the client API

## Usage scenarios

### Cache on first request

**Alternative to Background Fetch:** instead of the user explicitly starting a download, the cache is filled when the user first requests a resource (e.g. first time they play a video). Register **opfsServeRange** and **opfsRangeFromNetworkAndCache** (not opfsBackgroundFetch) for that folder. When the file is not in OPFS, the request goes to the network, the response is streamed to the client, and the file is saved to OPFS in the background. Later requests are served from cache. The download is aborted if the tab is closed or the network fails. Use this when you do not need an explicit "Download for offline" button and prefer automatic caching on first access.

Your server must support byte-range requests (HTTP Range): respond with 206 and Content-Length. Quota, LRU eviction, and pinned resources are described in the [Plugin reference](#reference-service-worker-plugins).

---

### Download for offline (Background Fetch)

In this scenario the user clicks something like "Download for offline"; selected files are downloaded in the background and the tab can be closed. When the download finishes, the app requests those same URLs with a Range header and receives data from cache.

#### Service worker

Register **opfsServeRange** and **opfsBackgroundFetch** with the **same folderName** per cache. Use a **different folderName** for each cache (e.g. video vs audio).

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { createOpfsServeAndBackgroundFetchPlugins } from '@budarin/psw-plugin-opfs-serve-range';

initServiceWorker(
    [
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'video-cache',
            include: ['*.mp4', '*.webm'],
            debug: true,
        }),
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'audio-cache',
            include: ['*.mp3', '*.m4a'],
        }),
    ],
    { version: '1.0.0' }
);
```

#### Client (page)

The easiest approach is the high-level API: one function starts the download. It returns a promise that resolves when assets are written to OPFS, or rejects on error or user cancel.

```typescript
import { startDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOffline(
    assets: string[],
    title: string,
    totalDownloadSizeInBytes?: number
) {
    try {
        const result = await startDownloadAssetsToOpfs({
            folderName: 'video-cache',
            assets,
            title,
            totalDownloadSizeInBytes,
            onProgress: (downloaded, total) =>
                console.log(`${downloaded}/${total}`),
            signal: myAbortController.signal,
        });
        console.log('Cached:', result.assets);
    } catch (e) {
        if (e && typeof e === 'object' && 'reason' in e) {
            console.warn('Download', (e as { reason: string }).reason);
        } else throw e;
    }
}
```

If you use React, the package provides a hook that keeps download state (status, progress in bytes and per file, errors, result). When the component unmounts, the hook only stops updating state; the download continues in the background. Call reset() to cancel. If the user returns to the page and clicks "Download" again with the same set of files, a download with that set may already be in progress — the new call then attaches to it instead of creating a duplicate, and the promise resolves when that download completes.

```typescript
import { useDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function DownloadButton() {
    const { startDownload, status, progress, fileProgress, error, data, reset } = useDownloadAssetsToOpfs();
    return (
        <>
            <button onClick={() => startDownload({ folderName: 'video-cache', assets: ['/assets/video.mp4'], title: 'Video' })}>
                Download
            </button>
            {status === 'pending' && progress && <span>{progress.downloaded}/{progress.total}</span>}
            {status === 'success' && data && <span>Done: {data.assets?.join(', ')}</span>}
            {status === 'failure' && error && <span>Failed</span>}
        </>
    );
}
```

If you need custom logic (your own download id, filtering, or callbacks), you can build the flow from low-level functions; see [Reference: Client API](#reference-client-api). The opfsBackgroundFetch plugin in the service worker still performs the write to OPFS; the download id must start with the prefix `opfs-ranges-` (constant **OPFS_BACKGROUND_FETCH_ID_PREFIX** in the package).

---

## Reference: Service worker plugins

**High-level helpers**

```ts
createOpfsServeAndBackgroundFetchPlugins(options: {
  folderName: string;
  order?: number;            // default: 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // default: false
  logger?: Logger;
  pinned?: string[];
  rangeResponseCacheControl?: string;
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin[]
```

```ts
createOpfsServeAndNetworkCachePlugins(options: {
  folderName: string;
  order?: number;            // default: 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // default: false
  logger?: Logger;
  pinned?: string[];
  rangeResponseCacheControl?: string;
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin[]
```

The factory returns an array of plugins. **initServiceWorker** (pluggable-serviceworker) flattens the plugins array, so you can pass the result directly without spread.

Each plugin requires **folderName: string** and **include: string[]** (non-empty) in its options. One folder = one cache. **include** and **exclude** can be glob patterns, pathnames, or full URLs (e.g. `['*.mp4', '/video/*']`, `['/assets/video.mp4']`, or `['https://example.com/video/*']`). At plugin init, full URLs are converted to pathnames (same-origin) or dropped (cross-origin). If after normalization `include` becomes empty (e.g. it contained only cross-origin URLs), the factory returns `undefined` and the plugin is not created. **When a request arrives:** if the request URL is cross-origin it is never processed (no serve, no cache). If same-origin, the URL’s pathname is matched against the (normalized) patterns — so a glob like `/video/*` matches a request with URL `https://example.com/video/1.mp4`. Plugins that serve or fill the same cache (e.g. opfsServeRange + opfsBackgroundFetch, or opfsServeRange + opfsRangeFromNetworkAndCache for the “cache on first request” scenario) must use the same **folderName** and consistent cache settings (rangeCacheMaxSizeBytes/rangeCacheMaxEntries when relevant); otherwise **registerFolderConfig** (called by the plugin factories) throws. Per-folder settings: **rangeCacheMaxSizeBytes** (default 5 MB), **rangeCacheMaxEntries** (default 300). To clear a cache, call **clearOpfsCache(folderName)**.

Storage is a **flat store**: all files live in one directory; **folderName** exists only in file metadata and is used for filtering (serve, list, clear). Cache size is limited by a **single global fraction** of origin quota (OPFS, Cache API, IndexedDB, etc. share the same quota). **getGlobalMaxCacheFraction()** (default 0.5) and **setGlobalMaxCacheFraction(fraction)** set the limit; **getMaxCacheFraction()** (no args) returns it. Do not set 1.0 if the app uses other storage.

In environments where OPFS is not available, plugin factories return undefined.

**Utility functions (SW)**

```ts
normalizePatternList(patterns: string[] | undefined, baseOrigin: string): { list: string[] | undefined; dropped: NormalizePatternListDropped }
emitDroppedPatternWarnings(dropped: NormalizePatternListDropped, logger: { warn?: (message: string) => void }): void
getRoot(): Promise<FileSystemDirectoryHandle>
getFlatStoreDir(): Promise<FileSystemDirectoryHandle>
getOpfsDir(root: FileSystemDirectoryHandle, create: boolean, folderName: string): Promise<FileSystemDirectoryHandle>
clearOpfsCache(folderName: string): Promise<void>
registerFolderConfig(folderName: string, config?: FolderCacheConfig): void
getGlobalMaxCacheFraction(): number
setGlobalMaxCacheFraction(fraction: number): void
getMaxCacheFraction(): number
getCacheLimit(estimate: StorageEstimate): number
getRangeCacheMaxSizeBytes(folderName: string): number
getRangeCacheMaxEntries(folderName: string): number
```

At init, full URLs are normalized to pathname; cross-origin or invalid go to `dropped`. Plugin factories emit warnings via logger. **getGlobalMaxCacheFraction** default is 0.5; **setGlobalMaxCacheFraction** expects (0, 1], throws if invalid.

**FolderCacheConfig** (for `registerFolderConfig`): only range cache limits (no per-folder quota).

```ts
interface FolderCacheConfig {
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}
```

**opfsServeRange** — reads files from OPFS and serves requested byte ranges (206).

```ts
opfsServeRange(options: {
  folderName: string;
  order?: number;            // default: 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // default: false
  logger?: Logger;
  rangeResponseCacheControl?: string;
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin | undefined
```

**opfsRangeFromNetworkAndCache** — handles requests that opfsServeRange did not serve from cache: fetches from the network, streams the response to the client immediately, and when possible saves the file to OPFS in the background. This download is aborted when the tab closes or the network drops.

```ts
opfsRangeFromNetworkAndCache(options: {
  folderName: string;
  order?: number;            // default: 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // default: false
  logger?: Logger;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetch** — when a Background Fetch completes successfully, writes the fetched responses to OPFS; later byte-range requests for those URLs are served by opfsServeRange. Only processes downloads whose id starts with **OPFS_BACKGROUND_FETCH_ID_PREFIX** (`opfs-ranges-`). In its message handler it calls the filter-response plugin (see **opfsBackgroundFetchFilter**).

```ts
opfsBackgroundFetch(options: {
  folderName: string;
  order?: number;            // default: 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // default: false
  logger?: Logger;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetchFilter** — handles only messages from the page: responds to the filter request (type OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER) with the current include and exclude. SW-side counterpart to the client **getBackgroundFetchFilter()**. When using the full stack you do not need to register it separately (opfsBackgroundFetch handles filter responses internally). For a custom service worker, register opfsBackgroundFetchFilter with the same include and exclude as your download logic. The filter normalizes include/exclude the same way (full URLs → pathnames or dropped); the client receives pathnames/globs. Returns **undefined** if after normalization include is empty (e.g. only cross-origin URLs).

```ts
opfsBackgroundFetchFilter(options: {
  include: string[];
  exclude?: string[];
  logger?: Logger;
}): Plugin | undefined
```

**opfsRegisteredFolders** — handles only messages from the page: responds to **OPFS_REQUEST_GET_REGISTERED_FOLDERS** with the list of folder names registered in the SW via **registerFolderConfig**. SW-side counterpart to the client **getRegisteredFolders()**. **startDownloadAssetsToOpfs** uses this list to reject downloads when the given folderName is not registered. Include in custom SW if you use the client folder check.

```ts
opfsRegisteredFolders(): Plugin | undefined
```

Pinned resources (the pinned option): an array of glob patterns for URLs. Resources matching these patterns are not evicted when space is low (LRU). Supported by both plugins that write to OPFS: opfsRangeFromNetworkAndCache and opfsBackgroundFetch.

---

## Reference: Client API

Client-side functions are imported from `@budarin/psw-plugin-opfs-serve-range/client`; the React hook is in `@budarin/psw-plugin-opfs-serve-range/client/react`.

### Downloading assets to OPFS

For startDownloadAssetsToOpfs to work as intended, the service worker must register plugins that answer client requests: **opfsBackgroundFetchFilter** (or opfsBackgroundFetch) for include/exclude filter, and **opfsRegisteredFolders** for the list of registered folder names. Otherwise the page cannot get the filter or folder list and the download will be rejected (see error codes OPFS_ERROR_*).

**getBackgroundFetchFilter()**

```ts
getBackgroundFetchFilter(): Promise<{ include?: string[]; exclude?: string[] }>
```

Asks the SW for the current include/exclude. The SW must register **opfsBackgroundFetchFilter** or opfsBackgroundFetch. Resolves with the filter; empty object on timeout or when no SW responds.

**getRegisteredFolders()**

```ts
getRegisteredFolders(): Promise<FolderName[]>
```

Asks the SW for the list of folder names registered via registerFolderConfig. The SW must register the **opfsRegisteredFolders** plugin. On timeout or no response returns an empty array (then startDownloadAssetsToOpfs will reject with OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE).

**filterAssetsForOpfs(assets, include?, exclude?)**

```ts
filterAssetsForOpfs(
  assets: string[],
  include?: string[],
  exclude?: string[]
): string[]
```

**estimateAssetsSizeInBytes(assets)**

```ts
estimateAssetsSizeInBytes(
  assets: string[]
): Promise<{ totalSize: number; sizes: Record<string, number> }>
```

Sends HEAD requests for the given resources (same-origin) and tries to read the `Content-Length` header to estimate their sizes.

- **assets** — list of resource pathnames (for example, `['/video/1.mp4']`).
- Returns an object:
  - **totalSize** — total number of bytes across all resources for which `Content-Length` was available (others contribute `0`).
  - **sizes** — map `pathname → size in bytes` (`0` when the size cannot be determined).

The helper works only for same-origin resources (like the rest of the package). If the server does not expose `Content-Length` or the response is not successful, the size is treated as `0`; the promise still resolves.

Example together with `startDownloadAssetsToOpfs`:

```ts
import {
  startDownloadAssetsToOpfs,
  estimateAssetsSizeInBytes,
} from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOfflineWithEstimatedSize(assets: string[], title: string) {
  const { totalSize } = await estimateAssetsSizeInBytes(assets);

  await startDownloadAssetsToOpfs({
    folderName: 'video-cache',
    assets,
    title,
    totalDownloadSizeInBytes: totalSize,
  });
}
```

**startDownloadAssetsToOpfs(options)**

On success, the system download list keeps the **title** you pass (fail/abort still show an updated title). Use a descriptive **title** so completed entries are distinguishable.

**Before starting:** The function requests the list of registered folders from the SW (**getRegisteredFolders()**). If **folderName** is not in the list or the list is empty, the promise rejects (OPFS_ERROR_FOLDER_NOT_REGISTERED or OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE). Then from the asset list (after include/exclude), it excludes pathnames that are already being fetched in other active Background Fetch registrations (pathnames from matchAll() for each active registration with the `opfs-ranges-` prefix). It then excludes pathnames already in OPFS (one call to **listOpfsCachedResources(folderName)**). This order (in progress first, then in cache) ensures a just-finished download is not missed. Only the remaining assets are queued for download. If none remain, the promise resolves immediately with `written: assetsToUse` (nothing to fetch). The download id is computed idempotently from the pathname set (getOpfsBackgroundFetchId). If a download with the same set is already running, the new call attaches to it instead of creating a duplicate; the promise resolves when that download completes.

```ts
startDownloadAssetsToOpfs(options: StartDownloadAssetsToOpfsOptions): Promise<DownloadAssetsToOpfsResult>

interface StartDownloadAssetsToOpfsOptions {
    folderName: string;
    assets: string[];
    title?: string;
    icons?: { src: string; sizes?: string; type?: string }[];
    totalDownloadSizeInBytes?: number;
    onProgress?: (downloaded: number, total: number) => void;
    onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
    signal?: AbortSignal;
}

interface DownloadAssetsToOpfsResult {
    registrationId: string;
    assets?: string[];
    written?: string[];
    failedOrSkipped?: string[];
    filteredOut?: string[];
}

interface DownloadAssetsToOpfsRejected {
    registrationId: string;
    reason: 'fail' | 'abort';
}
```

Use `try/catch` or `.catch()` to handle and display errors in the UI.

- **useDownloadAssetsToOpfs()** — React hook. Returns the function to start a download, status, progress in bytes and per file, **error** (set on failure so you can show it in the UI), result, and a reset function. **startDownload** rejects the promise on error (same errors as above); the error is also stored in **error** state. Check `error?.code` for `OPFS_ERROR_FOLDER_NOT_REGISTERED` or `OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE`. The download is not cancelled on unmount; cancel only via reset(). If the user clicks "Download" again with the same set of files, the call attaches to the existing download (no duplicate). Requires React as a peer dependency.

```ts
useDownloadAssetsToOpfs(): {
    startDownload: (options: Omit<StartDownloadAssetsToOpfsOptions, 'signal'>) => Promise<void>;
    status: 'idle' | 'pending' | 'success' | 'failure' | 'aborted';
    progress: { downloaded: number; total: number } | null;
    fileProgress: { loadedAssets: string[]; totalCount: number } | null;
    error: StartDownloadError | null;
    data: DownloadAssetsToOpfsResult | null;
    reset: () => void;
}
```

### Low-level API (without startDownloadAssetsToOpfs or the hook)

If you are not using startDownloadAssetsToOpfs or the hook and want to wire the flow yourself, you need two things. First, the functions to start a download and check for support: **startBackgroundFetch** and **isBackgroundFetchSupported** from the pluggable-serviceworker package (client submodule `client/background-fetch`). Second, subscribe to the service worker messages for completion, failure, abort, and per-file write; the subscription functions (**onOPFSBackgroundFetchCompleted**, **onOPFSBackgroundFetchFailed**, **onOPFSBackgroundFetchAborted**, **onOPFSBackgroundFetchFileWritten**) are exported from this package. The download id must be formed using **getOpfsBackgroundFetchId(assets, folderName)**. That id is unique per folder, so the same asset set in different caches does not collide. The service worker plugin uses the id prefix per folder to handle only its own completions.

### Subscriptions to service worker messages

Each function takes a handler and returns a function to unsubscribe. When each message type is sent is described in [opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md).

**Skip list:** When streaming a write to OPFS, the browser may throw QuotaExceeded. If by then we have already written as many bytes as the whole cache size, evicting old files will not free enough space. That URL is added to the skip list (kept in the service worker’s memory for its lifetime). On later requests for that URL, the plugin does not attempt to cache again and sends **onOPFSSkipQuotaExceeded** so the client can show a warning.

**What each subscription is for:**

- **onOPFSQuotaExceeded** — Quota exceeded while writing to OPFS.
- **onOPFSWriteSkipped** — Write skipped before starting: with known size, the space check failed (file does not fit even after eviction).
- **onOPFSEvictionCompleted** — Eviction completed.
- **onOPFSWriteFailed** — Write error.
- **onOPFSSkipQuotaExceeded** — Request for a URL in the skip list (plugin does not cache, only notifies).
- **onOPFSBackgroundFetchFailed** — Background Fetch completed with failure.
- **onOPFSBackgroundFetchAborted** — Background Fetch aborted.
- **onOPFSBackgroundFetchCompleted** — Background Fetch completed successfully, assets in OPFS.
- **onOPFSBackgroundFetchFileWritten** — Another file written to OPFS (per-file progress).
- **onOPFSRangeCacheFetchStarted** — Plugin opfsRangeFromNetworkAndCache started a background cache fetch (“cache on first request” scenario). Use it to show a “background download in progress” indicator.
- **onOPFSRangeCacheFetchAllDone** — All such background cache fetches have finished. Use it to hide the indicator.

All of these functions share the same signature and handler type. **Common interface** (exported from the package):

```ts
type OpfsMessageHandler = (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void;

interface OpfsMessagePayload {
    url?: string;
    size?: number;
    limit?: number;
    reason?: string;
    registrationId?: string;
    assets?: string[];
    written?: string[];
    failedOrSkipped?: string[];
    asset?: string;
    loadedAssets?: string[];
    totalCount?: number;
}
```

Which fields appear in `event.data` depends on the message type (see list above and [opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md)). Event type constants: `OPFS_MSG_*`, `OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER`, `OPFS_RESPONSE_BACKGROUND_FETCH_FILTER`.

### Cache utilities

These functions are called from the page and send requests to the service worker (plugin **opfsCacheControl**). The SW performs the operation in OPFS and invalidates its in-memory caches. Request timeout is 2 s. **folderName** must match a folder registered in the SW. If the folder is not registered, the SW responds with an error: **listOpfsCachedResources** and **hasInOpfsCache** then return `[]` and `false`; **deleteFromOpfsCache** does not require **folderName** (file is deleted by URL from the flat store). **clearOpfsCache** requires **folderName**; if the folder is not registered, it rejects with `opfs: folder not registered`. When using **createOpfsServeAndBackgroundFetchPlugins** or **createOpfsServeAndNetworkCachePlugins**, **opfsCacheControl** is included, so list/has/delete/clear work out of the box. To clear a cache from the page, call **clearOpfsCache(folderName)** (same signature as on the SW; the client sends a CLEAR request).

**listOpfsCachedResources(folderName)**

```ts
listOpfsCachedResources(folderName: string): Promise<OpfsCachedResource[]>

interface OpfsCachedResource {
    url: string;
    size: number;
    type: string | undefined;
    lastModified: string | undefined;
}
```

**hasInOpfsCache(url, folderName)**

```ts
hasInOpfsCache(url: string, folderName: string): Promise<boolean>
```

**deleteFromOpfsCache(url)**

```ts
deleteFromOpfsCache(url: string): Promise<void>
```

### Switch player to OPFS when file is loaded

When a file (the current source of a video/audio element) has been written to OPFS via Background Fetch, you can reconnect the player to that same URL so subsequent requests are served from OPFS (e.g. for instant seeking). Use **onOPFSBackgroundFetchFileWritten** and **reconnectPlayerOnFileLoadedIntoOpfs**. For **video**, the current frame is shown as an overlay during the switch and removed only when the new source is actually displaying (**playing** or **seeked**), so there is no black flash. The wrapper preserves the video’s layout (margin, box-sizing, display) so the switch does not shift content. If the video had no explicit dimensions, they are fixed for the duration of the switch and then cleared. Audio is reconnected without any overlay.

**reconnectPlayerOnFileLoadedIntoOpfs(element, payload, folderName, options?)**

Call from your `onOPFSBackgroundFetchFileWritten` handler. If `payload.asset` matches the element's current source and the file is in OPFS, reconnects the player and restores playback state. See **FileWrittenPayload** and **ReconnectPlayerOnFileLoadedIntoOpfsOptions** below.

```ts
reconnectPlayerOnFileLoadedIntoOpfs(
  element: HTMLMediaElement,
  payload: FileWrittenPayload,
  folderName: FolderName,
  options?: ReconnectPlayerOnFileLoadedIntoOpfsOptions
): Promise<void>

interface FileWrittenPayload {
    asset?: string;
}

interface ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    logger?: Logger;
    debug?: boolean;   // default: false
}

interface UseReconnectPlayerOnFileLoadedIntoOpfsOptions extends ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    folderName: FolderName;
}
```

**Example (vanilla TS):**

```ts
import {
    onOPFSBackgroundFetchFileWritten,
    reconnectPlayerOnFileLoadedIntoOpfs,
} from '@budarin/psw-plugin-opfs-serve-range/client';

const video = document.querySelector('video');
const folderName = 'video-cache';

if (video) {
    const unsubscribe = onOPFSBackgroundFetchFileWritten((event) => {
        reconnectPlayerOnFileLoadedIntoOpfs(video, event.data, folderName).catch(() => {});
    });
}
```

**Example (React):**

```tsx
import { useRef } from 'react';
import { useReconnectPlayerOnFileLoadedIntoOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function VideoPlayer() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    useReconnectPlayerOnFileLoadedIntoOpfs(videoRef, { folderName: 'video-cache' });
    return <video ref={videoRef} src="/video/lesson-1.mp4" controls />;
}
```

---

## OPFS storage format

For custom plugins or direct file access. All cache folders live under the plugin root **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) in the OPFS root: OPFS root → `.opfs-serve-range` → folderName. This keeps plugin data separate from other apps’ folders. File key: `hex(SHA-256(URL))` (64 chars). One file per URL: resource body, then footer (JSON metadata + 4-byte length). Metadata fields in JSON: `url`, `size`, `type`, `etag`, `lastModified`, `lastAccessed`, `evictable`. All plugins in this package use the same format and shared **urlToOpfsKey**.

**Important:** When serving a file in full (200 without Range), return only the body, not the footer: compute `bodySize` from the footer and use `file.slice(0, bodySize)`. The opfsServeRange plugin only serves body ranges (206); the footer is never exposed.

---

## Writing your own OPFS plugin

To write to OPFS with your own logic using the same format:

```ts
getRoot(): Promise<FileSystemDirectoryHandle>
getOpfsDir(root: FileSystemDirectoryHandle, create: boolean, folderName: string): Promise<FileSystemDirectoryHandle>
urlToOpfsKey(url: string): Promise<string>
metadataFromResponse(response: Response, url: string): OpfsMetadata
writeToOpfs(
  dir: FileSystemDirectoryHandle,
  key: string,
  bodyStream: ReadableStream<Uint8Array>,
  metadata: OpfsMetadata,
  options: WriteToOpfsOptions
): Promise<void>

interface OpfsMetadata {
    url: string;
    size: number;
    type?: string;
    etag?: string;
    lastModified?: string;
    lastAccessed?: number;
    evictable?: boolean;
}

interface WriteToOpfsOptions {
    folderName: string;
    url?: string;
    knownSize?: number;
}
```

```typescript
import {
    getRoot,
    getOpfsDir,
    urlToOpfsKey,
    writeToOpfs,
    metadataFromResponse,
} from '@budarin/psw-plugin-opfs-serve-range';

const root = await getRoot();
const dir = await getOpfsDir(root, true, 'my-cache');
const key = await urlToOpfsKey(url);
const metadata = metadataFromResponse(response, url);
await writeToOpfs(dir, key, response.body, metadata, {
    folderName: 'my-cache',
});
```

The response may omit `Content-Length` — size is determined by counting bytes in the body when writing. For cache limits to apply (space check before write, eviction, notifications, and skip list), pass the fifth argument `options` to `writeToOpfs` with `url` and `knownSize`.

---

## Requirements

You need a browser that supports OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) and a secure context (the page must be loaded over HTTPS).

---

## License

MIT
