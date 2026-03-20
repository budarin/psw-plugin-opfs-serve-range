# OPFS cache behavior: limits, LRU, and notifications

This document explains how the plugins in this package manage the OPFS cache: size limits, least‑recently‑used (LRU) eviction, handling of out‑of‑space situations, and notifications to client pages. The goal is to understand what happens during caching and why some resources may not be cached or may be evicted later.

---

## 1. Why limits are needed

The browser allocates a storage **quota** per origin (`navigator.storage.estimate().quota`). This quota is shared between OPFS, IndexedDB, Cache API and other storage types. The quota prevents writes from exceeding the limit (writes fail with `QuotaExceeded`), but it **does not guarantee** that “at least one large file will fit” – on low‑end devices the quota can be very small.

The cache limits in the plugins are not about “protecting the disk”; they are there to:

1. **Share the quota** – the OPFS cache should not take over all available storage; other parts of the application also need space.
2. **Enable LRU eviction** – without an upper bound the cache would grow until the quota is exhausted and would never clean itself up; the limit defines a threshold at which old files start to be evicted.

---

## 2. Configuration

**Why folders:** different groups of files need separate logical caches (include patterns, **folderName** stored in file metadata, etc.). A **folder** is the name of such a group.

Each plugin requires **`folderName: string`** in its options. One folder = one registry entry. When several plugins share the same folder, they use the same **folderName**.

**Global limit:** **getGlobalMaxCacheFraction()** (default `0.5`) and **setGlobalMaxCacheFraction(fraction)** set the fraction of the origin quota the OPFS cache may use. **getMaxCacheFraction()** (no arguments) returns that global value. The byte limit is computed in **getCacheLimit(estimate)**.

The effective cache limit in bytes is calculated as:

```text
limit = min(quota × getMaxCacheFraction(), quota − usage)
```

So the cache can never exceed either the configured fraction of the quota or the currently available free space. `quota` and `usage` are taken from `navigator.storage.estimate()`.

For convenience, the package exports constants:

- **`KILOBYTE`**, **`MEGABYTE`**, **`GIGABYTE`** – sizes in bytes (1024, 1024², 1024³).

---

## 3. How data is stored and the eviction index

- All plugin cache folders live under a **plugin root** **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) in the OPFS root. Path: OPFS root → `.opfs-serve-range` → `folderName` (from options). This keeps plugin data separate from other apps’ folders; the leading dot marks it as a reserved folder that should not be modified manually.
- One OPFS file per URL (the file name is a hash of the URL).
- Each file ends with a footer containing metadata (JSON + 4‑byte length). Metadata includes **`lastAccessed`** (timestamp) and **`evictable`** (false = pinned; not evicted by LRU).
- An **eviction index** file **`_eviction_index.json`** lives in the same cache directory. It holds only **evictable** entries: `{ key, size, lastAccessed }`. It is used for LRU: choosing which files to evict and in what order. If the index is missing or corrupted, it is **rebuilt** by scanning the directory and reading each file’s footer. The index is also **rewritten** when a directory scan finds more evictable entries than the on-disk index contains (e.g. after reload when the index was empty but the cache has files). All index reads and writes are serialized with an in‑memory lock so updates are consistent.

When a file is **read** (a Range response served from cache), **`lastAccessed`** is updated **in the index only** (in the background via `event.waitUntil`), at most once per 5 seconds per file during rapid requests (e.g. seeking), not in the file footer. That avoids concurrent read/write on the same OPFS file (which could cause errors when seeking). When a file is **written**, the current time is stored in the file footer and, if the file is evictable, a new entry is added to the index.

---

## 4. Writing when size is known (Content-Length)

When the response size is known from the `Content-Length` header:

1. The code computes how many bytes need to be **freed** so that the new file fits within both the cache limit and the quota:  
   `needToFree = max(0, currentCacheSize + fileSize − limit, …)` (also taking quota into account when needed).
2. **“Will it ever fit?” check:**  
   If we would have to delete more than the total cache size (i.e. even deleting all existing files would not free enough space), the write **does not start at all**. The resource is not cached, and a notification is sent to clients (for example, that the file does not fit or caching was skipped).
