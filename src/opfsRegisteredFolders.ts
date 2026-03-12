/**
 * Плагин для @budarin/pluggable-serviceworker: на запрос OPFS_REQUEST_GET_REGISTERED_FOLDERS
 * отвечает списком папок, зарегистрированных в SW через registerFolderConfig.
 * Отдельная зона ответственности; в кастомном SW можно подключить вместе с клиентской утилитой
 * getRegisteredFolders() / startDownloadAssetsToOpfs для проверки folderName перед стартом загрузки.
 */

import type { Plugin } from '@budarin/pluggable-serviceworker';
import { getRegisteredFolderNames } from './opfsUtil.js';
import {
    OPFS_REQUEST_GET_REGISTERED_FOLDERS,
    OPFS_RESPONSE_REGISTERED_FOLDERS,
} from './opfsMessages.js';

/**
 * Плагин только для обработки message: на OPFS_REQUEST_GET_REGISTERED_FOLDERS
 * отвечает folderNames (список имён папок из реестра SW). Клиентскому getRegisteredFolders() соответствует этот плагин.
 */
export function opfsRegisteredFolders(): Plugin | undefined {
    return {
        name: 'opfs-registered-folders',
        order: 0,

        message(event): void {
            const data = event.data as { type?: string; requestId?: string } | null;
            if (
                data?.type !== OPFS_REQUEST_GET_REGISTERED_FOLDERS ||
                data.requestId == null
            ) {
                return;
            }
            const source = event.source;
            if (source == null) {
                return;
            }
            if (typeof (source as Client).postMessage === 'function') {
                (source as Client).postMessage({
                    type: OPFS_RESPONSE_REGISTERED_FOLDERS,
                    requestId: data.requestId,
                    folderNames: getRegisteredFolderNames(),
                });
            }
        },
    };
}
