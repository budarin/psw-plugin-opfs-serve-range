/**
 * Общие утилиты: glob, папка плагина в OPFS, очистка, реестр папок по плагинам.
 */

import type { Logger } from '@budarin/pluggable-serviceworker';
import type { FolderName, OpfsKey, UrlString } from './types.js';
import { readMetadataFromFileFooter } from './opfsFormat.js';
import {
    invalidateCacheForDir,
    removeFromEvictionIndex,
} from './opfsEvictionIndex.js';
import { getRangeCache } from './opfsRangeCache.js';
import { getMetadataCache } from './opfsMetadataCache.js';
import { OPFS_RANGE_LOG_SW } from './opfsLog.js';
import { logCacheEvent } from './opfsCacheEventLog.js';

const DEFAULT_RANGE_CACHE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RANGE_CACHE_MAX_ENTRIES = 300;

/** Глобальный лимит: сумма долей всех папок не должна превышать это значение (по умолчанию 0.5). */
let globalMaxCacheFraction = 0.5;

export function getGlobalMaxCacheFraction(): number {
    return globalMaxCacheFraction;
}

export function setGlobalMaxCacheFraction(fraction: number): void {
    if (typeof fraction !== 'number' || fraction <= 0 || fraction > 1) {
        throw new Error('opfs: globalMaxCacheFraction must be a number in (0, 1]');
    }
    globalMaxCacheFraction = fraction;
}

/** Только для тестов: сброс реестра папок, глобального лимита и кеша корня плагина. */
export function resetFolderRegistryForTests(): void {
    folderRegistry.clear();
    globalMaxCacheFraction = 0.5;
    cachedRootPromise = null;
    cachedPluginRootPromise = null;
}

/** Конфиг кеша для одной папки (лимиты). При повторной регистрации того же folderName должен совпадать. */
export interface FolderCacheConfig {
    rangeCacheMaxSizeBytes?: number;
    rangeCacheMaxEntries?: number;
}

export interface OpfsConfigOptions {
    /** Доля квоты origin (0…1), которую может занимать кеш. По умолчанию 0.5. */
    maxCacheFraction?: number;
    /** Макс. суммарный размер in-memory кеша range-ответов (байты). */
    rangeCacheMaxSizeBytes?: number;
    /** Макс. количество записей в in-memory кеше range-ответов. */
    rangeCacheMaxEntries?: number;
}

const folderRegistry = new Map<string, Required<FolderCacheConfig>>();

/**
 * Разбор URL без throw: возвращает URL или null. При наличии URL.parse использует его, иначе try/catch с new URL.
 * Позволяет потом упростить код, убрав try/catch при переходе на среды с URL.parse (MDN: Newly available).
 */
function parseUrlSafe(url: UrlString, base?: string): URL | null {
    const parse = (URL as { parse?: (url: string, base?: string) => URL | null }).parse;
    if (typeof parse === 'function') {
        return base !== undefined ? parse(url, base) : parse(url);
    }
    try {
        return base !== undefined ? new URL(url, base) : new URL(url);
    } catch {
        return null;
    }
}

function normalizeFolderConfig(config: FolderCacheConfig = {}): Required<FolderCacheConfig> {
    const vb = config.rangeCacheMaxSizeBytes;
    const rangeCacheMaxSizeBytes =
        vb === undefined || vb < 0 ? DEFAULT_RANGE_CACHE_MAX_SIZE_BYTES : vb;
    const ve = config.rangeCacheMaxEntries;
    const rangeCacheMaxEntries =
        ve === undefined || ve < 0 ? DEFAULT_RANGE_CACHE_MAX_ENTRIES : ve;
    return { rangeCacheMaxSizeBytes, rangeCacheMaxEntries };
}

function configsEqual(a: Required<FolderCacheConfig>, b: Required<FolderCacheConfig>): boolean {
    return (
        a.rangeCacheMaxSizeBytes === b.rangeCacheMaxSizeBytes &&
        a.rangeCacheMaxEntries === b.rangeCacheMaxEntries
    );
}

