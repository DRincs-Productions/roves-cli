/**
 * Packed game content (format 1): the game folder written as a few ZIP archives plus
 * `roves-content.json`, read by the desktop players (engine `support/cef-windows-player/src/
 * content.rs`, from v0.9.1). The players memory-map the archives and serve stored entries
 * straight from the mapping, so the default (no compression) is the fastest layout; a
 * compression level trades in-game speed for download and disk size.
 *
 * - `code.pack`: `index.html` and every other code file (JS chunks, CSS, HTML, JSON, WASM,
 *   source maps), in one archive; the player pages it in (or inflates it) at boot.
 * - `data-<folder>[-N].pack`: every other file, grouped by its top-level folder (`data-root`
 *   for the files at the root) in path order, so a folder's files are adjacent and the
 *   player's read-ahead of "the next files" follows the folder; a group is split into parts of
 *   at most `maxArchiveSize` bytes (a larger single file gets a part of its own).
 * - Already-compressed media (images, audio, video, fonts, archives) are always stored.
 */
import { lstat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { RovesError } from "./errors";
import { S_IFREG, walkDirectory, ZipWriter } from "./zip";

export type ContentLayout = "archive" | "files";
export const CONTENT_LAYOUTS: readonly ContentLayout[] = ["archive", "files"];
export const CONTENT_MANIFEST = "roves-content.json";
export const CONTENT_FORMAT = 1;
export const CODE_ARCHIVE = "code.pack";
export const DEFAULT_COMPRESSION_LEVEL = 0;
/** 300 MB. */
export const DEFAULT_MAX_ARCHIVE_SIZE = 300_000_000;
/** Smallest accepted archive size limit (1 MB). */
const MIN_ARCHIVE_SIZE = 1_000_000;
/** First engine release whose players read packed content. */
export const PACKED_CONTENT_MIN_SHELL = "v0.9.1";

const CODE_EXTENSIONS = new Set([
    ".html",
    ".htm",
    ".js",
    ".mjs",
    ".cjs",
    ".css",
    ".json",
    ".webmanifest",
    ".map",
    ".wasm",
]);

/** Formats that are compressed already: deflating them again only costs CPU. */
const STORED_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".jxl",
    ".mp3",
    ".ogg",
    ".oga",
    ".opus",
    ".m4a",
    ".aac",
    ".flac",
    ".mp4",
    ".m4v",
    ".webm",
    ".mov",
    ".mkv",
    ".woff",
    ".woff2",
    ".zip",
    ".gz",
    ".br",
    ".zst",
    ".7z",
    ".rar",
    ".ktx2",
    ".basis",
]);

/** Fixed entry time, so packing the same build twice gives the same archives. */
const ENTRY_TIME = new Date(Date.UTC(2020, 0, 1));

export interface PackOptions {
    /** 0 (stored, default) to 9 (smallest). */
    compressionLevel?: number;
    /** Largest asset archive in bytes (default 300 MB). */
    maxArchiveSize?: number;
}

export interface PackedContent {
    /** Directory holding the manifest and the archives. */
    dir: string;
    /** File names in `dir`, the manifest first. */
    files: string[];
    /** One line for the log, e.g. `4 archives, 812 files, 96.3 MB, stored`. */
    summary: string;
    /** Whether any entry is compressed (the outer package zip then stores the archives). */
    compressed: boolean;
}

export function validateCompressionLevel(value: number | string): number {
    const level = typeof value === "number" ? value : Number(value.trim());
    if (!Number.isInteger(level) || level < 0 || level > 9) {
        throw new RovesError(
            `invalid compression level "${value}" (expected 0, no compression, to 9)`,
        );
    }
    return level;
}

/** `300MB`, `1.5 GB`, `512MiB`, `250000000`: decimal (KB/MB/GB) or binary (KiB/MiB/GiB) units. */
export function parseArchiveSize(value: number | string): number {
    let bytes: number;
    if (typeof value === "number") {
        bytes = value;
    } else {
        const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]i?b?|b)?\s*$/i.exec(value);
        if (!match) {
            throw new RovesError(`invalid archive size "${value}" (expected e.g. 300MB or 1GiB)`);
        }
        const unit = (match[2] ?? "b").toLowerCase().replace(/b$/, "");
        const scale: Record<string, number> = {
            "": 1,
            k: 1e3,
            m: 1e6,
            g: 1e9,
            ki: 2 ** 10,
            mi: 2 ** 20,
            gi: 2 ** 30,
        };
        bytes = Number(match[1]) * (scale[unit] as number);
    }
    bytes = Math.floor(bytes);
    if (!Number.isFinite(bytes) || bytes < MIN_ARCHIVE_SIZE) {
        throw new RovesError(`archive size "${value}" is too small (at least 1MB)`);
    }
    return bytes;
}

