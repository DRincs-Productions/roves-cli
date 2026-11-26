import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assemble, rewriteProvenance, type AssembleOptions } from "../src/assemble";
import { locateRoot, macosBundleNames, PlayerBase } from "../src/base";
import type { DesktopPlatform } from "../src/constants";
import { checkIco, type ProjectIcon, resolveProjectIcon } from "../src/icon";
import {
    decodePngSize,
    dist,
    EXEC,
    FILE,
    fileNames,
    icoFile,
    LINK,
    LINUX_EXE,
    linuxBase,
    MACOS_EXE,
    MACOS_FRAMEWORK,
    MACOS_ICNS,
    MACOS_PLIST,
    MCP_FILES,
    macosBase,
    pngFile,
    put,
    readZip,
    SETUID,
    tempDir,
    windowsBase,
    windowsFiles,
    withChecksums,
    write,
    writeZip,
} from "./helpers";

const noIcon: ProjectIcon = {
    window: { source: "roves", detail: "none" },
    summary: "",
    warnings: [],
};

function options(
    content: string,
    work: string,
    extra: Partial<AssembleOptions> = {},
): AssembleOptions {
    return {
        contentDir: content,
        topFolder: "my game",
        enableMcp: false,
        icon: noIcon,
        workDir: work,
        patchExe: async () => {
            throw new Error("play.exe must not be patched without a resolved icon");
        },
        ...extra,
    };
}

async function open(zip: string, platform: DesktopPlatform, steam = false) {
    return PlayerBase.open(zip, platform, steam);
}

async function build(
    baseZip: string,
    platform: DesktopPlatform,
    opts: AssembleOptions,
    out: string,
    steam = false,
) {
    const base = await open(baseZip, platform, steam);
    try {
        await assemble(base, opts, out);
    } finally {
        base.close();
    }
    return readZip(out);
}

describe("locating the package root", () => {
    it("finds it at the root or in one top folder", () => {
        expect(locateRoot(["play.exe", "game/index.html"], "windows")).toBe("");
        expect(locateRoot(["pkg/", "pkg/play.exe"], "windows")).toBe("pkg/");
        expect(() => locateRoot(["a/b/play.exe"], "windows")).toThrow();
        expect(() => locateRoot(["a/play.exe", "b/play.exe"], "windows")).toThrow(/more than one/);
        // The CEF helper apps' Info.plist files are deeper and never mistaken for the root.
        const mac = [
            "X.app/Contents/Info.plist",
            "X.app/Contents/Frameworks/H.app/Contents/Info.plist",
        ];
        expect(locateRoot(mac, "macos")).toBe("X.app/");
        expect(() => locateRoot(["play.exe"], "linux")).toThrow(/not a Roves linux player/);
    });

    it("reads the macOS executable and icon names from Info.plist", () => {
        expect(macosBundleNames(MACOS_PLIST)).toEqual({ executable: MACOS_EXE, icns: MACOS_ICNS });
        const withExtension = MACOS_PLIST.replace(
            "<key>CFBundleIconFile</key><string>roves-cef-macos-gate</string>",
            "<key>CFBundleIconFile</key><string>x.icns</string>",
        );
        expect(macosBundleNames(withExtension).icns).toBe("Contents/Resources/x.icns");
        expect(() => macosBundleNames('<plist version="1.0"><dict/></plist>')).toThrow(
            /CFBundleExecutable/,
        );
    });
});

