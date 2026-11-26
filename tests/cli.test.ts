import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDependencies, runCli } from "../src/cli";
import {
    assetName,
    assetUrl,
    hostPlatform,
    PINNED_SHELL_VERSION,
    parsePlatforms,
    validateName,
    validateShellVersion,
    validateSteamAppId,
} from "../src/constants";
import { bundleDesktop } from "../src/desktop";
import {
    decodePngSize,
    dist,
    fileNames,
    icoFile,
    linuxBase,
    macosBase,
    pngFile,
    readZip,
    tempDir,
    windowsBase,
} from "./helpers";

describe("asset naming and validation", () => {
    it("names every platform and variant, and rejects Steam + MCP", () => {
        for (const platform of ["windows", "macos", "linux"] as const) {
            expect(assetName(platform)).toBe(`roves_shell_${platform}.zip`);
            expect(assetName(platform, true)).toBe(`roves_shell_${platform}_steam.zip`);
            expect(assetName(platform, false, true)).toBe(`roves_shell_${platform}_mcp.zip`);
            expect(() => assetName(platform, true, true)).toThrow(/Steam/);
        }
        expect(assetUrl("roves_shell_linux_steam.zip", "v0.9.0")).toBe(
            "https://github.com/DRincs-Productions/roves/releases/download/v0.9.0/roves_shell_linux_steam.zip",
        );
    });

    it("pins the shell version in src/shell-version.txt", () => {
        expect(PINNED_SHELL_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
        expect(validateShellVersion(" v0.9.0 ")).toBe("v0.9.0");
        expect(validateShellVersion("v1.0.0-rc.1")).toBe("v1.0.0-rc.1");
        expect(() => validateShellVersion("0.9.0")).toThrow(/invalid shell version/);
    });

    it("parses platforms, names and Steam App IDs", () => {
        expect(parsePlatforms(["windows,linux", "macos", "linux"])).toEqual([
            "windows",
            "linux",
            "macos",
        ]);
        expect(parsePlatforms([])).toEqual([hostPlatform()]);
        expect(() => parsePlatforms(["android"])).toThrow(/unknown platform "android"/);
        expect(() => hostPlatform("aix")).toThrow(/unsupported host OS/);
        expect(validateName(" my game ")).toBe("my game");
        for (const bad of ["", "a/b", "back\\slash", "..", "x.", "a:b"]) {
            expect(() => validateName(bad), JSON.stringify(bad)).toThrow(/invalid name/);
        }
        expect(validateSteamAppId("480")).toBe("480");
        for (const bad of ["0", "-1", "abc", "4.8"]) {
            expect(() => validateSteamAppId(bad), bad).toThrow(/invalid Steam App ID/);
        }
    });
});

function capture(overrides: Partial<CliDependencies> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const deps: Partial<CliDependencies> = {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        ...overrides,
    };
    return { deps, out, err };
}

const argv = (...args: string[]) => ["node", "roves", ...args];

describe("command line", () => {
    it("maps bundle options to bundleDesktop", async () => {
        let received: Parameters<typeof bundleDesktop>[0] | undefined;
        const { deps, out } = capture({
            bundleDesktop: async (options) => {
                received = options;
                return [];
            },
        });
        const code = await runCli(
            argv(
                "bundle",
                "-c",
                "dist",
                "-p",
                "windows,linux",
                "--platform",
                "macos",
                "--steam",
                "--steam-app-id",
                "480",
                "--icon-png",
                "i.png",
                "-n",
                "my-game",
                "-o",
                "out",
                "--no-extract",
                "--no-cache",
                "--shell-version",
                "v0.9.1",
                "--json",
            ),
            deps,
        );
        expect(code).toBe(0);
        expect(received).toMatchObject({
            contentDir: "dist",
            platforms: ["windows", "linux", "macos"],
            steam: true,
            steamAppId: "480",
            enableMcp: false,
            iconPng: "i.png",
            name: "my-game",
            outDir: "out",
            extract: false,
            noCache: true,
            refresh: false,
            shellVersion: "v0.9.1",
        });
        expect(JSON.parse(out.join(""))).toEqual([]);
    });

    it("defaults to the host platform, the pinned version and roves-game", async () => {
        let received: Parameters<typeof bundleDesktop>[0] | undefined;
        const { deps } = capture({
            bundleDesktop: async (options) => {
                received = options;
                return [];
            },
        });
        expect(await runCli(argv("bundle", "-c", "dist"), deps)).toBe(0);
        expect(received).toMatchObject({
            platforms: [hostPlatform()],
            shellVersion: PINNED_SHELL_VERSION,
            name: "roves-game",
            outDir: ".",
            extract: true,
            noCache: false,
        });
    });

    it("reports usage and validation errors with exit code 1", async () => {
        const missing = capture();
        expect(await runCli(argv("bundle"), missing.deps)).toBe(1);
        expect(missing.err.join("")).toMatch(/--content-dir/);
        const bad = capture();
        expect(await runCli(argv("bundle", "-c", "dist", "-p", "beos"), bad.deps)).toBe(1);
        expect(bad.err.join("")).toMatch(/roves: error: unknown platform "beos"/);
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const combo = capture();
        expect(
            await runCli(argv("bundle", "-c", content, "--steam", "--enable-mcp"), combo.deps),
        ).toBe(1);
        expect(combo.err.join("")).toMatch(/can't be combined/);
        const appId = capture();
        expect(
            await runCli(argv("bundle", "-c", content, "--steam-app-id", "480"), appId.deps),
        ).toBe(1);
        expect(appId.err.join("")).toMatch(/--steam-app-id requires --steam/);
        const zipMany = capture();
        expect(
            await runCli(
                argv("bundle", "-c", content, "-p", "windows,linux", "--shell-zip", "x.zip"),
                zipMany.deps,
            ),
        ).toBe(1);
        expect(zipMany.err.join("")).toMatch(/--shell-zip needs exactly one --platform/);
        const noIndex = capture();
        expect(await runCli(argv("bundle", "-c", tmp, "-p", "linux"), noIndex.deps)).toBe(1);
        expect(noIndex.err.join("")).toMatch(/no index.html/);
        const orientation = capture();
        expect(
            await runCli(
                argv("android", "-c", content, "--orientation", "sideways"),
                orientation.deps,
            ),
        ).toBe(1);
        expect(orientation.err.join("")).toMatch(/Allowed choices/);
    });

    it("prints help and the version", async () => {
        const help = capture();
        expect(await runCli(argv("--help"), help.deps)).toBe(0);
        expect(help.out.join("")).toMatch(/bundle \[options\]/);
        const version = capture();
        expect(await runCli(argv("--version"), version.deps)).toBe(0);
        expect(version.out.join("")).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("maps android options, reading secrets from the environment", async () => {
        let received: Record<string, unknown> | undefined;
        const { deps, out } = capture({
            buildAndroid: async (options) => {
                received = options as unknown as Record<string, unknown>;
                return {
                    platform: "android",
                    bundleDir: "/o/g",
                    archivePath: "/o/g.zip",
                    engineDir: "/e",
                };
            },
        });
        process.env.ROVES_ANDROID_KEYSTORE_PASSWORD = "from-env";
        try {
            const code = await runCli(
                argv(
                    "android",
                    "-c",
                    "dist",
                    "--release",
                    "--keystore",
                    "k.jks",
                    "--key-alias",
                    "a",
                    "--key-password",
                    "kp",
                    "--no-bootstrap",
                    "--orientation",
                    "landscape",
                ),
                deps,
            );
            expect(code).toBe(0);
        } finally {
            delete process.env.ROVES_ANDROID_KEYSTORE_PASSWORD;
        }
        expect(received).toMatchObject({
            release: true,
            keystore: "k.jks",
            keystorePassword: "from-env",
            keyAlias: "a",
            keyPassword: "kp",
            bootstrap: false,
            orientation: "landscape",
        });
        expect(out.join("")).toContain("archive-path: /o/g.zip");
    });

    it("download prints the cached path and requires --output with --no-cache", async () => {
        const { deps, out } = capture({
            ensureShellAsset: async (asset, options) => ({
                path: `/cache/${options?.version}/${asset}`,
                url: "u",
                version: options?.version ?? "",
                fromCache: true,
                cleanup: async () => {},
            }),
        });
        expect(await runCli(argv("download", "-p", "linux", "--steam"), deps)).toBe(0);
        expect(out.join("")).toBe(`/cache/${PINNED_SHELL_VERSION}/roves_shell_linux_steam.zip\n`);
        const noCache = capture();
        expect(await runCli(argv("download", "-p", "linux", "--no-cache"), noCache.deps)).toBe(1);
        expect(noCache.err.join("")).toMatch(/--no-cache requires --output/);
    });
});

describe("bundleDesktop end to end (local --shell-zip)", () => {
    it("writes <name>.zip with <name>/ inside and the unzipped folder for one platform", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await pngFile(join(content, "icon.png"), 64);
        const [result] = await bundleDesktop({
            contentDir: content,
            platforms: ["linux"],
            shellZip: await linuxBase(tmp),
            name: "my-game",
            outDir: join(tmp, "out"),
        });
        expect(result?.archivePath).toBe(join(tmp, "out", "my-game.zip"));
        expect(result?.bundleDir).toBe(join(tmp, "out", "my-game"));
        expect(result?.iconSource).toBe("window project (game icon.png 64x64)");
        const zip = await readZip(result?.archivePath as string);
        expect(fileNames(zip).every((name) => name.startsWith("my-game/"))).toBe(true);
        expect(await stat(join(tmp, "out", "my-game", "game", "index.html"))).toBeTruthy();
        expect(await decodePngSize(zip.get("my-game/icon.png")?.bytes as Buffer)).toEqual([64, 64]);
    });

    it("puts the .app at the zip root on macOS and suffixes names for several platforms", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const macZip = await macosBase(tmp);
        const [mac] = await bundleDesktop({
            contentDir: content,
            platforms: ["macos"],
            shellZip: macZip,
            name: "My Game",
            outDir: join(tmp, "out"),
            extract: false,
        });
        expect(mac?.topFolder).toBe("My Game.app");
        expect(mac?.bundleDir).toBeUndefined();
        const zip = await readZip(mac?.archivePath as string);
        expect(fileNames(zip).every((name) => name.startsWith("My Game.app/Contents/"))).toBe(true);
    });

    it("names the outputs <name>_<platform> when several platforms are downloaded", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const assets: Record<string, Buffer> = {
            "/v0.9.0/roves_shell_windows.zip": await readFile(await windowsBase(tmp)),
            "/v0.9.0/roves_shell_linux.zip": await readFile(await linuxBase(tmp)),
        };
        const server = createServer((request, response) => {
            const body = assets[request.url ?? ""];
            if (body) response.writeHead(200).end(body);
            else response.writeHead(404).end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        try {
            const results = await bundleDesktop({
                contentDir: content,
                platforms: ["windows", "linux"],
                name: "g",
                outDir: join(tmp, "out"),
                shellVersion: "v0.9.0",
                baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                cacheDir: join(tmp, "cache"),
                patchExe: async () => {},
            });
            expect(results.map((r) => r.archivePath)).toEqual([
                join(tmp, "out", "g_windows.zip"),
                join(tmp, "out", "g_linux.zip"),
            ]);
            expect(results.map((r) => r.topFolder)).toEqual(["g", "g"]);
            expect(results[1]?.bundleDir).toBe(join(tmp, "out", "g_linux"));
            expect(results[0]?.base).toMatch(/\/v0\.9\.0\/roves_shell_windows\.zip$/);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("assembles Windows with the base's Roves icon as play.exe fallback", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const rovesIco = await readFile(await icoFile(join(tmp, "roves.ico"), 32));
        const patched: string[] = [];
        const [win] = await bundleDesktop({
            contentDir: content,
            platforms: ["windows"],
            shellZip: await windowsBase(tmp, { rovesIco }),
            outDir: join(tmp, "out"),
            patchExe: async (_exe, ico) => {
                patched.push(ico);
            },
        });
        expect(patched).toHaveLength(1);
        expect(win?.iconSource).toBe(
            "window roves (no project icon (embedded Roves logo)); executable roves (Roves fallback icon)",
        );
        expect(win?.archivePath).toBe(join(tmp, "out", "roves-game.zip"));
    });
});