/** `v0.9.1` >= `v0.9.0`; pre-release suffixes are ignored. */
export function shellReadsPackedContent(shellVersion: string): boolean {
    const parse = (tag: string) =>
        (/^v(\d+)\.(\d+)\.(\d+)/.exec(tag) ?? []).slice(1, 4).map(Number);
    const [a, b] = [parse(shellVersion), parse(PACKED_CONTENT_MIN_SHELL)];
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
}

export function isCodeFile(rel: string): boolean {
    return CODE_EXTENSIONS.has(extname(rel).toLowerCase());
}

/** `assets` -> `assets`; anything outside `[A-Za-z0-9._-]` becomes `_`. */
function groupName(rel: string): string {
    const slash = rel.indexOf("/");
    if (slash < 0) return "root";
    return rel.slice(0, slash).replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

interface Planned {
    name: string;
    files: { rel: string; size: number }[];
}

/** The archives and their files, in write order (code first). Exported for tests. */
export async function planArchives(contentDir: string, maxArchiveSize: number): Promise<Planned[]> {
    const code: Planned = { name: CODE_ARCHIVE, files: [] };
    const groups = new Map<string, { rel: string; size: number }[]>();
    for (const rel of await walkDirectory(contentDir)) {
        if (rel.endsWith("/")) continue;
        const info = await lstat(join(contentDir, rel));
        if (!info.isFile()) {
            throw new RovesError(
                `${rel} is not a regular file (symlinks can't be packed; use --content-layout files)`,
            );
        }
        const file = { rel, size: info.size };
        if (isCodeFile(rel)) {
            code.files.push(file);
            continue;
        }
        const group = groupName(rel);
        const list = groups.get(group) ?? [];
        list.push(file);
        groups.set(group, list);
    }
    if (!code.files.some((f) => f.rel === "index.html")) {
        throw new RovesError(`${contentDir} has no index.html at its root`);
    }
    const out = [code];
    const used = new Set([CODE_ARCHIVE]);
    for (const [group, files] of groups) {
        const parts: { rel: string; size: number }[][] = [];
        let current: { rel: string; size: number }[] = [];
        let size = 0;
        for (const file of files) {
            if (current.length > 0 && size + file.size > maxArchiveSize) {
                parts.push(current);
                current = [];
                size = 0;
            }
            current.push(file);
            size += file.size;
        }
        if (current.length > 0) parts.push(current);
        parts.forEach((part, i) => {
            let name = `data-${group}${i === 0 ? "" : `-${i + 1}`}.pack`;
            // Two folders that sanitize to the same name ("a b", "a_b").
            for (let n = 2; used.has(name); n++) name = name.replace(/\.pack$/, `~${n}.pack`);
            used.add(name);
            out.push({ name, files: part });
        });
    }
    return out;
}

/**
 * Packs `contentDir` into `outDir` (which must exist): the archives and `roves-content.json`.
 */
export async function packContent(
    contentDir: string,
    outDir: string,
    options: PackOptions = {},
): Promise<PackedContent> {
    const level = validateCompressionLevel(options.compressionLevel ?? DEFAULT_COMPRESSION_LEVEL);
    const maxSize = parseArchiveSize(options.maxArchiveSize ?? DEFAULT_MAX_ARCHIVE_SIZE);
    const plan = await planArchives(contentDir, maxSize);
    let fileCount = 0;
    let bytes = 0;
    for (const archive of plan) {
        const writer = new ZipWriter(join(outDir, archive.name));
        try {
            for (const { rel, size } of archive.files) {
                const stored = level === 0 || STORED_EXTENSIONS.has(extname(rel).toLowerCase());
                writer.addFile(join(contentDir, rel), rel, {
                    mode: S_IFREG | 0o644,
                    mtime: ENTRY_TIME,
                    compressionLevel: stored ? 0 : level,
                });
                fileCount++;
                bytes += size;
            }
            await writer.finish();
        } catch (error) {
            await writer.abort();
            throw error;
        }
    }
    const manifest = {
        format: CONTENT_FORMAT,
        code: CODE_ARCHIVE,
        assets: plan.slice(1).map((a) => a.name),
        compressionLevel: level,
        maxArchiveSize: maxSize,
    };
    await writeFile(join(outDir, CONTENT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
        dir: outDir,
        files: [CONTENT_MANIFEST, ...plan.map((a) => a.name)],
        summary: `${plan.length} archives, ${fileCount} files, ${(bytes / 1e6).toFixed(1)} MB, ${
            level === 0 ? "stored" : `compression level ${level}`
        }`,
        compressed: level > 0,
    };
}
