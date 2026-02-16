/**
 * Общие утилиты: glob, папка плагина в OPFS, очистка, централизованный конфиг.
 */

import { OPFS_FOLDER_NAME } from './opfsFormat.js';

let opfsConfig: { folderName?: string } = {};

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
 * Имя папки используется во всех плагинах и в clearOpfsCache(), если не передано явно.
 */
export function configureOpfs(options: { folderName?: string }): void {
    opfsConfig = { ...options };
}

function getResolvedFolderName(): string {
    return opfsConfig.folderName ?? OPFS_FOLDER_NAME;
}

export function matchesGlob(url: string, pattern: string): boolean {
    const pathname = new URL(url, 'https://example.com').pathname;
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(pathname);
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
    const root = await navigator.storage.getDirectory();
    const name = getResolvedFolderName();
    try {
        await root.removeEntry(name, { recursive: true });
    } catch {
        // папки не было — не ошибка
    }
}
