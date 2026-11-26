/**
 * Synthetic player packages, mirroring the fixtures of Roves Packmaster's `cef_player.rs` tests:
 * small zips with the layout, Unix modes, symlinks and checksums of the engine's release assets.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { afterEach } from "vitest";
import yazl from "yazl";
import { generateIco } from "../src/icon";
import { ZipReader } from "../src/zip";

export const FILE = 0o100644;
export const EXEC = 0o100755;
export const SETUID = 0o104755;
export const LINK = 0o120777;
export const LINUX_EXE = "roves-cef-linux-gate";
export const MACOS_EXE = "Contents/MacOS/roves-cef-macos-gate";
export const MACOS_ICNS = "Contents/Resources/roves-cef-macos-gate.icns";
export const MACOS_FRAMEWORK = "Contents/Frameworks/Chromium Embedded Framework.framework";
export const MCP_FILES = [
    "enabled",
    "server.mjs",
    "README.md",
    "node_modules/@modelcontextprotocol/server/package.json",
];
export const MACOS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>roves-cef-macos-gate</string>
<key>CFBundleIconFile</key><string>roves-cef-macos-gate</string>
</dict></plist>`;

/** Package-relative path -> (bytes, full Unix mode). For symlinks the bytes are the target. */
export type Files = Map<string, { bytes: Buffer; mode: number }>;

export function put(files: Files, rel: string, bytes: string | Buffer, mode = FILE): void {
    files.set(rel, { bytes: Buffer.from(bytes), mode });
}

export function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function withChecksums(files: Files): void {
    let sums = "";
    for (const [rel, { bytes, mode }] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if ((mode & 0o170000) === 0o120000) continue;
        sums += `${sha256(bytes)}  ${rel}\r\n`;
    }
    put(files, "SHA256SUMS.txt", sums);
}

/** Writes `files` (and directory entries for their parents) under `top` (`""`: zip root). */
export async function writeZip(path: string, top: string, files: Files): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const zip = new yazl.ZipFile();
    const done = new Promise<void>((resolve, reject) => {
        const out = createWriteStream(path);
        out.on("close", () => resolve());
        out.on("error", reject);
        zip.outputStream.pipe(out);
    });
    const prefix = top ? `${top}/` : "";
    const dirs = new Set<string>();
    for (const rel of files.keys()) {
        const parts = rel.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    if (prefix) zip.addEmptyDirectory(prefix, { mode: 0o40755 });
    for (const dir of [...dirs].sort())
        zip.addEmptyDirectory(`${prefix}${dir}/`, { mode: 0o40755 });
    for (const [rel, { bytes, mode }] of files) {
        zip.addBuffer(bytes, `${prefix}${rel}`, { mode });
    }
    zip.end();
    await done;
    return path;
}

export interface ZipContent {
    bytes: Buffer;
    mode: number | undefined;
}

/** The zip's entries: name -> (bytes, raw Unix mode); directories end with a slash. */
export async function readZip(path: string): Promise<Map<string, ZipContent>> {
    const reader = await ZipReader.open(path);
    const out = new Map<string, ZipContent>();
    try {
        for (const info of reader.entries) {
            out.set(info.name, {
                bytes: info.isDirectory ? Buffer.alloc(0) : await reader.read(info),
                mode: info.mode,
            });
        }
    } finally {
        reader.close();
    }
    return out;
}

export function fileNames(zip: Map<string, ZipContent>): string[] {
    return [...zip.keys()].filter((name) => !name.endsWith("/"));
}

/** A Windows base like the engine's; `sampleGame` adds an older base's `game/` and template provenance. */
export function windowsFiles(options: { mcp?: boolean; sampleGame?: boolean } = {}): Files {
    const files: Files = new Map();
    for (const file of [
        "play.exe",
        "play.dll",
        "play.exe.manifest",
        "libcef.dll",
        "locales/en-US.pak",
    ]) {
        put(files, file, file);
    }
    put(files, "provenance/Cargo.lock", "lock");
    let provenance = "Engine\r\n  commit abc\r\n";
    if (options.sampleGame) {
        put(files, "game/index.html", "<p>sample</p>");
        put(files, "game/assets/sample.js", "sample");
        put(files, "icon.png", "sample icon");
        put(files, "provenance/visual-novel-template-npm-ls.txt", "template");
        provenance += "\r\nGame (folder game\\)\r\n  template\r\n";
    }
    if (options.mcp) {
        for (const file of MCP_FILES) put(files, `mcp/${file}`, "mcp");
        put(files, "provenance/mcp-npm-ls.txt", "mcp deps");
        put(files, "mcp/node_modules/.package-lock.json", "{}");
        provenance +=
            "\r\nMCP-enabled development package (enable-mcp=true; never ship to players)\r\n  mcp\\enabled\r\n";
    }
    put(files, "PROVENANCE.txt", provenance);
    return files;
}

