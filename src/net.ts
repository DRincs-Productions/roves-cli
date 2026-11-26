/**
 * HTTP downloads with checksum verification and archive extraction, shared by the player
 * download (`download.ts`) and the toolchain installer (`toolchains.ts`). The `Net` interface
 * is what tests replace, so no test touches the network.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { extract as extractTar } from "tar";
import { RovesError } from "./errors";
import { extractZip } from "./zip";

export interface DownloadProgress {
    received: number;
    /** 0 when the server sends no length. */
    total: number;
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const HEADERS = { "User-Agent": "roves-cli" };

export async function downloadFile(
    url: string,
    dest: string,
    onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
    const response = await fetch(url, { redirect: "follow", headers: HEADERS });
    if (!response.ok || !response.body) {
        throw new HttpError(response.status, `HTTP ${response.status} ${response.statusText}`);
    }
    const total = Number(response.headers.get("content-length") ?? 0) || 0;
    let received = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            onProgress?.({ received, total });
            callback(null, chunk);
        },
    });
    await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        counter,
        createWriteStream(dest),
    );
}

export async function hashFile(path: string, algorithm: "sha256" | "sha1"): Promise<string> {
    const hash = createHash(algorithm);
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/** Network access of the toolchain installer; replaceable in tests. */
export interface Net {
    fetchJson(url: string): Promise<unknown>;
    fetchText(url: string): Promise<string>;
    /** Downloads `url` to `dest`; the caller verifies the checksum (`downloadVerified`). */
    download(
        url: string,
        dest: string,
        onProgress?: (progress: DownloadProgress) => void,
    ): Promise<void>;
}

async function fetchOk(url: string): Promise<Response> {
    const response = await fetch(url, { redirect: "follow", headers: HEADERS });
    if (!response.ok) {
        throw new RovesError(`${url}: HTTP ${response.status} ${response.statusText}`);
    }
    return response;
}

export const defaultNet: Net = {
    fetchJson: async (url) => (await fetchOk(url)).json(),
    fetchText: async (url) => (await fetchOk(url)).text(),
    download: async (url, dest, onProgress) => {
        try {
            await downloadFile(url, dest, onProgress);
        } catch (error) {
            throw new RovesError(`downloading ${url}: ${(error as Error).message}`);
        }
    },
};

/** Logs download progress in 25% steps (stderr in the CLI). */
export function progressLog(log: (message: string) => void, label: string) {
    let last = -1;
    return ({ received, total }: DownloadProgress) => {
        if (total === 0) return;
        const step = Math.floor((received / total) * 4) * 25;
        if (step !== last) {
            last = step;
            log(`${label}: ${step}% of ${(total / 1048576).toFixed(0)} MiB`);
        }
    };
}

/**
 * Downloads `url` to `dest` and checks its SHA-256; a mismatching file is deleted and the run
 * fails (never retried silently with a different file).
 */
export async function downloadVerified(
    net: Net,
    url: string,
    dest: string,
    sha256: string,
    log: (message: string) => void,
    label: string,
): Promise<void> {
    log(`${label}: downloading ${url}`);
    await net.download(url, dest, progressLog(log, label));
    const actual = await hashFile(dest, "sha256");
    if (actual !== sha256.toLowerCase()) {
        await rm(dest, { force: true });
        throw new RovesError(
            `${label}: SHA-256 mismatch for ${url} (expected ${sha256}, got ${actual})`,
        );
    }
    log(`${label}: SHA-256 verified`);
}

/** Extracts a `.zip` (modes and symlinks kept where the host allows) or a `.tar.gz`. */
export async function extractArchive(file: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });
    if (/\.zip$/i.test(file)) {
        await extractZip(file, dest);
    } else if (/\.(tar\.gz|tgz)$/i.test(file)) {
        await extractTar({ file, cwd: dest });
    } else {
        throw new RovesError(`unsupported archive ${file}`);
    }
}
