# @budarin/psw-plugin-opfs-serve-range

Плагины и утилиты для [@budarin/pluggable-serviceworker](https://www.npmjs.com/package/@budarin/pluggable-serviceworker). Большие файлы хранятся в Origin Private File System (OPFS), а запросы по диапазону байтов (HTTP Range) обслуживаются напрямую из файлов: можно читать любую часть файла без последовательного прохода, в отличие от Cache API. Лимиты по квоте, вытеснение по LRU и список закреплённых ресурсов настраиваются вами. Поддерживается сценарий «скачать в фоне и смотреть офлайн» через Background Fetch.

**Сторонние ресурсы не поддерживаются:** загрузка и кеширование только same-origin. При запросе к другому origin браузер возвращает [opaque response](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque): тело ответа недоступно для чтения и записи в OPFS, поэтому плагины не качают такие ресурсы.

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

Типичный сценарий: пользователь сам выбирает, что скачать (кнопка «Скачать для офлайна»). Подключают **opfsServeRange** (отдаёт диапазоны байтов из OPFS, если файл в кеше) и **opfsBackgroundFetch** (пишет в OPFS по завершении Background Fetch). Для **разных** кешей — **разные folderName** (например видео, аудио).

- **opfsServeRange** — отдаёт запрошенные диапазоны байтов из OPFS, если файл уже есть в кеше.
- **opfsBackgroundFetch** — когда пользователь запускает загрузку через Background Fetch (например со страницы через `startDownloadAssetsToOpfs`), готовые ответы записываются в OPFS; последующие запросы обслуживаются из кеша через opfsServeRange.

Пример с **отдельными кешами** для видео и аудио (по два плагина на папку):

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { createOpfsServeAndBackgroundFetchPlugins } from '@budarin/psw-plugin-opfs-serve-range';

initServiceWorker(
    [
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'video-cache',
            include: ['*.mp4', '*.webm'],
        }),
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'audio-cache',
            include: ['*.mp3', '*.m4a'],
        }),
    ],
    { version: '1.0.0' }
);
```

Плагины, которые используют **один и тот же** кеш (одну папку), должны иметь один и тот же **folderName** и согласованные опции. На странице вызывают `startDownloadAssetsToOpfs({ folderName, assets, title })` для запуска загрузки; по завершении эти URL обслуживаются из кеша. Подробнее — в разделе [«Скачать для офлайна»](#скачать-для-офлайна-background-fetch).

---

## Сценарии использования

### Кеш при первом запросе

**Альтернатива Background Fetch:** кеш заполняется при первом запросе к ресурсу (например при первом проигрывании видео), без отдельной кнопки «Скачать». Регистрируют **opfsServeRange** и **opfsRangeFromNetworkAndCache** (без opfsBackgroundFetch) для этой папки. Если файла нет в OPFS, запрос уходит в сеть, ответ отдаётся клиенту потоком и в фоне сохраняется в OPFS. Дальнейшие запросы обслуживаются из кеша. Загрузка прерывается при закрытии вкладки или обрыве сети. Используйте этот сценарий, когда не нужна кнопка «Скачать для офлайна» и нужна автоматическая загрузка в кеш при первом обращении.

Сервер должен поддерживать запросы по диапазону байтов (HTTP Range): ответ 206 и Content-Length. Квота, вытеснение по LRU и закреплённые ресурсы — в [Справочнике по плагинам](#справочник-плагины-сервис-воркер).

---

### «Скачать для офлайна» (Background Fetch)

В этом сценарии пользователь нажимает кнопку вроде «Скачать для офлайна»; выбранные файлы загружаются в фоне, вкладку можно закрыть. После завершения загрузки приложение обращается к тем же адресам с запросом диапазона байтов (Range) и получает данные уже из кеша.

#### Сервис-воркер

В сервис-воркере регистрируют **opfsServeRange** и **opfsBackgroundFetch** с одним **folderName** на кеш. Для **каждого** кеша — **свой folderName** (например видео и аудио — разные папки).

```typescript
import { initServiceWorker } from '@budarin/pluggable-serviceworker';
import { createOpfsServeAndBackgroundFetchPlugins } from '@budarin/psw-plugin-opfs-serve-range';

