/**
 * Semantic type aliases for string values used across the codebase.
 * Use in parameters, return types, and interface fields for clearer contracts.
 */

/** Pathname from a URL (e.g. `/video/1.mp4`). */
export type Pathname = string;

/** Full URL string. */
export type UrlString = string;

/** OPFS file key: hex(SHA-256(URL)), from urlToOpfsKey(). */
export type OpfsKey = string;

/** Name of a folder in OPFS (cache namespace). */
export type FolderName = string;
