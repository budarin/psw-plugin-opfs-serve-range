/**
 * Вычисление ключа файла в OPFS по URL.
 * Вынесено в отдельный модуль для устранения циклических зависимостей.
 */

import type { OpfsKey, UrlString } from './types.js';

const urlToKeyCache = new Map<UrlString, OpfsKey>();

/**
 * Вычисляет ключ файла в OPFS по URL: hex(SHA-256(URL)).
 * Результат кешируется в памяти на время жизни воркера — повторные запросы по одному URL не пересчитывают хеш.
 * Плагин кеширования в OPFS должен использовать ту же функцию для записи.
 */
export async function urlToOpfsKey(url: UrlString): Promise<OpfsKey> {
    const cached = urlToKeyCache.get(url);
    if (cached !== undefined) {
        return cached;
    }
    const bytes = new TextEncoder().encode(url);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const hex = '0123456789abcdef';
    const arr = new Uint8Array(hash);
    let key = '';
    for (let i = 0; i < arr.length; i++) {
        const b = arr[i]!;
        key += hex.charAt(b >> 4) + hex.charAt(b & 0x0f);
    }
    urlToKeyCache.set(url, key);
    return key;
}
