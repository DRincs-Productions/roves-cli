/**
 * Zip-to-zip assembly of a desktop package: every engine entry of the base is copied with the
 * same bytes, compression choice, Unix mode and file type (executables, the setuid
 * `chrome-sandbox`, framework symlinks), so the result is correct whichever host builds it;
 * only the files this tool adds or replaces are written anew.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    CHECKSUMS,
    GAME_DIR,
    joinRel,
    LAYOUT,
    MCP_PROVENANCE_HEADER,
    MCP_REQUIRED,
    mcpDir,
    type PlayerBase,
    PROJECT_ICON_FILE,
    PROVENANCE,
    STEAM_APP_ID_FILE,
    WINDOWS_EXE,
} from "./base";
import type { DesktopPlatform } from "./constants";
import { CONTENT_MANIFEST, type PackedContent } from "./content";
import { RovesError } from "./errors";
import { setExeIcon } from "./exe-icon";
import type { ProjectIcon } from "./icon";
import { S_IFDIR, S_IFREG, sha256File, walkDirectory, ZipWriter } from "./zip";

/** Mode of the files this tool writes (game files, icons, `steam_appid.txt`). */
const FILE_MODE = S_IFREG | 0o644;
const DIR_MODE = S_IFDIR | 0o755;
const EXE_MODE = S_IFREG | 0o755;

export interface AssembleOptions {
    /** The developer's build output (must contain `index.html`). */
    contentDir: string;
    /** The same build packed into archives (`packContent`); `game/` then holds these files. */
    packed?: PackedContent;
    /** Top-level folder of the output zip: `<name>` (Windows/Linux) or `<name>.app` (macOS). */
    topFolder: string;
    /** Keep the base's local MCP bridge (the `_mcp` asset's `mcp/` folder). */
    enableMcp: boolean;
    /** Written to `steam_appid.txt` next to the executable. */
    steamAppId?: string;
    icon: ProjectIcon;
    /** Scratch directory (the patched `play.exe`). */
    workDir: string;
    /** Where the base came from (URL or path), recorded in `PROVENANCE.txt`. */
    baseNote?: string;
    /** Patches `play.exe`'s icon resource in place; `setExeIcon` by default. */
    patchExe?: (exe: string, ico: string) => Promise<void>;
}

type Source = { file: string; compress?: boolean } | { bytes: Buffer };

/**
 * Writes `outZip`: the base's entries (raw copies) with the game replaced by `contentDir`, the
 * MCP choice, the resolved project icon, `steam_appid.txt`, a rewritten `PROVENANCE.txt` and a
 * regenerated `SHA256SUMS.txt` when the base has them. A partial output is removed on failure.
 */
export async function assemble(
    base: PlayerBase,
    options: AssembleOptions,
    outZip: string,
): Promise<void> {
    const platform = base.platform;
    if (options.enableMcp && !base.mcpCapable) {
        throw new RovesError(
            `the local MCP bridge is enabled, but the ${platform} player package is not a complete MCP-enabled package (it needs the roves_shell_${platform}_mcp.zip release asset)`,
        );
    }
    if (!(await stat(join(options.contentDir, "index.html")).catch(() => null))?.isFile()) {
        throw new RovesError(`${options.contentDir} has no index.html at its root`);
    }
    await rm(outZip, { force: true });
    const writer = new ZipWriter(outZip);
    try {
        await writePackage(base, options, writer);
        await writer.finish();
    } catch (error) {
        await writer.abort();
        throw error;
    }
}

