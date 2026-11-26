import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureShellAsset, shellCachePath } from "../src/download";
import { linuxBase, tempDir } from "./helpers";

let server: Server | undefined;
afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
});

/** Serves `routes` (URL path -> body or status) and counts requests per path. */
async function serve(routes: Record<string, Buffer | number>) {
    const hits = new Map<string, number>();
    server = createServer((request, response) => {
        const path = request.url ?? "";
        hits.set(path, (hits.get(path) ?? 0) + 1);
        const route = routes[path];
        if (route === undefined || typeof route === "number") {
            response.writeHead(typeof route === "number" ? route : 404).end();
            return;
        }
        response.writeHead(200, { "content-length": route.length }).end(route);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, hits };
}

describe("ensureShellAsset", () => {
    it("downloads once into the version-keyed cache and reuses it", async () => {
        const tmp = await tempDir();
        const zip = await readFile(await linuxBase(tmp));
        const { baseUrl, hits } = await serve({ "/v9.9.9/roves_shell_linux.zip": zip });
        const options = {
            version: "v9.9.9",
            baseUrl,
            cacheDir: join(tmp, "cache"),
            retryDelayMs: 0,
        };
        const first = await ensureShellAsset("roves_shell_linux.zip", options);
        expect(first.fromCache).toBe(false);
        expect(first.path).toBe(
            shellCachePath("roves_shell_linux.zip", "v9.9.9", join(tmp, "cache")).zip,
        );
        expect(await readFile(first.path)).toEqual(zip);
        const progress: number[] = [];
        const second = await ensureShellAsset("roves_shell_linux.zip", {
            ...options,
            onProgress: (p) => progress.push(p.received),
        });
        expect(second.fromCache).toBe(true);
        expect(hits.get("/v9.9.9/roves_shell_linux.zip")).toBe(1);
        await ensureShellAsset("roves_shell_linux.zip", { ...options, refresh: true });
        expect(hits.get("/v9.9.9/roves_shell_linux.zip")).toBe(2);
    });

    it("fails fast on 404, retries other failures and never caches a broken zip", async () => {
        const tmp = await tempDir();
        const { baseUrl, hits } = await serve({
            "/v1.0.0/broken.zip": Buffer.from("not a zip"),
            "/v1.0.0/error.zip": 500,
        });
        const options = {
            version: "v1.0.0",
            baseUrl,
            cacheDir: join(tmp, "cache"),
            retryDelayMs: 0,
        };
        await expect(ensureShellAsset("missing.zip", options)).rejects.toThrow(
            /HTTP 404 \(is the Roves release v1.0.0 published with missing.zip\?\)/,
        );
        expect(hits.get("/v1.0.0/missing.zip")).toBe(1);
        await expect(ensureShellAsset("error.zip", options)).rejects.toThrow(
            /after 3 attempts: HTTP 500/,
        );
        expect(hits.get("/v1.0.0/error.zip")).toBe(3);
        await expect(ensureShellAsset("broken.zip", options)).rejects.toThrow(/not a readable zip/);
        expect(
            await stat(shellCachePath("broken.zip", "v1.0.0", join(tmp, "cache")).dir).catch(
                () => null,
            ),
        ).toBeNull();
    });

    it("downloads into a temporary directory with noCache", async () => {
        const tmp = await tempDir();
        const zip = await readFile(await linuxBase(tmp));
        const { baseUrl } = await serve({ "/v9.9.9/roves_shell_linux.zip": zip });
        const asset = await ensureShellAsset("roves_shell_linux.zip", {
            version: "v9.9.9",
            baseUrl,
            noCache: true,
            cacheDir: join(tmp, "cache"),
        });
        expect(asset.path.startsWith(join(tmp, "cache"))).toBe(false);
        expect(await readFile(asset.path)).toEqual(zip);
        await asset.cleanup();
        expect(await stat(asset.path).catch(() => null)).toBeNull();
        expect(await stat(join(tmp, "cache")).catch(() => null)).toBeNull();
    });
});
