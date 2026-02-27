# Changelog

## Unreleased

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

- Documentation: for `listOpfsCachedResources`, one ts block (interface `OpfsCachedResource`, then signature); removed the label and second block "Each array element" / "Элемент массива". Removed subsection "Message payload" / "Данные в сообщениях" in README/README.ru (duplicated description under each subscription).

## 1.1.10 - 2025-02-18

- Documentation: subsection "Cache management and types" / "Управление кешем и типы" renamed to "Cache management utilities" / "Утилиты управления кэшем", added intro sentence (where called, purpose). Rules in `.cursor/rules/main.mdc`: tightened §1 — explicitly stated that stating the correct solution is not consent; added checklist before editing (three questions) and rule "when in doubt, do not edit".

## 1.1.9 - 2025-02-18

- Documentation: functions and plugins in README/README.ru formatted as list items (`- **\`name\`\*\* — purpose`); code blocks (signatures, OpfsCachedResource type) under list items indented by 4 spaces to render as item content in preview. Rules in `.cursor/rules/docs.mdc`: API reference section rewritten (short bullets, all in English), added explicit rule about indenting blocks under list items and "Do not" bullet — do not leave blocks at column 0.

## 1.1.8 - 2025-02-18

- Documentation: in README/README.ru, headings `###` only for logical groups (Message subscriptions, Cache management and types, Plugin specifications); function and plugin descriptions — **`name`** — purpose, no heading level. Message subscriptions: one ts block per function — message type (`type EventData`) and signature with `MessageEvent<EventData>`; field comments — inline (`//` at end of line). Added block with `OpfsCachedResource` type next to `listOpfsCachedResources`. Removed list markers from `event.data` descriptions. Rules in `.cursor/rules/docs.mdc` updated to this API format.

## 1.1.7 - 2025-02-18

- Documentation: restructured README/README.ru — client utilities and subscriptions formatted as specifications (heading + purpose in one line, full TypeScript signature, `event.data` types in multi-line blocks with comments for non-obvious fields); plugins section renamed to "Plugin specifications" / "Спецификации плагинов", plugin descriptions aligned with wording from intro list at start of file; plugin options — only in signature block with inline comments for non-obvious parameters; added API formatting rules in `.cursor/rules/docs.mdc`.

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

- Документация: все ссылки на файлы `docs/opfs-cache-behavior*.md` в README переведены на абсолютные GitHub-URL, чтобы корректно открываться на npmjs.com.

## 1.0.3 - 2026-02-17

- Документация: выделен явный раздел про клиентские утилиты (`Client utilities` / «Клиентские утилиты») в README, добавлены перекрёстные ссылки из `docs/opfs-cache-behavior*.md` и обновлена справка по клиентскому entry point в `.cursor/rules/reference.mdc`.

## 1.0.2 - 2026-02-17

- Документация: добавлены английские версии README и описания поведения кеша OPFS (`docs/opfs-cache-behavior.md`), доработан русский README и `docs/opfs-cache-behavior.ru.md` (тон, терминология, структура).
- README: добавлены и выровнены бейджи (CI, npm, bundlephobia, license), ссылки на русскую/английскую документацию.

## 1.0.1 - 2026-02-17

- Первая публичная версия `@budarin/psw-plugin-opfs-serve-range`.
- Плагины для обработки HTTP Range-запросов из OPFS: `opfsServeRange`, `opfsPrecache`,
  `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch`.
- Единый формат хранения в OPFS: один файл на URL (`hex(SHA-256(URL))`), метаданные с `url`, `size`,
  `type`, `etag`, `lastAccessed` во футере.
- Клиентский entry-point `@budarin/psw-plugin-opfs-serve-range/client`:
  события о квоте/эвикции и утилиты `listOpfsCachedResources`, `hasInOpfsCache`,
  `deleteFromOpfsCache` для управления кешем из UI.
- Базовые юнит-тесты под Node (Vitest) для `urlToOpfsKey` и LRU-логики (`getCacheLimit`,
  `computeEvictionSet`); добавлен скрипт `pnpm test` и прогон тестов в CI.
