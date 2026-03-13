/**
 * Общий формат хранения в OPFS: константы и типы.
 * Используется плагином отдачи (serve) и утилитами/плагинами записи.
 */

import type { UrlString } from './types.js';

/** Размер поля длины метаданных в байтах (uint32 LE в конце файла). */
export const OPFS_META_FOOTER_LENGTH = 4;
/** Максимальная длина JSON метаданных в байтах (по полям + overhead, защита от битых данных). */
export const MAX_META_JSON_BYTES = 3000;

/** 1 KiB в байтах. Для конфигурации и лимитов. */
export const KILOBYTE = 1024;
/** 1 MiB в байтах. */
export const MEGABYTE = 1024 * 1024;
/** 1 GiB в байтах. */
export const GIGABYTE = 1024 * 1024 * 1024;

/** Метаданные ресурса (JSON в конце файла). */
export interface OpfsMetadata {
    /** Исходный URL ресурса, для которого создан этот файл. */
    url: UrlString;
    size: number;
    /** Логическая папка, к которой относится файл (группа для list/clear/настроек плагина). */
    folderName?: string;
    type?: string;
    etag?: string;
    lastModified?: string;
    /** Время последнего доступа (timestamp), для LRU. */
    lastAccessed?: number;
    /** Можно ли эвиктить ресурс (по умолчанию true). false = pinned, не удалять. */
    evictable?: boolean;
}

/** Размер хвоста файла для чтения футера: 4 байта длины + макс. JSON. Файлы меньше читаем целиком. */
const FOOTER_READ_SIZE = OPFS_META_FOOTER_LENGTH + MAX_META_JSON_BYTES;

/**
 * Читает метаданные из футера файла: последние 4 байта = длина JSON (uint32 LE), перед ними — JSON.
 * Один read хвоста; если metaLen больше, чем прочитано в хвосте, — второе чтение полного JSON (чтобы не парсить неполные данные).
 */
export async function readMetadataFromFileFooter(
    file: File
): Promise<{ metadata: OpfsMetadata | undefined; bodySize: number }> {
    const size = file.size;
    if (size < OPFS_META_FOOTER_LENGTH) {
        return { metadata: undefined, bodySize: size };
    }
    const tailBytes = Math.min(size, FOOTER_READ_SIZE);
    const tailBlob = file.slice(size - tailBytes, size);
    const tailBuf = new Uint8Array(await tailBlob.arrayBuffer());
    const metaLenOffset = tailBuf.length - OPFS_META_FOOTER_LENGTH;
    const metaLen = new DataView(tailBuf.buffer, tailBuf.byteOffset, tailBuf.byteLength).getUint32(
        metaLenOffset,
        true
    );
    if (metaLen === 0 || metaLen > size - OPFS_META_FOOTER_LENGTH) {
        return { metadata: undefined, bodySize: size };
    }
    if (metaLen > MAX_META_JSON_BYTES) {
        return { metadata: undefined, bodySize: size };
    }
    try {
        let text: string;
        if (metaLen > metaLenOffset) {
            const jsonBlob = file.slice(
                size - OPFS_META_FOOTER_LENGTH - metaLen,
                size - OPFS_META_FOOTER_LENGTH
            );
            text = await jsonBlob.text();
        } else {
            const jsonStart = metaLenOffset - metaLen;
            text = new TextDecoder().decode(tailBuf.subarray(jsonStart, metaLenOffset));
        }
        const metadata = JSON.parse(text) as OpfsMetadata;
        const bodySize = size - OPFS_META_FOOTER_LENGTH - metaLen;
        return { metadata, bodySize };
    } catch {
        return { metadata: undefined, bodySize: size };
    }
}
