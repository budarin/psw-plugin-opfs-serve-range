/**
 * Формирование идемпотентного id загрузки Background Fetch по списку assets и папке.
 * Один и тот же набор (folderName, assets) даёт один и тот же id; разные папки — разные id (нет коллизий).
 */

import { OPFS_BACKGROUND_FETCH_ID_PREFIX } from './opfsMessages.js';

const HASH_HEX_LENGTH = 32;

/** Символы, допустимые в части id для folderName; остальные заменяются на '_'. Разделитель между папкой и хешем — '-'. */
const FOLDER_SAFE_REGEX = /[^a-zA-Z0-9_]/g;

function encodeFolderForId(folderName: string): string {
    return folderName.replace(FOLDER_SAFE_REGEX, '_');
}

/**
 * Возвращает префикс id для данной папки. В SW используется, чтобы обрабатывать только загрузки своей папки.
 */
export function getOpfsBackgroundFetchIdPrefixForFolder(folderName: string): string {
    return `${OPFS_BACKGROUND_FETCH_ID_PREFIX}${encodeFolderForId(folderName)}-`;
}

/**
 * Возвращает идемпотентный id для Background Fetch: префикс + папка + '-' + hex(SHA-256(canonical)).
 * canonical = JSON.stringify([folderName, отсортированный массив assets]). Один и тот же (folderName, assets) даёт один и тот же id.
 */
export async function getOpfsBackgroundFetchId(
    assets: string[],
    folderName: string
): Promise<string> {
    const canonical = JSON.stringify([folderName, ...[...assets].sort()]);
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    let hex = '';
    const byteCount = Math.min(HASH_HEX_LENGTH / 2, hashArray.length);
    for (let i = 0; i < byteCount; i++) {
        hex += hashArray[i]!.toString(16).padStart(2, '0');
    }
    return `${getOpfsBackgroundFetchIdPrefixForFolder(folderName)}${hex}`;
}
