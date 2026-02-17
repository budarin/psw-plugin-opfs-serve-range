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