/**
 * Регистрирует конфиг папки. Вызывается фабриками плагинов при создании.
 * Если папка уже зарегистрирована с другим конфигом — throw.
 * Эффективная доля квоты (для getMaxCacheFraction) при сумме долей выше глобального лимита
 * считается пропорционально: сумма эффективных долей = глобальный лимит.
 */
export interface NormalizePatternListDropped {
    crossOrigin: string[];
    invalid: string[];
}

/**
 * При инициализации приводит элементы include/exclude/pinned к pathname и отбрасывает сторонние (другой origin).
 * Полные URL с тем же origin заменяются на pathname; с другим origin — в dropped.crossOrigin; невалидные URL — в dropped.invalid.
 * Варнинги по dropped нужно вывести через context.logger при первом вызове обработчика плагина (контракт плагина).
 */
export function normalizePatternList(
    patterns: string[] | undefined,
    baseOrigin: string
): { list: string[] | undefined; dropped: NormalizePatternListDropped } {
    const dropped: NormalizePatternListDropped = { crossOrigin: [], invalid: [] };
    if (patterns == null || patterns.length === 0) return { list: patterns, dropped };
    if (!baseOrigin) return { list: patterns, dropped };
    const result: string[] = [];
    for (const p of patterns) {
        const s = p.trim();
        if (!s) continue;
        if (s.includes('://')) {
            const u = parseUrlSafe(s);
            if (u === null) {
                dropped.invalid.push(s);
                continue;
            }
            if (u.origin !== baseOrigin) {
                dropped.crossOrigin.push(s);
                continue;
            }
            result.push(u.pathname || '/');
        } else {
            result.push(s);
        }
    }
    return { list: result, dropped };
}

/** Выводит предупреждения по отброшенным паттернам через logger контракта плагина. Очищает dropped после вывода. */
export function emitDroppedPatternWarnings(
    dropped: NormalizePatternListDropped,
    logger: Logger
): void {
    for (const s of dropped.crossOrigin) {
        logger.warn(`${OPFS_RANGE_LOG_SW}dropped cross-origin pattern (use pathnames or same-origin URLs): ${s}`);
    }
    for (const s of dropped.invalid) {
        logger.warn(`${OPFS_RANGE_LOG_SW}dropped invalid URL in include/exclude/pinned: ${s}`);
    }
    dropped.crossOrigin.length = 0;
    dropped.invalid.length = 0;
}

export function registerFolderConfig(
    folderName: FolderName,
    config: FolderCacheConfig = {}
): void {
    if (typeof folderName !== 'string' || folderName.trim() === '') {
        throw new Error('opfs: folderName is required and must be a non-empty string');
    }
    const normalized = normalizeFolderConfig(config);
    const existing = folderRegistry.get(folderName);
    if (existing !== undefined) {
        if (!configsEqual(existing, normalized)) {
            throw new Error(
                `opfs: folder "${folderName}" is already registered with different cache settings (rangeCacheMaxSizeBytes or rangeCacheMaxEntries)`
            );
        }
        return;
    }
    folderRegistry.set(folderName, normalized);
}

/**
 * Возвращает имена папок, зарегистрированных в SW через registerFolderConfig.
 * Используется плагином opfsRegisteredFolders для ответа клиенту на запрос списка папок.
 */
export function getRegisteredFolderNames(): FolderName[] {
    return Array.from(folderRegistry.keys());
}

let cachedRootPromise: Promise<FileSystemDirectoryHandle> | null = null;

/**
 * Имя корневой папки плагина в OPFS. Все кеши плагина лежат внутри неё, чтобы не смешиваться
 * с папками других приложений в корне OPFS. Точка в начале — признак служебной папки.
 */
