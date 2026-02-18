# Changelog

## Unreleased

- …

## 1.1.4 - 2026-02-17

- Документация: в разделе «Клиентские утилиты» README/README.ru добавлены сигнатуры подписок, описание полей `event.data` (OpfsMessagePayload), таблица по каждой функции (когда вызывается, что в payload), пример с типизацией и отпиской.

## 1.1.3 - 2026-02-17

- Документация: переписан абзац сравнения с `@budarin/psw-plugin-serve-range-requests` в README/README.ru — явно указано преимущество произвольного доступа к части файла (OPFS vs последовательное чтение в Cache API) и перечислены остальные преимущества пакета (контроль квоты/эвикции, LRU, pinned, Background Fetch, precache, утилиты).

## 1.1.2 - 2026-02-17

- Документация: исправлены примеры использования опции `pinned` в README/README.ru — заменены примеры с векторными картами на примеры с медиафайлами (видео), соответствующие контексту Range-запросов.

## 1.1.0 - 2026-02-17

- Новое: добавлена поддержка «закреплённых» ресурсов в OPFS-кеше.
  - В метаданные OPFS-файла добавлено поле `evictable` (по умолчанию `true`), при `false` ресурс не участвует в LRU-эвикции.
  - В опции плагинов `opfsPrecache`, `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch` добавлена опция `pinned` (массив glob-паттернов URL, которые нельзя эвиктить).
  - LRU-логика (`computeEvictionSet`) обновлена так, чтобы никогда не удалять pinned-ресурсы.
- Тесты: расширены юнит-тесты `computeEvictionSet` для проверки поведения с `evictable: false`.
- Документация: README/README.ru обновлены — описаны опция `pinned`, поле `evictable` в футере метаданных и примеры конфигурации для неизвлекаемых (pinned) ресурсов.

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
