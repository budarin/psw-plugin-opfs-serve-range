# @budarin/psw-plugin-opfs-serve-range

Большие медиафайлы и другие «тяжёлые» ресурсы почти всегда запрашиваются по частям через HTTP Range, а не одним куском. Когда такие файлы лежат в обычном HTTP‑кеше (Cache API), сервис‑воркеру приходится каждый раз читать и обрабатывать весь файл, даже если клиенту нужен только небольшой диапазон. Это лишняя нагрузка на память и процессор, которая особенно больно бьёт по слабым устройствам и при небольшой квоте хранилища.

Этот пакет решает задачу по‑другому: он использует Origin Private File System (OPFS) как основное хранилище для больших ресурсов и ответов по Range. Файлы записываются в OPFS в собственном формате (один файл на URL плюс метаданные во футере), а диапазоны читаются напрямую из файловой системы, без Cache API. Поверх этого построены плагины для предзагрузки, фоновых загрузок и обслуживания range‑запросов.

В отличие от `@budarin/psw-plugin-serve-range-requests`, который работает поверх Cache API: там данные читаются из кеша **только последовательно**, без произвольного доступа, поэтому запрос диапазона в конце или в середине большого файла заставляет читать всё от начала до нужного места. Этот пакет использует OPFS: нужный диапазон читается напрямую из файла (произвольный доступ), без прохода по предыдущим байтам — обращение к любой части файла одинаково быстро. Кроме того, квотой и эвикцией управляете вы (лимиты, LRU, закреплённые ресурсы, уведомления вкладок), поддерживаются сценарии «скачать в фоне — потом смотреть офлайн» (Background Fetch, precache) и есть утилиты для своих плагинов записи и чтения из OPFS.

Пакет предоставляет плагины и утилиты для [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker) для обработки range‑запросов к файлам в OPFS:

- **opfsServeRange** — читает файлы из OPFS и отдаёт запрошенные диапазоны байтов.
- **opfsPrecache** — при установке сервис‑воркера загружает список URL и записывает их в OPFS. Загрузка объёмных файлов на стадии установки может занять много времени, поэтому в UI имеет смысл явно сообщать пользователю, что идёт инициализация, либо не включать большие файлы в precache. Отдельно важно учитывать, что если на стадии `install` при записи в OPFS не хватит места и операция завершится ошибкой, весь сервис‑воркер не будет установлен (install не завершится успешно). Через opfsPrecache стоит грузить только те ресурсы, которые гарантированно помещаются даже на маленьких и уже частично заполненных устройствах; тяжёлые файлы лучше выносить в отдельные сценарии фоновой или отложенной загрузки с помощью плагина `opfsRangeFromNetworkAndCache` или Background Fetch.
- **opfsRangeFromNetworkAndCache** — подхватывает запросы, которые `opfsServeRange` не обслужил (ресурс ещё не в кеше): идёт в сеть, сразу отдаёт ответ клиенту и при необходимости запускает параллельно полную загрузку файла в OPFS; в кеш попадают только полностью загруженные файлы. При закрытии вкладки, браузера или обрыве сети загрузка прерывается — при следующем запросе к тому же URL загрузка начнётся заново. Для очень больших файлов и платных каналов стоит особенно внимательно отнестись к таким сценариям; если нужна загрузка, переживающая закрытие вкладки или браузера, используйте `Background Fetch API` и плагины из `@budarin/pluggable-serviceworker`.
- **opfsBackgroundFetch** — при успешном завершении загрузки при помощи `Background Fetch API` записывает ответы в OPFS; дальнейшие range‑запросы по этим URL обслуживает `opfsServeRange`.
- **writeToOpfs**, **metadataFromResponse**, **urlToOpfsKey**, **isOpfsAvailable** — утилиты, которые могут понадобиться для написания собственных плагинов записи в OPFS; **isOpfsAvailable()** — утилита для синхронной проверки наличия OPFS.

В средах без поддержки OPFS фабрики плагинов возвращают `undefined`.

Все файлы кеша лежат в одной папке OPFS. Её имя задаётся один раз в **configureOpfs({ folderName })** до регистрации плагинов (по умолчанию `'range-requests-cache'`). Чтобы очистить кеш, вызовите **clearOpfsCache()** — удалится вся папка. Внутри — один файл на URL, все метаданные хранятся в самом файле.