export const OPFS_PLUGIN_ROOT_DIR_NAME = '.opfs-serve-range';

let cachedPluginRootPromise: Promise<FileSystemDirectoryHandle> | null = null;

/**
 * Возвращает корень OPFS с кешированием на время жизни воркера.
 * Избегает повторных вызовов navigator.storage.getDirectory() при частых запросах.
 */
export function getRoot(): Promise<FileSystemDirectoryHandle> {
    if (cachedRootPromise === null) {
        const p = navigator.storage.getDirectory();
        p.catch(() => {
            cachedRootPromise = null;
        });
        cachedRootPromise = p;
    }
    return cachedRootPromise;
}

/**
 * Возвращает корневую папку плагина в OPFS (OPFS_PLUGIN_ROOT_DIR_NAME). Создаётся при отсутствии.
 * Кешируется на время жизни воркера. Все файлы хранятся в ней плоским списком (один каталог).
 */
export async function getPluginRoot(): Promise<FileSystemDirectoryHandle> {
    if (cachedPluginRootPromise === null) {
        const root = await getRoot();
        const p = root.getDirectoryHandle(OPFS_PLUGIN_ROOT_DIR_NAME, {
            create: true,
        });
        p.catch(() => {
            cachedPluginRootPromise = null;
        });
        cachedPluginRootPromise = p;
    }
    return cachedPluginRootPromise;
}

/** Возвращает единственный каталог плоского хранилища (все файлы по ключу). Совпадает с getPluginRoot(). */
export async function getFlatStoreDir(): Promise<FileSystemDirectoryHandle> {
    return getPluginRoot();
}

/**
 * Синхронная проверка доступности OPFS (navigator.storage.getDirectory).
 * В средах без OPFS фабрики плагинов могут возвращать undefined.
 */
export function isOpfsAvailable(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        navigator?.storage != null &&
        typeof navigator.storage.getDirectory === 'function'
    );
}

/** Глобальная доля квоты origin (0…1), которую может занимать кеш. Задаётся через setGlobalMaxCacheFraction. */
export function getMaxCacheFraction(): number {
    return globalMaxCacheFraction;
}

/** Лимит размера in-memory кеша range-ответов для папки. */
export function getRangeCacheMaxSizeBytes(folderName: FolderName): number {
    const c = folderRegistry.get(folderName);
    return c?.rangeCacheMaxSizeBytes ?? DEFAULT_RANGE_CACHE_MAX_SIZE_BYTES;
}

/** Лимит количества записей in-memory кеша range-ответов для папки. */
export function getRangeCacheMaxEntries(folderName: FolderName): number {
    const c = folderRegistry.get(folderName);
    return c?.rangeCacheMaxEntries ?? DEFAULT_RANGE_CACHE_MAX_ENTRIES;
}

const globRegexCache = new Map<string, RegExp>();
const GLOB_CACHE_MAX = 64;

function getGlobRegex(pattern: string): RegExp {
    let regex = globRegexCache.get(pattern);
    if (regex === undefined) {
        if (globRegexCache.size >= GLOB_CACHE_MAX) {
            const firstKey = globRegexCache.keys().next().value;
            if (firstKey !== undefined) globRegexCache.delete(firstKey);
        }
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        regex = new RegExp(`^${regexPattern}$`);
        globRegexCache.set(pattern, regex);
    }
    return regex;
}

export function matchesGlob(url: UrlString, pattern: string, base?: string): boolean {
    const u = base ? parseUrlSafe(url, base) : parseUrlSafe(url);
    if (u === null) return false;
    return getGlobRegex(pattern).test(u.pathname);
}

/**
 * Определяет, можно ли эвиктить ресурс по pinned-паттернам.
 * URL, совпадающий с pinned, не эвиктится (evictable: false).
 */
export function isEvictable(url: UrlString, pinned?: string[]): boolean {
    return pinned ? !shouldProcessFile(url, pinned) : true;
}

