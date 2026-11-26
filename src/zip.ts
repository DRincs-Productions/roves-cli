/**
 * Zip reading and writing that keeps what the engine's release assets store: Unix modes
 * (executables, the setuid `chrome-sandbox`), symlinks (the macOS framework links) and the
 * compression choice of every entry. Reading is yauzl, writing is yazl; both expose the raw
 * external attributes, so the same code works on every host OS.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { RovesError } from "./errors";

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export interface ZipEntryInfo {
    /** Entry name as stored (forward slashes, directories end with `/`). */
    name: string;
    isDirectory: boolean;
    isSymlink: boolean;
    /** Unix mode including the file type bits (`st_mode`), when the archive stores one. */
    mode: number | undefined;
    /** True when the entry is deflated, false when stored. */
    compressed: boolean;
    uncompressedSize: number;
    mtime: Date;
    /** The underlying yauzl entry. */
    entry: yauzl.Entry;
}

function unixMode(entry: yauzl.Entry): number | undefined {
    const high = entry.externalFileAttributes >>> 16;
    const madeByUnix = entry.versionMadeBy >> 8 === 3;
    return madeByUnix || high !== 0 ? high : undefined;
}

/** A zip archive opened for random access to its entries. */
export class ZipReader {
    private constructor(
        private readonly zip: yauzl.ZipFile,
        readonly path: string,
        readonly entries: ZipEntryInfo[],
    ) {}

    static async open(path: string): Promise<ZipReader> {
        const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
            yauzl.open(
                path,
                { lazyEntries: true, autoClose: false, validateEntrySizes: true },
                (error, file) => (error ? reject(error) : resolvePromise(file)),
            );
        }).catch((error: Error) => {
            throw new RovesError(`${path}: not a readable zip archive (${error.message})`);
        });
        const entries: ZipEntryInfo[] = [];
        await new Promise<void>((resolvePromise, reject) => {
            zip.on("entry", (entry: yauzl.Entry) => {
                const mode = unixMode(entry);
                const type = mode === undefined ? 0 : mode & S_IFMT;
                entries.push({
                    name: entry.fileName,
                    isDirectory: entry.fileName.endsWith("/") || type === S_IFDIR,
                    isSymlink: type === S_IFLNK,
                    mode,
                    compressed: entry.compressionMethod !== 0,
                    uncompressedSize: entry.uncompressedSize,
                    mtime: entry.getLastModDate(),
                    entry,
                });
                zip.readEntry();
            });
            zip.on("end", () => resolvePromise());
            zip.on("error", reject);
            zip.readEntry();
        }).catch((error: Error) => {
            zip.close();
            throw new RovesError(`${path}: ${error.message}`);
        });
        return new ZipReader(zip, path, entries);
    }

    openStream(info: ZipEntryInfo): Promise<Readable> {
        return new Promise((resolvePromise, reject) => {
            this.zip.openReadStream(info.entry, (error, stream) =>
                error ? reject(error) : resolvePromise(stream),
            );
        });
    }

    async read(info: ZipEntryInfo): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of await this.openStream(info)) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
    }

    async sha256(info: ZipEntryInfo): Promise<string> {
        return sha256Stream(await this.openStream(info));
    }

    close(): void {
        this.zip.close();
    }
}

export async function sha256Stream(stream: Readable): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

export function sha256File(path: string): Promise<string> {
    return sha256Stream(createReadStream(path));
}

export interface ZipWriteOptions {
    /** Full Unix mode including the type bits (e.g. `0o100644`, `0o120777` for a symlink). */
    mode: number;
    mtime?: Date;
    /** Deflate (default) or store. */
    compress?: boolean;
}

/**
 * Writes a zip with Unix entries on every host (yazl records "made by Unix" and the mode in
 * the external attributes, setuid included), like the engine's own release zips.
 */
export class ZipWriter {
    private readonly zip = new yazl.ZipFile();
    private readonly done: Promise<void>;

    constructor(readonly path: string) {
        const out = createWriteStream(path);
        this.done = new Promise((resolvePromise, reject) => {
            out.on("close", () => resolvePromise());
            out.on("error", reject);
            this.zip.on("error", reject);
            this.zip.outputStream.on("error", reject);
        });
        // Observed by finish()/abort(); marked handled so an early failure is not reported twice.
        this.done.catch(() => {});
        this.zip.outputStream.pipe(out);
    }

    addDirectory(name: string, mode = S_IFDIR | 0o755, mtime?: Date): void {
        this.zip.addEmptyDirectory(name, { mode, ...(mtime ? { mtime } : {}) });
    }

