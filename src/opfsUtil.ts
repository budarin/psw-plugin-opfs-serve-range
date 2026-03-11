/**
 * Общие утилиты: glob, папка плагина в OPFS, очистка, реестр папок по плагинам.
 */

import { invalidateCacheForDir } from './opfsEvictionIndex.js';
import { getRangeCache } from './opfsRangeCache.js';
import { getMetadataCache } from './opfsMetadataCache.js';

const DEFAULT_MAX_CACHE_FRACTION = 0.5;
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

/** Только для тестов: сброс реестра папок и глобального лимита. */
export function resetFolderRegistryForTests(): void {
    folderRegistry.clear();
    globalMaxCacheFraction = 0.5;
}

/** Конфиг кеша для одной папки (лимиты). При повторной регистрации того же folderName должен совпадать. */
export interface FolderCacheConfig {
    maxCacheFraction?: number;
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
function parseUrlSafe(url: string, base?: string): URL | null {
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
    const v = config.maxCacheFraction;
    const maxCacheFraction =
        v === undefined || v < 0 || v > 1 ? DEFAULT_MAX_CACHE_FRACTION : v;
    const vb = config.rangeCacheMaxSizeBytes;
    const rangeCacheMaxSizeBytes =
        vb === undefined || vb < 0 ? DEFAULT_RANGE_CACHE_MAX_SIZE_BYTES : vb;
    const ve = config.rangeCacheMaxEntries;
    const rangeCacheMaxEntries =
        ve === undefined || ve < 0 ? DEFAULT_RANGE_CACHE_MAX_ENTRIES : ve;
    return { maxCacheFraction, rangeCacheMaxSizeBytes, rangeCacheMaxEntries };
}

function configsEqual(a: Required<FolderCacheConfig>, b: Required<FolderCacheConfig>): boolean {
    return (
        a.maxCacheFraction === b.maxCacheFraction &&
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
    logger: { warn?: (message: string) => void }
): void {
    for (const s of dropped.crossOrigin) {
        logger.warn?.(`opfs: dropped cross-origin pattern (use pathnames or same-origin URLs): ${s}`);
    }
    for (const s of dropped.invalid) {
        logger.warn?.(`opfs: dropped invalid URL in include/exclude/pinned: ${s}`);
    }
    dropped.crossOrigin.length = 0;
    dropped.invalid.length = 0;
}

export function registerFolderConfig(
    folderName: string,
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
                `opfs: folder "${folderName}" is already registered with different cache settings (maxCacheFraction, rangeCacheMaxSizeBytes, or rangeCacheMaxEntries)`
            );
        }
        return;
    }
    folderRegistry.set(folderName, normalized);
}

let cachedRootPromise: Promise<FileSystemDirectoryHandle> | null = null;

/**
 * Возвращает корень OPFS с кешированием на время жизни воркера.
 * Избегает повторных вызовов navigator.storage.getDirectory() при частых запросах.
 */
export function getRoot(): Promise<FileSystemDirectoryHandle> {
    if (cachedRootPromise === null) {
        cachedRootPromise = navigator.storage.getDirectory();
    }
    return cachedRootPromise;
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

/** Доля квоты для папки. Если сумма долей всех папок > глобального лимита — возвращается пропорционально уменьшенная доля. */
export function getMaxCacheFraction(folderName: string): number {
    const c = folderRegistry.get(folderName);
    const stored = c?.maxCacheFraction ?? DEFAULT_MAX_CACHE_FRACTION;
    let sum = 0;
    for (const entry of folderRegistry.values()) {
        sum += entry.maxCacheFraction;
    }
    if (sum <= globalMaxCacheFraction) {
        return stored;
    }
    return stored * (globalMaxCacheFraction / sum);
}

/** Лимит размера in-memory кеша range-ответов для папки. */
export function getRangeCacheMaxSizeBytes(folderName: string): number {
    const c = folderRegistry.get(folderName);
    return c?.rangeCacheMaxSizeBytes ?? DEFAULT_RANGE_CACHE_MAX_SIZE_BYTES;
}

/** Лимит количества записей in-memory кеша range-ответов для папки. */
export function getRangeCacheMaxEntries(folderName: string): number {
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

export function matchesGlob(url: string, pattern: string): boolean {
    const u = parseUrlSafe(url, 'https://example.com');
    if (u === null) return false;
    return getGlobRegex(pattern).test(u.pathname);
}

/**
 * Определяет, можно ли эвиктить ресурс по pinned-паттернам.
 * URL, совпадающий с pinned, не эвиктится (evictable: false).
 */
export function isEvictable(url: string, pinned?: string[]): boolean {
    return pinned ? !shouldProcessFile(url, pinned) : true;
}

/**
 * Проверяет, нужно ли обрабатывать URL по include/exclude. Сторонние (другой origin) URL не обрабатываются.
 * В SW используется self.origin; в иных средах нужен мок self.
 */
export function shouldProcessFile(
    url: string,
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
            if (matchesGlob(url, pattern)) {
                return false;
            }
        }
    }
    if (include == null || include.length === 0) {
        return false;
    }
    for (const pattern of include) {
        if (matchesGlob(url, pattern)) {
            return true;
        }
    }
    return false;
}

/** Кеш папки по folderName, чтобы не вызывать getDirectoryHandle при каждом запросе. Сбрасывается в clearOpfsCache. */
const dirCacheByFolder = new Map<string, FileSystemDirectoryHandle>();

/**
 * Возвращает папку в OPFS по имени. Все файлы кеша для этой папки лежат только в ней.
 * Результат кешируется; при clearOpfsCache кеш для папки сбрасывается.
 *
 * @param root — корень OPFS (navigator.storage.getDirectory())
 * @param create — если true, создаёт папку при отсутствии; если false, при отсутствии будет выброшена ошибка
 * @param folderName — имя папки (обязательно, задаётся в опциях плагина)
 */
export async function getOpfsDir(
    root: FileSystemDirectoryHandle,
    create: boolean,
    folderName: string
): Promise<FileSystemDirectoryHandle> {
    const cached = dirCacheByFolder.get(folderName);
    if (cached !== undefined) {
        return cached;
    }
    const dir = await root.getDirectoryHandle(folderName, { create });
    dirCacheByFolder.set(folderName, dir);
    return dir;
}

/**
 * Удаляет папку в OPFS со всем содержимым. Сбрасывает in-memory кеш индекса эвикции и range cache для этой папки.
 *
 * @param folderName — имя папки (обязательно)
 */
export async function clearOpfsCache(folderName: string): Promise<void> {
    invalidateCacheForDir(folderName);
    getRangeCache(folderName)?.invalidateAll();
    getMetadataCache(folderName)?.invalidateAll();
    dirCacheByFolder.delete(folderName);
    const root = await getRoot();
    try {
        await root.removeEntry(folderName, { recursive: true });
    } catch {
        // папки не было — не ошибка
    }
}