initServiceWorker(
    [
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'video-cache',
            include: ['*.mp4', '*.webm'],
            debug: true,
        }),
        createOpfsServeAndBackgroundFetchPlugins({
            folderName: 'audio-cache',
            include: ['*.mp3', '*.m4a'],
        }),
    ],
    { version: '1.0.0' }
);
```

#### Клиент (страница)

Удобнее всего использовать высокоуровневый API: одна функция запускает загрузку. Она возвращает обещание (промис), которое выполняется, когда ресурсы записаны в OPFS, или отклоняется при ошибке или отмене пользователем. При этом:
- системный UI Background Fetch (например, уведомление о загрузке на Android), если он поддерживается браузером, показывает прогресс и кнопки управления;
- клиентский код получает детализированный прогресс и статусы через колбеки и подписки и может строить собственный расширенный интерфейс состояния загрузки.

```typescript
import { startDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOffline(
    assets: string[],
    title: string,
    totalDownloadSizeInBytes?: number
) {
    try {
        const result = await startDownloadAssetsToOpfs({
            folderName: 'video-cache',
            assets,
            title,
            totalDownloadSizeInBytes,
            onProgress: (downloaded, total) =>
                console.log(`${downloaded}/${total}`),
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

Если вы используете React, в пакете есть хук: он хранит состояние загрузки (статус, прогресс по байтам и по файлам, ошибки, результат). При размонтировании компонента хук только перестаёт обновлять состояние, загрузка в фоне продолжается; отменить её можно вызовом reset(). Если пользователь вернулся на страницу и снова нажал «Скачать» с тем же набором файлов, загрузка с таким набором может уже идти — тогда новый вызов не создаёт дубликат, а подписывается на неё (attach), и промис выполнится при завершении той загрузки.

```typescript
import { useDownloadAssetsToOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function DownloadButton() {
    const { startDownload, status, progress, fileProgress, error, data, reset } = useDownloadAssetsToOpfs();
    return (
        <>
            <button onClick={() => startDownload({ folderName: 'video-cache', assets: ['/assets/video.mp4'], title: 'Видео' })}>
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

**Высокоуровневые фабрики**

```ts
createOpfsServeAndBackgroundFetchPlugins(options: {
  folderName: string;
  order?: number;            // по умолчанию 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // по умолчанию false
  logger?: Logger;
  pinned?: string[];
  rangeResponseCacheControl?: string;
}): Plugin[]
```

```ts
createOpfsServeAndNetworkCachePlugins(options: {
  folderName: string;
  order?: number;            // по умолчанию 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // по умолчанию false
  logger?: Logger;
  pinned?: string[];
  rangeResponseCacheControl?: string;
}): Plugin[]
```

Фабрика возвращает массив плагинов. **initServiceWorker** (pluggable-serviceworker) разворачивает вложенные массивы плагинов, поэтому результат можно передавать без спреда.

У каждого плагина в опциях обязательны **folderName: string** и **include: string[]** (непустой массив). Одна папка = один кеш. **include** и **exclude** могут быть glob-паттернами, pathname'ами или полными URL (например `['*.mp4', '/video/*']`, `['/assets/video.mp4']` или `['https://example.com/video/*']`). При инициализации полные URL приводятся к pathname (same-origin) или отбрасываются (cross-origin). Если после нормализации `include` оказался пустым (например в `include` были только cross-origin URL), фабрика возвращает `undefined` и плагин не создаётся. **Когда приходит запрос:** если URL запроса с другого origin — запрос не обрабатывается (ни отдача из кеша, ни запись). Если same-origin — по pathname URL запроса сопоставляем с (нормализованными) паттернами: например глоб `/video/*` совпадает с запросом на `https://example.com/video/1.mp4`. Плагины, которые обслуживают один и тот же кеш (например opfsServeRange + opfsBackgroundFetch или opfsServeRange + opfsRangeFromNetworkAndCache для сценария «кеш при первом запросе»), должны использовать один и тот же **folderName**. Очистить кеш: **clearOpfsCache(folderName)**.

**Плоское хранилище (flat store):** все файлы лежат в одном каталоге; **folderName** хранится только в метаданных файла и используется для фильтрации (отдача, list, clear). Размер кеша ограничен **одной глобальной долей** квоты origin: **getGlobalMaxCacheFraction()** (по умолчанию 0.5) и **setGlobalMaxCacheFraction(fraction)** задают лимит; **getMaxCacheFraction()** (без аргументов) возвращает его. Задайте лимит до регистрации плагинов; не задавайте 1.0, если приложение использует и другие хранилища (Cache API, IndexedDB и т.д.).

В средах, где OPFS недоступен, фабрики плагинов возвращают undefined.

**Утилиты (SW)**

```ts
normalizePatternList(patterns: string[] | undefined, baseOrigin: string): { list: string[] | undefined; dropped: NormalizePatternListDropped }
emitDroppedPatternWarnings(dropped: NormalizePatternListDropped, logger: { warn?: (message: string) => void }): void
getRoot(): Promise<FileSystemDirectoryHandle>
getFlatStoreDir(): Promise<FileSystemDirectoryHandle>
getOpfsDir(root: FileSystemDirectoryHandle, create: boolean, folderName: string): Promise<FileSystemDirectoryHandle>
clearOpfsCache(folderName: string): Promise<void>
registerFolderConfig(folderName: string): void
getGlobalMaxCacheFraction(): number
setGlobalMaxCacheFraction(fraction: number): void
getMaxCacheFraction(): number
getCacheLimit(estimate: StorageEstimate): number
```

При инициализации полные URL приводятся к pathname; cross-origin и невалидные попадают в `dropped`. Фабрики плагинов выводят предупреждения через logger. **getGlobalMaxCacheFraction** по умолчанию 0.5; **setGlobalMaxCacheFraction** ожидает (0, 1], при неверном значении — throw.

**opfsServeRange** — читает файлы из OPFS и отдаёт запрошенные диапазоны байтов (206), потоково по чанкам из файла.

```ts
opfsServeRange(options: {
  folderName: string;
  order?: number;            // по умолчанию 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // по умолчанию false
  logger?: Logger;
  rangeResponseCacheControl?: string;
}): Plugin | undefined
```

**opfsRangeFromNetworkAndCache** — обрабатывает запросы, которые opfsServeRange не отдал из кеша: загружает из сети, сразу отдаёт ответ клиенту и при возможности сохраняет файл в OPFS в фоне. Загрузка прерывается при закрытии вкладки или обрыве сети.

```ts
opfsRangeFromNetworkAndCache(options: {
  folderName: string;
  order?: number;            // по умолчанию 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // по умолчанию false
  logger?: Logger;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetch** — при успешном завершении Background Fetch записывает ответы в OPFS; последующие запросы по диапазону байтов обслуживает opfsServeRange. Учитываются только загрузки с id, начинающимся с **OPFS_BACKGROUND_FETCH_ID_PREFIX** (`opfs-ranges-`). В обработчике сообщений вызывает плагин ответа по фильтру (см. **opfsBackgroundFetchFilter**).

```ts
opfsBackgroundFetch(options: {
  folderName: string;
  order?: number;            // по умолчанию 0
  include: string[];
  exclude?: string[];
  debug?: boolean;   // по умолчанию false
  logger?: Logger;
  pinned?: string[];
}): Plugin | undefined
```

**opfsBackgroundFetchFilter** — обрабатывает только сообщения от страницы: на запрос фильтра (OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER) отвечает текущими include и exclude. Серверная пара клиентской утилиты **getBackgroundFetchFilter()**. При полном стеке регистрировать отдельно не нужно (opfsBackgroundFetch обрабатывает ответ по фильтру сам). В кастомном SW зарегистрируйте с теми же include и exclude, что и логика загрузки. Фильтр так же нормализует include/exclude (полные URL → pathname или отбрасываются). Возвращает **undefined**, если после нормализации include пуст.

```ts
opfsBackgroundFetchFilter(options: {
  include: string[];
  exclude?: string[];
  logger?: Logger;
}): Plugin | undefined
```

**opfsRegisteredFolders** — обрабатывает только сообщения от страницы: на запрос **OPFS_REQUEST_GET_REGISTERED_FOLDERS** отвечает списком папок, зарегистрированных в SW через **registerFolderConfig**. Серверная пара клиентской утилиты **getRegisteredFolders()**. **startDownloadAssetsToOpfs** использует этот список и отклоняет загрузку, если указанная папка не зарегистрирована. Подключайте в кастомном SW, если используете проверку папки на клиенте.

```ts
opfsRegisteredFolders(): Plugin | undefined
```

Закреплённые ресурсы (опция pinned): массив масок (glob) по адресам. Ресурсы, подходящие под эти маски, не вытесняются при нехватке места (LRU). Поддерживается обоими плагинами, которые пишут в OPFS: opfsRangeFromNetworkAndCache и opfsBackgroundFetch.

---

## Справочник: клиентский API

Entry point: `@budarin/psw-plugin-opfs-serve-range/client`. React-хук: `@budarin/psw-plugin-opfs-serve-range/client/react`.

### Загрузка assets в OPFS

**Условие:** в SW должны быть зарегистрированы плагины, отвечающие на запросы клиента: **opfsBackgroundFetchFilter** (или opfsBackgroundFetch) — для фильтра include/exclude; **opfsRegisteredFolders** — для списка зарегистрированных папок. Иначе `startDownloadAssetsToOpfs` не получит фильтр или список папок и загрузка будет отклонена с ошибкой (см. коды OPFS_ERROR_*).

**getBackgroundFetchFilter()**

```ts
getBackgroundFetchFilter(): Promise<{ include?: string[]; exclude?: string[] }>
```

Запрашивает у SW текущие include и exclude. В SW должен быть зарегистрирован **opfsBackgroundFetchFilter** или opfsBackgroundFetch. Резолвится объектом с фильтром; пустой объект при таймауте или отсутствии ответа от SW.

**getRegisteredFolders()**

```ts
getRegisteredFolders(): Promise<FolderName[]>
```

Запрашивает у SW список папок, зарегистрированных через registerFolderConfig. В SW должен быть зарегистрирован плагин **opfsRegisteredFolders**. При таймауте или отсутствии ответа возвращает пустой массив (тогда startDownloadAssetsToOpfs отклонит загрузку с OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE).

**filterAssetsForOpfs(assets, include?, exclude?)**

```ts
filterAssetsForOpfs(
  assets: string[],
  include?: string[],
  exclude?: string[]
): string[]
```

**estimateAssetsSizeInBytes(assets)**

```ts
estimateAssetsSizeInBytes(
  assets: string[]
): Promise<{ totalSize: number; sizes: Record<string, number> }>
```

Отправляет HEAD-запросы к указанным ресурсам (same-origin) и пытается прочитать заголовок `Content-Length` для оценки размеров.

- **assets** — список pathname'ов ресурсов (например, `['/video/1.mp4']`).
- Возвращает объект:
  - **totalSize** — суммарный размер в байтах по всем ресурсам, для которых удалось получить `Content-Length` (для остальных — 0).
  - **sizes** — словарь `pathname → размер в байтах` (0, если размер определить не удалось).

Хелпер работает только для same-origin ресурсов (как и весь пакет). Если сервер не отдаёт `Content-Length` или ответ неуспешен, размер считается равным 0, при этом промис не отклоняется.

Пример использования вместе с `startDownloadAssetsToOpfs`:

```ts
import {
  startDownloadAssetsToOpfs,
  estimateAssetsSizeInBytes,
} from '@budarin/psw-plugin-opfs-serve-range/client';

async function downloadForOfflineWithEstimatedSize(assets: string[], title: string) {
  const { totalSize } = await estimateAssetsSizeInBytes(assets);

  await startDownloadAssetsToOpfs({
    folderName: 'video-cache',
    assets,
    title,
    totalDownloadSizeInBytes: totalSize,
  });
}
```

**startDownloadAssetsToOpfs(options)**

При успешном завершении в системном списке загрузок остаётся переданный **title** (при ошибке/отмене заголовок обновляется). Задавайте осмысленный **title**, чтобы записи различались.

**Логика перед запуском:** запрашивается список зарегистрированных в SW папок (**getRegisteredFolders()**); если папка **folderName** не в списке или список пуст — промис отклоняется (OPFS_ERROR_FOLDER_NOT_REGISTERED или OPFS_ERROR_SERVICE_WORKER_UNAVAILABLE). Затем из списка assets (после фильтра include/exclude) исключаются те, что уже качаются в других активных Background Fetch (pathname берутся из matchAll() по каждой активной регистрации с префиксом `opfs-ranges-`). Затем исключаются те, что уже есть в OPFS (один вызов **listOpfsCachedResources(folderName)**). Порядок такой специально: сначала «в процессе», потом «уже в кеше» — чтобы не пропустить только что завершившуюся загрузку. В загрузку уходит только то, что осталось. Если ничего не осталось, промис сразу выполняется с `written: assetsToUse` (ничего не качаем). Идентификатор загрузки считается по набору pathname'ов идемпотентно (getOpfsBackgroundFetchId). Если с тем же набором загрузка уже идёт, новый вызов не создаёт вторую, а подписывается на уже идущую (attach); промис выполнится при её завершении.

```ts
startDownloadAssetsToOpfs(options: StartDownloadAssetsToOpfsOptions): Promise<DownloadAssetsToOpfsResult>

interface StartDownloadAssetsToOpfsOptions {
    folderName: string;
    assets: string[];
    title?: string;
    icons?: { src: string; sizes?: string; type?: string }[];
    totalDownloadSizeInBytes?: number;
    onProgress?: (downloaded: number, total: number) => void;
    onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
    signal?: AbortSignal;
}

interface DownloadAssetsToOpfsResult {
    registrationId: string;
    assets?: string[];
    written?: string[];
    failedOrSkipped?: string[];
    filteredOut?: string[];
}

interface DownloadAssetsToOpfsRejected {
    registrationId: string;
    reason: 'fail' | 'abort';
}
```

Для отображения в UI обрабатывайте ошибку через try/catch или .catch() и при необходимости проверяйте error?.code.

- **useDownloadAssetsToOpfs()** — React-хук. Возвращает функцию запуска загрузки, статус, прогресс по байтам и по файлам, **error** (заполняется при ошибке — можно показывать в UI), результат и функцию сброса. **startDownload** при ошибке отклоняет промис (те же коды); ошибка также попадает в состояние **error**. Для проверки кода используйте `error?.code` (OPFS_ERROR_FOLDER_NOT_REGISTERED и т.д.). При размонтировании загрузка не отменяется; отменить можно только вызовом reset(). При повторном нажатии «Скачать» с тем же набором файлов происходит подписка на уже идущую загрузку (attach). Требуется установленный React (peer dependency).

```ts
useDownloadAssetsToOpfs(): {
    startDownload: (options: Omit<StartDownloadAssetsToOpfsOptions, 'signal'>) => Promise<void>;
    status: 'idle' | 'pending' | 'success' | 'failure' | 'aborted';
    progress: { downloaded: number; total: number } | null;
    fileProgress: { loadedAssets: string[]; totalCount: number } | null;
    error: StartDownloadError | null;
    data: DownloadAssetsToOpfsResult | null;
    reset: () => void;
}
```

### Низкоуровневый API (без startDownloadAssetsToOpfs и хука)

Если вы не используете startDownloadAssetsToOpfs или хук и собираете сценарий вручную, понадобятся две вещи. Во-первых, функции запуска загрузки и проверки поддержки: **startBackgroundFetch** и **isBackgroundFetchSupported** из пакета pluggable-serviceworker (клиентский подмодуль `client/background-fetch`). Во-вторых, подписка на сообщения от сервис-воркера — об успешном завершении загрузки, об ошибке, об отмене и о записи каждого файла в OPFS; соответствующие функции подписки (**onOPFSBackgroundFetchCompleted**, **onOPFSBackgroundFetchFailed**, **onOPFSBackgroundFetchAborted**, **onOPFSBackgroundFetchFileWritten**) экспортируются из этого пакета. Идентификатор загрузки обязан быть сформирован при помощи **getOpfsBackgroundFetchId(assets, folderName)**. Id уникален для папки, поэтому один и тот же набор ресурсов в разных кешах не даёт коллизий; плагин в SW обрабатывает только события своей папки.

### Подписки на сообщения от сервис-воркера

Каждая функция принимает обработчик и возвращает функцию для отписки. В каком случае отправляется то или иное сообщение — в [описании поведения кеша](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

**Список отменённых (skip list):** при потоковой записи в OPFS может произойти превышение квоты (QuotaExceeded). Если к моменту ошибки файл оказался не меньше всего кеша, вытеснять старые файлы бесполезно — места всё равно не хватит. Такой URL заносят в список отменённых (в памяти сервис-воркера на время его жизни). При следующих запросах к этому адресу плагин не пытается кешировать ответ и отправляет **onOPFSSkipQuotaExceeded**, чтобы клиент мог показать предупреждение.

**Назначение каждой подписки:**

- **onOPFSQuotaExceeded** — квота исчерпана при записи в OPFS; URL при этом может быть занесён в список отменённых (см. выше).
- **onOPFSWriteSkipped** — запись отменена до начала: при известном размере файла проверка места не прошла, файл не помещается даже после эвикции.
- **onOPFSEvictionCompleted** — эвикция завершена.
- **onOPFSWriteFailed** — ошибка записи.
- **onOPFSSkipQuotaExceeded** — пришёл запрос к URL из списка отменённых; плагин не кеширует, только оповещает.
- **onOPFSBackgroundFetchFailed** — Background Fetch завершился с ошибкой.
- **onOPFSBackgroundFetchAborted** — Background Fetch отменён.
- **onOPFSBackgroundFetchCompleted** — Background Fetch успешно завершён, ресурсы в OPFS.
- **onOPFSBackgroundFetchFileWritten** — очередной файл записан в OPFS (прогресс по файлам).
- **onOPFSRangeCacheFetchStarted** — плагин opfsRangeFromNetworkAndCache начал фоновую загрузку в кеш (сценарий «кеш при первом запросе»). По нему можно включить индикатор «идёт фоновая загрузка».
- **onOPFSRangeCacheFetchAllDone** — все такие фоновые загрузки завершены. По нему можно выключить индикатор.

У всех этих функций один и тот же интерфейс. **Общий тип обработчика и payload** (экспортируются из пакета):

```ts
type OpfsMessageHandler = (event: MessageEvent & { data: { type: string } & OpfsMessagePayload }) => void;

interface OpfsMessagePayload {
    url?: string;
    size?: number;
    limit?: number;
    reason?: string;
    registrationId?: string;
    assets?: string[];
    written?: string[];
    failedOrSkipped?: string[];
    asset?: string;
    loadedAssets?: string[];
    totalCount?: number;
}
```

Какие поля есть в `event.data`, зависит от типа сообщения (см. список выше и [описание поведения кеша](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md)). Константы типов сообщений: OPFS_MSG_*, OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER, OPFS_RESPONSE_BACKGROUND_FETCH_FILTER.

### Утилиты кэша

Эти функции вызываются на странице и отправляют запросы в сервис-воркер (плагин **opfsCacheControl**). SW выполняет операцию в OPFS и инвалидирует свои in-memory кэши. Таймаут запроса 2 с. **folderName** должен совпадать с папкой, зарегистрированной в SW. Если папка не зарегистрирована, SW отвечает ошибкой: **listOpfsCachedResources** и **hasInOpfsCache** в этом случае возвращают `[]` и `false` соответственно; **deleteFromOpfsCache** не требует **folderName** (файл удаляется по URL из плоского хранилища). **clearOpfsCache** требует **folderName**; если папка не зарегистрирована, промис отклоняется с `opfs: folder not registered`. При использовании **createOpfsServeAndBackgroundFetchPlugins** или **createOpfsServeAndNetworkCachePlugins** плагин **opfsCacheControl** уже входит в набор — list/has/delete/clear работают «из коробки». Очистить кеш со страницы: **clearOpfsCache(folderName)** (клиент шлёт запрос CLEAR).

**listOpfsCachedResources(folderName)**

```ts
listOpfsCachedResources(folderName: string): Promise<OpfsCachedResource[]>

interface OpfsCachedResource {
    url: string;
    size: number;
    type: string | undefined;
    lastModified: string | undefined;
}
```

**hasInOpfsCache(url, folderName)**

```ts
hasInOpfsCache(url: string, folderName: string): Promise<boolean>
```

**deleteFromOpfsCache(url)**

```ts
deleteFromOpfsCache(url: string): Promise<void>
```

### Переподключение плеера к OPFS после загрузки файла

Когда файл (текущий источник video/audio) записан в OPFS через Background Fetch, можно переподключить плеер к тому же URL, чтобы последующие запросы шли из OPFS (например, для мгновенного перемотки). Используйте **onOPFSBackgroundFetchFileWritten** и **reconnectPlayerOnFileLoadedIntoOpfs**. Для **видео** во время смены источника показывается последний кадр (оверлей), оверлей убирается только когда новый источник уже отображается (события **playing** или **seeked**), поэтому нет чёрного экрана. Обёртка сохраняет layout видео (margin, box-sizing, display), так что контент не смещается. Если у видео не были заданы явные размеры, на время переключения они фиксируются, затем снимаются. Для аудио оверлей не используется.

**reconnectPlayerOnFileLoadedIntoOpfs(element, payload, folderName, options?)**

Вызывайте из обработчика **onOPFSBackgroundFetchFileWritten**. Если `payload.asset` совпадает с текущим источником элемента и файл есть в OPFS, переподключает плеер и восстанавливает состояние воспроизведения. Типы: **FileWrittenPayload**, **ReconnectPlayerOnFileLoadedIntoOpfsOptions** (ниже).

```ts
reconnectPlayerOnFileLoadedIntoOpfs(
  element: HTMLMediaElement,
  payload: FileWrittenPayload,
  folderName: FolderName,
  options?: ReconnectPlayerOnFileLoadedIntoOpfsOptions
): Promise<void>

interface FileWrittenPayload {
    asset?: string;
}

interface ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    logger?: Logger;
    debug?: boolean;  // по умолчанию false
}

interface UseReconnectPlayerOnFileLoadedIntoOpfsOptions extends ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    folderName: FolderName;
}
```

**Пример (ванильный TS):**

```ts
import {
    onOPFSBackgroundFetchFileWritten,
    reconnectPlayerOnFileLoadedIntoOpfs,
} from '@budarin/psw-plugin-opfs-serve-range/client';

const video = document.querySelector('video');
const folderName = 'video-cache';

if (video) {
    const unsubscribe = onOPFSBackgroundFetchFileWritten((event) => {
        reconnectPlayerOnFileLoadedIntoOpfs(video, event.data, folderName).catch(() => {});
    });
}
```

**Пример (React):**

```tsx
import { useRef } from 'react';
import { useReconnectPlayerOnFileLoadedIntoOpfs } from '@budarin/psw-plugin-opfs-serve-range/client/react';

function VideoPlayer() {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    useReconnectPlayerOnFileLoadedIntoOpfs(videoRef, { folderName: 'video-cache' });
    return <video ref={videoRef} src="/video/lesson-1.mp4" controls />;
}
```

---

## Формат хранения в OPFS

**Плоское хранилище (flat store, v4):** все закешированные файлы лежат в **одном каталоге** под корнем плагина. Путь: корень OPFS → **OPFS_PLUGIN_ROOT_DIR_NAME** (по умолчанию **`.opfs-serve-range`**) → один каталог (подкаталогов по folderName нет). Имя файла = ключ = `hex(SHA-256(URL))` (64 символа). Один файл на URL. **folderName** не входит в путь; он хранится в метаданных в футере файла и используется только для фильтрации (какой плагин отдаёт файл, list/clear по папке).

Структура файла: тело ресурса, затем футер (4 байта длины JSON + JSON метаданных). Метаданные: url, size, type, etag, lastModified, lastAccessed, evictable, **folderName**. Эвикция управляется **индексом только в памяти** (файла `_eviction_index.json` на диске нет); индекс при необходимости заполняется сканом каталога. **getFlatStoreDir()** возвращает этот единственный каталог; **getOpfsDir(root, create, folderName)** — обёртка совместимости, возвращает тот же каталог.

Если отдаёте файл целиком (ответ 200 без Range), отдавайте только тело, без футера: по футеру вычислите размер тела и отдайте file.slice(0, bodySize). Плагин opfsServeRange отдаёт только диапазоны тела (ответ 206), футер в ответ не входит.

---

## Свой плагин записи в OPFS

Если нужно записывать в OPFS по своей логике, но в том же формате, что и плагины пакета:

```ts
getRoot(): Promise<FileSystemDirectoryHandle>
getOpfsDir(root: FileSystemDirectoryHandle, create: boolean, folderName: string): Promise<FileSystemDirectoryHandle>
urlToOpfsKey(url: string): Promise<string>
metadataFromResponse(response: Response, url: string): OpfsMetadata
writeToOpfs(
  dir: FileSystemDirectoryHandle,
  key: string,
  bodyStream: ReadableStream<Uint8Array>,
  metadata: OpfsMetadata,
  options: WriteToOpfsOptions
): Promise<void>

interface OpfsMetadata {
    url: string;
    size: number;
    type?: string;
    etag?: string;
    lastModified?: string;
    lastAccessed?: number;
    evictable?: boolean;
}

interface WriteToOpfsOptions {
    folderName: string;
    url?: string;
    knownSize?: number;
}
```

```typescript
import {
    getRoot,
    getOpfsDir,
    urlToOpfsKey,
    writeToOpfs,
    metadataFromResponse,
} from '@budarin/psw-plugin-opfs-serve-range';

const root = await getRoot();
const dir = await getOpfsDir(root, true, 'my-cache');
const key = await urlToOpfsKey(url);
const metadata = metadataFromResponse(response, url);
await writeToOpfs(dir, key, response.body, metadata, { folderName: 'my-cache' });
```

Ответ от сервера может быть без заголовка Content-Length; при записи полного тела размер определяется путём подсчёта байт в теле. Чтобы при записи учитывались лимиты кеша (проверка места до записи, эвикция, оповещения и список отменённых), передавайте в writeToOpfs пятый аргумент options с полями url и knownSize.

---

## Требования

Браузер с поддержкой OPFS (Chrome 108+, Edge 108+, Firefox 111+, Safari 16.4+) и безопасный контекст (страница по HTTPS).

---

## Лицензия

MIT
