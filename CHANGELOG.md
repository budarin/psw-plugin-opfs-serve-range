# Changelog

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
