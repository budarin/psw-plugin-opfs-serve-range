# @budarin/psw-plugin-opfs-serve-range

[Русская версия](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/README.ru.md)

[![CI](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@budarin/psw-plugin-opfs-serve-range?color=cb0000)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![npm](https://img.shields.io/npm/dt/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![bundle](https://img.shields.io/bundlephobia/minzip/@budarin/psw-plugin-opfs-serve-range)](https://bundlephobia.com/result?p=@budarin/psw-plugin-opfs-serve-range)
[![license](https://img.shields.io/npm/l/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)

Service Worker plugins and utilities for [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker). Large files are stored in the Origin Private File System (OPFS), and byte-range (HTTP Range) requests are served directly from those files: you can read any part of a file without reading from the start, unlike with the Cache API. You configure quota limits, eviction (LRU), and pinned resources. The package supports "download in the background and use offline" via the Background Fetch API.

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

The simplest case: on the first request for a resource, data is loaded from the network and saved to OPFS. On later requests to the same URL, the response is served from cache without going to the network.

To enable this, register two plugins in the service worker:

- **opfsServeRange** — serves requested byte ranges from OPFS when the file is already in cache.
- **opfsRangeFromNetworkAndCache** — when the file is not in cache, the request goes to the network; the response is streamed to the client immediately, and the file is saved to OPFS in the background when possible.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    configureOpfs,
    opfsServeRange,
    opfsRangeFromNetworkAndCache,
} from '@budarin/psw-plugin-opfs-serve-range';

configureOpfs({
    folderName: 'ranges-media-cache',
    maxCacheFraction: 0.5,
});

initServiceWorker(
    [
        opfsServeRange({
            order: -15,
            include: ['*.mp4', '*.webm'],
        }),
        opfsRangeFromNetworkAndCache({
            order: -10,
            include: ['*.mp4', '*.webm'],
        }),
    ],
    { version: '1.0.0' }
);
```

After this setup, requests to URLs in `include` check the OPFS cache first; if the file is not there, the request goes to the network and a successful response is written to cache. You do not need any code on the page for this scenario.

Important: a download started by opfsRangeFromNetworkAndCache is aborted when the tab is closed or the network fails. To show whether such a background cache fetch is in progress, the page can subscribe to **onOPFSRangeCacheFetchStarted** and **onOPFSRangeCacheFetchAllDone** (to turn the indicator on and off). If you need a download that continues after the tab is closed, use the [Download for offline](#download-for-offline-background-fetch) scenario.

---

## Usage scenarios

### Cache on first request

For this scenario to work as intended, your server must support byte-range requests (HTTP Range): it should respond to requests that include a Range header with status 206 and a Content-Length header.

How it works is described in [Quick start](#quick-start). In short: a request first checks the OPFS cache; if the file is missing, the request goes to the network, the response is sent to the client, and when possible it is also saved to OPFS. Later requests to the same URL are then served from cache. The plugins involved are opfsServeRange and opfsRangeFromNetworkAndCache. Quota, LRU eviction, and pinned resources are described in the [Plugin reference](#reference-service-worker-plugins).

---

### Download for offline (Background Fetch)

In this scenario the user clicks something like "Download for offline"; selected files are downloaded in the background and the tab can be closed. When the download finishes, the app requests those same URLs with a Range header and receives data from cache.

#### Service worker

In the service worker, register the **opfsBackgroundFetch** plugin. It handles Background Fetch events and messages from the page (response to the filter include/exclude request), so you do not need to add a separate `message` listener.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    configureOpfs,
    opfsServeRange,
    opfsRangeFromNetworkAndCache,
    opfsBackgroundFetch,
} from '@budarin/psw-plugin-opfs-serve-range';

configureOpfs({ folderName: 'range-requests-cache', maxCacheFraction: 0.5 });

initServiceWorker(
    [
        opfsServeRange({
            order: -15,
            include: ['*.mp4', '*.webm'],
        }),
        opfsRangeFromNetworkAndCache({
            order: -10,
            include: ['*.mp4', '*.webm'],
        }),
        opfsBackgroundFetch({
            include: ['*.mp4', '*.webm'],
            enableLogging: true,
        }),
    ],
    { version: '1.0.0' }
);
```

#### Client (page)

The easiest approach is the high-level API: one function starts the download. It returns a promise that resolves when assets are written to OPFS, or rejects on error or user cancel.

```typescript
import { startDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOffline(assets: string[], title: string, downloadTotal?: number) {
    try {
        const result = await startDownloadAssetsToOpfs({
            assets,
            title,
            downloadTotal,
            onProgress: (downloaded, total) => console.log(`${downloaded}/${total}`),
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

If you use React, the package provides a hook that keeps download state (status, progress in bytes and per file, errors, result). When the component unmounts, the hook only stops updating state; the download continues in the background. Call reset() to cancel.

```typescript
import { useDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function DownloadButton() {
    const { startDownload, status, progress, fileProgress, error, data, reset } = useDownloadAssetsToOpfs();
    return (
        <>
            <button onClick={() => startDownload({ assets: ['/assets/video.mp4'], title: 'Video' })}>
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

Global cache settings are set via configureOpfs: the OPFS folder name and the fraction of storage quota. Call configureOpfs before registering plugins. By default the folder name is `range-requests-cache` and the quota fraction is 0.5. To clear the entire cache, use clearOpfsCache().

In environments where OPFS is not available, plugin factories return undefined.

| Plugin | Purpose |
|--------|---------|
| **opfsServeRange** | Reads files from OPFS and serves requested byte ranges (206). |
| **opfsRangeFromNetworkAndCache** | Requests opfsServeRange did not serve: network → stream to client and optionally write to OPFS in background. Download is aborted when the tab closes or the network drops. |
| **opfsBackgroundFetch** | On successful Background Fetch completion, writes responses to OPFS; subsequent Range requests for those URLs are served by opfsServeRange. Only processes downloads whose id starts with **OPFS_BACKGROUND_FETCH_ID_PREFIX** (`opfs-ranges-`). In its message handler it calls the filter-response plugin (see **opfsBackgroundFetchFilter**). |
| **opfsBackgroundFetchFilter** | Message handler only: responds to OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER with current include/exclude. Server-side counterpart to client **getBackgroundFetchFilter()**. Standalone plugin — for a custom SW you can register only this plugin with your own include/exclude. |

**opfsServeRange**

```ts
opfsServeRange(options?: {
  order?: number;
  enableLogging?: boolean;
  include?: string[];
  exclude?: string[];
  rangeResponseCacheControl?: string; // default: max-age=31536000, immutable
}): Plugin | undefined
```

**opfsRangeFromNetworkAndCache**

```ts
opfsRangeFromNetworkAndCache(options?: {
  order?: number;
  include?: string[];
  exclude?: string[];
  enableLogging?: boolean;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetch**

```ts
opfsBackgroundFetch(options?: {
  order?: number;
  include?: string[];
  exclude?: string[];
  enableLogging?: boolean;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetchFilter**

Plugin that only answers the filter request (getBackgroundFetchFilter on the client). When using the full stack you do not need to register it separately — opfsBackgroundFetch calls it internally. For a custom service worker, register opfsBackgroundFetchFilter with the same include/exclude as your download logic.

```ts
opfsBackgroundFetchFilter(options?: {
  include?: string[];
  exclude?: string[];
}): Plugin
```

Pinned resources (the pinned option): an array of glob patterns for URLs. Resources matching these patterns are not evicted when space is low (LRU). Supported by both plugins that write to OPFS: opfsRangeFromNetworkAndCache and opfsBackgroundFetch.

---

## Reference: Client API

Client-side functions are imported from `@budarin/psw-plugin-opfs-serve-range/client`; the React hook is in `@budarin/psw-plugin-opfs-serve-range/client/react`.

### Downloading assets to OPFS

For startDownloadAssetsToOpfs to work as intended, the service worker must register a plugin that answers the filter request — either **opfsBackgroundFetch** (which calls the filter plugin internally) or **opfsBackgroundFetchFilter** alone (for a custom SW). Otherwise the page cannot get the filter settings and the download may use the wrong set of URLs.

- **getBackgroundFetchFilter()** — Asks the service worker for the current filter settings (include and exclude). Server-side counterpart is the **opfsBackgroundFetchFilter** plugin (or opfsBackgroundFetch, which calls it). Returns a promise with an object `{ include?, exclude? }`.

- **filterAssetsForOpfs(assets, include?, exclude?, origin?)** — Filters a list of URLs by the same rules as the plugin (glob patterns). Use it together with the result of getBackgroundFetchFilter() when building your own download logic.

- **startDownloadAssetsToOpfs(options)** — Asks the service worker for the filter, filters the URLs, starts Background Fetch. The promise resolves when the service worker has written the files to OPFS; the result includes lists of written, failed/skipped, and filtered-out URLs. You can pass progress callbacks and a cancel signal.

```ts
interface StartDownloadAssetsToOpfsOptions {
    assets: string[];
    title?: string;
    downloadTotal?: number;
    onProgress?: (downloaded: number, total: number) => void;
    onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
    signal?: AbortSignal;
}
startDownloadAssetsToOpfs(options): Promise<DownloadAssetsToOpfsResult>
// Resolve: { registrationId: string; assets?: string[]; written?; failedOrSkipped?; filteredOut? }
// Reject: DownloadAssetsToOpfsRejected | Error
```

- **useDownloadAssetsToOpfs()** — React hook. Returns the function to start a download, status, progress in bytes and per file, error, result, and a reset function. Calling reset() cancels the current download (if one is in progress) and clears state. Requires React as a peer dependency.

```ts
useDownloadAssetsToOpfs(): {
    startDownload: (options: Omit<StartDownloadAssetsToOpfsOptions, 'signal'>) => Promise<void>;
    status: 'idle' | 'pending' | 'success' | 'failure' | 'aborted';
    progress: { downloaded: number; total: number } | null;
    fileProgress: { loadedAssets: string[]; totalCount: number } | null;
    error: Error | DownloadAssetsToOpfsRejected | null;
    data: DownloadAssetsToOpfsResult | null;
    reset: () => void;
}
```

**Low-level:** `startBackgroundFetch(registration, id, urls, options)` and `isBackgroundFetchSupported()` from `@budarin/pluggable-serviceworker/client/background-fetch`; subscribe to `onOPFSBackgroundFetchCompleted`, `onOPFSBackgroundFetchFailed`, `onOPFSBackgroundFetchAborted`, `onOPFSBackgroundFetchFileWritten` from this package. The download id must start with `opfs-ranges-` (see **OPFS_BACKGROUND_FETCH_ID_PREFIX**).

### Subscriptions to service worker messages

Each function takes a handler and returns a function to unsubscribe. When each type of message is sent is described in [opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md).

**Blocklist:** When writing to OPFS, the browser may throw QuotaExceeded. If the number of bytes already written is at least the current total cache size, eviction cannot free enough space, so that URL is added to a blocklist (kept in the service worker’s memory for its lifetime). On later requests for that URL, the plugin does not attempt to cache the response again and sends a message so the client can show a warning to the user.

- **onOPFSQuotaExceeded** — Quota exceeded while writing to OPFS.
- **onOPFSWriteSkipped** — Write skipped (file does not fit even after eviction).
- **onOPFSEvictionCompleted** — Eviction completed.
- **onOPFSWriteFailed** — Write error.
- **onOPFSSkipQuotaExceeded** — Repeat request for a URL in the blocklist (plugin does not cache, only notifies).
- **onOPFSBackgroundFetchFailed** — Background Fetch completed with failure.
- **onOPFSBackgroundFetchAborted** — Background Fetch aborted.
- **onOPFSBackgroundFetchCompleted** — Background Fetch completed successfully, assets in OPFS.
- **onOPFSBackgroundFetchFileWritten** — Another file written to OPFS (per-file progress).
- **onOPFSRangeCacheFetchStarted** — Plugin opfsRangeFromNetworkAndCache started a background cache fetch (“cache on first request” scenario). Use it to show a “background download in progress” indicator.
- **onOPFSRangeCacheFetchAllDone** — All such background cache fetches have finished. Use it to hide the indicator.

Event types: `OpfsMessagePayload`; constants `OPFS_MSG_*`, `OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER`, `OPFS_RESPONSE_BACKGROUND_FETCH_FILTER`.

### Cache management utilities

These functions are called from the page. To clear the entire cache, call clearOpfsCache() from the service worker or from the page.

- **listOpfsCachedResources()** — List of cached resources (`Promise<OpfsCachedResource[]>`).
- **hasInOpfsCache(url)** — Whether the URL is in the cache.
- **deleteFromOpfsCache(url)** — Remove the resource by URL from the cache.

---

## OPFS storage format

For custom plugins or direct file access. File key: `hex(SHA-256(URL))` (64 chars). One file per URL: resource body, then footer (JSON metadata + 4-byte length). Metadata fields in JSON: `url`, `size`, `type`, `etag`, `lastModified`, `lastAccessed`, `evictable`. All plugins in this package use the same format and shared **urlToOpfsKey**.

**Important:** When serving a file in full (200 without Range), return only the body, not the footer: compute `bodySize` from the footer and use `file.slice(0, bodySize)`. The opfsServeRange plugin only serves body ranges (206); the footer is never exposed.

---

## Writing your own OPFS plugin

To write to OPFS with your own logic using the same format: **getRoot**, **getOpfsDir**, **urlToOpfsKey**, **writeToOpfs**, **metadataFromResponse**.

```typescript
import {
    getRoot,
    getOpfsDir,
    urlToOpfsKey,
    writeToOpfs,
    metadataFromResponse,
} from '@budarin/psw-plugin-opfs-serve-range';

const root = await getRoot();
const dir = await getOpfsDir(root, true);
const key = await urlToOpfsKey(url);
const metadata = metadataFromResponse(response, url);
await writeToOpfs(dir, key, response.body, metadata);
```

The response may omit `Content-Length` — size is determined automatically when writing the full body. When using limits, pass the fifth `options` argument to `writeToOpfs`: `{ url, knownSize }`.

---

## Requirements

You need a browser that supports OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) and a secure context (the page must be loaded over HTTPS).

---

## License

MIT
