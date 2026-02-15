/**
 * Общий формат хранения в OPFS: константы и типы.
 * Используется плагином отдачи (serve) и утилитами/плагинами записи.
 */

/** Имя папки в корне OPFS для всех файлов этого плагина. Другие плагины не должны сюда писать. */
export const OPFS_FOLDER_NAME = 'opfs-serve-range';

/** Размер поля длины метаданных в байтах (uint32 LE в конце файла). */
export const OPFS_META_FOOTER_LENGTH = 4;
/** Максимальная длина JSON метаданных в байтах (защита от битых данных). */
export const MAX_META_JSON_BYTES = 2048;

/** Метаданные ресурса (JSON в конце файла). */
export interface OpfsMetadata {
    size: number;
    type?: string;
    etag?: string;
    lastModified?: string;
}