describe("Windows", () => {
    it("adds the game to a shell-only base, rewrites PROVENANCE and regenerates SHA256SUMS", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const out = join(tmp, "out.zip");
        const zip = await build(
            await windowsBase(tmp),
            "windows",
            options(content, join(tmp, "work"), {
                baseNote: "https://example/roves_shell_windows.zip",
            }),
            out,
        );
        expect(zip.get("my game/game/index.html")?.bytes.toString()).toBe("<p>mine</p>");
        expect(zip.get("my game/game/assets/app.js")?.bytes.toString()).toBe("mine");
        expect(zip.get("my game/play.exe")?.bytes.toString()).toBe("play.exe");
        const provenance = zip.get("my game/PROVENANCE.txt")?.bytes.toString() ?? "";
        expect(provenance).toContain("Game replaced by @drincs/roves-cli");
        expect(provenance).toContain("Local MCP bridge: OFF");
        expect(provenance).toContain("base: https://example/roves_shell_windows.zip");
        expect(provenance).toContain("\r\n");
        // The output is itself a valid, checksum-verified Windows package without MCP.
        const again = await open(out, "windows");
        expect(again.mcpCapable).toBe(false);
        expect(again.checksums?.get("game/index.html")).toBeDefined();
        again.close();
    });

    it("drops an older base's sample game, its provenance, its icon.png and the MCP files", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const out = join(tmp, "out.zip");
        const base = await windowsBase(tmp, { mcp: true, sampleGame: true });
        const zip = await build(base, "windows", options(content, join(tmp, "work")), out);
        const names = fileNames(zip);
        expect(names).toContain("my game/game/assets/app.js");
        expect(
            names.some((n) => n.includes("sample.js") || n.includes("visual-novel-template")),
        ).toBe(false);
        expect(names).not.toContain("my game/icon.png");
        expect(
            names.some((n) => n.startsWith("my game/mcp/") || n.includes("provenance/mcp-")),
        ).toBe(false);
        const provenance = zip.get("my game/PROVENANCE.txt")?.bytes.toString() ?? "";
        expect(provenance).not.toContain("MCP-enabled development package");
        (await open(out, "windows")).close();
    });

    it("keeps the verified MCP files with enableMcp", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const out = join(tmp, "out.zip");
        const zip = await build(
            await windowsBase(tmp, { mcp: true }),
            "windows",
            options(content, join(tmp, "work"), { enableMcp: true }),
            out,
        );
        expect(zip.has("my game/mcp/node_modules/.package-lock.json")).toBe(true);
        expect(zip.get("my game/PROVENANCE.txt")?.bytes.toString()).toContain(
            "Local MCP bridge: ON",
        );
        const again = await open(out, "windows");
        expect(again.mcpCapable).toBe(true);
        again.close();
    });

    it("refuses a hand-added marker, a modified file, a missing file and unsafe listed paths", async () => {
        const tmp = await tempDir();
        const variants: [string, (files: ReturnType<typeof windowsFiles>) => void, RegExp][] = [
            [
                "marker",
                (f) => put(f, "mcp/enabled", ""),
                /mcp\/enabled, which its SHA256SUMS.txt does not list/,
            ],
            ["modified", (f) => put(f, "play.dll", "patched"), /play.dll does not match/],
            ["missing", (f) => f.delete("libcef.dll"), /lacks libcef.dll/],
        ];
        for (const [name, mutate, error] of variants) {
            const files = windowsFiles();
            withChecksums(files);
            mutate(files);
            const zip = await writeZip(join(tmp, `${name}.zip`), "", files);
            await expect(open(zip, "windows")).rejects.toThrow(error);
        }
        const files = windowsFiles();
        withChecksums(files);
        const sums = files.get("SHA256SUMS.txt")?.bytes.toString() ?? "";
        put(files, "SHA256SUMS.txt", `${sums}${"0".repeat(64)}  ../evil\r\n`);
        await expect(
            open(await writeZip(join(tmp, "unsafe.zip"), "", files), "windows"),
        ).rejects.toThrow(/unsafe path/);
    });
});