3. If it is possible to fit the file after eviction: from the list of cache files (size + `lastAccessed`) the algorithm chooses the **minimal set** of files to delete – the ones that have not been used for the longest time, until the sum of their sizes reaches at least `needToFree`. Only those files are removed.
4. After eviction completes, the new file is written.

In other words, when the size is known, the cache does not “delete blindly until it fits”; it calculates what needs to be removed, evicts just enough, and then writes the file.

---

## 5. Writing when size is unknown (stream without Content-Length)

When the size is unknown (the response is a stream):

- The file is written to OPFS as a stream. If a **QuotaExceeded** error occurs (quota is exhausted), the write is aborted.

After the error:

1. The **partial file is always removed** – the cache never keeps a broken file.
2. The code calculates how many bytes were written before the error (**bytesWritten**) and how big the entire cache is (**totalCacheSize**).
3. **Decision: should we evict more?**
   - If **bytesWritten ≥ totalCacheSize** – we have already written at least as much as we could possibly free by deleting the whole cache. This means the resource is “bigger than we can ever store” under the current quota. **No eviction is performed** (it would be pointless). The URL is added to an in‑memory list of resources we do not try to cache again (see below).
   - If **bytesWritten < totalCacheSize** – by freeing some cache space we could have more room. In this case, an LRU eviction is performed (freeing approximately **bytesWritten + some headroom**) so that the cache does not stay overfilled and future writes have a better chance to succeed.

The stream is not re‑read – there is no automatic retry for **the same** response. On the next request for the same URL there will be a new response and a new stream.

---

## 6. Resources that are not re‑cached

For **streaming** responses (without `Content-Length`) after QuotaExceeded we might determine that “even deleting the entire cache would not be enough” (bytesWritten ≥ totalCacheSize). In that case:

- The **URL is added to a skip list** (kept in memory for the lifetime of the service worker). On subsequent attempts to cache this URL, the plugin **does not start** writing it to OPFS again – it avoids wasting bandwidth and time.
- For each such **repeat request**, a **quota‑related notification** is sent to clients (for example, that the resource is too large to cache). The application can show a UI hint like “not enough space to cache this resource”.

---

## 7. Notifying client pages

The service worker sends messages to all client windows using the `notifyClients` helper from `@budarin/pluggable-serviceworker`. The message type and payload (for example, `url`, sizes, limits) depend on the event:

- Quota exceeded while writing (QuotaExceeded).
- Write refused when size is known (the file would not fit even after clearing the cache).
- Cache limit reached / eviction performed.
- Write error (including after deleting a partial file).
- Repeat request for a URL from the “skip list” – a quota‑related message is sent so the client can show a warning.

On the client, you can subscribe to these events via **typed handlers** exposed by this package (for example, `onOPFSQuotaExceeded`, `onOPFSWriteSkipped`, `onOPFSCacheLimitReached`, `onOPFSWriteFailed`, etc.). The full list of client utilities (including cache management helpers such as `listOpfsCachedResources`, `hasInOpfsCache`, `deleteFromOpfsCache`) with usage examples is described in the **Client utilities** section of the README and in the TypeScript definitions.

---

## 8. Invalidation on file errors (three levels)

Invalidation is handled at three levels:

1. **File** — On error accessing a specific file (`getFileHandle(key)`, `getFile()`, or reading the footer), **per-key invalidation** runs: **invalidateCachesForFileKeyOnError** → **removeFromEvictionIndex** (metadata cache, range cache, eviction index for that key).
2. **Folder** — If that throws (e.g. the cache folder was removed), **full folder invalidation** runs: **invalidateAllCachesForFolder(folderName)**.
3. **Plugin root** — When opening a cache folder under the plugin root fails (`getOpfsDir` cannot get `folderName` under `.opfs-serve-range`), **invalidateAllCachesAndPluginRoot()** runs: the plugin root cache is cleared and caches for **all** registered folders are invalidated; then one retry is made to obtain the folder (creating the root if needed). This covers the case where the entire `.opfs-serve-range` directory was removed.

This keeps in-memory caches from serving stale data after a file, folder, or the plugin root was removed outside the plugin.

---

## 9. Edge cases

