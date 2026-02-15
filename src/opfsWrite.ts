/**
 * Утилиты записи в OPFS в формате, совместимом с opfsServeRange.
 * Один файл: [тело][4 байта длина JSON (uint32 LE)][JSON мета].
 */

import {
    OPFS_META_FOOTER_LENGTH,
    type OpfsMetadata,
} from './opfsFormat.js';

/**
 * Записывает в OPFS файл по ключу: тело (потоком), затем футер с метаданными.
 * Метаданные должны содержать size (размер тела в байтах); при записи футера используется он.
 *
 * @param dir — папка плагина в OPFS (getOpfsDir(root, true)); все файлы плагина лежат в ней
 * @param key — ключ файла (например, из urlToOpfsKey(url))
 * @param bodyStream — поток тела ресурса
 * @param metadata — size обязательно; type, etag, lastModified — по желанию
 */
export async function writeToOpfs(
    dir: FileSystemDirectoryHandle,
    key: string,
    bodyStream: ReadableStream<Uint8Array>,
    metadata: OpfsMetadata
): Promise<void> {
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();

    let bodySize = 0;

    const wrapper = new WritableStream<Uint8Array>({
        write(chunk) {
            bodySize += chunk.byteLength;
            // FileSystemWriteChunkType в типах требует ArrayBufferView<ArrayBuffer>, поток даёт Uint8Array<ArrayBufferLike>
            return writable.write(
                chunk as Parameters<FileSystemWritableFileStream['write']>[0]
            );
        },
        async close() {
            const meta: OpfsMetadata = { ...metadata, size: bodySize };
            const metaJson = JSON.stringify(meta);
            const metaBytes = new TextEncoder().encode(metaJson);
            const lengthAb = new ArrayBuffer(OPFS_META_FOOTER_LENGTH);
            new DataView(lengthAb).setUint32(0, metaBytes.length, true);

            await writable.seek(bodySize);
            await writable.write(
                metaBytes as Parameters<FileSystemWritableFileStream['write']>[0]
            );
            await writable.write(lengthAb);
            await writable.close();
        },
    });

    await bodyStream.pipeTo(wrapper);
}

/**
 * Собирает метаданные для OPFS из заголовков HTTP-ответа.
 */
export function metadataFromResponse(response: Response): OpfsMetadata {
    const contentLength = response.headers.get('Content-Length');
    const size = contentLength ? parseInt(contentLength, 10) : 0;
    if (size <= 0 || !Number.isInteger(size)) {
        throw new Error('Content-Length missing or invalid');
    }
    const type =
        response.headers.get('Content-Type') ?? 'application/octet-stream';
    const etag = response.headers.get('ETag') ?? undefined;
    const lastModified = response.headers.get('Last-Modified') ?? undefined;

    return {
        size,
        type,
        ...(etag && { etag }),
        ...(lastModified && { lastModified }),
    };
}