describe("MCP", () => {
    it("needs a complete MCP-enabled package on every platform", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const out = join(tmp, "out.zip");
        const on = options(content, join(tmp, "work"), { enableMcp: true });
        for (const [zip, platform] of [
            [await windowsBase(tmp), "windows"],
            [await linuxBase(tmp), "linux"],
            [await macosBase(tmp), "macos"],
        ] as const) {
            const base = await open(zip, platform);
            expect(base.mcpCapable).toBe(false);
            await expect(assemble(base, on, out)).rejects.toThrow(
                /not a complete MCP-enabled package/,
            );
            base.close();
        }
        // The marker alone (an incomplete mcp/ folder) is not an MCP-enabled package.
        const files = new Map() as ReturnType<typeof windowsFiles>;
        put(files, LINUX_EXE, "elf", EXEC);
        put(files, "chrome-sandbox", "x", SETUID);
        for (const file of ["libcef.so", "icudtl.dat", "resources.pak", "mcp/enabled"])
            put(files, file, "x");
        const base = await open(await writeZip(join(tmp, "marker-only.zip"), "", files), "linux");
        expect(base.mcpCapable).toBe(false);
        base.close();
    });

    it("keeps mcp/ next to the Linux executable or drops it", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const baseZip = await linuxBase(tmp, { mcp: true });
        const on = await build(
            baseZip,
            "linux",
            options(content, join(tmp, "work"), { enableMcp: true }),
            join(tmp, "on.zip"),
        );
        for (const file of MCP_FILES) expect(on.has(`my game/mcp/${file}`)).toBe(true);
        const off = await build(
            baseZip,
            "linux",
            options(content, join(tmp, "work")),
            join(tmp, "off.zip"),
        );
        expect([...off.keys()].some((name) => name.startsWith("my game/mcp"))).toBe(false);
    });

    it("keeps mcp/ in the .app resources or drops it", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const baseZip = await macosBase(tmp, { mcp: true });
        const on = await build(
            baseZip,
            "macos",
            options(content, join(tmp, "work"), { enableMcp: true, topFolder: "my game.app" }),
            join(tmp, "on.zip"),
        );
        for (const file of MCP_FILES) {
            expect(on.has(`my game.app/Contents/Resources/mcp/${file}`)).toBe(true);
        }
        const again = await open(join(tmp, "on.zip"), "macos");
        expect(again.mcpCapable).toBe(true);
        again.close();
        const off = await build(
            baseZip,
            "macos",
            options(content, join(tmp, "work"), { topFolder: "my game.app" }),
            join(tmp, "off.zip"),
        );
        expect([...off.keys()].some((name) => name.includes("/mcp"))).toBe(false);
    });
});

describe("Steam", () => {
    it("needs the redistributable exactly for Steam bases and writes steam_appid.txt next to the executable", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await expect(open(await linuxBase(tmp), "linux", true)).rejects.toThrow(
            /lacks libsteam_api.so/,
        );
        const steamZip = await linuxBase(tmp, { steam: true });
        await expect(open(steamZip, "linux", false)).rejects.toThrow(
            /unexpectedly contains libsteam_api.so/,
        );
        const opts = options(content, join(tmp, "work"), { steamAppId: "480" });
        const linux = await build(steamZip, "linux", opts, join(tmp, "linux.zip"), true);
        expect(linux.get("my game/steam_appid.txt")?.bytes.toString()).toBe("480");

        const winZip = await windowsBase(join(tmp, "win"), { steam: true });
        const win = await build(winZip, "windows", opts, join(tmp, "win.zip"), true);
        expect(win.get("my game/steam_appid.txt")?.bytes.toString()).toBe("480");
        (await open(join(tmp, "win.zip"), "windows", true)).close();
    });
});

