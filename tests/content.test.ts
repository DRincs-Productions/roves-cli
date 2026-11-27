import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    CONTENT_MANIFEST,
    packContent,
    parseArchiveSize,
    planArchives,
    shellReadsPackedContent,
    validateCompressionLevel,
} from "../src/content";
import { bundleDesktop, validateDesktopOptions } from "../src/desktop";
import { ZipReader } from "../src/zip";
import { dist, fileNames, readZip, tempDir, windowsBase, write } from "./helpers";

/** A build with code, a root asset and two asset folders (one nested, one with a space). */
async function game(root: string): Promise<string> {
    await write(root, "index.html", "<script type=module src=assets/main.js></script>");
    await write(root, "assets/main.js", "export {};\n".repeat(200));
    await write(root, "assets/chunk-a.js", "a");
    await write(root, "assets/style.css", "body{}");
    await write(root, "assets/img/bg.png", Buffer.alloc(3_000, 1));
    await write(root, "assets/img/text.txt", "lorem ipsum ".repeat(500));
    await write(root, "sounds/a.ogg", Buffer.alloc(1_200_000, 2));
    await write(root, "sounds/b.ogg", Buffer.alloc(1_200_000, 3));
    await write(root, "my folder/x.bin", "x");
    await write(root, "favicon.ico", "ico");
    return root;
}

async function entries(path: string) {
    const reader = await ZipReader.open(path);
    const out = new Map<string, { compressed: boolean; bytes: Buffer }>();
    try {
        for (const info of reader.entries) {
            out.set(info.name, { compressed: info.compressed, bytes: await reader.read(info) });
        }
    } finally {
        reader.close();
    }
    return out;
}

describe("packed content plan", () => {
    it("puts all code in code.pack and groups assets by top-level folder, split by size", async () => {
        const root = await game(join(await tempDir(), "dist"));
        const plan = await planArchives(root, 2_000_000);
        expect(plan.map((a) => [a.name, a.files.map((f) => f.rel)])).toEqual([
            [
                "code.pack",
                ["assets/chunk-a.js", "assets/main.js", "assets/style.css", "index.html"],
            ],
            ["data-assets.pack", ["assets/img/bg.png", "assets/img/text.txt"]],
            ["data-root.pack", ["favicon.ico"]],
            ["data-my_folder.pack", ["my folder/x.bin"]],
            ["data-sounds.pack", ["sounds/a.ogg"]],
            ["data-sounds-2.pack", ["sounds/b.ogg"]],
        ]);
    });

    it("needs index.html", async () => {
        const root = join(await tempDir(), "dist");
        await write(root, "main.js", "x");
        await expect(planArchives(root, 1_000_000)).rejects.toThrow(/no index.html/);
    });
});

describe("packContent", () => {
    it("stores every entry by default and writes the manifest", async () => {
        const tmp = await tempDir();
        const root = await game(join(tmp, "dist"));
        const out = join(tmp, "packed");
        await (await import("node:fs/promises")).mkdir(out);
        const packed = await packContent(root, out);
        expect(packed.compressed).toBe(false);
        expect(packed.files[0]).toBe(CONTENT_MANIFEST);
        const manifest = JSON.parse(await readFile(join(out, CONTENT_MANIFEST), "utf8"));
        expect(manifest).toMatchObject({
            format: 1,
            code: "code.pack",
            assets: [
                "data-assets.pack",
                "data-root.pack",
                "data-my_folder.pack",
                "data-sounds.pack",
            ],
            compressionLevel: 0,
            maxArchiveSize: 300_000_000,
        });
        const code = await entries(join(out, "code.pack"));
        expect([...code.keys()]).toContain("index.html");
        expect([...code.values()].every((e) => !e.compressed)).toBe(true);
        const sounds = await entries(join(out, "data-sounds.pack"));
        expect(sounds.get("sounds/b.ogg")?.bytes.equals(Buffer.alloc(1_200_000, 3))).toBe(true);
    });

    it("compresses code and text at a level but always stores media", async () => {
        const tmp = await tempDir();
        const root = await game(join(tmp, "dist"));
        const out = join(tmp, "packed");
        await (await import("node:fs/promises")).mkdir(out);
        const packed = await packContent(root, out, { compressionLevel: 9 });
        expect(packed.compressed).toBe(true);
        expect(packed.summary).toContain("compression level 9");
        const code = await entries(join(out, "code.pack"));
        expect(code.get("assets/main.js")?.compressed).toBe(true);
        expect(code.get("assets/main.js")?.bytes.toString()).toBe("export {};\n".repeat(200));
        const assets = await entries(join(out, "data-assets.pack"));
        expect(assets.get("assets/img/text.txt")?.compressed).toBe(true);
        expect(assets.get("assets/img/bg.png")?.compressed).toBe(false);
    });

    it("is deterministic", async () => {
        const tmp = await tempDir();
        const root = await game(join(tmp, "dist"));
        const fs = await import("node:fs/promises");
        const [a, b] = [join(tmp, "a"), join(tmp, "b")];
        await fs.mkdir(a);
        await fs.mkdir(b);
        await packContent(root, a, { compressionLevel: 6 });
        await packContent(root, b, { compressionLevel: 6 });
        for (const name of ["code.pack", "data-assets.pack", CONTENT_MANIFEST]) {
            expect((await readFile(join(a, name))).equals(await readFile(join(b, name)))).toBe(
                true,
            );
        }
    });
});

