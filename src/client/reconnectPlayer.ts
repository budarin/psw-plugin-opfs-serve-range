/**
 * Переподключение медиа-элемента к тому же URL из OPFS после записи файла (Background Fetch).
 */

import type { Logger } from '@budarin/pluggable-serviceworker';
import type { FolderName, Pathname, UrlString } from '../types.js';
import { OPFS_RANGE_LOG_CLIENT } from '../opfsLog.js';
import { hasInOpfsCache } from './cacheControl.js';

interface PlayerState {
    currentTime: number;
    paused: boolean;
    playbackRate: number;
    volume: number;
    muted: boolean;
}

function hasExplicitDimensions(el: HTMLVideoElement): boolean {
    return (
        el.hasAttribute('width') ||
        el.hasAttribute('height') ||
        (el.style.width !== '' && el.style.width !== undefined) ||
        (el.style.height !== '' && el.style.height !== undefined)
    );
}

async function reconnectMediaElementToCurrentSrcFromOpfs(
    element: HTMLMediaElement
): Promise<void> {
    const url = element.currentSrc || element.src;
    if (!url) return;

    const state: PlayerState = {
        currentTime: element.currentTime,
        paused: element.paused,
        playbackRate: element.playbackRate,
        volume: element.volume,
        muted: element.muted,
    };

    const isVideo = element instanceof HTMLVideoElement;
    let weAddedDimensions = false;
    let wrapper: HTMLDivElement | null = null;
    let overlay: HTMLCanvasElement | null = null;
    let savedVideoWidth = '';
    let savedVideoHeight = '';
    let savedVideoMaxWidth = '';
    let savedVideoMaxHeight = '';
    let savedVideoPosition = '';
    let savedVideoTop = '';
    let savedVideoLeft = '';
    let savedVideoZIndex = '';

    if (isVideo) {
        const video = element as HTMLVideoElement;
        if (!hasExplicitDimensions(video)) {
            const w = video.offsetWidth;
            const h = video.offsetHeight;
            Object.assign(video.style, { width: `${w}px`, height: `${h}px` });
            weAddedDimensions = true;
        }

        const parent = video.parentNode;
        if (parent) {
            const nextSibling = video.nextSibling;
            const computed = getComputedStyle(video);
            const wrapW = video.offsetWidth;
            const wrapH = video.offsetHeight;
            savedVideoWidth = video.style.width;
            savedVideoHeight = video.style.height;
            savedVideoMaxWidth = video.style.maxWidth;
            savedVideoMaxHeight = video.style.maxHeight;
            savedVideoPosition = video.style.position;
            savedVideoTop = video.style.top;
            savedVideoLeft = video.style.left;
            savedVideoZIndex = video.style.zIndex;
            wrapper = document.createElement('div');
            const wrapperDisplay =
                computed.display === 'inline' ? 'inline-block' : computed.display;
            wrapper.style.setProperty('position', 'relative', 'important');
            Object.assign(wrapper.style, {
                width: `${wrapW}px`,
                height: `${wrapH}px`,
                display: wrapperDisplay,
                overflow: 'hidden',
                isolation: 'isolate',
                boxSizing: computed.boxSizing,
                marginTop: computed.marginTop,
                marginRight: computed.marginRight,
                marginBottom: computed.marginBottom,
                marginLeft: computed.marginLeft,
                verticalAlign: computed.verticalAlign,
            });
            parent.removeChild(video);
            wrapper.appendChild(video);
            parent.insertBefore(wrapper, nextSibling);
            Object.assign(video.style, {
                position: 'absolute',
                top: '0',
                left: '0',
                zIndex: '0',
                width: `${wrapW}px`,
                height: `${wrapH}px`,
                maxWidth: 'none',
                maxHeight: 'none',
            });

            if (video.videoWidth > 0 && video.videoHeight > 0) {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(
                        video as unknown as CanvasImageSource,
                        0,
                        0
                    );
                    canvas.style.setProperty('position', 'absolute', 'important');
                    canvas.style.setProperty('top', '0', 'important');
                    canvas.style.setProperty('left', '0', 'important');
                    canvas.style.setProperty('width', `${wrapW}px`, 'important');
                    canvas.style.setProperty('height', `${wrapH}px`, 'important');
                    canvas.style.setProperty('z-index', '1', 'important');
                    canvas.style.pointerEvents = 'none';
                    wrapper.insertBefore(canvas, wrapper.firstChild);
                    overlay = canvas;
                }
            }
        }
    }

    const cleanup = (): void => {
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
            overlay = null;
        }
        if (wrapper && wrapper.parentNode && element.parentNode === wrapper) {
            const parent = wrapper.parentNode;
            const nextSibling = wrapper.nextSibling;
            parent.removeChild(wrapper);
            parent.insertBefore(element, nextSibling);
            wrapper = null;
        }
        if (isVideo) {
            const video = element as HTMLVideoElement;
            if (weAddedDimensions) {
                Object.assign(video.style, { width: '', height: '' });
            } else {
                Object.assign(video.style, {
                    width: savedVideoWidth,
                    height: savedVideoHeight,
                    maxWidth: savedVideoMaxWidth,
                    maxHeight: savedVideoMaxHeight,
                    position: savedVideoPosition,
                    top: savedVideoTop,
                    left: savedVideoLeft,
                    zIndex: savedVideoZIndex,
                });
            }
        }
    };

    element.src = url;
    element.load();

    await new Promise<void>((resolve, reject) => {
        const done = (): void => {
            cleanup();
            resolve();
        };

        const onCanPlay = (): void => {
            element.removeEventListener('canplay', onCanPlay);
            element.removeEventListener('error', onError);

            element.playbackRate = state.playbackRate;
            element.volume = state.volume;
            element.muted = state.muted;
            element.currentTime = state.currentTime;

            if (!state.paused) {
                element.play().catch(() => {});
            }

            if (overlay) {
                const onFrameVisible = (): void => {
                    element.removeEventListener('playing', onFrameVisible);
                    element.removeEventListener('seeked', onFrameVisible);
                    done();
                };
                element.addEventListener('playing', onFrameVisible, {
                    once: true,
                });
                element.addEventListener('seeked', onFrameVisible, {
                    once: true,
                });
            } else {
                done();
            }
        };

        const onError = (): void => {
            element.removeEventListener('canplay', onCanPlay);
            element.removeEventListener('error', onError);
            cleanup();
            reject(
                new Error(
                    'reconnectPlayerOnFileLoadedIntoOpfs: load failed'
                )
            );
        };

        element.addEventListener('canplay', onCanPlay, { once: true });
        element.addEventListener('error', onError, { once: true });
    });
}