/**
 * Проверяет, нужно ли обрабатывать URL по include/exclude. Сторонние (другой origin) URL не обрабатываются.
 * В SW используется self.origin; в иных средах нужен мок self.
 */
export function shouldProcessFile(
    url: UrlString,
    include?: string[],
    exclude?: string[]
): boolean {
    const origin = typeof self !== 'undefined' ? self.origin : '';
    if (origin) {
        const u = parseUrlSafe(url, origin);
        if (u === null || u.origin !== origin) {
            return false;
        }
    }
    if (exclude?.length) {
        for (const pattern of exclude) {
            if (matchesGlob(url, pattern, origin)) {
                return false;
            }
        }
    }
    if (include == null || include.length === 0) {
        return false;
    }
    for (const pattern of include) {
        if (matchesGlob(url, pattern, origin)) {
            return true;
        }
    }
    return false;
}

/**
 * Сбрасывает кеш корневой папки плагина и инвалидирует in-memory кэши для всех зарегистрированных папок.
 * Вызывать при ошибке доступа к папке под плагин-корнем (уровень «корневая папка»).
 */
export function invalidateAllCachesAndPluginRoot(): void {
    cachedRootPromise = null;
    cachedPluginRootPromise = null;
    for (const fn of getRegisteredFolderNames()) {
        invalidateAllCachesForFolder(fn);
    }
}

/**
 * Возвращает каталог плоского хранилища (все файлы в одном каталоге по ключу).
 * Параметры _root, create, folderName сохранены для совместимости API; фактически возвращается getFlatStoreDir().
 */
export async function getOpfsDir(
    _root: FileSystemDirectoryHandle,
    _create: boolean,
    _folderName: FolderName
): Promise<FileSystemDirectoryHandle> {
    return getFlatStoreDir();
}

/**
 * Инвалидирует кэши по одному ключу (metadata, range, eviction index).
 * При ошибке (например папка удалена и dir невалиден) эскалирует в полную инвалидацию папки.
 * Вызывать при файловой ошибке чтения (getFileHandle/getFile/футер), чтобы не отдавать устаревшие данные.
 */
export async function invalidateCachesForFileKeyOnError(
    dir: FileSystemDirectoryHandle,
    folderName: FolderName,
    key: OpfsKey
): Promise<void> {
    try {
        await removeFromEvictionIndex(dir, [key], getRegisteredFolderNames());
    } catch {
        invalidateAllCachesForFolder(folderName);
    }
}

/**
 * Сбрасывает все in-memory кэши для папки (индекс эвикции, metadata, range, хэндл директории).
 * Вызывать после ручного удаления папки в OPFS или при NotFoundError из-за рассинхрона.
 */
export function invalidateAllCachesForFolder(folderName: FolderName): void {
    invalidateCacheForDir(folderName);
    getRangeCache(folderName)?.invalidateAll();
    getMetadataCache()?.invalidateEntriesByFolder(folderName);
}

/**
 * Удаляет с диска все файлы, у которых в метаданных указан данный folderName.
 * Сбрасывает in-memory кэши для этой папки.
 *
 * @param folderName — логическая папка (обязательно)
 */
export async function clearOpfsCache(folderName: FolderName): Promise<void> {
    const dir = await getFlatStoreDir();
    const toDelete: string[] = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        try {
            const file = await (handle as FileSystemFileHandle).getFile();
            const { metadata } = await readMetadataFromFileFooter(file);
            if (metadata?.folderName === folderName) {
                toDelete.push(name);
            }
        } catch {
            // пропустить битый файл
        }
    }
    for (const name of toDelete) {
        try {
            await dir.removeEntry(name);
        } catch {
            // уже удалён или ошибка — пропустить
        }
    }
    logCacheEvent(`cache cleared for folder: ${folderName}, ${toDelete.length} files removed`);
    invalidateAllCachesForFolder(folderName);
}
