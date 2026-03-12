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
            enableLogging: true,
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

Удобнее всего использовать высокоуровневый API: одна функция запускает загрузку. Она возвращает обещание (промис), которое выполняется, когда ресурсы записаны в OPFS, или отклоняется при ошибке или отмене пользователем.

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
  include: string[];  // обязательно, непустой массив
  exclude?: string[];
  enableLogging?: boolean;
  logger?: Logger; // по умолчанию console
  maxCacheFraction?: number;
  pinned?: string[];
  order?: number;  // по умолчанию 0 — первый плагин получает order, второй — order + 1
  rangeResponseCacheControl?: string;
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin[]
```

```ts
createOpfsServeAndNetworkCachePlugins(options: {
  folderName: string;
  include: string[];  // обязательно, непустой массив
  exclude?: string[];
  enableLogging?: boolean;
  logger?: Logger; // по умолчанию console
  maxCacheFraction?: number;
  pinned?: string[];
  order?: number;  // по умолчанию 0 — первый плагин получает order, второй — order + 1
  rangeResponseCacheControl?: string;
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number };
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin[]
```

Фабрика возвращает массив плагинов. **initServiceWorker** (pluggable-serviceworker) разворачивает вложенные массивы плагинов, поэтому результат можно передавать без спреда.

У каждого плагина в опциях обязательны **folderName: string** и **include: string[]** (непустой массив). Одна папка = один кеш. **include** и **exclude** могут быть glob-паттернами, pathname'ами или полными URL (например `['*.mp4', '/video/*']`, `['/assets/video.mp4']` или `['https://example.com/video/*']`). При инициализации полные URL приводятся к pathname (same-origin) или отбрасываются (cross-origin). Если после нормализации `include` оказался пустым (например в `include` были только cross-origin URL), фабрика возвращает `undefined` и плагин не создаётся. **Когда приходит запрос:** если URL запроса с другого origin — запрос не обрабатывается (ни отдача из кеша, ни запись). Если same-origin — по pathname URL запроса сопоставляем с (нормализованными) паттернами: например глоб `/video/*` совпадает с запросом на `https://example.com/video/1.mp4`. Плагины, которые обслуживают один и тот же кеш (например opfsServeRange + opfsBackgroundFetch или opfsServeRange + opfsRangeFromNetworkAndCache для сценария «кеш при первом запросе»), должны использовать один и тот же **folderName** и согласованные настройки (maxCacheFraction и при необходимости rangeCacheMaxSizeBytes/rangeCacheMaxEntries); иначе **registerFolderConfig** (вызывается фабриками плагинов) выбросит ошибку. Настройки по умолчанию для папки: maxCacheFraction 0.5, rangeCacheMaxSizeBytes 5 МБ, rangeCacheMaxEntries 300. Очистить кеш: **clearOpfsCache(folderName)**.

Квота хранилища общая для origin: её делят OPFS, Cache API, IndexedDB и другие хранилища. При выборе доли (maxCacheFraction) учитывайте, что остальное место может понадобиться для кеша сервис-воркера, баз данных приложения и прочего — не задавайте 1.0, если приложение использует не только этот кеш. **Глобальный лимит** ограничивает сумму эффективных долей всех папок: **getGlobalMaxCacheFraction()** (по умолчанию 0.5) и **setGlobalMaxCacheFraction(fraction)**. Если сумма долей папок превышает этот лимит, эффективные доли пропорционально уменьшаются так, чтобы сумма равнялась глобальному лимиту (без выброса ошибки).

В средах, где OPFS недоступен, фабрики плагинов возвращают undefined.

**Утилиты (SW)**

```ts
normalizePatternList(patterns: string[] | undefined, baseOrigin: string): { list: string[] | undefined; dropped: NormalizePatternListDropped }
emitDroppedPatternWarnings(dropped: NormalizePatternListDropped, logger: { warn?: (message: string) => void }): void
getRoot(): Promise<FileSystemDirectoryHandle>
getOpfsDir(root: FileSystemDirectoryHandle, create: boolean, folderName: string): Promise<FileSystemDirectoryHandle>
clearOpfsCache(folderName: string): Promise<void>
registerFolderConfig(folderName: string, config?: FolderCacheConfig): void
getGlobalMaxCacheFraction(): number
setGlobalMaxCacheFraction(fraction: number): void
getMaxCacheFraction(folderName: string): number
getRangeCacheMaxSizeBytes(folderName: string): number
getRangeCacheMaxEntries(folderName: string): number
```

При инициализации полные URL приводятся к pathname; cross-origin и невалидные попадают в `dropped`. Фабрики плагинов выводят предупреждения через logger (по умолчанию console). **getGlobalMaxCacheFraction** по умолчанию 0.5; **setGlobalMaxCacheFraction** ожидает (0, 1], при неверном значении — throw.

**FolderCacheConfig** (для `registerFolderConfig`):

```ts
interface FolderCacheConfig {
    maxCacheFraction?: number;
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}
```

| Плагин                           | Назначение                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **opfsServeRange**               | Читает файлы из OPFS и отдаёт запрошенные диапазоны байтов (206).                                                                                                                                                                                                                                                                                                                                       |
| **opfsRangeFromNetworkAndCache** | Обрабатывает запросы, которые opfsServeRange не отдал из кеша: загружает данные из сети, сразу отдаёт ответ клиенту и при возможности сохраняет файл в OPFS в фоне. Такая загрузка прерывается при закрытии вкладки или обрыве сети.                                                                                                                                                                    |
| **opfsBackgroundFetch**          | При успешном завершении Background Fetch записывает загруженные ответы в OPFS; последующие запросы по диапазону байтов к этим адресам обслуживает opfsServeRange. Учитываются только загрузки с идентификатором, начинающимся с **OPFS_BACKGROUND_FETCH_ID_PREFIX** (`opfs-ranges-`). В обработчике сообщений от страницы вызывает плагин ответа на запрос фильтра (см. **opfsBackgroundFetchFilter**). |
| **opfsBackgroundFetchFilter**    | Обрабатывает только сообщения от страницы: на запрос фильтра (тип OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER) отвечает текущими значениями include и exclude. Эту пару на стороне клиента вызывает **getBackgroundFetchFilter()**. Плагин можно регистрировать отдельно в кастомном сервис-воркере со своими include и exclude.                                                                           |

**opfsServeRange**

```ts
opfsServeRange(options: {
  folderName: string;  // обязательно
  order?: number;
  include: string[];  // обязательно, непустой; если после нормализации список пуст — возвращает undefined
  exclude?: string[];
  enableLogging?: boolean;
  logger?: Logger; // по умолчанию console
  rangeResponseCacheControl?: string; // по умолчанию '' (не кэшировать диапазоны в HTTP-кеше браузера)
  rangeCache?: true | { maxSizeBytes?: number; maxEntries?: number }; // in-memory кеш 206-ответов; лимиты из конфига папки, если не заданы
  maxCacheFraction?: number;
  rangeCacheMaxSizeBytes?: number;
  rangeCacheMaxEntries?: number;
}): Plugin | undefined
```

**opfsRangeFromNetworkAndCache**

```ts
opfsRangeFromNetworkAndCache(options: {
  folderName: string;  // обязательно
  order?: number;
  include: string[];  // обязательно, непустой; если после нормализации список пуст — возвращает undefined
  exclude?: string[];
  enableLogging?: boolean;
  logger?: Logger; // по умолчанию console
  pinned?: string[];
  maxCacheFraction?: number;
}): Plugin | undefined
```

**opfsBackgroundFetch**

```ts
opfsBackgroundFetch(options: {
  folderName: string;  // обязательно
  order?: number;
  include: string[];  // обязательно, непустой; если после нормализации список пуст — возвращает undefined
  exclude?: string[];
  enableLogging?: boolean;
  logger?: Logger; // по умолчанию console
  pinned?: string[];
  maxCacheFraction?: number;
}): Plugin | undefined
```

**opfsBackgroundFetchFilter**

Плагин отвечает на запрос фильтра, который со стороны клиента отправляет **getBackgroundFetchFilter()**. При использовании полного стека регистрировать его отдельно не нужно: opfsBackgroundFetch сам вызывает этот плагин. В кастомном сервис-воркере зарегистрируйте opfsBackgroundFetchFilter с теми же include и exclude, что и ваша логика загрузки. Фильтр так же нормализует include/exclude (полные URL → pathname или отбрасываются); клиент получает pathname/глобы. Возвращает **undefined**, если после нормализации include пуст (например только cross-origin URL), плагин не создаётся.

```ts
opfsBackgroundFetchFilter(options: {
  include: string[];  // обязательно, непустой; если все паттерны нормализуются в пустой список — возвращает undefined
  exclude?: string[];
  logger?: Logger; // по умолчанию console
}): Plugin | undefined
```

Закреплённые ресурсы (опция pinned): массив масок (glob) по адресам. Ресурсы, подходящие под эти маски, не вытесняются при нехватке места (LRU). Поддерживается обоими плагинами, которые пишут в OPFS: opfsRangeFromNetworkAndCache и opfsBackgroundFetch.

---

## Справочник: клиентский API

Entry point: `@budarin/psw-plugin-opfs-serve-range/client`. React-хук: `@budarin/psw-plugin-opfs-serve-range/client/react`.

### Загрузка assets в OPFS

**Условие:** в SW должен быть зарегистрирован плагин, отвечающий на запрос фильтра — либо **opfsBackgroundFetch** (он внутри вызывает плагин ответа по фильтру), либо отдельно **opfsBackgroundFetchFilter** (для кастомного SW). Иначе `startDownloadAssetsToOpfs` не получит фильтр и загрузка может быть некорректной.

**getBackgroundFetchFilter()**

```ts
getBackgroundFetchFilter(): Promise<{ include?: string[]; exclude?: string[] }>
```

Резолвится фильтром от SW (opfsBackgroundFetchFilter или opfsBackgroundFetch). Пустой объект при таймауте или отсутствии ответа от SW.

**filterAssetsForOpfs(assets, include?, exclude?)**

```ts
filterAssetsForOpfs(
  assets: string[],  // pathname'ы, напр. '/video/1.mp4'
  include?: string[],
  exclude?: string[]
): string[]
```

**startDownloadAssetsToOpfs(options)**

**Логика перед запуском:** из списка assets (после фильтра include/exclude) сначала исключаются те, что уже качаются в других активных Background Fetch (pathname берутся из matchAll() по каждой активной регистрации с префиксом `opfs-ranges-`). Затем исключаются те, что уже есть в OPFS (один вызов **listOpfsCachedResources(folderName)**). Порядок такой специально: сначала «в процессе», потом «уже в кеше» — чтобы не пропустить только что завершившуюся загрузку. В загрузку уходит только то, что осталось. Если ничего не осталось, промис сразу выполняется с `written: assetsToUse` (ничего не качаем). Идентификатор загрузки считается по набору pathname'ов идемпотентно (getOpfsBackgroundFetchId). Если с тем же набором загрузка уже идёт, новый вызов не создаёт вторую, а подписывается на уже идущую (attach); промис выполнится при её завершении.

```ts
interface StartDownloadAssetsToOpfsOptions {
    /** Имя папки в OPFS (обязательно). Должно совпадать с folderName в opfsBackgroundFetch. */
    folderName: string;
    /** Pathname'ы ресурсов для загрузки. Фильтруются по include/exclude со стороны SW. */
    assets: string[];
    /** Заголовок для системного UI Background Fetch (например, уведомление на Android). */
    title?: string;
    /** Суммарный размер загрузки в байтах (всех assets). Опционально; только для прогресса (onProgress и системный UI показывают «X из Y» или %). */
    totalDownloadSizeInBytes?: number;
    /** Колбек прогресса: (скачано байт, всего байт). Вызывается при каждом progress Background Fetch. */
    onProgress?: (downloaded: number, total: number) => void;
    /** Колбек после записи каждого файла в OPFS: (уже записанные pathname'ы, общее число файлов). */
    onFileWritten?: (loadedAssets: string[], totalCount: number) => void;
    /** AbortSignal для отмены. При abort промис отклоняется с reason: 'abort'. */
    signal?: AbortSignal;
}
startDownloadAssetsToOpfs(options): Promise<DownloadAssetsToOpfsResult>
```

Тип результата **DownloadAssetsToOpfsResult**:

```ts
interface DownloadAssetsToOpfsResult {
    registrationId: string;
    assets?: string[];
    written?: string[];
    failedOrSkipped?: string[];
    filteredOut?: string[];
}
```

При reject: **DownloadAssetsToOpfsRejected** `{ registrationId: string; reason: 'fail' | 'abort' }` или **Error**.

- **useDownloadAssetsToOpfs()** — React-хук. Возвращает функцию запуска загрузки, статус, прогресс по байтам и по файлам, ошибку, результат и функцию сброса. При размонтировании загрузка не отменяется; отменить можно только вызовом reset(). При повторном нажатии «Скачать» с тем же набором файлов происходит подписка на уже идущую загрузку (attach), дубликат не создаётся. Требуется установленный React (peer dependency).

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

### Низкоуровневый API (без startDownloadAssetsToOpfs и хука)

Если вы не используете startDownloadAssetsToOpfs или хук и собираете сценарий вручную, понадобятся две вещи. Во-первых, функции запуска загрузки и проверки поддержки: **startBackgroundFetch** и **isBackgroundFetchSupported** из пакета pluggable-serviceworker (клиентский подмодуль `client/background-fetch`). Во-вторых, подписка на сообщения от сервис-воркера — об успешном завершении загрузки, об ошибке, об отмене и о записи каждого файла в OPFS; соответствующие функции подписки (**onOPFSBackgroundFetchCompleted**, **onOPFSBackgroundFetchFailed**, **onOPFSBackgroundFetchAborted**, **onOPFSBackgroundFetchFileWritten**) экспортируются из этого пакета. Идентификатор загрузки обязан быть сформирован при помощи **getOpfsBackgroundFetchId(assets)**. Такой id нужен плагину в сервис-воркере, чтобы корректно связывать загрузку с набором ресурсов.

### Подписки на сообщения от сервис-воркера

Каждая функция принимает обработчик и возвращает функцию для отписки. В каком случае сервис-воркер отправляет то или иное сообщение, описано в [описании поведения кеша](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md).

```ts
onOPFSQuotaExceeded(handler): () => void
onOPFSWriteSkipped(handler): () => void
onOPFSCacheLimitReached(handler): () => void
onOPFSEvictionCompleted(handler): () => void
onOPFSWriteFailed(handler): () => void
onOPFSSkipQuotaExceeded(handler): () => void
onOPFSBackgroundFetchFailed(handler): () => void
onOPFSBackgroundFetchAborted(handler): () => void
onOPFSBackgroundFetchCompleted(handler): () => void
onOPFSBackgroundFetchFileWritten(handler): () => void
onOPFSRangeCacheFetchStarted(handler): () => void
onOPFSRangeCacheFetchAllDone(handler): () => void
```

Каждая функция принимает обработчик и возвращает функцию отписки. Тип handler и payload (экспортируются из пакета):

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

Какие поля есть в `event.data`, зависит от типа сообщения (см. список ниже и [описание поведения кеша](https://github.com/budarin/psw-plugin-opfs-serve-range/blob/master/docs/opfs-cache-behavior.ru.md)).

**Список отменённых (skip list):** при потоковой записи в OPFS может произойти превышение квоты (QuotaExceeded). Если к моменту ошибки файл оказался не меньше всего кеша, вытеснять старые файлы бесполезно — места всё равно не хватит. Такой URL заносят в список отменённых (в памяти сервис-воркера на время его жизни). При следующих запросах к этому адресу плагин не пытается кешировать ответ и отправляет **onOPFSSkipQuotaExceeded**, чтобы клиент мог показать предупреждение.

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

Типы данных и константы типов сообщений экспортируются из пакета (OpfsMessagePayload, константы OPFS*MSG*\*, OPFS_REQUEST_GET_BACKGROUND_FETCH_FILTER, OPFS_RESPONSE_BACKGROUND_FETCH_FILTER).

### Утилиты кэша

Эти функции вызываются на странице (в клиентском коде). **folderName** должен совпадать с именем папки при регистрации плагинов. Очистить кеш: **clearOpfsCache(folderName)** (из сервис-воркера или со страницы).

**listOpfsCachedResources(folderName)**

```ts
listOpfsCachedResources(folderName: string): Promise<OpfsCachedResource[]>
```

**OpfsCachedResource** (экспортируется из пакета):

```ts
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

**deleteFromOpfsCache(url, folderName)**

```ts
deleteFromOpfsCache(url: string, folderName: string): Promise<void>
```

---

## Формат хранения в OPFS

Раздел для тех, кто пишет свой плагин или читает файлы из OPFS напрямую. Имя файла в OPFS — 64 символа (hex от SHA-256 от URL). В файле сначала идёт тело ресурса, в конце — футер: метаданные в JSON и 4 байта длины. В метаданных хранятся url, size, type, etag, lastModified, lastAccessed, evictable. Все плагины пакета используют этот формат и общую функцию urlToOpfsKey.

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
```

**OpfsMetadata** (возвращается из `metadataFromResponse`; `size` — из Content-Length или 0):

```ts
interface OpfsMetadata {
    url: string;
    size: number;
    type?: string;
    etag?: string;
    lastModified?: string;
    lastAccessed?: number;
    evictable?: boolean;
}
```

**WriteToOpfsOptions** (пятый аргумент `writeToOpfs`; нужен для лимитов кеша, эвикции и skip list):

```ts
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