describe("options", () => {
    it("validates compression levels and archive sizes", () => {
        expect(validateCompressionLevel("0")).toBe(0);
        expect(validateCompressionLevel(9)).toBe(9);
        expect(() => validateCompressionLevel("10")).toThrow(/0, no compression, to 9/);
        expect(() => validateCompressionLevel("1.5")).toThrow();
        expect(parseArchiveSize("300MB")).toBe(300_000_000);
        expect(parseArchiveSize("1.5 GB")).toBe(1_500_000_000);
        expect(parseArchiveSize("512MiB")).toBe(512 * 2 ** 20);
        expect(parseArchiveSize("2000000")).toBe(2_000_000);
        expect(() => parseArchiveSize("10KB")).toThrow(/too small/);
        expect(() => parseArchiveSize("big")).toThrow(/expected e.g. 300MB/);
    });

    it("knows which players read packed content", () => {
        expect(shellReadsPackedContent("v0.9.0")).toBe(false);
        expect(shellReadsPackedContent("v0.9.1")).toBe(true);
        expect(shellReadsPackedContent("v0.10.0")).toBe(true);
        expect(shellReadsPackedContent("v1.0.0-rc.1")).toBe(true);
    });

    it("falls back to loose files for an older player unless archives are asked for", async () => {
        const content = await dist(join(await tempDir(), "dist"));
        const auto = await validateDesktopOptions({ contentDir: content, shellVersion: "v0.9.0" });
        expect(auto.contentLayout).toBe("files");
        expect(auto.warnings[0]).toMatch(/predates packed content/);
        await expect(
            validateDesktopOptions({
                contentDir: content,
                shellVersion: "v0.9.0",
                contentLayout: "archive",
            }),
        ).rejects.toThrow(/needs the player v0.9.1/);
        const newer = await validateDesktopOptions({ contentDir: content, shellVersion: "v0.9.1" });
        expect(newer.contentLayout).toBe("archive");
    });
});

describe("bundleDesktop with packed content", () => {
    it("puts the archives and the manifest in game/, or loose files on request", async () => {
        const tmp = await tempDir();
        const content = await game(join(tmp, "dist"));
        const shellZip = await windowsBase(tmp);
        const [packed] = await bundleDesktop({
            contentDir: content,
            platforms: ["windows"],
            shellZip,
            name: "g",
            outDir: join(tmp, "out"),
            extract: false,
            compressionLevel: 6,
            maxArchiveSize: "1MB",
            patchExe: async () => {},
        });
        expect(packed?.contentLayout).toBe("archive");
        const zip = await readZip(packed?.archivePath as string);
        const gameFiles = fileNames(zip)
            .filter((n) => n.startsWith("g/game/"))
            .sort();
        expect(gameFiles).toEqual([
            "g/game/code.pack",
            "g/game/data-assets.pack",
            "g/game/data-my_folder.pack",
            "g/game/data-root.pack",
            "g/game/data-sounds-2.pack",
            "g/game/data-sounds.pack",
            "g/game/roves-content.json",
        ]);
        const sums = zip.get("g/SHA256SUMS.txt")?.bytes.toString() ?? "";
        expect(sums).toContain("  game/code.pack");
        expect(sums).not.toContain("game/index.html");

        const [loose] = await bundleDesktop({
            contentDir: content,
            platforms: ["windows"],
            shellZip,
            name: "h",
            outDir: join(tmp, "out"),
            extract: false,
            contentLayout: "files",
            patchExe: async () => {},
        });
        expect(loose?.contentLayout).toBe("files");
        const files = fileNames(await readZip(loose?.archivePath as string));
        expect(files).toContain("h/game/index.html");
        expect(files).not.toContain("h/game/roves-content.json");
    });
});