describe("Linux", () => {
    it("keeps Unix modes, the setuid sandbox and symlinks, and places the window icon next to the executable", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await pngFile(join(content, "icon.png"), 128);
        const baseZip = await linuxBase(tmp, { sampleGame: true });
        expect((await readZip(baseZip)).get("roves-cef-linux/chrome-sandbox")?.mode).toBe(SETUID);
        const icon = await resolveProjectIcon({
            platform: "linux",
            contentDir: content,
            workDir: join(tmp, "icon"),
        });
        expect(icon.summary).toBe("window project (game icon.png 128x128)");
        const zip = await build(
            baseZip,
            "linux",
            options(content, join(tmp, "work"), { icon }),
            join(tmp, "out.zip"),
        );
        const mode = (name: string) => zip.get(name)?.mode;
        expect(mode(`my game/${LINUX_EXE}`)).toBe(EXEC);
        expect(mode("my game/chrome-sandbox")).toBe(SETUID);
        expect(mode("my game/game/assets/app.js")).toBe(FILE);
        expect(mode("my game/libvk_swiftshader.so")).toBe(LINK);
        expect(zip.get("my game/libvk_swiftshader.so")?.bytes.toString()).toBe(
            "libvk_swiftshader.so.1",
        );
        expect(zip.get("my game/icon.png")?.bytes.length).toBeGreaterThan(0);
        expect(zip.get("my game/game/index.html")?.bytes.toString()).toBe("<p>mine</p>");
        expect(fileNames(zip).some((name) => name.includes("sample"))).toBe(false);
    });

    it("detects the executable and refuses a base that lost its Unix modes", async () => {
        const tmp = await tempDir();
        const base = await open(await linuxBase(tmp), "linux");
        expect(base.executable).toBe(LINUX_EXE);
        base.close();
        const files = new Map() as ReturnType<typeof windowsFiles>;
        for (const file of [LINUX_EXE, "libcef.so", "icudtl.dat", "resources.pak"])
            put(files, file, "x");
        put(files, "chrome-sandbox", "x", SETUID);
        await expect(
            open(await writeZip(join(tmp, "modes.zip"), "", files), "linux"),
        ).rejects.toThrow(/Unix modes/);
        put(files, "chrome-sandbox", "x", FILE);
        await expect(
            open(await writeZip(join(tmp, "sandbox.zip"), "", files), "linux"),
        ).rejects.toThrow(/execute bit/);
    });
});

describe("macOS", () => {
    it("replaces the game, window icon and bundle icon inside the .app and keeps framework symlinks", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await pngFile(join(content, "icon.png"), 256);
        const baseZip = await macosBase(tmp, { sampleGame: true });
        const icon = await resolveProjectIcon({
            platform: "macos",
            contentDir: content,
            workDir: join(tmp, "icon"),
        });
        expect(icon.summary).toMatch(/app icon project \(ICNS generated from game icon\.png\)$/);
        const top = { topFolder: "my game.app" };
        const zip = await build(
            baseZip,
            "macos",
            options(content, join(tmp, "work"), { ...top, icon }),
            join(tmp, "out.zip"),
        );
        expect(zip.get("my game.app/Contents/Resources/game/index.html")?.bytes.toString()).toBe(
            "<p>mine</p>",
        );
        expect(zip.get("my game.app/Contents/Resources/icon.png")?.bytes.toString()).not.toBe(
            "sample icon",
        );
        expect(zip.get(`my game.app/${MACOS_EXE}`)?.mode).toBe(EXEC);
        expect(zip.get(`my game.app/${MACOS_ICNS}`)?.bytes.subarray(0, 4).toString()).toBe("icns");
        expect(zip.get(`my game.app/${MACOS_FRAMEWORK}/Versions/Current`)?.mode).toBe(LINK);
        expect(zip.get(`my game.app/${MACOS_FRAMEWORK}/Versions/Current`)?.bytes.toString()).toBe(
            "A",
        );
        expect(
            zip.has(
                "my game.app/Contents/Frameworks/roves-cef-macos-gate Helper.app/Contents/Info.plist",
            ),
        ).toBe(true);

        // No project icon: the sample icon is dropped, the Roves .icns stays.
        const plain = await dist(join(tmp, "plain"));
        const none = await resolveProjectIcon({
            platform: "macos",
            contentDir: plain,
            workDir: join(tmp, "icon2"),
        });
        expect(none.summary).toContain("app icon roves");
        const zip2 = await build(
            baseZip,
            "macos",
            options(plain, join(tmp, "work"), { ...top, icon: none }),
            join(tmp, "plain.zip"),
        );
        expect(zip2.has("my game.app/Contents/Resources/icon.png")).toBe(false);
        expect(zip2.get(`my game.app/${MACOS_ICNS}`)?.bytes.toString()).toBe("roves icns");
    });
});