/** Payload от onOPFSBackgroundFetchFileWritten: event.data с полем asset (pathname). */
export interface FileWrittenPayload {
    asset?: Pathname;
}

/** Опции отладки для reconnectPlayerOnFileLoadedIntoOpfs и useReconnectPlayerOnFileLoadedIntoOpfs. */
export interface ReconnectPlayerOnFileLoadedIntoOpfsOptions {
    /** Логгер для отладочных сообщений при debug: true. По умолчанию console. */
    logger?: Logger;
    /** Включить логирование (причины пропуска, переподключение, ошибки). По умолчанию false. */
    debug?: boolean;
}

/**
 * Если event.data.asset совпадает с текущим источником плеера и файл в OPFS —
 * переподключает плеер к тому же URL (из OPFS), сохраняя позицию и состояние.
 * Вызывать из обработчика onOPFSBackgroundFetchFileWritten.
 */
export async function reconnectPlayerOnFileLoadedIntoOpfs(
    element: HTMLMediaElement,
    payload: FileWrittenPayload,
    folderName: FolderName,
    options: ReconnectPlayerOnFileLoadedIntoOpfsOptions = {}
): Promise<void> {
    const { logger = console, debug = false } = options;

    const asset = payload.asset;
    if (!asset) {
        if (debug) logger.debug(`${OPFS_RANGE_LOG_CLIENT}reconnectPlayer: no asset in payload`);
        return;
    }

    if (typeof location === 'undefined') return;
    const origin = location.origin;
    const assetUrl = new URL(asset, origin).href as UrlString;
    const current = element.currentSrc || element.src;
    if (!current || current !== assetUrl) {
        if (debug) {
            logger.debug(
                `${OPFS_RANGE_LOG_CLIENT}reconnectPlayer: skip (asset URL !== current src), asset=${assetUrl}, current=${current}`
            );
        }
        return;
    }

    const inCache = await hasInOpfsCache(assetUrl, folderName);
    if (!inCache) {
        if (debug) {
            logger.debug(
                `${OPFS_RANGE_LOG_CLIENT}reconnectPlayer: skip (not in OPFS), url=${assetUrl}`
            );
        }
        return;
    }

    if (debug) {
        logger.debug(`${OPFS_RANGE_LOG_CLIENT}reconnectPlayer: reconnecting to ${assetUrl}`);
    }
    try {
        await reconnectMediaElementToCurrentSrcFromOpfs(element);
    } catch (err) {
        if (debug) {
            logger.warn(
                `${OPFS_RANGE_LOG_CLIENT}reconnectPlayer: load failed`,
                err
            );
        }
        throw err;
    }
}
