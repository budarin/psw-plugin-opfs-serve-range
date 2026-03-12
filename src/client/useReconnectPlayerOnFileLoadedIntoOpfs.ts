/**
 * React-хук: подписка на onOPFSBackgroundFetchFileWritten и переподключение плеера к OPFS,
 * когда загруженный файл совпадает с текущим src элемента.
 */

import { useEffect, type RefObject } from 'react';
import {
    onOPFSBackgroundFetchFileWritten,
    reconnectPlayerOnFileLoadedIntoOpfs,
    type FileWrittenPayload,
    type FolderName,
    type ReconnectPlayerOnFileLoadedIntoOpfsOptions,
} from './index.js';

export interface UseReconnectPlayerOnFileLoadedIntoOpfsOptions
    extends ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    folderName: FolderName;
}

/**
 * Подписывается на onOPFSBackgroundFetchFileWritten и переподключает плеер к OPFS,
 * когда загруженный файл совпадает с текущим src элемента.
 */
export function useReconnectPlayerOnFileLoadedIntoOpfs(
    mediaRef: RefObject<HTMLMediaElement | null>,
    options: UseReconnectPlayerOnFileLoadedIntoOpfsOptions
): void {
    const { folderName, logger = console, debug = false } = options;

    useEffect(() => {
        const el = mediaRef.current;
        if (!el) return;

        const unsubscribe = onOPFSBackgroundFetchFileWritten(
            (event: MessageEvent & { data: FileWrittenPayload }) => {
                reconnectPlayerOnFileLoadedIntoOpfs(
                    el,
                    event.data,
                    folderName,
                    { logger, debug }
                ).catch(() => {});
            }
        );

        return () => {
            unsubscribe();
        };
    }, [mediaRef, folderName, logger, debug]);
}
