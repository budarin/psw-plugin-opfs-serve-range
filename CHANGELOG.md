# Changelog

## Unreleased

- Первая публичная версия `@budarin/psw-plugin-opfs-serve-range`.
- Плагины для обработки HTTP Range-запросов из OPFS: `opfsServeRange`, `opfsPrecache`,
  `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch`.
- Единый формат хранения в OPFS: один файл на URL (`hex(SHA-256(URL))`), метаданные с `url`, `size`,
  `type`, `etag`, `lastModified`, `lastAccessed` во футере.
- Клиентский entry-point `@budarin/psw-plugin-opfs-serve-range/client`:
  события о квоте/эвикции и утилиты `listOpfsCachedResources`, `hasInOpfsCache`,
  `deleteFromOpfsCache` для управления кешем из UI.
- Базовые юнит-тесты под Node (Vitest) для `urlToOpfsKey` и LRU-логики (`getCacheLimit`,
  `computeEvictionSet`); добавлен скрипт `pnpm test` и прогон тестов в CI.