async function writePackage(
    base: PlayerBase,
    options: AssembleOptions,
    writer: ZipWriter,
): Promise<void> {
    const platform = base.platform;
    const layout = LAYOUT[platform];
    const gameDir = joinRel(layout.resourcesDir, GAME_DIR);
    const windowIcon = joinRel(layout.resourcesDir, PROJECT_ICON_FILE);
    const steamAppIdFile = joinRel(layout.exeDir, STEAM_APP_ID_FILE);
    const mcp = mcpDir(platform);
    const inMcpDir = (rel: string) => rel === mcp || rel.startsWith(`${mcp}/`);
    const mcpMarker = joinRel(mcp, MCP_REQUIRED[0]);

    // Files this tool writes, (package-relative path, source).
    const added: [string, Source][] = [];
    const addedDirs = [gameDir];
    if (options.packed) {
        const { dir, files, compressed } = options.packed;
        for (const name of files) {
            // Compressed archives are stored in the package zip: deflating them again is wasted.
            const compress = !compressed || name === CONTENT_MANIFEST;
            added.push([`${gameDir}/${name}`, { file: join(dir, name), compress }]);
        }
    } else {
        for (const rel of await walkDirectory(options.contentDir)) {
            if (rel.endsWith("/")) addedDirs.push(`${gameDir}/${rel.slice(0, -1)}`);
            else added.push([`${gameDir}/${rel}`, { file: join(options.contentDir, rel) }]);
        }
    }
    if (options.icon.windowPng) added.push([windowIcon, { file: options.icon.windowPng }]);
    if (options.icon.appIcns && base.bundleIcns) {
        added.push([base.bundleIcns, { file: options.icon.appIcns }]);
    }
    if (options.icon.exeIco && platform === "windows") {
        await mkdir(options.workDir, { recursive: true });
        const exe = join(options.workDir, WINDOWS_EXE);
        await writeFile(exe, await base.read(WINDOWS_EXE));
        await (options.patchExe ?? setExeIcon)(exe, options.icon.exeIco);
        added.push([WINDOWS_EXE, { file: exe }]);
    }
    if (options.steamAppId) {
        added.push([steamAppIdFile, { bytes: Buffer.from(options.steamAppId, "utf8") }]);
    }
    if (base.isFile(PROVENANCE)) {
        const provenance = (await base.read(PROVENANCE)).toString("utf8");
        added.push([
            PROVENANCE,
            {
                bytes: Buffer.from(
                    rewriteProvenance(provenance, {
                        platform,
                        executable: base.executable,
                        enableMcp: options.enableMcp,
                        icon: options.icon,
                        baseNote: options.baseNote,
                    }),
                    "utf8",
                ),
            },
        ]);
    }

    const replaced = new Set(added.map(([rel]) => rel));
    const excluded = (rel: string) =>
        rel === gameDir ||
        rel.startsWith(`${gameDir}/`) ||
        rel === windowIcon ||
        rel === steamAppIdFile ||
        rel === CHECKSUMS ||
        replaced.has(rel) ||
        // Provenance of a sample game in older bases (release assets are shell only since v0.9.0).
        rel.startsWith("provenance/visual-novel-template-") ||
        (!options.enableMcp && (inMcpDir(rel) || rel.startsWith("provenance/mcp-")));
    const kept = [...base.entries].filter(([rel]) => !excluded(rel));

    const top = options.topFolder;
    writer.addDirectory(`${top}/`, DIR_MODE);
    const hashes = new Map<string, string>();
    for (const [rel, entry] of kept) {
        if (entry.isDirectory) {
            writer.addDirectory(`${top}/${rel}/`, entry.mode ?? DIR_MODE, entry.mtime);
            continue;
        }
        writer.addLazyStream(`${top}/${rel}`, () => base.zip.openStream(entry), {
            mode: entry.mode ?? FILE_MODE,
            mtime: entry.mtime,
            compress: entry.compressed,
            size: entry.uncompressedSize,
        });
        const sum = base.checksums?.get(rel);
        if (sum) hashes.set(rel, sum);
    }
    for (const dir of addedDirs) writer.addDirectory(`${top}/${dir}/`, DIR_MODE);
    for (const [rel, source] of added) {
        const mode = rel === base.executable ? EXE_MODE : FILE_MODE;
        if ("bytes" in source) {
            writer.addBuffer(`${top}/${rel}`, source.bytes, { mode });
            hashes.set(rel, createHash("sha256").update(source.bytes).digest("hex"));
        } else {
            writer.addFile(source.file, `${top}/${rel}`, { mode, compress: source.compress });
            hashes.set(rel, await sha256File(source.file));
        }
    }
    if (base.checksums) {
        const lines = [...hashes]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([rel, hash]) => `${hash}  ${rel}\r\n`)
            .join("");
        writer.addBuffer(`${top}/${CHECKSUMS}`, Buffer.from(lines, "utf8"), { mode: FILE_MODE });
    }

    const hasMarker = replaced.has(mcpMarker) || kept.some(([rel]) => rel === mcpMarker);
    const hasMcpDir = kept.some(([rel]) => inMcpDir(rel));
    if (options.enableMcp !== hasMarker || (!options.enableMcp && hasMcpDir)) {
        throw new RovesError(
            "internal error: the MCP state of the assembled package does not match the setting",
        );
    }
}

export interface ProvenanceOptions {
    platform: DesktopPlatform;
    executable: string;
    enableMcp: boolean;
    icon: Pick<ProjectIcon, "exeIco" | "summary">;
    baseNote?: string;
}

/**
 * The base's `PROVENANCE.txt` with the MCP section dropped when MCP is off, plus a "game
 * replaced" note (CRLF line endings, like the engine's).
 */
export function rewriteProvenance(text: string, options: ProvenanceOptions): string {
    let lines = text.replace(/^﻿/, "").split(/\r?\n/);
    if (!options.enableMcp) {
        const at = lines.findIndex((line) => line.startsWith(MCP_PROVENANCE_HEADER));
        if (at >= 0) lines = lines.slice(0, at);
    }
    while (lines.length > 0 && !(lines[lines.length - 1] as string).trim()) lines.pop();
    const out = [
        ...lines,
        "",
        "Game replaced by @drincs/roves-cli",
        "  the game folder contains the developer's own build output; any sample game of the",
        "  base package and its provenance files were removed.",
    ];
    if (options.icon.exeIco && options.platform === "windows") {
        out.push(
            `  engine files are the base package's; only ${options.executable}'s icon resource was replaced`,
            "  (resedit).",
        );
    } else {
        out.push("  engine files are the base package's, unmodified.");
    }
    if (options.icon.summary) out.push(`  icons: ${options.icon.summary}`);
    if (options.baseNote) out.push(`  base: ${options.baseNote}`);
    if (options.platform === "windows") {
        out.push(
            ...(options.enableMcp
                ? [
                      "  Local MCP bridge: ON (mcp\\enabled kept). Development and playtests only: any program",
                      "  running as your Windows user can read and control the running game. Never ship to players.",
                  ]
                : ["  Local MCP bridge: OFF (no mcp\\ folder, no activation marker)."]),
        );
    }
    return `${out.join("\r\n")}\r\n`;
}