Подробное описание поведения кеша (лимиты, LRU, эвикция, оповещения) — в [docs/opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

## Установка

```bash
pnpm add @budarin/psw-plugin-opfs-serve-range
```

## Использование

В следующем примере показано, как сделать так, чтобы медиа (видео, тайлы карт и т.п.) по первому запросу подгружались и сохранялись в локальный кэш, а при повторных запросах — после полной загрузки — отдавались из кэша без сети.

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import {
    configureOpfs,
    opfsServeRange,
    opfsRangeFromNetworkAndCache,
} from '@budarin/psw-plugin-opfs-serve-range';

configureOpfs({
    folderName: 'ranges-media-cache',
    maxCacheFraction: 0.5, // доля квоты origin для кеша (по умолчанию 0.5)
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

Здесь два плагина: **opfsServeRange** отдаёт диапазоны из OPFS, если файл уже в кеше; **opfsRangeFromNetworkAndCache** — если файла ещё нет — идёт в сеть, сразу отдаёт ответ клиенту и при необходимости догружает файл в OPFS в фоне. Так при следующих запросах тот же URL уже обслужит opfsServeRange из кэша. При необходимости можно добавить **opfsPrecache** или **opfsBackgroundFetch**; состав и порядок плагинов можно менять под свою задачу.

### Пример: загрузка по кнопке (Background Fetch) и отдача по range

**Что реализует пример:** Пользователь нажимает «Скачать для офлайна» → большой файл (видео, карта) качается в фоне, можно закрыть вкладку. После завершения загрузки плеер или карта запрашивают этот URL с заголовком Range — ответы идут из кэша, без повторной загрузки. Цель: полный цикл «кнопка → фоновая загрузка → воспроизведение/просмотр из кэша».

**Клиент (страница)** — запуск загрузки по действию пользователя:

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
        console.warn('Background Fetch API не поддерживается');
        return;
    }
    const reg = await navigator.serviceWorker.ready;
    const id = `offline-${Date.now()}`;
    await startBackgroundFetch(reg, id, [url], { title, downloadTotal });
}
```

**Сервис-воркер** — регистрация плагинов (по завершении Background Fetch файл пишется в range cache, дальше range-запросы обслуживает opfsServeRange):

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

## Схема хранения в OPFS

Тем, кто пишет свой плагин записи или отдаёт файл из OPFS в обход плагинов, пригодятся детали формата. Ключ файла — `hex(SHA-256(URL))` (64 символа). Один файл на URL: сначала тело ресурса, в конце футер (JSON с метаданными + 4 байта длины). Очистка — удалить файл по ключу или всю папку через clearOpfsCache.

**Важно:** если вы отдаёте файл из OPFS **целиком** (например, 200 без Range) плееру или другому коду — отдавайте только тело, без футера: сначала прочитайте футер и вычислите `bodySize`, затем `new Response(file.slice(0, bodySize), ...)`. Плагин opfsServeRange отдаёт только диапазоны тела (206), футер в ответ не попадает.

Пример метаданных в футере (JSON): `url`, `size`, `type`, `etag`, `lastModified`, `lastAccessed`, `evictable`. Все плагины пакета используют один формат и общий `urlToOpfsKey`. Поле `evictable` (по умолчанию `true`) указывает, можно ли эвиктить ресурс алгоритмом LRU; `false` означает, что ресурс закреплён и не будет удалён.

## Свой плагин записи в OPFS

Если нужно записывать в OPFS по своей логике (тот же формат, что и у плагинов пакета), могут понадобиться **getOpfsDir**, **urlToOpfsKey**, **writeToOpfs**, **metadataFromResponse**. Пример:

```typescript
import {
    getOpfsDir,
    urlToOpfsKey,
    writeToOpfs,
    metadataFromResponse,
} from '@budarin/psw-plugin-opfs-serve-range';

const root = await navigator.storage.getDirectory();
const dir = await getOpfsDir(root, true);
const key = await urlToOpfsKey(url);
const metadata = metadataFromResponse(response, url);
await writeToOpfs(dir, key, response.body, metadata);
```

Ответ может быть без заголовка `Content-Length` — при записи полного тела размер определяется автоматически. При использовании лимитов передайте в `writeToOpfs` пятый аргумент `options`: `{ url, knownSize }` (например, `knownSize: metadata.size > 0 ? metadata.size : undefined`).

## Клиентские утилиты

Клиентские хелперы экспортируются из entry point `@budarin/psw-plugin-opfs-serve-range/client`. В этом разделе — сигнатуры, типы и примеры; в [opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md) описано только **когда** сервис-воркер шлёт сообщения (лимиты, LRU, эвикция), не API.

**Данные в сообщениях**

Во всех подписках обработчик получает `MessageEvent`: в `event.data` приходит объект типа `{ type: string } & OpfsMessagePayload`:

- `type` — тип сообщения (константа `OPFS_MSG_*`);
- `url?` — URL ресурса, к которому относится событие (если применимо);
- `size?` — размер в байтах (например, размер файла, который не влез);
- `limit?` — лимит кеша в байтах (например, в WRITE_SKIPPED / CACHE_LIMIT_REACHED);
- `reason?` — текст ошибки (в WRITE_FAILED).

В части сообщений в `event.data` бывают и другие поля (например, `count` в EVICTION_COMPLETED).

**Подписки на сообщения**

Каждая функция принимает один аргумент — обработчик — и возвращает функцию отписки `() => void`. Вызовите её, когда подписка больше не нужна.

| Функция | Сигнатура | Когда вызывается |
|--------|-----------|-------------------|
| `onOPFSQuotaExceeded` | `(handler: (event: MessageEvent) => void) => () => void` | При записи в OPFS браузер вернул QuotaExceeded. В `event.data`: `url`, при необходимости `size`. |
| `onOPFSWriteSkipped` | `(handler: (event: MessageEvent) => void) => () => void` | Запись не начата: файл не влезает даже после попытки эвикции. В `event.data`: `url`, `size`, `limit`. |
| `onOPFSCacheLimitReached` | `(handler: (event: MessageEvent) => void) => () => void` | Достигнут лимит кеша, начинается эвикция. В `event.data`: `limit` и др. |
| `onOPFSEvictionCompleted` | `(handler: (event: MessageEvent) => void) => () => void` | Эвикция завершена. В `event.data`: `count` (число удалённых файлов). |
| `onOPFSWriteFailed` | `(handler: (event: MessageEvent) => void) => () => void` | Ошибка записи (сеть, диск, удалён частичный файл). В `event.data`: `url`, `reason`. |
| `onOPFSSkipQuotaExceeded` | `(handler: (event: MessageEvent) => void) => () => void` | Повторный запрос к URL из чёрного списка (ресурс не кешируем). В `event.data`: `url`. |

**Управление кешем и типы**

- `listOpfsCachedResources(): Promise<OpfsCachedResource[]>` — список закешированных ресурсов; элемент: `{ url, size, type?, lastModified? }`.
- `hasInOpfsCache(url: string): Promise<boolean>` — есть ли URL в кеше.
- `deleteFromOpfsCache(url: string): Promise<void>` — удалить ресурс по URL из кеша.

Типы `OpfsMessagePayload` и `OpfsCachedResource` экспортируются из пакета; константы типов сообщений — `OPFS_MSG_QUOTA_EXCEEDED`, `OPFS_MSG_WRITE_SKIPPED_SIZE` и т.д.

### Оповещения вкладок о квоте и лимитах

Пример: подписаться на события и показать пользователю, какой ресурс не удалось закешировать; при размонтировании компонента — отписаться.

```typescript
import {
    onOPFSQuotaExceeded,
    onOPFSSkipQuotaExceeded,
    type OpfsMessagePayload,
} from '@budarin/psw-plugin-opfs-serve-range/client';

const unsubQuota = onOPFSQuotaExceeded((event: MessageEvent) => {
    const data = event.data as { type: string } & OpfsMessagePayload;
    console.warn('OPFS: квота исчерпана', data.url);
    // например: showToast(`Не удалось сохранить: ${data.url}`);
});

const unsubSkip = onOPFSSkipQuotaExceeded((event: MessageEvent) => {
    const data = event.data as { type: string } & OpfsMessagePayload;
    console.warn('OPFS: ресурс не кешируется (лимит)', data.url);
});

// когда подписка не нужна:
// unsubQuota(); unsubSkip();
```

В каких ситуациях шлются сообщения — [opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

### Очистка кеша и управление отдельными ресурсами

Когда нужно сбросить весь кеш (например, по кнопке в UI или при логауте), можно вызвать `clearOpfsCache()` из сервис-воркера или клиента — будет удалена вся папка кеша.

Если нужно работать с отдельными ресурсами (показать пользователю список сохранённых файлов и дать удалить что-то выборочно), можно использовать клиентские утилиты из entry point `@budarin/psw-plugin-opfs-serve-range/client`. Список в кеше строится по метаданным в футере (там теперь хранится исходный url каждого ресурса).

Основные сценарии:

- `listOpfsCachedResources(): Promise<OpfsCachedResource[]>` — список ресурсов в OPFS-кеше (url, size, type, lastModified);
- `hasInOpfsCache(url: string): Promise<boolean>` — есть ли URL в кеше;
- `deleteFromOpfsCache(url: string): Promise<void>` — удалить один ресурс по URL.

## Опции плагинов

Имя папки и доля квоты задаются в **configureOpfs({ folderName, maxCacheFraction })**.

- **opfsServeRange:** `order`, `enableLogging`, `include`, `exclude`, `rangeResponseCacheControl` — чтобы ограничить URL и кеш ответов 206.
- **opfsPrecache:** `urls` (список или функция, возвращающая список), `order`, `enableLogging`, `pinned` — какие URL загружать при установке SW. `pinned` — массив glob-паттернов для URL, которые нельзя эвиктить (например, `['/assets/media/**']`).
- **opfsRangeFromNetworkAndCache:** `order` (например -10, после opfsServeRange), `include`, `exclude`, `enableLogging`, `pinned` — какие запросы кешировать; при запросе с Range отдаёт ответ сразу и при необходимости догружает файл в OPFS в фоне. `pinned` — массив glob-паттернов для URL, которые нельзя эвиктить. При `enableLogging` в консоль пишется предупреждение, если файл уже есть в OPFS, но ответ по Range отдан с сети (например, из‑за If-Range или порядка плагинов).
- **opfsBackgroundFetch:** `order`, `include`, `exclude`, `enableLogging`, `pinned` — какие URL писать в OPFS по завершении Background Fetch. `pinned` — массив glob-паттернов для URL, которые нельзя эвиктить. События fail/abort/click при `enableLogging` логируются; можно зарегистрировать свой плагин с теми же хуками (например, показать уведомление при fail). Запуск загрузки с клиента — утилиты из `@budarin/pluggable-serviceworker/client/background-fetch`.

### Закреплённые ресурсы (защита от эвикции)

Все три плагина кеширования (`opfsPrecache`, `opfsRangeFromNetworkAndCache`, `opfsBackgroundFetch`) поддерживают опцию `pinned`: массив glob-паттернов для URL, которые никогда не должны удаляться алгоритмом LRU-эвикции. Ресурсы, соответствующие этим паттернам, сохраняются с `evictable: false` в метаданных и не будут удалены даже при достижении лимита кеша.

Пример: пометить важные медиафайлы как закреплённые, чтобы они не эвиктились, остальные закешированные медиа могут удаляться:

```typescript
opfsPrecache({
  urls: ['/assets/media/featured-video.mp4', '/assets/media/trailer.mp4'],
  pinned: ['/assets/media/featured-video.mp4'], // важный контент не будет эвиктиться
});

opfsRangeFromNetworkAndCache({
  include: ['*.mp4', '*.webm'],
  pinned: ['/assets/media/featured/**'], // важные медиафайлы не будут эвиктиться
});
```

По умолчанию все ресурсы эвиктабельны (`evictable: true`). Только ресурсы, соответствующие паттернам в `pinned`, защищены от эвикции.

## Требования

- Браузер с поддержкой OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) и secure context (HTTPS).

## Лицензия

MIT
