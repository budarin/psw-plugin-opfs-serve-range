# psw-plugin-opfs-serve-range

Плагины и утилиты для @budarin/pluggable-serviceworker для обработки range запросов к файлам в OPFS.

- **opfsServeRange** — читает файлы из OPFS и отдаёт диапазоны (206). Запись в OPFS **не** делает.
- **opfsPrecache** — при установке SW загружает список URL и записывает их в OPFS.
- **opfsCacheOnFetch** — при первом запросе по сети сохраняет ответ в OPFS (следующие запросы обслуживает opfsServeRange).
- **writeToOpfs**, **metadataFromResponse**, **urlToOpfsKey** — утилиты для своих плагинов записи.

Все файлы плагина лежат в **одной папке** в OPFS. Имя папки задаётся **в одном месте** — **configureOpfs({ folderName })**. Вызовите его один раз до регистрации плагинов; по умолчанию используется `'opfs-serve-range'` (константа `OPFS_FOLDER_NAME`). Очистка: **clearOpfsCache()** удаляет эту папку со всем содержимым.

Ключ файла внутри папки: **key = hex(SHA-256(URL))** — без общего индекса. **Один файл на ресурс:** в конце файла футер `[4 байта длина JSON (uint32 LE)][JSON мета]`. Отдельных файлов метаданных нет — при очистке удаляют папку целиком или один файл.

## Установка

```bash
pnpm add @budarin/psw-plugin-opfs-serve-range
```

## Использование

Имя папки в OPFS задаётся один раз через **configureOpfs** (до регистрации плагинов):

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    configureOpfs,
    opfsServeRange,
    opfsPrecache,
    opfsCacheOnFetch,
} from '@budarin/psw-plugin-opfs-serve-range';

configureOpfs({ folderName: 'my-opfs-cache' }); // опционально; по умолчанию 'opfs-serve-range'

initServiceWorker(
    [
        opfsServeRange({
            order: -15,
            include: ['*.mp4', '*.webm', '*.pmtiles'],
        }),
        opfsCacheOnFetch({
            order: -10,
            include: ['*.mp4', '*.webm', '*.pmtiles'],
        }),
        opfsPrecache({
            urls: ['/media/intro.mp4'], // или () => fetch('/manifest.json').then(r => r.json()).then(m => m.opfsUrls)
        }),
    ],
    { version: '1.0.0' }
);
```

Порядок: сначала **opfsServeRange** (попытка отдать из OPFS), затем **opfsCacheOnFetch** (если не в OPFS — fetch и запись в OPFS), при установке — **opfsPrecache** (предкеш по списку).

## Схема хранения в OPFS

- **Ключ файла:** `key = hex(SHA-256(URL))` (64 символа). Коллизии SHA-256 практически исключены.
- **Один файл на URL:** структура `[тело ресурса][футер]`. Футер: 4 байта — длина JSON в байтах (uint32, little-endian), затем байты JSON с метаданными. Если футер отсутствует или невалиден, размер берётся из файла, тип — `application/octet-stream`.
- **Очистка:** удалить один файл `key` — мусора не остаётся.

**Важно:** если другой код (Worker, плагин) отдаёт этот файл **целиком** (например, 200 без Range) видеоплееру или другому потребителю, нельзя отдавать файл «как есть» — в конце лежит футер, плеер может сломаться. Нужно отдавать только тело: сначала прочитать футер и вычислить `bodySize`, затем `new Response(file.slice(0, bodySize), ...)`. Этот плагин отдаёт только диапазоны тела (206), футер в ответ не попадает.

Формат **JSON метаданных** (в конце файла):

```json
{
  "size": 104857600,
  "type": "video/mp4",
  "etag": "\"xyz\"",
  "lastModified": "Wed, 21 Oct 2015 07:28:00 GMT"
}
```

**Общие правила** — в этом пакете: все плагины и утилиты используют один формат и `urlToOpfsKey`, ничего шарить снаружи не нужно.

## Утилиты для своей записи в OPFS

```typescript
import {
    getOpfsDir,
    urlToOpfsKey,
    writeToOpfs,
    metadataFromResponse,
    type OpfsMetadata,
} from '@budarin/psw-plugin-opfs-serve-range';

const root = await navigator.storage.getDirectory();
const dir = await getOpfsDir(root, true); // папка из configureOpfs
const key = await urlToOpfsKey(url);
const metadata = metadataFromResponse(response); // из заголовков ответа
await writeToOpfs(dir, key, response.body, metadata);
```

`writeToOpfs` принимает папку плагина (результат `getOpfsDir(root, true)`), сам дописывает футер. Ответ должен содержать заголовок `Content-Length`.

## Очистка кеша

```typescript
import { clearOpfsCache } from '@budarin/psw-plugin-opfs-serve-range';

await clearOpfsCache(); // удаляет папку из конфига со всем содержимым
```

Вызывать при необходимости сброса (например, по сообщению со страницы или при логауте).

## Опции плагинов

Имя папки задаётся только в **configureOpfs({ folderName })**.

**opfsServeRange:** `order`, `enableLogging`, `include`, `exclude`, `rangeResponseCacheControl`.

**opfsPrecache:** `urls` (string[] или () => Promise<string[]>), `order`, `enableLogging`.

**opfsCacheOnFetch:** `order` (например -10, после opfsServeRange), `include`, `exclude`, `enableLogging`. Для совпадений с `include` выполняет fetch, сохраняет в OPFS (tee потока) и отдаёт ответ.

## Требования

- Браузер с поддержкой OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+).
- Secure context (HTTPS).
- Файлы в OPFS по той же схеме (key = hex(SHA-256(URL)), футер в конце). Можно использовать opfsPrecache и opfsCacheOnFetch из этого пакета или свои плагины на базе writeToOpfs.

## Лицензия

MIT
