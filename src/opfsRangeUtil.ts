/**
 * Общая логика разбора Range и сборки ответа 206.
 * Используется opfsServeRange (отдача из OPFS) и opfsRangeFromNetworkAndCache (отдача из буфера при 200).
 */

import {
    HEADER_CONTENT_TYPE,
    HEADER_CONTENT_RANGE,
    HEADER_CONTENT_LENGTH,
    HEADER_ETAG,
    HEADER_LAST_MODIFIED,
} from '@budarin/http-constants/headers';
import { HTTP_STATUS_PARTIAL_CONTENT } from '@budarin/http-constants/statuses';
import { MIME_APPLICATION_OCTET_STREAM } from '@budarin/http-constants/mime-types';

const HEADER_ACCEPT_RANGES = 'Accept-Ranges';

export interface RangeSpec {
    start: number;
    end: number;
}

/** Размер чанка при потоковом чтении диапазона из File (не создаём один большой Blob). */
const FILE_RANGE_STREAM_CHUNK_SIZE = 256 * 1024;

/**
 * Поток, читающий из File только байты [range.start, range.end] чанками.
 * Не создаёт один огромный Blob — только маленькие slice на каждый чанк.
 */
export function createFileRangeStream(
    file: File,
    range: RangeSpec
): ReadableStream<Uint8Array> {
    const length = range.end - range.start + 1;
    let offset = range.start;
    let read = 0;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (read >= length) {
                controller.close();
                return;
            }
            const chunkSize = Math.min(
                FILE_RANGE_STREAM_CHUNK_SIZE,
                length - read
            );
            const blob = file.slice(offset, offset + chunkSize);
            const buf = await blob.arrayBuffer();
            controller.enqueue(new Uint8Array(buf));
            offset += chunkSize;
            read += chunkSize;
        },
    });
}

/**
 * Парсит заголовок Range и возвращает диапазон [start, end] (inclusive).
 * @throws Error при невалидном формате или выходе за границы fullSize
 */
export function parseRangeHeader(
    rangeHeader: string,
    fullSize: number
): RangeSpec {
    const trimmed = rangeHeader.trim();

    const suffixMatch = /^bytes=-(\d+)$/.exec(trimmed);
    if (suffixMatch) {
        const suffixLength = parseInt(suffixMatch[1]!, 10);
        if (isNaN(suffixLength) || suffixLength <= 0) {
            throw new Error('Invalid suffix range value');
        }
        const start = Math.max(0, fullSize - suffixLength);
        const end = fullSize - 1;
        return { start, end };
    }

    const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(trimmed);
    if (!rangeMatch) {
        throw new Error('Invalid or unsupported range header format');
    }

    const start = parseInt(rangeMatch[1]!, 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fullSize - 1;

    if (isNaN(start) || isNaN(end)) {
        throw new Error('Invalid range values');
    }
    if (start < 0 || start >= fullSize) {
        throw new Error('Range start is out of bounds');
    }
    if (end < start || end >= fullSize) {
        throw new Error('Range end is out of bounds');
    }

    return { start, end };
}

export interface Build206Options {
    type?: string;
    etag?: string;
    lastModified?: string;
    cacheControl?: string;
}

/**
 * TransformStream: из потока полного тела выдаёт только байты диапазона [range.start, range.end].
 * Не держит всё тело в памяти.
 */
export function createRangeExtractTransform(
    range: RangeSpec
): TransformStream<Uint8Array, Uint8Array> {
    let offset = 0;
    const { start, end } = range;

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            const chunkStart = offset;
            const chunkEnd = offset + chunk.byteLength;
            offset = chunkEnd;

            if (chunkEnd <= start || chunkStart > end) {
                return;
            }
            const sliceStart = Math.max(0, start - chunkStart);
            const sliceEnd = Math.min(chunk.byteLength, end - chunkStart + 1);
            if (sliceStart < sliceEnd) {
                controller.enqueue(
                    chunk.slice(sliceStart, sliceEnd) as Uint8Array
                );
            }
        },
    });
}

/**
 * Собирает ответ 206 Partial Content по срезу Blob и полному размеру.
 * Тело передаётся как сам Blob (не rangeBlob.stream()): стабильнее в SW/Chromium для
 * срезов из OPFS и записей in-memory range cache; для небольших диапазонов накладные расходы малы.
 */
export function build206Response(
    rangeBlob: Blob,
    range: RangeSpec,
    fullSize: number,
    options: Build206Options = {}
): Response {
    const {
        type = MIME_APPLICATION_OCTET_STREAM,
        etag,
        lastModified,
        cacheControl,
    } = options;

    const contentRange = `bytes ${String(range.start)}-${String(range.end)}/${String(fullSize)}`;
    const headers = new Headers({
        [HEADER_CONTENT_RANGE]: contentRange,
        [HEADER_CONTENT_LENGTH]: String(rangeBlob.size),
        [HEADER_CONTENT_TYPE]: type,
        [HEADER_ACCEPT_RANGES]: 'bytes',
    });
    if (cacheControl) {
        headers.set('Cache-Control', cacheControl);
    }
    if (etag) {
        headers.set(HEADER_ETAG, etag);
    }
    if (lastModified) {
        headers.set(HEADER_LAST_MODIFIED, lastModified);
    }

    return new Response(rangeBlob, {
        status: HTTP_STATUS_PARTIAL_CONTENT,
        headers,
    });
}

/**
 * Собирает ответ 206 с телом-потоком (уже отфильтрованным по диапазону).
 * rangeLength = range.end - range.start + 1.
 */
export function build206ResponseFromStream(
    rangeStream: ReadableStream<Uint8Array>,
    range: RangeSpec,
    fullSize: number,
    options: Build206Options = {}
): Response {
    const {
        type = MIME_APPLICATION_OCTET_STREAM,
        etag,
        lastModified,
        cacheControl,
    } = options;

    const rangeLength = range.end - range.start + 1;
    const contentRange = `bytes ${String(range.start)}-${String(range.end)}/${String(fullSize)}`;
    const headers = new Headers({
        [HEADER_CONTENT_RANGE]: contentRange,
        [HEADER_CONTENT_LENGTH]: String(rangeLength),
        [HEADER_CONTENT_TYPE]: type,
        [HEADER_ACCEPT_RANGES]: 'bytes',
    });
    if (cacheControl) {
        headers.set('Cache-Control', cacheControl);
    }
    if (etag) {
        headers.set(HEADER_ETAG, etag);
    }
    if (lastModified) {
        headers.set(HEADER_LAST_MODIFIED, lastModified);
    }

    return new Response(rangeStream, {
        status: HTTP_STATUS_PARTIAL_CONTENT,
        headers,
    });
}