describe("Windows icon precedence", () => {
    async function assembleWithIcon(tmp: string, content: string, icon: ProjectIcon) {
        let patched: string | undefined;
        const out = join(tmp, "out.zip");
        const zip = await build(
            await windowsBase(tmp),
            "windows",
            options(content, join(tmp, "work"), {
                icon,
                patchExe: async (exe, ico) => {
                    expect(exe).toBe(join(tmp, "work", "play.exe"));
                    patched = ico;
                },
            }),
            out,
        );
        (await open(out, "windows")).close();
        return { patched, zip };
    }

    it("uses the game PNG, then the game ICO, then the Roves icon", async () => {
        const tmp = await tempDir();
        const fallback = await icoFile(join(tmp, "roves.ico"), 256);

        const withPng = await dist(join(tmp, "png"));
        await pngFile(join(withPng, "icon.png"), 512);
        let icon = await resolveProjectIcon({
            platform: "windows",
            contentDir: withPng,
            fallbackIco: fallback,
            workDir: join(tmp, "i1"),
        });
        expect(icon.summary).toBe(
            "window project (game icon.png 512x512); executable project (ICO generated from game icon.png)",
        );
        let result = await assembleWithIcon(join(tmp, "a"), withPng, icon);
        expect(await checkIco(result.patched as string)).toBe(256);
        expect(result.zip.get("my game/PROVENANCE.txt")?.bytes.toString()).toContain(
            "icon resource was replaced",
        );

        const withFavicon = await dist(join(tmp, "favicon"));
        const favicon = await icoFile(join(withFavicon, "favicon.ico"), 48);
        icon = await resolveProjectIcon({
            platform: "windows",
            contentDir: withFavicon,
            fallbackIco: fallback,
            workDir: join(tmp, "i2"),
        });
        result = await assembleWithIcon(join(tmp, "b"), withFavicon, icon);
        expect(result.patched).toBe(favicon);
        expect(await decodePngSize(result.zip.get("my game/icon.png")?.bytes as Buffer)).toEqual([
            48, 48,
        ]);

        const none = await dist(join(tmp, "none"));
        icon = await resolveProjectIcon({
            platform: "windows",
            contentDir: none,
            fallbackIco: fallback,
            workDir: join(tmp, "i3"),
        });
        expect(icon.windowPng).toBeUndefined();
        expect(icon.summary).toContain("executable roves");
        result = await assembleWithIcon(join(tmp, "c"), none, icon);
        expect(result.patched).toBe(fallback);
        expect(result.zip.has("my game/icon.png")).toBe(false);

        icon = await resolveProjectIcon({
            platform: "windows",
            contentDir: none,
            workDir: join(tmp, "i4"),
        });
        expect(icon.exeIco).toBeUndefined();
        expect(icon.summary).toContain("executable unchanged");
    });
});

describe("content and provenance", () => {
    it("refuses content without index.html", async () => {
        const tmp = await tempDir();
        const content = join(tmp, "dist");
        await write(content, "main.js", "x");
        const base = await open(await windowsBase(tmp), "windows");
        await expect(
            assemble(base, options(content, join(tmp, "work")), join(tmp, "out.zip")),
        ).rejects.toThrow(/no index.html/);
        base.close();
    });

    it("drops the MCP section unless MCP is on", () => {
        const text = "﻿Engine\r\n  x\r\n\r\nMCP-enabled development package\r\n  mcp\\enabled\r\n";
        const off = rewriteProvenance(text, {
            platform: "windows",
            executable: "play.exe",
            enableMcp: false,
            icon: { summary: "s" },
        });
        expect(off.startsWith("Engine\r\n")).toBe(true);
        expect(off).not.toContain("MCP-enabled development package");
        expect(off).toContain("  icons: s\r\n");
        const on = rewriteProvenance(text, {
            platform: "windows",
            executable: "play.exe",
            enableMcp: true,
            icon: { summary: "" },
        });
        expect(on).toContain("MCP-enabled development package");
        const linux = rewriteProvenance(text, {
            platform: "linux",
            executable: "x",
            enableMcp: false,
            icon: { summary: "" },
        });
        expect(linux).not.toContain("Local MCP bridge");
    });
});