- **Quota smaller than a single file** – writes will fail with QuotaExceeded; the partial file is removed, the URL may be added to the “do not cache” list, and clients receive a notification.
- **Partial writes for streamed responses** – partial files are always removed; the decision about eviction and adding to the skip list follows the rules above.
- **Updating `lastAccessed`** on read never blocks the response – it runs in the background (written to the eviction index only, not the file).

---

## 10. In-memory caches

The plugins use several in-memory caches to reduce I/O and repeated work. All are per service worker lifetime and are cleared or invalidated when the cache folder is cleared or when entries are evicted.

- **Metadata cache**: Global LRU keyed by **opfsKey**. Value: `{ fullSize, type, etag?, lastModified?, evictable?, folderName? }`. Used so that the file footer is not read on every request for the same file; the first request fills the cache, later requests use it. Default 500 entries. Invalidated when files are evicted (**removeFromEvictionIndex**) and on **clearOpfsCache**. Internal (not exported).

- **Dir cache** (opfsUtil): Key: **folderName**. Value: **FileSystemDirectoryHandle** returned by `root.getDirectoryHandle(folderName)`. **getOpfsDir(root, create, folderName)** returns the cached handle when present; otherwise it calls the API, caches the result, and returns. Cleared in **clearOpfsCache(folderName)** so the handle is not reused after the folder has been removed.

- **Eviction index in-memory** (opfsEvictionIndex): Per folder (by dir.name). Map of key → `{ size, lastAccessed, evictable }`. Populated on first use (e.g. **getEntriesForEviction**, **updateEvictionIndexLastAccessed**); avoids repeated directory scans. The on-disk file **\_eviction_index.json** is written when the index is updated; writes are **throttled** to at most once per 5 seconds, with a deferred flush (setTimeout) so that many rapid updates (e.g. seeking) result in a single write. **lastAccessedUpdateByKey** (used for per-key throttle) is cleared when keys are removed from the index so the map does not grow without bound.

- **Other:** **urlToKeyCache** (URL → opfsKey), **globRegexCache** (pattern → RegExp), **skip list** (URLs not to cache again), **loadingUrls** (URLs currently being full-fetched in background), **folderRegistry** (registered **folderName** values). **getRoot()** caches the OPFS root promise.

---

In summary: the cache is limited by both the configured fraction of the origin quota and the currently available free space. Eviction uses LRU with a precomputed eviction set; for streaming writes without a known size, after QuotaExceeded the code either evicts with some headroom or marks the URL as “too large to cache” and, on subsequent requests, only notifies clients about quota issues without attempting to cache the resource again.

# OPFS cache behavior: limits, LRU, and notifications

This document explains how the plugins in this package manage the OPFS cache: size limits, least‑recently‑used (LRU) eviction, handling of out‑of‑space situations, and notifications to client pages. The goal is to understand what happens during caching and why some resources may not be cached or may be evicted later.

---

## 1. Why limits are needed

The browser allocates a storage **quota** per origin (`navigator.storage.estimate().quota`). This quota is shared between OPFS, IndexedDB, Cache API and other storage types. The quota prevents writes from exceeding the limit (writes fail with `QuotaExceeded`), but it **does not guarantee** that “at least one large file will fit” – on low‑end devices the quota can be very small.

The cache limits in the plugins are not about “protecting the disk”; they are there to:

1. **Share the quota** – the OPFS cache should not take over all available storage; other parts of the application also need space.
2. **Enable LRU eviction** – without an upper bound the cache would grow until the quota is exhausted and would never clean itself up; the limit defines a threshold at which old files start to be evicted.

---

## 2. Configuration

Each plugin requires **`folderName: string`** in its options. One folder = one registry entry. When several plugins share the same folder, they use the same **folderName**.

**Global limit:** **getGlobalMaxCacheFraction()** (default `0.5`) and **setGlobalMaxCacheFraction(fraction)** set the fraction of the origin quota the OPFS cache may use. **getMaxCacheFraction()** returns that global value. The byte limit is computed in **getCacheLimit(estimate)**.

The effective cache limit in bytes is calculated as:

```
limit = min(quota × getMaxCacheFraction(), quota − usage)
```

So the cache can never exceed either the configured fraction of the quota or the currently available free space. `quota` and `usage` are taken from `navigator.storage.estimate()`.

For convenience, the package exports constants:

- **`KILOBYTE`**, **`MEGABYTE`**, **`GIGABYTE`** – sizes in bytes (1024, 1024², 1024³).

