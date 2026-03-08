# @budarin/psw-plugin-opfs-serve-range

[Русская версия](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/README.ru.md)

Service Worker plugins and utilities for [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker) that serve HTTP Range requests from files stored in Origin Private File System (OPFS).

[![CI](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/budarin/psw-plugin-opfs-serve-range/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@budarin/psw-plugin-opfs-serve-range?color=cb0000)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![npm](https://img.shields.io/npm/dt/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)
[![bundle](https://img.shields.io/bundlephobia/minzip/@budarin/psw-plugin-opfs-serve-range)](https://bundlephobia.com/result?p=@budarin/psw-plugin-opfs-serve-range)
[![license](https://img.shields.io/npm/l/@budarin/psw-plugin-opfs-serve-range)](https://www.npmjs.com/package/@budarin/psw-plugin-opfs-serve-range)

Large media files and other heavy assets are almost always requested in chunks via HTTP Range rather than as a single download. When such files live in a regular HTTP cache (Cache API), the service worker often has to read and process the entire file to serve a small range, which is wasteful in terms of memory and CPU and quickly hits storage limits on low‑end devices.

This package takes a different approach: it uses the Origin Private File System (OPFS) as the primary storage for large resources and range responses. Files are stored in OPFS in a custom format (one file per URL plus a metadata footer), and ranges are read directly from the file system instead of Cache API. On top of that, the package provides plugins for precaching, background downloads, and serving range requests.

Unlike `@budarin/psw-plugin-serve-range-requests`, which uses the Cache API: cached data can only be read **sequentially**, with no random access, so serving a range at the end or in the middle of a large file requires reading everything from the start up to that point. This package uses OPFS: the requested range is read directly from the file (random access), with no need to read preceding bytes — any part of the file is equally fast to access. In addition, you control quota and eviction (limits, LRU, pinned resources, tab notifications), “download in background, then use offline” is supported (Background Fetch, precache), and utilities are provided for your own OPFS read/write plugins.

### What this package provides

- **opfsServeRange** – reads files from OPFS and serves byte ranges.
- **opfsRangeFromNetworkAndCache** – handles requests that `opfsServeRange` did not serve (resource not in cache yet): goes to the network, streams the response to the client, and optionally starts a full background download into OPFS; only fully downloaded files are cached. If the tab or browser is closed or the network drops, the download is aborted; the next request for the same URL starts a new full download (which may be slow or expensive for large files). If you need downloads that survive tab or browser closes, or your files are very large, use the Background Fetch API utilities from `@budarin/pluggable-serviceworker`. **Note:** when the server returns `200` for a Range request without `Content-Length`, the response body is buffered fully in memory (`response.blob()`) to serve the range — avoid very large files without `Content-Length` to prevent high memory usage.
- **opfsBackgroundFetch** – on successful Background Fetch completion, writes responses into OPFS; subsequent Range requests for these URLs are served by `opfsServeRange`.
- **writeToOpfs**, **metadataFromResponse**, **urlToOpfsKey**, **getRoot**, **isOpfsAvailable** – low‑level utilities for writing your own OPFS plugins; **getRoot()** returns a cached OPFS root (avoids repeated navigator.storage.getDirectory calls); **isOpfsAvailable()** provides a synchronous check for OPFS support.

In environments without OPFS support, plugin factories return `undefined`.

All cache files live under a single OPFS directory. The directory name is configured once via **configureOpfs({ folderName })** before registering plugins (defaults to `'range-requests-cache'`). To clear the cache, call **clearOpfsCache()** – the whole directory is removed. Inside, there is one file per URL; all metadata is stored in the file footer.

Detailed cache behavior (limits, LRU, eviction, notifications) is described in [docs/opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md) (Russian version: [docs/opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md)).

## Install

```bash
pnpm add @budarin/psw-plugin-opfs-serve-range
```

## Usage

The following example shows how to configure media (video, map tiles, etc.) so that on the first request the content is loaded and stored in the local OPFS cache, and on subsequent requests – once fully downloaded – it is served from OPFS without hitting the network.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    configureOpfs,
    opfsServeRange,
    opfsRangeFromNetworkAndCache,
} from '@budarin/psw-plugin-opfs-serve-range';

configureOpfs({
    folderName: 'ranges-media-cache',
    maxCacheFraction: 0.5, // fraction of origin quota reserved for this cache (default 0.5)
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

Here `opfsServeRange` serves ranges from OPFS when the file is already cached; `opfsRangeFromNetworkAndCache` goes to the network when the file is not cached yet, streams the response to the client, and optionally fills OPFS in the background so that subsequent requests are served from OPFS. You can add **opfsBackgroundFetch** as needed; the set and order of plugins are fully configurable.

### Example: “Download for offline” (Background Fetch) + Range playback

**Scenario:** The user clicks “Download for offline” → a large file (video, map) is downloaded in the background; the tab may be closed. After the download finishes, a player or map viewer issues Range requests for this URL – responses come from OPFS, without re‑downloading the file. The goal is the full cycle “button → background download → offline playback from cache”.

**Client (page)** – trigger a background download based on user action:

```typescript
import {
    startBackgroundFetch,
    isBackgroundFetchSupported,
} from '@budarin/pluggable-serviceworker/client/background-fetch';

async function downloadForOffline(
    url: string,
    title: string,
    downloadTotal?: number
) {
    const supported = await isBackgroundFetchSupported();
    if (!supported) {
        console.warn('Background Fetch API is not supported');
        return;
    }
    const reg = await navigator.serviceWorker.ready;
    const id = `offline-${Date.now()}`;
    await startBackgroundFetch(reg, id, [url], { title, downloadTotal });
}
```

**Service worker** – register plugins (after Background Fetch completes, the file is written into the range cache, and subsequent Range requests are served by `opfsServeRange`):

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

## OPFS storage format

If you implement your own writer plugin or serve files from OPFS directly (bypassing these plugins), the format details are important. The cache key is `hex(SHA-256(URL))` (64 characters). There is one OPFS file per URL: the file layout is `[body][JSON metadata][4‑byte JSON length (uint32 LE)]`. To clear the cache, delete a file by key or remove the entire directory via `clearOpfsCache`.

**Important:** if you serve a file from OPFS **as a whole** (e.g. `200` without Range) to a player or other code, you must strip the footer and only return the body: first read the footer, compute `bodySize`, then do `new Response(file.slice(0, bodySize), ...)`. The `opfsServeRange` plugin only serves body ranges (`206`) and never exposes the footer.

Metadata example (JSON footer): `url`, `size`, `type`, `etag`, `lastModified`, `lastAccessed`, `evictable`. All plugins in this package use the same format and the shared `urlToOpfsKey`. The `evictable` field (default `true`) indicates whether the resource can be evicted by the LRU algorithm; `false` means the resource is pinned and will not be removed.

## Writing your own OPFS plugin

If you need to write into OPFS following the same format as the built‑in plugins, you can use **getRoot**, **getOpfsDir**, **urlToOpfsKey**, **writeToOpfs**, **metadataFromResponse**. Example:

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

The response may not have a `Content-Length` header – when writing the full body, the size is determined automatically from the bytes written. When using limits, pass the fifth `options` argument to `writeToOpfs`: `{ url, knownSize }` (for example, `knownSize: metadata.size > 0 ? metadata.size : undefined`).

## Client utilities

Client‑side helpers are exported from the entry point `@budarin/psw-plugin-opfs-serve-range/client`. This section gives signatures, types, and examples; [opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md) only describes **when** the service worker sends messages (limits, LRU, eviction), not the API.

### Message subscriptions

Each function takes a handler and returns an unsubscribe function (call it to remove the subscription). Below are the subscriptions for messages that the service worker actually sends in the current version.

```ts
type Unsubscribe = () => void;
```

- **`onOPFSQuotaExceeded`** — subscribe to notification when the browser throws QuotaExceeded while writing to OPFS.

    ```ts
    type EventData = {
      type: string;
      url: string;
    };

    onOPFSQuotaExceeded(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSWriteSkipped`** — subscribe to notification when the write was skipped (file does not fit even after eviction).

    ```ts
    type EventData = {
      type: string;
      url: string;
      size: number; // File size in bytes
      reason: string; // Reason the write was not started
    };

    onOPFSWriteSkipped(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSEvictionCompleted`** — subscribe to notification when eviction has finished.

    ```ts
    type EventData = {
      type: string;
      count: number; // Number of files removed by eviction
    };

    onOPFSEvictionCompleted(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSWriteFailed`** — subscribe to notification on write error (network, disk, partial file removed).

    ```ts
    type EventData = {
      type: string;
      url?: string;
      reason: string; // Reason the write failed
    };

    onOPFSWriteFailed(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSSkipQuotaExceeded`** — subscribe to notification on repeat request for a blocklisted URL (resource not cached).

    ```ts
    type EventData = {
      type: string;
      url: string;
    };

    onOPFSSkipQuotaExceeded(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSBackgroundFetchFailed`** — subscribe to notification when a Background Fetch completes with failure.

    ```ts
    type EventData = { type: string; registrationId?: string };
    onOPFSBackgroundFetchFailed(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

- **`onOPFSBackgroundFetchAborted`** — subscribe to notification when a Background Fetch is aborted.

    ```ts
    type EventData = { type: string; registrationId?: string };
    onOPFSBackgroundFetchAborted(handler: (event: MessageEvent<EventData>) => void): Unsubscribe
    ```

### Cache management utilities

Functions to list cached resources, check by URL, and remove by URL. Called from the client (page); use when you need to show the user what is cached and let them delete selected items.

- **`listOpfsCachedResources`** — returns the list of cached resources.

    ```ts
    interface OpfsCachedResource {
      url: string;
      size: number;
      type: string | undefined;
      lastModified: string | undefined;
    }

    listOpfsCachedResources(): Promise<OpfsCachedResource[]>
    ```

- **`hasInOpfsCache`** — checks whether a URL is in the cache.

    ```ts
    hasInOpfsCache(url: string): Promise<boolean>
    ```

- **`deleteFromOpfsCache`** — removes a resource by URL from the cache.

    ```ts
    deleteFromOpfsCache(url: string): Promise<void>
    ```

Types `OpfsMessagePayload` and `OpfsCachedResource` are exported. Message type constants (name equals the string value in `event.data.type`): `OPFS_MSG_QUOTA_EXCEEDED`, `OPFS_MSG_WRITE_SKIPPED_SIZE`, `OPFS_MSG_CACHE_LIMIT_REACHED`, `OPFS_MSG_EVICTION_COMPLETED`, `OPFS_MSG_WRITE_FAILED`, `OPFS_MSG_SKIP_QUOTA_EXCEEDED`, `OPFS_MSG_BACKGROUND_FETCH_FAILED`, `OPFS_MSG_BACKGROUND_FETCH_ABORTED`.

### Tab notifications about quota and limits

Example: subscribe to events and show the user which resource failed to cache; unsubscribe when the component unmounts.

```typescript
import {
    onOPFSQuotaExceeded,
    onOPFSSkipQuotaExceeded,
    type OpfsMessagePayload,
} from '@budarin/psw-plugin-opfs-serve-range/client';

const unsubQuota = onOPFSQuotaExceeded((event: MessageEvent) => {
    const data = event.data as { type: string } & OpfsMessagePayload;
    console.warn('OPFS: quota exceeded', data.url);
    // e.g. showToast(`Failed to save: ${data.url}`);
});

const unsubSkip = onOPFSSkipQuotaExceeded((event: MessageEvent) => {
    const data = event.data as { type: string } & OpfsMessagePayload;
    console.warn('OPFS: resource not cached (quota)', data.url);
});

// when no longer needed:
// unsubQuota(); unsubSkip();
```

When each message is sent: [opfs-cache-behavior.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.md) (Russian: [opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md)).

### Clearing the cache and managing individual resources

To wipe the whole cache (e.g. from a UI button or on logout), call **clearOpfsCache()** from the service worker or client – the entire cache directory will be deleted.

If you need finer‑grained control (show a list of cached resources and let users delete specific ones), use the client utilities from `@budarin/psw-plugin-opfs-serve-range/client`: `listOpfsCachedResources`, `hasInOpfsCache`, `deleteFromOpfsCache` (see above). The list is built from metadata in the footer (each file stores its original `url`).

## Plugin specifications

Global cache settings (folder name, quota fraction) are set in **configureOpfs({ folderName, maxCacheFraction })**. Below are the package plugins and their options.

- **`opfsServeRange`** — reads files from OPFS and serves requested byte ranges.

    ```ts
    opfsServeRange(options?: {
      order?: number;
      enableLogging?: boolean;
      include?: string[];
      exclude?: string[];
      rangeResponseCacheControl?: string; // Cache-Control for 206 responses (default: max-age=31536000, immutable)
    }): Plugin | undefined
    ```

- **`opfsRangeFromNetworkAndCache`** — handles requests that opfsServeRange did not serve (resource not in cache yet): goes to the network, streams the response to the client, and optionally fills OPFS in the background.

    ```ts
    opfsRangeFromNetworkAndCache(options?: {
      order?: number;
      include?: string[];
      exclude?: string[];
      enableLogging?: boolean;
      pinned?: string[]; // glob patterns for URLs protected from eviction
    }): Plugin | undefined
    ```

- **`opfsBackgroundFetch`** — on successful Background Fetch completion, writes responses into OPFS; subsequent Range requests for these URLs are served by opfsServeRange.

    ```ts
    opfsBackgroundFetch(options?: {
      order?: number;
      include?: string[];
      exclude?: string[];
      enableLogging?: boolean;
      pinned?: string[]; // glob patterns for URLs protected from eviction
    }): Plugin | undefined
    ```

To trigger downloads from the client: `@budarin/pluggable-serviceworker/client/background-fetch`.

### Pinned resources (eviction protection)

Both caching plugins that write to OPFS (`opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch`) support the `pinned` option: an array of glob patterns for URLs that should never be evicted by the LRU eviction algorithm. Resources matching these patterns are stored with `evictable: false` in metadata and will not be removed even when the cache limit is reached.

Example: mark important media files as pinned so they are never evicted, while allowing other cached media to be evicted:

```typescript
opfsRangeFromNetworkAndCache({
    include: ['*.mp4', '*.webm'],
    pinned: ['/assets/media/featured/**'], // featured media files won't be evicted
});
```

By default, all resources are evictable (`evictable: true`). Only resources matching patterns in `pinned` are protected from eviction.

## Requirements

- A browser with OPFS support (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) and a secure context (HTTPS).

## License

MIT