export async function windowsBase(
    dir: string,
    options: { mcp?: boolean; sampleGame?: boolean; steam?: boolean; rovesIco?: Buffer } = {},
): Promise<string> {
    const files = windowsFiles(options);
    if (options.steam) put(files, "steam_api64.dll", "steam");
    if (options.rovesIco) put(files, "roves.ico", options.rovesIco);
    withChecksums(files);
    return writeZip(join(dir, "windows.zip"), "roves", files);
}

export function putMcp(files: Files, mcpDir: string): void {
    for (const file of MCP_FILES) put(files, `${mcpDir}/${file}`, "mcp");
    put(files, `${mcpDir}/package.json`, "{}");
    put(files, `${mcpDir}/node_modules/.package-lock.json`, "{}");
}

export async function linuxBase(
    dir: string,
    options: { steam?: boolean; mcp?: boolean; sampleGame?: boolean } = {},
): Promise<string> {
    const files: Files = new Map();
    put(files, LINUX_EXE, "elf", EXEC);
    put(files, "libcef.so", "cef", EXEC);
    put(files, "chrome-sandbox", "sandbox", SETUID);
    put(files, "chrome_crashpad_handler", "crashpad", EXEC);
    put(files, "icudtl.dat", "icu");
    put(files, "resources.pak", "pak");
    put(files, "libvk_swiftshader.so.1", "vk", EXEC);
    put(files, "libvk_swiftshader.so", "libvk_swiftshader.so.1", LINK);
    if (options.sampleGame) put(files, "game/index.html", "<p>sample</p>");
    if (options.steam) put(files, "libsteam_api.so", "steam", EXEC);
    if (options.mcp) putMcp(files, "mcp");
    return writeZip(
        join(dir, `linux${options.steam ? "-steam" : ""}${options.mcp ? "-mcp" : ""}.zip`),
        "roves-cef-linux",
        files,
    );
}

export async function macosBase(
    dir: string,
    options: { mcp?: boolean; sampleGame?: boolean } = {},
): Promise<string> {
    const files: Files = new Map();
    put(files, "Contents/Info.plist", MACOS_PLIST);
    put(files, MACOS_EXE, "macho", EXEC);
    put(files, MACOS_ICNS, "roves icns");
    put(files, `${MACOS_FRAMEWORK}/Versions/A/Chromium Embedded Framework`, "cef", EXEC);
    put(files, `${MACOS_FRAMEWORK}/Versions/Current`, "A", LINK);
    put(
        files,
        `${MACOS_FRAMEWORK}/Chromium Embedded Framework`,
        "Versions/Current/Chromium Embedded Framework",
        LINK,
    );
    put(
        files,
        "Contents/Frameworks/roves-cef-macos-gate Helper.app/Contents/Info.plist",
        "<plist/>",
    );
    if (options.sampleGame) {
        put(files, "Contents/Resources/game/index.html", "<p>sample</p>");
        put(files, "Contents/Resources/icon.png", "sample icon");
    }
    if (options.mcp) putMcp(files, "Contents/Resources/mcp");
    return writeZip(
        join(dir, `macos${options.mcp ? "-mcp" : ""}.zip`),
        "roves-cef-macos-gate.app",
        files,
    );
}

/** A temporary directory removed after the current test. */
const temps: string[] = [];
afterEach(async () => {
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});
export async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "roves-cli-test-"));
    temps.push(dir);
    return dir;
}

export async function write(root: string, rel: string, bytes: string | Buffer): Promise<string> {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
}

/** A tiny game build: `index.html` and `assets/app.js`. */
export async function dist(root: string): Promise<string> {
    await write(root, "index.html", "<p>mine</p>");
    await write(root, "assets/app.js", "mine");
    return root;
}

const Jimp = createJimp({ formats: [png] });

export async function pngFile(path: string, width: number, color = 0xc81e1eff, height = width) {
    const image = new Jimp({ width, height, color });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await image.getBuffer("image/png"));
    return path;
}

export async function decodePngSize(bytes: Buffer): Promise<[number, number]> {
    const image = await Jimp.read(bytes);
    return [image.bitmap.width, image.bitmap.height];
}

/** An ICO with a 16 px frame and an `edge` px frame. */
export async function icoFile(path: string, edge: number, color = 0x1e1ec8ff): Promise<string> {
    const source = `${path}.source.png`;
    await pngFile(source, edge, color);
    await generateIco(source, path, edge === 16 ? [16] : [16, edge]);
    await rm(source);
    return path;
}