    addBuffer(name: string, data: Buffer, options: ZipWriteOptions): void {
        this.zip.addBuffer(data, name, {
            mode: options.mode,
            compress: options.compress ?? true,
            ...(options.mtime ? { mtime: options.mtime } : {}),
        });
    }

    addFile(realPath: string, name: string, options: ZipWriteOptions): void {
        this.zip.addFile(realPath, name, {
            mode: options.mode,
            compress: options.compress ?? true,
            ...(options.mtime ? { mtime: options.mtime } : {}),
        });
    }

    /** The stream is opened only when yazl reaches this entry, so large archives stay cheap. */
    addLazyStream(
        name: string,
        open: () => Promise<Readable>,
        options: ZipWriteOptions & { size?: number },
    ): void {
        this.zip.addReadStreamLazy(
            name,
            {
                mode: options.mode,
                compress: options.compress ?? true,
                ...(options.mtime ? { mtime: options.mtime } : {}),
                ...(options.size !== undefined ? { size: options.size } : {}),
            },
            (callback) => {
                open().then(
                    (stream) => callback(null, stream),
                    (error: Error) => callback(error, undefined as never),
                );
            },
        );
    }

    async finish(): Promise<void> {
        this.zip.end();
        await this.done;
    }

    /** Ends the archive after a failure and removes the partial file. */
    async abort(): Promise<void> {
        try {
            this.zip.end();
            await this.done;
        } catch {
            // The archive is being discarded anyway.
        }
        await rm(this.path, { force: true });
    }
}

export interface ExtractResult {
    /** Symlinks that could not be created (e.g. on Windows without the privilege). */
    skippedSymlinks: string[];
}

/**
 * Extracts `zipPath` into `dest`, restoring modes (on POSIX hosts) and symlinks where the host
 * allows them. Entry names were already validated by yauzl (no absolute paths, no `..`).
 */
export async function extractZip(zipPath: string, dest: string): Promise<ExtractResult> {
    const reader = await ZipReader.open(zipPath);
    const root = resolve(dest);
    const skippedSymlinks: string[] = [];
    try {
        await mkdir(root, { recursive: true });
        for (const info of reader.entries) {
            const target = resolve(root, info.name);
            if (target !== root && !target.startsWith(root + sep)) {
                throw new RovesError(`${zipPath}: unsafe entry name ${info.name}`);
            }
            if (info.isDirectory) {
                await mkdir(target, { recursive: true });
                continue;
            }
            await mkdir(dirname(target), { recursive: true });
            if (info.isSymlink) {
                const linkTarget = (await reader.read(info)).toString("utf8");
                try {
                    await rm(target, { force: true });
                    await symlink(linkTarget, target);
                } catch {
                    skippedSymlinks.push(info.name);
                }
                continue;
            }
            await pipeline(await reader.openStream(info), createWriteStream(target));
            if (process.platform !== "win32" && info.mode !== undefined) {
                await chmod(target, info.mode & 0o777);
            }
        }
    } finally {
        reader.close();
    }
    return { skippedSymlinks };
}

/** Files of `dir` (recursively, sorted), relative with forward slashes; directories end with `/`. */
export async function walkDirectory(dir: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (current: string): Promise<void> => {
        const entries = await readdir(current, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = join(current, entry.name);
            const rel = relative(dir, full).split(sep).join("/");
            if (entry.isDirectory()) {
                out.push(`${rel}/`);
                await visit(full);
            } else {
                out.push(rel);
            }
        }
    };
    await visit(dir);
    return out;
}

/**
 * Zips the folder `dir` as `<topName>/...` (one named folder, never loose files at the archive
 * root), keeping symlinks and, on POSIX hosts, the file modes.
 */
export async function zipDirectory(dir: string, zipPath: string, topName: string): Promise<void> {
    await rm(zipPath, { force: true });
    const writer = new ZipWriter(zipPath);
    try {
        writer.addDirectory(`${topName}/`);
        for (const rel of await walkDirectory(dir)) {
            const full = join(dir, rel);
            const stat = await lstat(full);
            const name = `${topName}/${rel}`;
            if (rel.endsWith("/")) {
                writer.addDirectory(name, S_IFDIR | 0o755, stat.mtime);
            } else if (stat.isSymbolicLink()) {
                writer.addBuffer(name, Buffer.from(await readlink(full), "utf8"), {
                    mode: S_IFLNK | 0o777,
                    mtime: stat.mtime,
                });
            } else {
                const perm = process.platform === "win32" ? 0o644 : stat.mode & 0o7777;
                writer.addFile(full, name, { mode: S_IFREG | perm, mtime: stat.mtime });
            }
        }
        await writer.finish();
    } catch (error) {
        await writer.abort();
        throw error;
    }
}

/** Writes `data` creating the parent directories. */
export async function writeFileDeep(path: string, data: Buffer | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}