---

## 3. How data is stored and the eviction index

- All plugin cache folders live under a **plugin root** **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) in the OPFS root. Path: OPFS root → `.opfs-serve-range` → `folderName` (from options). This keeps plugin data separate from other apps’ folders; the leading dot marks it as a reserved folder that should not be modified manually.
- One OPFS file per URL (the file name is a hash of the URL).
- Each file ends with a footer containing metadata (JSON + 4‑byte length). Metadata includes **`lastAccessed`** (timestamp) and **`evictable`** (false = pinned; not evicted by LRU).
- An **eviction index** file **`_eviction_index.json`** lives in the same cache directory. It holds only **evictable** entries: `{ key, size, lastAccessed }`. It is used for LRU: choosing which files to evict and in what order. If the index is missing or corrupted, it is **rebuilt** by scanning the directory and reading each file’s footer. The index is also **rewritten** when a directory scan finds more evictable entries than the on-disk index contains (e.g. after reload when the index was empty but the cache has files). All index reads and writes are serialized with an in‑memory lock so updates are consistent.

When a file is **read** (a Range response served from cache), **`lastAccessed`** is updated **in the index only** (in the background via `event.waitUntil`), at most once per 5 seconds per file during rapid requests (e.g. seeking), not in the file footer. That avoids concurrent read/write on the same OPFS file (which could cause errors when seeking). When a file is **written**, the current time is stored in the file footer and, if the file is evictable, a new entry is added to the index.

---

## 4. Writing when size is known (Content-Length)

When the response size is known from the `Content-Length` header:

1. The code computes how many bytes need to be **freed** so that the new file fits within both the cache limit and the quota:  
   `needToFree = max(0, currentCacheSize + fileSize − limit, …)` (also taking quota into account when needed).
2. **“Will it ever fit?” check:**  
   If we would have to delete more than the total cache size (i.e. even deleting all existing files would not free enough space), the write **does not start at all**. The resource is not cached, and a notification is sent to clients (for example, that the file does not fit or caching was skipped).
3. If it is possible to fit the file after eviction: from the list of cache files (size + `lastAccessed`) the algorithm chooses the **minimal set** of files to delete – the ones that have not been used for the longest time, until the sum of their sizes reaches at least `needToFree`. Only those files are removed.
4. After eviction completes, the new file is written.

In other words, when the size is known, the cache does not “delete blindly until it fits”; it calculates what needs to be removed, evicts just enough, and then writes the file.

---

## 5. Writing when size is unknown (stream without Content-Length)

When the size is unknown (the response is a stream):

- The file is written to OPFS as a stream. If a **QuotaExceeded** error occurs (quota is exhausted), the write is aborted.

After the error:

1. The **partial file is always removed** – the cache never keeps a broken file.
2. The code calculates how many bytes were written before the error (**bytesWritten**) and how big the entire cache is (**totalCacheSize**).
3. **Decision: should we evict more?**
   - If **bytesWritten ≥ totalCacheSize** – we have already written at least as much as we could possibly free by deleting the whole cache. This means the resource is “bigger than we can ever store” under the current quota. **No eviction is performed** (it would be pointless). The URL is added to an in‑memory list of resources we do not try to cache again (see below).
   - If **bytesWritten < totalCacheSize** – by freeing some cache space we could have more room. In this case, an LRU eviction is performed (freeing approximately **bytesWritten + some headroom**) so that the cache does not stay overfilled and future writes have a better chance to succeed.

The stream is not re‑read – there is no automatic retry for **the same** response. On the next request for the same URL there will be a new response and a new stream.

---

## 6. Resources that are not re‑cached

For **streaming** responses (without `Content-Length`) after QuotaExceeded we might determine that “even deleting the entire cache would not be enough” (bytesWritten ≥ totalCacheSize). In that case:

- The **URL is added to a skip list** (kept in memory for the lifetime of the service worker). On subsequent attempts to cache this URL, the plugin **does not start** writing it to OPFS again – it avoids wasting bandwidth and time.
- For each such **repeat request**, a **quota‑related notification** is sent to clients (for example, that the resource is too large to cache). The application can show a UI hint like “not enough space to cache this resource”.

---

## 7. Notifying client pages

