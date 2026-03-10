/**
 * Утилита для формирования идемпотентного id загрузки Background Fetch по списку assets.
 * Один и тот же набор URL даёт один и тот же id — при повторном старте той же загрузки
 * можно определить, что она уже идёт, и подписаться на её завершение.
 */

import { OPFS_BACKGROUND_FETCH_ID_PREFIX } from '../opfsMessages.js';

const HASH_HEX_LENGTH = 32;

/**
 * Возвращает идемпотентный id для Background Fetch: префикс + hex(SHA-256(canonical)).
 * canonical = JSON.stringify(отсортированный массив assets).
 * Один и тот же набор assets даёт один и тот же id.
 */
export async function getOpfsBackgroundFetchId(assets: string[]): Promise<string> {
    const canonical = JSON.stringify([...assets].sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    let hex = '';
    const byteCount = Math.min(HASH_HEX_LENGTH / 2, hashArray.length);
    for (let i = 0; i < byteCount; i++) {
        hex += hashArray[i]!.toString(16).padStart(2, '0');
    }
    return `${OPFS_BACKGROUND_FETCH_ID_PREFIX}${hex}`;
}
