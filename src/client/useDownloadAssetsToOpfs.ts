/**
 * React-хук для загрузки assets в OPFS через Background Fetch.
 * Строится на startDownloadAssetsToOpfs; при размонтировании только перестаёт обновлять состояние,
 * загрузка в фоне не отменяется. Отмена — через reset().
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
    startDownloadAssetsToOpfs,
    type StartDownloadAssetsToOpfsOptions,
    type DownloadAssetsToOpfsResult,
    type DownloadAssetsToOpfsRejected,
} from './index.js';

export type DownloadAssetsStatus = 'idle' | 'pending' | 'success' | 'failure' | 'aborted';

export interface UseDownloadAssetsToOpfsState {
    status: DownloadAssetsStatus;
    progress: { downloaded: number; total: number } | null;
    /** Прогресс по файлам: уже записанные assets и общее число. */
    fileProgress: { loadedAssets: string[]; totalCount: number } | null;
    error: Error | DownloadAssetsToOpfsRejected | null;
    data: DownloadAssetsToOpfsResult | null;
}

const THROTTLE_MS = 200;

/**
 * Хук для загрузки assets в OPFS. Возвращает startDownload и состояние (status, progress, error, data).
 * При размонтировании подписки снимаются, setState не вызывается, загрузка не отменяется.
 */
export function useDownloadAssetsToOpfs(): {
    startDownload: (options: Omit<StartDownloadAssetsToOpfsOptions, 'signal'>) => Promise<void>;
    status: DownloadAssetsStatus;
    progress: UseDownloadAssetsToOpfsState['progress'];
    fileProgress: UseDownloadAssetsToOpfsState['fileProgress'];
    error: UseDownloadAssetsToOpfsState['error'];
    data: UseDownloadAssetsToOpfsState['data'];
    reset: () => void;
} {
    const [status, setStatus] = useState<DownloadAssetsStatus>('idle');
    const [progress, setProgress] = useState<UseDownloadAssetsToOpfsState['progress']>(null);
    const [fileProgress, setFileProgress] = useState<UseDownloadAssetsToOpfsState['fileProgress']>(null);
    const [error, setError] = useState<UseDownloadAssetsToOpfsState['error']>(null);
    const [data, setData] = useState<UseDownloadAssetsToOpfsState['data']>(null);

    const mountedRef = useRef(true);
    const controllerRef = useRef<AbortController | null>(null);
    const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const setProgressThrottled = useCallback((downloaded: number, total: number) => {
        if (!mountedRef.current) return;
        if (progressTimeoutRef.current == null) {
            setProgress({ downloaded, total });
            progressTimeoutRef.current = setTimeout(() => {
                progressTimeoutRef.current = null;
            }, THROTTLE_MS);
        } else {
            const t = progressTimeoutRef.current;
            progressTimeoutRef.current = setTimeout(() => {
                if (mountedRef.current) setProgress({ downloaded, total });
                progressTimeoutRef.current = null;
            }, THROTTLE_MS);
            clearTimeout(t);
        }
    }, []);

    const reset = useCallback(() => {
        if (controllerRef.current) {
            controllerRef.current.abort();
            controllerRef.current = null;
        }
        if (progressTimeoutRef.current != null) {
            clearTimeout(progressTimeoutRef.current);
            progressTimeoutRef.current = null;
        }
        setStatus('idle');
        setProgress(null);
        setFileProgress(null);
        setError(null);
        setData(null);
    }, []);

    const startDownload = useCallback(
        async (options: Omit<StartDownloadAssetsToOpfsOptions, 'signal'>) => {
            setStatus('pending');
            setProgress(null);
            setFileProgress(null);
            setError(null);
            setData(null);

            const controller = new AbortController();
            controllerRef.current = controller;
            const cleanup = (): void => {
                controllerRef.current = null;
                if (progressTimeoutRef.current != null) {
                    clearTimeout(progressTimeoutRef.current);
                    progressTimeoutRef.current = null;
                }
            };

            try {
                const result = await startDownloadAssetsToOpfs({
                    ...options,
                    onProgress: (downloaded, total) => setProgressThrottled(downloaded, total),
                    onFileWritten: (loadedAssets, totalCount) => {
                        if (mountedRef.current) {
                            setFileProgress({ loadedAssets, totalCount });
                        }
                    },
                    signal: controller.signal,
                });
                if (mountedRef.current) {
                    setStatus('success');
                    setData(result);
                    setProgress(null);
                }
            } catch (err) {
                if (mountedRef.current) {
                    setStatus(
                        err && typeof err === 'object' && 'reason' in err && (err as { reason: string }).reason === 'abort'
                            ? 'aborted'
                            : 'failure'
                    );
                    setError(err instanceof Error ? err : (err as DownloadAssetsToOpfsRejected));
                    setProgress(null);
                }
            } finally {
                cleanup();
            }
        },
        [setProgressThrottled]
    );

    return { startDownload, status, progress, fileProgress, error, data, reset };
}