The service worker sends messages to all client windows using the `notifyClients` helper from `@budarin/pluggable-serviceworker`. The message type and payload (for example, `url`, sizes, limits) depend on the event:

- Quota exceeded while writing (QuotaExceeded).
- Write refused when size is known (the file would not fit even after clearing the cache).
- Cache limit reached / eviction performed.
- Write error (including after deleting a partial file).
- Repeat request for a URL from the “skip list” – a quota‑related message is sent so the client can show a warning.

On the client, you can subscribe to these events via **typed handlers** exposed by this package (for example, `onOPFSQuotaExceeded`, `onOPFSWriteSkipped`, `onOPFSCacheLimitReached`, `onOPFSWriteFailed`, etc.). Details and examples are provided in the README and type definitions.

---

## 8. Invalidation on file errors (three levels)

Invalidation is handled at three levels:

1. **File** — On error accessing a specific file (`getFileHandle(key)`, `getFile()`, or reading the footer), **per-key invalidation** runs: **invalidateCachesForFileKeyOnError** → **removeFromEvictionIndex** (metadata cache, range cache, eviction index for that key).
2. **Folder** — If that throws (e.g. the cache folder was removed), **full folder invalidation** runs: **invalidateAllCachesForFolder(folderName)**.
3. **Plugin root** — When opening a cache folder under the plugin root fails (`getOpfsDir` cannot get `folderName` under `.opfs-serve-range`), **invalidateAllCachesAndPluginRoot()** runs: the plugin root cache is cleared and caches for **all** registered folders are invalidated; then one retry is made to obtain the folder (creating the root if needed). This covers the case where the entire `.opfs-serve-range` directory was removed.

This keeps in-memory caches from serving stale data after a file, folder, or the plugin root was removed outside the plugin.

---

## 9. Edge cases

- **Quota smaller than a single file** – writes will fail with QuotaExceeded; the partial file is removed, the URL may be added to the “do not cache” list, and clients receive a notification.
- **Partial writes for streamed responses** – partial files are always removed; the decision about eviction and adding to the skip list follows the rules above.
- **Updating `lastAccessed`** on read never blocks the response – it runs in the background (written to the eviction index only, not the file).

---

## 10. In-memory caches

The plugins use several in-memory caches to reduce I/O and repeated work. All are per service worker lifetime and are cleared or invalidated when the cache folder is cleared or when entries are evicted.

- **Metadata cache**: Global LRU keyed by **opfsKey**. Value: `{ fullSize, type, etag?, lastModified?, evictable?, folderName? }`. Used so that the file footer is not read on every request for the same file; the first request fills the cache, later requests use it. Default 500 entries. Invalidated when files are evicted (**removeFromEvictionIndex**) and on **clearOpfsCache**. Internal (not exported).

- **Dir cache** (opfsUtil): Key: **folderName**. Value: **FileSystemDirectoryHandle** returned by `root.getDirectoryHandle(folderName)`. **getOpfsDir(root, create, folderName)** returns the cached handle when present; otherwise it calls the API, caches the result, and returns. Cleared in **clearOpfsCache(folderName)** so the handle is not reused after the folder has been removed.

- **Eviction index in-memory** (opfsEvictionIndex): Per folder (by dir.name). Map of key → `{ size, lastAccessed, evictable }`. Populated on first use (e.g. **getEntriesForEviction**, **updateEvictionIndexLastAccessed**); avoids repeated directory scans. The on-disk file **\_eviction_index.json** is written when the index is updated; writes are **throttled** to at most once per 5 seconds, with a deferred flush (setTimeout) so that many rapid updates (e.g. seeking) result in a single write. **lastAccessedUpdateByKey** (used for per-key throttle) is cleared when keys are removed from the index so the map does not grow without bound.

- **Other:** **urlToKeyCache** (URL → opfsKey), **globRegexCache** (pattern → RegExp), **skip list** (URLs not to cache again), **loadingUrls** (URLs currently being full-fetched in background), **folderRegistry** (registered **folderName** values). **getRoot()** caches the OPFS root promise.

---

In summary: the cache is limited by both the configured fraction of the origin quota and the currently available free space. Eviction uses LRU with a precomputed eviction set; for streaming writes without a known size, after QuotaExceeded the code either evicts with some headroom or marks the URL as “too large to cache” and, on subsequent requests, only notifies clients about quota issues without attempting to cache the resource again.

