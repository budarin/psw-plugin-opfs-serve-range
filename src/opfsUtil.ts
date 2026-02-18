/**
 * Общие утилиты: glob, папка плагина в OPFS, очистка, централизованный конфиг.
 */

import { OPFS_FOLDER_NAME } from './opfsFormat.js';

const DEFAULT_MAX_CACHE_FRACTION = 0.5;

export interface OpfsConfigOptions {
    /** Имя папки в OPFS для файлов кеша. */
    folderName?: string;
    /** Доля квоты origin (0…1), которую может занимать кеш. По умолчанию 0.5. */
    maxCacheFraction?: number;
}

let opfsConfig: OpfsConfigOptions = {};

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

/**
 * Централизованная настройка OPFS-плагинов. Вызовите один раз до регистрации плагинов.
 * Имя папки и доля квоты используются во всех плагинах и в clearOpfsCache().
 */
export function configureOpfs(options: OpfsConfigOptions = {}): void {
    opfsConfig = { ...options };
}

function getResolvedFolderName(): string {
    return opfsConfig.folderName ?? OPFS_FOLDER_NAME;
}

/** Текущая доля квоты для кеша (для внутреннего использования). */
export function getMaxCacheFraction(): number {
    const v = opfsConfig.maxCacheFraction;
    if (v === undefined || v < 0 || v > 1) {
        return DEFAULT_MAX_CACHE_FRACTION;
    }
    return v;
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
    const pathname = new URL(url, 'https://example.com').pathname;
    return getGlobRegex(pattern).test(pathname);
}

export function shouldProcessFile(
    url: string,
    include?: string[],
    exclude?: string[]
): boolean {
    if (exclude?.length) {
        for (const pattern of exclude) {
            if (matchesGlob(url, pattern)) {
                return false;
            }
        }
    }
    if (include?.length) {
        for (const pattern of include) {
            if (matchesGlob(url, pattern)) {
                return true;
            }
        }
        return false;
    }
    return true;
}

/**
 * Возвращает папку плагина в OPFS. Все файлы плагина лежат только в ней.
 * Имя папки задаётся через configureOpfs({ folderName }) или по умолчанию OPFS_FOLDER_NAME.
 *
 * @param root — корень OPFS (navigator.storage.getDirectory())
 * @param create — если true, создаёт папку при отсутствии; если false, при отсутствии будет выброшена ошибка
 */
export async function getOpfsDir(
    root: FileSystemDirectoryHandle,
    create: boolean
): Promise<FileSystemDirectoryHandle> {
    const name = getResolvedFolderName();
    return root.getDirectoryHandle(name, { create });
}

/**
 * Удаляет папку плагина в OPFS со всем содержимым. Очищает кеш «одним махом».
 * Используется имя папки из configureOpfs({ folderName }) или OPFS_FOLDER_NAME.
 */
export async function clearOpfsCache(): Promise<void> {
    const root = await getRoot();
    const name = getResolvedFolderName();
    try {
        await root.removeEntry(name, { recursive: true });
    } catch {
        // папки не было — не ошибка
    }
}
