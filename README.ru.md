# @budarin/psw-plugin-opfs-serve-range

Плагины и утилиты для [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker). Большие файлы хранятся в Origin Private File System (OPFS), а запросы по диапазону байтов (HTTP Range) обслуживаются напрямую из файлов: можно читать любую часть файла без последовательного прохода, в отличие от Cache API. Лимиты по квоте, вытеснение по LRU и список закреплённых ресурсов настраиваются вами. Поддерживается сценарий «скачать в фоне и смотреть офлайн» через Background Fetch.

Подробнее о поведении кеша (лимиты, LRU, эвикция, оповещения): [docs/opfs-cache-behavior.ru.md](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

---

## Оглавление

- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Сценарии использования](#сценарии-использования)
  - [Кеш при первом запросе](#кеш-при-первом-запросе)
  - [«Скачать для офлайна» (Background Fetch)](#скачать-для-офлайна-background-fetch)
- [Справочник: плагины (сервис-воркер)](#справочник-плагины-сервис-воркер)
- [Справочник: клиентский API](#справочник-клиентский-api)
- [Формат хранения в OPFS](#формат-хранения-в-opfs)
- [Свой плагин записи в OPFS](#свой-плагин-записи-в-opfs)
- [Требования](#требования)
- [Лицензия](#лицензия)

---

## Установка

```bash
pnpm add @budarin/psw-plugin-opfs-serve-range
```

---

## Быстрый старт

Самый простой сценарий: при первом запросе к ресурсу данные загружаются из сети и сохраняются в хранилище OPFS. При следующих запросах к тому же адресу ответ отдаётся уже из кеша, без обращения к сети.

Для этого в сервис-воркере подключают два плагина:

- **opfsServeRange** — отдаёт запрошенные диапазоны байтов из OPFS, если файл уже есть в кеше.
- **opfsRangeFromNetworkAndCache** — если файла в кеше ещё нет, запрос уходит в сеть; ответ сразу передаётся клиенту потоком, а в фоне при необходимости тот же файл сохраняется в OPFS.

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

После такой настройки запросы к адресам из списка `include` сначала проверяют кеш в OPFS; если файла там нет, идёт обращение в сеть и при успешной загрузке — запись в кеш. Отдельный код на странице для этого сценария не нужен.

Важно: загрузка, которую запускает плагин opfsRangeFromNetworkAndCache, прерывается при закрытии вкладки или обрыве сети. О том, идёт ли такая фоновая загрузка в кеш, страница может узнавать по подпискам **onOPFSRangeCacheFetchStarted** и **onOPFSRangeCacheFetchAllDone** (включить и выключить индикатор). Если нужна загрузка, которая продолжается и после закрытия вкладки, используйте сценарий [«Скачать для офлайна»](#скачать-для-офлайна-background-fetch).

---

## Сценарии использования

### Кеш при первом запросе

Чтобы сценарий работал как задумано, сервер должен поддерживать запросы по диапазону байтов (HTTP Range): на запрос с заголовком Range он должен отвечать статусом 206 и указывать размер в заголовке Content-Length.

Как это устроено, описано в разделе [Быстрый старт](#быстрый-старт). Кратко: при запросе сначала проверяется кеш в OPFS; если файла нет, запрос уходит в сеть, ответ отдаётся клиенту и при возможности сохраняется в OPFS. Следующие запросы по тому же адресу уже обслуживаются из кеша. Используются плагины opfsServeRange и opfsRangeFromNetworkAndCache. Настройки квоты, вытеснения по LRU и закреплённых ресурсов описаны в [Справочнике по плагинам](#справочник-плагины-сервис-воркер).

---

### «Скачать для офлайна» (Background Fetch)

В этом сценарии пользователь нажимает кнопку вроде «Скачать для офлайна»; выбранные файлы загружаются в фоне, вкладку можно закрыть. После завершения загрузки приложение обращается к тем же адресам с запросом диапазона байтов (Range) и получает данные уже из кеша.

#### Сервис-воркер

В сервис-воркере нужно зарегистрировать плагин **opfsBackgroundFetch**. Он обрабатывает события Background Fetch и сообщения от страницы (ответ на запрос фильтра include/exclude), поэтому отдельно вешать обработчик `message` не требуется.

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

#### Клиент (страница)

Удобнее всего использовать высокоуровневый API: одна функция запускает загрузку. Она возвращает обещание (промис), которое выполняется, когда ресурсы записаны в OPFS, или отклоняется при ошибке или отмене пользователем.

```typescript
import { startDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOffline(
    assets: string[],
    title: string,
    downloadTotal?: number
) {
    try {
        const result = await startDownloadAssetsToOpfs({
            assets,
            title,
            downloadTotal,
            onProgress: (downloaded, total) => console.log(`${downloaded}/${total}`),
            signal: myAbortController.signal,
        });
        console.log('Закешировано:', result.assets);
    } catch (e) {
        if (e && typeof e === 'object' && 'reason' in e) {
            console.warn('Загрузка', (e as { reason: string }).reason);
        } else throw e;
    }
}
```

Если вы используете React, в пакете есть хук: он хранит состояние загрузки (статус, прогресс по байтам и по файлам, ошибки, результат). При размонтировании компонента хук только перестаёт обновлять состояние, загрузка в фоне продолжается; отменить её можно вызовом reset().

```typescript
import { useDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function DownloadButton() {
    const { startDownload, status, progress, fileProgress, error, data, reset } = useDownloadAssetsToOpfs();
    return (
        <>
            <button onClick={() => startDownload({ assets: ['/assets/video.mp4'], title: 'Видео' })}>
                Скачать
            </button>
            {status === 'pending' && progress && <span>{progress.downloaded}/{progress.total}</span>}
            {status === 'success' && data && <span>Готово: {data.assets?.join(', ')}</span>}
            {status === 'failure' && error && <span>Ошибка</span>}
        </>
    );
}
```

Если нужна своя логика (свой идентификатор загрузки, своя фильтрация или свои колбеки), сценарий можно собрать из низкоуровневых функций. Подробности — в разделе [Справочник: клиентский API](#справочник-клиентский-api). Запись в OPFS по-прежнему выполняет плагин opfsBackgroundFetch в сервис-воркере; идентификатор загрузки должен начинаться с префикса `opfs-ranges-` (константа **OPFS_BACKGROUND_FETCH_ID_PREFIX** в пакете).

---

## Справочник: плагины (сервис-воркер)

Общие настройки кеша задаются через configureOpfs: имя папки в OPFS и доля квоты хранилища. Вызвать configureOpfs нужно до регистрации плагинов. По умолчанию имя папки — `range-requests-cache`, доля квоты — 0.5. Полностью очистить кеш можно функцией clearOpfsCache().

В средах, где OPFS недоступен, фабрики плагинов возвращают undefined.

| Плагин | Назначение |
|--------|------------|
| **opfsServeRange** | Читает файлы из OPFS и отдаёт запрошенные диапазоны байтов (206). |
| **opfsRangeFromNetworkAndCache** | Запросы, которые opfsServeRange не обслужил: сеть → ответ клиенту и при необходимости фоновая запись в OPFS. Загрузка прерывается при закрытии вкладки/обрыве сети. |
| **opfsBackgroundFetch** | По успешному завершению Background Fetch записывает ответы в OPFS; дальше range по этим URL обслуживает opfsServeRange. Обрабатываются только загрузки, чей идентификатор начинается с **OPFS_BACKGROUND_FETCH_ID_PREFIX** (`opfs-ranges-`). Внутри в обработчике `message` вызывает плагин ответа на запрос фильтра (см. **opfsBackgroundFetchFilter**). |
| **opfsBackgroundFetchFilter** | Только обработка `message`: на запрос типа OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER отвечает текущими include/exclude. Серверная пара к клиентскому **getBackgroundFetchFilter()**. Независимый плагин — для кастомного SW можно регистрировать один этот плагин со своими include/exclude. |

**opfsServeRange**

```ts
opfsServeRange(options?: {
  order?: number;
  enableLogging?: boolean;
  include?: string[];
  exclude?: string[];
  rangeResponseCacheControl?: string; // по умолчанию max-age=31536000, immutable
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

Плагин только для ответа на запрос фильтра (getBackgroundFetchFilter на клиенте). При использовании полного стека его отдельно регистрировать не нужно — opfsBackgroundFetch внутри себя вызывает этот плагин. Для кастомного сервис-воркера зарегистрируйте opfsBackgroundFetchFilter с теми же include/exclude, что и ваша логика загрузки.

```ts
opfsBackgroundFetchFilter(options?: {
  include?: string[];
  exclude?: string[];
}): Plugin
```

Закреплённые ресурсы (опция pinned): массив масок (glob) по адресам. Ресурсы, подходящие под эти маски, не вытесняются при нехватке места (LRU). Поддерживается обоими плагинами, которые пишут в OPFS: opfsRangeFromNetworkAndCache и opfsBackgroundFetch.

---

## Справочник: клиентский API

Entry point: `@budarin/psw-plugin-opfs-serve-range/client`. React-хук: `@budarin/psw-plugin-opfs-serve-range/client/react`.

### Загрузка assets в OPFS

**Условие:** в SW должен быть зарегистрирован плагин, отвечающий на запрос фильтра — либо **opfsBackgroundFetch** (он внутри вызывает плагин ответа по фильтру), либо отдельно **opfsBackgroundFetchFilter** (для кастомного SW). Иначе `startDownloadAssetsToOpfs` не получит фильтр и загрузка может быть некорректной.

- **getBackgroundFetchFilter()** — запрашивает у сервис-воркера текущие настройки фильтра (include и exclude). Серверная пара — плагин **opfsBackgroundFetchFilter** (или opfsBackgroundFetch, который его вызывает). Возвращает обещание с объектом `{ include?, exclude? }`.

- **filterAssetsForOpfs(assets, include?, exclude?, origin?)** — отбирает из списка адресов только те, что подходят под те же правила, что и плагин (по маскам glob). Удобно использовать вместе с результатом getBackgroundFetchFilter(), если собираете свою логику загрузки.

- **startDownloadAssetsToOpfs(options)** — запрашивает у сервис-воркера фильтр, отбирает подходящие адреса, запускает Background Fetch. Обещание выполняется, когда сервис-воркер записал файлы в OPFS; в результате приходят списки записанных (written), пропущенных или с ошибкой (failedOrSkipped) и отфильтрованных (filteredOut). Можно передать колбеки прогресса и отмену через signal.

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

- **useDownloadAssetsToOpfs()** — React-хук. Возвращает функцию запуска загрузки, статус, прогресс по байтам и по файлам, ошибку, результат и функцию сброса. Вызов reset() отменяет текущую загрузку (если она идёт) и обнуляет состояние. Требуется установленный React (peer dependency).

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

Низкоуровневый вариант: функции startBackgroundFetch и isBackgroundFetchSupported из пакета pluggable-serviceworker (клиентский подмодуль background-fetch), плюс подписки на сообщения от сервис-воркера (onOPFSBackgroundFetchCompleted, onOPFSBackgroundFetchFailed, onOPFSBackgroundFetchAborted, onOPFSBackgroundFetchFileWritten) из этого пакета. Идентификатор загрузки должен начинаться с префикса `opfs-ranges-` (константа **OPFS_BACKGROUND_FETCH_ID_PREFIX**).

### Подписки на сообщения от сервис-воркера

Каждая функция принимает обработчик и возвращает функцию для отписки. В каком случае сервис-воркер отправляет то или иное сообщение, описано в [описании поведения кеша](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

**Blocklist (список исключённых адресов):** при записи в OPFS может произойти превышение квоты (QuotaExceeded). Если уже записано байт не меньше, чем текущий размер всего кеша, освободить место эвикцией бесполезно — такой URL заносят в blocklist (в памяти сервис-воркера на время его жизни). При следующих запросах к этому адресу плагин не пытается кешировать ответ снова и отправляет сообщение, чтобы клиент мог показать предупреждение пользователю.

- **onOPFSQuotaExceeded** — квота исчерпана при записи в OPFS.
- **onOPFSWriteSkipped** — запись пропущена (файл не влезает даже после эвикции).
- **onOPFSEvictionCompleted** — эвикция завершена.
- **onOPFSWriteFailed** — ошибка записи.
- **onOPFSSkipQuotaExceeded** — повторный запрос к адресу из blocklist (плагин не кеширует, только оповещает).
- **onOPFSBackgroundFetchFailed** — Background Fetch завершился с ошибкой.
- **onOPFSBackgroundFetchAborted** — Background Fetch отменён.
- **onOPFSBackgroundFetchCompleted** — Background Fetch успешно завершён, ресурсы в OPFS.
- **onOPFSBackgroundFetchFileWritten** — очередной файл записан в OPFS (прогресс по файлам).
- **onOPFSRangeCacheFetchStarted** — плагин opfsRangeFromNetworkAndCache начал фоновую загрузку в кеш (сценарий «кеш при первом запросе»). По нему можно включить индикатор «идёт фоновая загрузка».
- **onOPFSRangeCacheFetchAllDone** — все такие фоновые загрузки завершены. По нему можно выключить индикатор.

Типы данных и константы типов сообщений экспортируются из пакета (OpfsMessagePayload, константы OPFS_MSG_*, OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER, OPFS_RESPONSE_BACKGROUND_FETCH_FILTER).

### Утилиты управления кешем

Эти функции вызываются на странице (в клиентском коде). Полностью очистить кеш можно вызовом clearOpfsCache() из сервис-воркера или со страницы.

- **listOpfsCachedResources()** — возвращает список закешированных ресурсов.
- **hasInOpfsCache(url)** — проверяет, есть ли такой адрес в кеше.
- **deleteFromOpfsCache(url)** — удаляет ресурс по адресу из кеша.

---

## Формат хранения в OPFS

Раздел для тех, кто пишет свой плагин или читает файлы из OPFS напрямую. Имя файла в OPFS — 64 символа, hex от SHA-256 от URL. В одном файле: сначала тело ресурса, в конце — футер (метаданные в JSON и 4 байта длины). В метаданных хранятся url, size, type, etag, lastModified, lastAccessed, evictable. Все плагины пакета используют этот формат и общую функцию urlToOpfsKey.

Если отдаёте файл целиком (ответ 200 без Range), отдавайте только тело, без футера: по футеру вычислите размер тела и отдайте file.slice(0, bodySize). Плагин opfsServeRange отдаёт только диапазоны тела (ответ 206), футер в ответ не входит.

---

## Свой плагин записи в OPFS

Если нужно записывать в OPFS по своей логике, но в том же формате, что и плагины пакета, используйте функции getRoot, getOpfsDir, urlToOpfsKey, writeToOpfs, metadataFromResponse.

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

Ответ от сервера может быть без заголовка Content-Length; при записи полного тела размер определяется автоматически. Если у вас включены лимиты по квоте, в writeToOpfs передайте пятый аргумент options с полями url и knownSize.

---

## Требования

Нужен браузер с поддержкой OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) и безопасный контекст (страница по HTTPS).

---

## Лицензия

MIT