# OPFS cache behavior: limits, LRU, and notifications

This document explains how the plugins in this package manage the OPFS cache: size limits, least‑recently‑used (LRU) eviction, handling of out‑of‑space situations, and notifications to client pages. The goal is to make it clear why some resources might not be cached or might be evicted even if they were cached earlier.

---

## 1. Why limits are needed

The browser allocates a storage **quota** per origin (`navigator.storage.estimate().quota`). This quota is shared between OPFS, IndexedDB, Cache API, etc. The quota prevents you from exceeding the limit (writes fail with `QuotaExceeded`), but it **does not guarantee** that “at least one large file will fit” – on low‑end devices the quota can be very small.

The cache limits in the plugins are not about “protecting the disk”; they are there to:

1. **Share the quota** – the OPFS cache should not take over all available storage; you want to leave room for other storage used by the app.
2. **Enable LRU eviction** – without an upper bound the cache would grow until the quota is exhausted and would never clean itself up; the limit defines a threshold at which older files start to be evicted.

---

## 2. Configuration

Each plugin requires **`folderName: string`** in its options. One folder = one registry entry. When several plugins share the same folder, they use the same **folderName**.

**Global limit:** **getGlobalMaxCacheFraction()** (default `0.5`) and **setGlobalMaxCacheFraction(fraction)** set the fraction of the origin quota the OPFS cache may use. **getMaxCacheFraction()** returns that global value. The byte limit is computed in **getCacheLimit(estimate)**.

The effective cache limit in bytes is calculated as:

```
limit = min(quota × getMaxCacheFraction(), quota − usage)
```

So the cache can never exceed either the configured fraction of the quota or the currently available free space. `quota` and `usage` are taken from `navigator.storage.estimate()`.

For convenience, the package exports constants:

- **`KILOBYTE`**, **`MEGABYTE`**, **`GIGABYTE`** – sizes in bytes (1024, 1024², 1024³).

---

## 3. How data is stored and the eviction index

- All plugin cache folders live under a **plugin root** **OPFS_PLUGIN_ROOT_DIR_NAME** (default **`.opfs-serve-range`**) in the OPFS root. Path: OPFS root → `.opfs-serve-range` → `folderName` (from options). This keeps plugin data separate from other apps’ folders; the leading dot marks it as a reserved folder that should not be modified manually.
- One OPFS file per URL (the file name is a hash of the URL).
- Each file ends with a footer containing metadata (JSON + 4‑byte length). Metadata includes **`lastAccessed`** (timestamp) and **`evictable`** (false = pinned; not evicted by LRU).
- An **eviction index** file **`_eviction_index.json`** lives in the same cache directory. It holds only **evictable** entries: `{ key, size, lastAccessed }`. It is used for LRU: choosing which files to evict and in what order. If the index is missing or corrupted, it is **rebuilt** by scanning the directory and reading each file’s footer. The index is also **rewritten** when a directory scan finds more evictable entries than the on-disk index contains (e.g. after reload when the index was empty but the cache has files). All index reads and writes are serialized with an in‑memory lock so updates are consistent.

When a file is **read** (a Range response served from cache), **`lastAccessed`** is updated **in the index only** (in the background via `event.waitUntil`), at most once per 5 seconds per file during rapid requests (e.g. seeking), not in the file footer. That avoids concurrent read/write on the same OPFS file (which could cause errors when seeking). When a file is **written**, the current time is stored in the file footer and, if the file is evictable, a new entry is added to the index.

---

## 4. Запись при известном размере (есть Content-Length)

Когда размер ответа известен по заголовку `Content-Length`:

1. Вычисляется, сколько байт нужно **освободить**, чтобы новый файл влез в лимит и в квоту:  
   `needToFree = max(0, текущий_размер_кеша + размер_файла − лимит, …)` (с учётом квоты при необходимости).

2. **Проверка «влезет ли вообще»:**  
   Если для этого пришлось бы удалить больше, чем есть в кеше (т.е. даже удалив все файлы, места не хватит), запись **не начинается**, загрузка в кеш не выполняется, клиенту отправляется оповещение (например, о превышении квоты / отказе в кешировании).

