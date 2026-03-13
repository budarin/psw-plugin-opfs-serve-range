/**
 * Опциональное логирование событий кэша (заполнение, инвалидация, эвикция).
 * Включается опцией logCacheEvents в фабриках при переданном logger.
 */

import type { Logger } from '@budarin/pluggable-serviceworker';

let cacheEventLogEnabled = false;
let cacheEventLogger: Logger | undefined;

export function setCacheEventLogging(enabled: boolean, logger?: Logger): void {
    cacheEventLogEnabled = enabled;
    cacheEventLogger = logger;
}

export function getCacheEventLogging(): { enabled: boolean; logger?: Logger } {
    return {
        enabled: cacheEventLogEnabled,
        ...(cacheEventLogger !== undefined && { logger: cacheEventLogger }),
    };
}

export function logCacheEvent(message: string): void {
    if (cacheEventLogEnabled && cacheEventLogger?.info) {
        cacheEventLogger.info(`[opfs] ${message}`);
    }
}
