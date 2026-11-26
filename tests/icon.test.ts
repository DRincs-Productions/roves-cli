import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    checkIco,
    checkPng,
    generateIcns,
    generateIco,
    ICNS_TYPES,
    resolveProjectIcon,
} from "../src/icon";
import { decodePngSize, dist, icoFile, pngFile, tempDir, write } from "./helpers";

/** `(OSType, PNG edge)` of every element of an .icns. */
async function icnsElements(path: string): Promise<[string, number][]> {
    const data = await readFile(path);
    expect(data.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(data.readUInt32BE(4)).toBe(data.length);
    const out: [string, number][] = [];
    for (let at = 8; at < data.length; ) {
        const type = data.subarray(at, at + 4).toString("latin1");
        const length = data.readUInt32BE(at + 4);
        const [width] = await decodePngSize(data.subarray(at + 8, at + length));
        out.push([type, width]);
        at += length;
    }
    return out;
}

describe("generated icons", () => {
    it("writes one decodable PNG frame per ICO size", async () => {
        const tmp = await tempDir();
        const source = await pngFile(join(tmp, "icon.png"), 512);
        const ico = join(tmp, "out.ico");
        await generateIco(source, ico, [16, 32, 256]);
        const bytes = await readFile(ico);
        expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
        expect(bytes.readUInt16LE(4)).toBe(3);
        expect(await checkIco(ico)).toBe(256);
    });

    it("writes every iconset element up to the source edge, never upscaled", async () => {
        const tmp = await tempDir();
        const big = join(tmp, "big.icns");
        await generateIcns(await pngFile(join(tmp, "big.png"), 1024), big);
        expect(await icnsElements(big)).toEqual(ICNS_TYPES.map(([type, size]) => [type, size]));
        const small = join(tmp, "small.icns");
        await generateIcns(await pngFile(join(tmp, "small.png"), 48), small);
        expect(await icnsElements(small)).toEqual([
            ["icp4", 16],
            ["ic11", 32],
            ["icp5", 32],
        ]);
    });
});

describe("icon rules", () => {
    it("refuses non-square, too small, too large, truncated and oversized PNGs", async () => {
        const tmp = await tempDir();
        for (const [name, width, height] of [
            ["non-square", 256, 128],
            ["tiny", 8, 8],
            ["huge", 4096, 4096],
        ] as const) {
            const path = await pngFile(join(tmp, `${name}.png`), width, 0xff, height);
            await expect(checkPng(path)).rejects.toThrow();
        }
        const good = await pngFile(join(tmp, "good.png"), 256);
        expect(await checkPng(good)).toBe(256);
        const bytes = await readFile(good);
        await writeFile(good, bytes.subarray(0, Math.floor(bytes.length / 2)));
        await expect(checkPng(good)).rejects.toThrow();
        await writeFile(good, Buffer.alloc(9 * 1024 * 1024));
        await expect(checkPng(good)).rejects.toThrow(/byte limit/);
    });

    it("lets explicit icons win on every platform and requires them to be valid", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await pngFile(join(content, "icon.png"), 256);
        const own = await pngFile(join(tmp, "own.png"), 128);
        for (const platform of ["windows", "macos", "linux"] as const) {
            const icon = await resolveProjectIcon({
                platform,
                contentDir: content,
                iconPng: own,
                workDir: join(tmp, platform),
            });
            expect(icon.windowPng).toBe(own);
            expect(icon.window.detail).toBe("icon-png 128x128");
            expect(icon.exeIco !== undefined).toBe(platform === "windows");
            expect(icon.appIcns !== undefined).toBe(platform === "macos");
        }
        const bad = await write(
            tmp,
            "bad.png",
            Buffer.from("\x89PNG\r\n\x1a\n not really", "latin1"),
        );
        await expect(
            resolveProjectIcon({
                platform: "linux",
                contentDir: content,
                iconPng: bad,
                workDir: join(tmp, "w"),
            }),
        ).rejects.toThrow(/^icon-png /);
        const badIco = await write(tmp, "bad.ico", "nope");
        await expect(
            resolveProjectIcon({
                platform: "windows",
                contentDir: content,
                iconIco: badIco,
                workDir: join(tmp, "w2"),
            }),
        ).rejects.toThrow(/^icon-ico /);
    });

    it("uses an explicit ICO for play.exe and, without a PNG, as the window icon", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const ico = await icoFile(join(tmp, "own.ico"), 64);
        const windows = await resolveProjectIcon({
            platform: "windows",
            contentDir: content,
            iconIco: ico,
            workDir: join(tmp, "w"),
        });
        expect(windows.exeIco).toBe(ico);
        expect(windows.summary).toBe(
            "window project (largest frame of icon-ico 64x64); executable project (icon-ico)",
        );
        const linux = await resolveProjectIcon({
            platform: "linux",
            contentDir: content,
            iconIco: ico,
            workDir: join(tmp, "l"),
        });
        expect(await decodePngSize(await readFile(linux.windowPng as string))).toEqual([64, 64]);
        // With a PNG too, the PNG is the window icon and the explicit ICO still wins for play.exe.
        await pngFile(join(content, "icon.png"), 32);
        const both = await resolveProjectIcon({
            platform: "windows",
            contentDir: content,
            iconIco: ico,
            workDir: join(tmp, "b"),
        });
        expect(both.summary).toBe(
            "window project (game icon.png 32x32); executable project (icon-ico)",
        );
    });

    it("warns about malformed game icons and falls back to the Roves icon", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const fallback = await icoFile(join(tmp, "roves.ico"), 256);
        await write(content, "icon.png", "<html>not an image</html>");
        const broken = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(30, 0xff)]);
        await write(content, "favicon.ico", broken);
        const icon = await resolveProjectIcon({
            platform: "windows",
            contentDir: content,
            fallbackIco: fallback,
            workDir: join(tmp, "w"),
        });
        expect(icon.summary).toBe(
            "window roves (no project icon (embedded Roves logo)); executable roves (Roves fallback icon)",
        );
        expect(icon.warnings).toHaveLength(2);
    });
});