3. Если места достаточно после эвикции: по списку файлов кеша (размер + `lastAccessed`) выбирается **минимальный набор** файлов для удаления — те, к которым дольше всего не обращались, пока сумма их размеров не станет не меньше `needToFree`. Удаляются **только эти** файлы.

4. После удаления выполняется запись нового файла.

Таким образом, при известном размере мы не «удаляем подряд пока не влезет», а один раз вычисляем, что удалить, удаляем только нужное и затем пишем.

---

## 5. Запись при неизвестном размере (поток без Content-Length)

Когда размер не известен (ответ приходит потоком):

- Запись в OPFS идёт потоком. Если в процессе возникает **QuotaExceeded** (закончилась квота), запись прерывается.

После ошибки:

1. **Частичный файл всегда удаляется** — в кеше не остаётся битой записи.

2. Считается, сколько байт успели записать до ошибки (**bytesWritten**), и сколько места занимает весь текущий кеш (**totalCacheSize**).

3. **Решение, удалять ли что-то ещё:**
   - Если **bytesWritten ≥ totalCacheSize** — мы уже записали не меньше, чем можно освободить удалением всего кеша. Значит, этот ресурс «больше, чем мы вообще можем записать» при текущей квоте. **Ничего не удаляем** (эвикция бессмысленна). URL заносится в **список ресурсов, которые не пытаемся кешировать повторно** (см. ниже).
   - Если **bytesWritten < totalCacheSize** — освободив часть кеша, мы могли бы иметь больше места. Тогда выполняется эвикция по LRU (освобождается объём порядка **bytesWritten + запас**), чтобы не держать кеш переполненным и дать шанс следующим загрузкам.

Поток повторно не читается — повторной попытки записи **того же** ответа нет; при следующем запросе к тому же URL придёт новый ответ и новый поток.

---

## 6. Список ресурсов, которые не кешируем повторно

Для запросов **без Content-Length** после QuotaExceeded мы можем решить: «даже удалив весь кеш, этот файл не влезет» (bytesWritten ≥ totalCacheSize). Тогда:

- **URL попадает в список** (в памяти сервис-воркера на время его жизни). При повторной попытке кешировать этот URL (новый запрос) плагин **не начинает** загрузку в кеш — не тратит трафик и время.
- При каждом таком **повторном запросе** клиенту отправляется **оповещение о превышении квоты** (например, что ресурс не кешируется из‑за лимитов). Так приложение может показывать пользователю сообщение вроде «недостаточно места для кеширования этого ресурса».

---

## 7. Оповещение вкладок

Сервис-воркер отправляет сообщения всем окнам-клиентам через утилиту пакета `@budarin/pluggable-serviceworker` (`notifyClients`). Типы сообщений и данные (например, `url`, размеры, лимиты) зависят от события:

- Квота исчерпана при записи (QuotaExceeded).
- Отказ в записи при известном размере (файл не влез бы даже после полной очистки кеша).
- Достигнут лимит кеша / выполнена эвикция.
- Ошибка записи (в т.ч. после удаления частичного файла).
- Повторный запрос к URL из «списка плохих» — отправляется сообщение о превышении квот, чтобы клиент мог показать предупреждение.

На клиенте можно подписаться на эти события через **типизированные обработчики** из этого пакета (например, `onOPFSQuotaExceeded`, `onOPFSWriteSkipped`, `onOPFSCacheLimitReached`, `onOPFSWriteFailed` и т.д.). Подробности и примеры — в README и типах пакета.

---

## 8. Крайние случаи

- **Квота меньше одного файла** — при записи получим QuotaExceeded; частичный файл удалится, при необходимости URL попадёт в список «не кешируем», клиент получит оповещение.
- **Частичная запись при потоке** — всегда удаляется; решение об эвикции и skip list принимается по правилам выше.
- **Обновление lastAccessed** при чтении не блокирует ответ — выполняется в фоне.

---

Итог: кеш ограничен долей квоты и текущим свободным местом, вытеснение идёт по давности использования (LRU) с предварительным расчётом, какие файлы удалить; при потоке без размера после QuotaExceeded мы либо эвиктируем с запасом, либо заносим URL в список и при повторных запросах не кешируем и оповещаем клиента о превышении квот.
