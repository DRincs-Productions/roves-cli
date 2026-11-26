/**
 * Fetches and caches the prebuilt desktop player packages (`roves_shell_<platform>[_steam|_mcp].zip`)
 * of an engine release. The cache keeps the downloaded zip itself, never an extraction: the
 * assembly copies its entries as they are, so Unix modes and symlinks survive on every host.
 */
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import envPaths from "env-paths";
import { assetUrl, PINNED_SHELL_VERSION, RELEASE_DOWNLOAD_BASE } from "./constants";
import { RovesError } from "./errors";
import { type DownloadProgress, downloadFile, HttpError } from "./net";
import { ZipReader } from "./zip";

/**
 * The user cache directory of this tool (`ROVES_CACHE_DIR` overrides it): e.g.
 * `%LOCALAPPDATA%\roves\Cache`, `~/Library/Caches/roves`, `~/.cache/roves`.
 */
export function defaultCacheDir(): string {
    return process.env.ROVES_CACHE_DIR || envPaths("roves", { suffix: "" }).cache;
}

/** `<cacheDir>/shells/<version>/<asset without .zip>/<asset>`. */
export function shellCachePath(asset: string, version: string, cacheDir = defaultCacheDir()) {
    const dir = join(cacheDir, "shells", version, asset.replace(/\.zip$/, ""));
    return { dir, zip: join(dir, asset), marker: join(dir, ".complete") };
}

export type { DownloadProgress } from "./net";

export interface EnsureShellAssetOptions {
    /** Engine release tag (default: the pinned `PINNED_SHELL_VERSION`). */
    version?: string;
    /** Never read or write the cache: download into a temporary directory (see `cleanup`). */
    noCache?: boolean;
    /** Download again even when a complete cached copy exists. */
    refresh?: boolean;
    cacheDir?: string;
    /** Release download base URL (tests, mirrors). */
    baseUrl?: string;
    attempts?: number;
    retryDelayMs?: number;
    onProgress?: (progress: DownloadProgress) => void;
    log?: (message: string) => void;
}

export interface ShellAsset {
    /** Path of the zip. */
    path: string;
    url: string;
    version: string;
    fromCache: boolean;
    /** Removes a temporary (`noCache`) download; a no-op for cached files. */
    cleanup: () => Promise<void>;
}

async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
}

/**
 * Returns a local copy of release asset `asset`: the cached one when complete, else a fresh
 * download (retried on network errors, never on HTTP 404). A download is accepted only once its
 * zip central directory reads back, so a truncated file is never cached.
 */
export async function ensureShellAsset(
    asset: string,
    options: EnsureShellAssetOptions = {},
): Promise<ShellAsset> {
    const version = options.version ?? PINNED_SHELL_VERSION;
    const url = assetUrl(asset, version, options.baseUrl ?? RELEASE_DOWNLOAD_BASE);
    const log = options.log ?? (() => {});
    const noop = async () => {};

    let dir: string;
    let zipPath: string;
    let marker: string | undefined;
    if (options.noCache) {
        dir = await mkdtemp(join(tmpdir(), "roves-shell-"));
        zipPath = join(dir, asset);
    } else {
        const paths = shellCachePath(asset, version, options.cacheDir);
        dir = paths.dir;
        zipPath = paths.zip;
        marker = paths.marker;
        if (!options.refresh && (await exists(marker)) && (await exists(zipPath))) {
            log(`Using cached ${asset} (${version}): ${zipPath}`);
            return { path: zipPath, url, version, fromCache: true, cleanup: noop };
        }
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
    }

    const attempts = options.attempts ?? 3;
    const partial = `${zipPath}.partial`;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
        log(`Downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ""}`);
        try {
            await downloadFile(url, partial, options.onProgress);
            (await ZipReader.open(partial)).close();
            await rename(partial, zipPath);
            lastError = "";
            break;
        } catch (error) {
            await rm(partial, { force: true });
            if (error instanceof HttpError && error.status === 404) {
                await rm(dir, { recursive: true, force: true });
                throw new RovesError(
                    `cannot download ${url}: HTTP 404 (is the Roves release ${version} published with ${asset}?)`,
                );
            }
            lastError = (error as Error).message;
            if (attempt < attempts) {
                await new Promise((r) => setTimeout(r, (options.retryDelayMs ?? 2000) * attempt));
            }
        }
    }
    if (lastError) {
        await rm(dir, { recursive: true, force: true });
        throw new RovesError(`downloading ${url} failed after ${attempts} attempts: ${lastError}`);
    }
    if (marker) await writeFile(marker, "1");
    const cleanup = options.noCache
        ? async () => {
              await rm(dir, { recursive: true, force: true });
          }
        : noop;
    return { path: zipPath, url, version, fromCache: false, cleanup };
}
