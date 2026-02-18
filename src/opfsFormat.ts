/**
 * Общий формат хранения в OPFS: константы и типы.
 * Используется плагином отдачи (serve) и утилитами/плагинами записи.
 */

/** Имя папки в корне OPFS для всех файлов этого плагина. Другие плагины не должны сюда писать. */
export const OPFS_FOLDER_NAME = 'range-requests-cache';

/** Размер поля длины метаданных в байтах (uint32 LE в конце файла). */
export const OPFS_META_FOOTER_LENGTH = 4;
/** Максимальная длина JSON метаданных в байтах (защита от битых данных). */
export const MAX_META_JSON_BYTES = 2048;

/** 1 KiB в байтах. Для конфигурации и лимитов. */
export const KILOBYTE = 1024;
/** 1 MiB в байтах. */
export const MEGABYTE = 1024 * 1024;
/** 1 GiB в байтах. */
export const GIGABYTE = 1024 * 1024 * 1024;

/** Метаданные ресурса (JSON в конце файла). */
export interface OpfsMetadata {
    /** Исходный URL ресурса, для которого создан этот файл. */
    url: string;
    size: number;
    type?: string;
    etag?: string;
    lastModified?: string;
    /** Время последнего доступа (timestamp), для LRU. */
    lastAccessed?: number;
    /** Можно ли эвиктить ресурс (по умолчанию true). false = pinned, не удалять. */
    evictable?: boolean;
}

/**
 * Читает метаданные из футера файла: последние 4 байта = длина JSON (uint32 LE), перед ними — JSON.
 * Общая реализация для opfsServeRange, opfsLru и клиента.
 */
export async function readMetadataFromFileFooter(
    file: File
): Promise<{ metadata: OpfsMetadata | undefined; bodySize: number }> {
    const size = file.size;
    if (size < OPFS_META_FOOTER_LENGTH) {
        return { metadata: undefined, bodySize: size };
    }
    const footerBlob = file.slice(size - OPFS_META_FOOTER_LENGTH, size);
    const footerBuf = await footerBlob.arrayBuffer();
    const metaLen = new DataView(footerBuf).getUint32(0, true);
    if (
        metaLen === 0 ||
        metaLen > MAX_META_JSON_BYTES ||
        metaLen > size - OPFS_META_FOOTER_LENGTH
    ) {
        return { metadata: undefined, bodySize: size };
    }
    try {
        const jsonBlob = file.slice(
            size - OPFS_META_FOOTER_LENGTH - metaLen,
            size - OPFS_META_FOOTER_LENGTH
        );
        const text = await jsonBlob.text();
        const metadata = JSON.parse(text) as OpfsMetadata;
        const bodySize = size - OPFS_META_FOOTER_LENGTH - metaLen;
        return { metadata, bodySize };
    } catch {
        return { metadata: undefined, bodySize: size };
    }
}
