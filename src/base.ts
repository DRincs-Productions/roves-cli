/**
 * The engine's desktop player packages (release assets `roves_shell_<platform>[_steam|_mcp].zip`,
 * engine v0.9.0+). Each asset is the player shell without a game (any `game/` an older base
 * carries is dropped on assembly):
 *
 * | | package root | executable | `game/` and window `icon.png` |
 * | --- | --- | --- | --- |
 * | Windows | folder | `play.exe` | next to `play.exe` |
 * | macOS | `<name>.app` | `Contents/MacOS/<CFBundleExecutable>` | `Contents/Resources/` |
 * | Linux | folder | the only executable that is not a CEF helper | next to the executable |
 *
 * The zip may hold the package root directly or inside a single top folder. Kept in step with
 * Roves Packmaster's `src-tauri/src/cef_player.rs` and roves-action's `cef/assemble.*`.
 */
import { parse as parsePlist } from "plist";
import type { DesktopPlatform } from "./constants";
import { RovesError } from "./errors";
import { ZipReader, type ZipEntryInfo } from "./zip";

export const CHECKSUMS = "SHA256SUMS.txt";
export const PROVENANCE = "PROVENANCE.txt";
/** Window icon file name, in the platform's resources folder (read by the player at startup). */
export const PROJECT_ICON_FILE = "icon.png";
/** The official Roves icon the Windows base ships, the `play.exe` fallback. */
export const ROVES_FALLBACK_ICO = "roves.ico";
export const STEAM_APP_ID_FILE = "steam_appid.txt";
export const GAME_DIR = "game";
export const MCP_DIR = "mcp";
/** Written by the engine CI at the end of the Windows `PROVENANCE.txt` of the `_mcp` asset. */
export const MCP_PROVENANCE_HEADER = "MCP-enabled development package";
/** Files of a complete MCP-enabled package, relative to the platform's `mcp/` folder. */
export const MCP_REQUIRED = [
    "enabled",
    "server.mjs",
    "README.md",
    "node_modules/@modelcontextprotocol/server/package.json",
] as const;
export const WINDOWS_EXE = "play.exe";
export const MACOS_INFO_PLIST = "Contents/Info.plist";
export const MACOS_CEF_FRAMEWORK = "Contents/Frameworks/Chromium Embedded Framework.framework";
/** Executables of the Linux package that are not the player (CEF's own helpers). */
const LINUX_NOT_THE_PLAYER = ["chrome-sandbox", "chrome_crashpad_handler"];

export function joinRel(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
}

/** Per-platform layout of a player package. */
export const LAYOUT: Record<
    DesktopPlatform,
    {
        /** File that identifies the package root inside the zip. */
        rootMarker: string;
        /** Folder of the executable: `steam_appid.txt` and the Steamworks redistributable. */
        exeDir: string;
        /** Folder holding `game/`, the window `icon.png` and `mcp/`. */
        resourcesDir: string;
        required: readonly string[];
        steamLibrary: string;
    }
> = {
    windows: {
        rootMarker: WINDOWS_EXE,
        exeDir: "",
        resourcesDir: "",
        required: [
            WINDOWS_EXE,
            "play.dll",
            "play.exe.manifest",
            "libcef.dll",
            PROVENANCE,
            CHECKSUMS,
        ],
        steamLibrary: "steam_api64.dll",
    },
    macos: {
        rootMarker: MACOS_INFO_PLIST,
        exeDir: "Contents/MacOS",
        resourcesDir: "Contents/Resources",
        // Plus the CFBundleExecutable, the CFBundleIconFile and the CEF framework.
        required: [MACOS_INFO_PLIST],
        steamLibrary: "Contents/MacOS/libsteam_api.dylib",
    },
    linux: {
        rootMarker: "libcef.so",
        exeDir: "",
        resourcesDir: "",
        required: ["libcef.so", "chrome-sandbox", "icudtl.dat", "resources.pak"],
        steamLibrary: "libsteam_api.so",
    },
};

export function mcpDir(platform: DesktopPlatform): string {
    return joinRel(LAYOUT[platform].resourcesDir, MCP_DIR);
}

/** The archive prefix (`""` or `"<top folder>/"`) of the only package root in `names`. */
export function locateRoot(names: Iterable<string>, platform: DesktopPlatform): string {
    const marker = LAYOUT[platform].rootMarker;
    const roots = new Set<string>();
    for (const name of names) {
        let prefix: string;
        if (name === marker) prefix = "";
        else if (name.endsWith(`/${marker}`)) prefix = name.slice(0, -marker.length);
        else continue;
        if ((prefix.match(/\//g) ?? []).length <= 1) roots.add(prefix);
    }
    if (roots.size === 0) {
        throw new RovesError(
            `not a Roves ${platform} player package (no ${marker} at its root or in a single top folder)`,
        );
    }
    if (roots.size > 1) {
        throw new RovesError(`contains more than one Roves ${platform} player package`);
    }
    return [...roots][0] as string;
}

/**
 * `(Contents/MacOS/<CFBundleExecutable>, Contents/Resources/<CFBundleIconFile>.icns)`, read from
 * `Info.plist` like roves-action's `cef/assemble.sh` does with PlistBuddy.
 */
export function macosBundleNames(infoPlist: string): { executable: string; icns: string } {
    let parsed: unknown;
    try {
        parsed = parsePlist(infoPlist);
    } catch (error) {
        throw new RovesError(`${MACOS_INFO_PLIST}: ${(error as Error).message}`);
    }
    const key = (name: string): string => {
        const value =
            parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[name] : "";
        if (typeof value !== "string" || !value || value.includes("/")) {
            throw new RovesError(`${MACOS_INFO_PLIST} has no usable ${name}`);
        }
        return value;
    };
    const executable = key("CFBundleExecutable");
    const icon = key("CFBundleIconFile");
    return {
        executable: `Contents/MacOS/${executable}`,
        icns: `Contents/Resources/${icon.replace(/\.icns$/, "")}.icns`,
    };
}

/** An engine player package (release asset zip), checked and ready to assemble from. */
export class PlayerBase {
    /** Verified `SHA256SUMS.txt` (path -> lowercase hex), when the package ships one. */
    checksums: Map<string, string> | undefined;
    /** Complete MCP-enabled package (every MCP file, plus the MCP section of `PROVENANCE.txt`). */
    mcpCapable = false;
    /** The player executable, relative to the package root. */
    executable = WINDOWS_EXE;
    /** macOS: the bundle icon named by `CFBundleIconFile`. */
    bundleIcns: string | undefined;

    private constructor(
        readonly zip: ZipReader,
        readonly platform: DesktopPlatform,
        /** Package-relative path (no trailing slash) -> archive entry, sorted. */
        readonly entries: Map<string, ZipEntryInfo>,
    ) {}

    /**
     * Opens and checks `zipPath`: the platform's required files (plus the Steamworks
     * redistributable exactly when `steam`), `SHA256SUMS.txt` when present (always on Windows),
     * and the MCP capability. Call `close()` when done.
     */
    static async open(
        zipPath: string,
        platform: DesktopPlatform,
        steam: boolean,
    ): Promise<PlayerBase> {
        const zip = await ZipReader.open(zipPath);
        try {
            const base = await PlayerBase.check(zip, zipPath, platform, steam);
            return base;
        } catch (error) {
            zip.close();
            if (error instanceof RovesError) throw error;
            throw new RovesError(`${zipPath}: ${(error as Error).message}`);
        }
    }

    private static async check(
        zip: ZipReader,
        zipPath: string,
        platform: DesktopPlatform,
        steam: boolean,
    ): Promise<PlayerBase> {
        let prefix: string;
        try {
            prefix = locateRoot(
                zip.entries.map((entry) => entry.name),
                platform,
            );
        } catch (error) {
            throw new RovesError(`${zipPath}: ${(error as Error).message}`);
        }
        const entries = new Map<string, ZipEntryInfo>();
        const sorted = zip.entries
            .filter((entry) => entry.name.startsWith(prefix))
            .map((entry) => [entry.name.slice(prefix.length).replace(/\/+$/, ""), entry] as const)
            .filter(([rel]) => rel !== "")
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [rel, entry] of sorted) {
            if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
                throw new RovesError(`the ${platform} player package has an unsafe path: ${rel}`);
            }
            entries.set(rel, entry);
        }
        const base = new PlayerBase(zip, platform, entries);
        const lacks = (rel: string) =>
            new RovesError(`the ${platform} player package lacks ${rel}`);
        const layout = LAYOUT[platform];
        for (const required of layout.required) {
            if (!base.isFile(required)) throw lacks(required);
        }
        if (platform === "macos") {
            const names = macosBundleNames((await base.read(MACOS_INFO_PLIST)).toString("utf8"));
            for (const required of [names.executable, names.icns]) {
                if (!base.isFile(required)) throw lacks(required);
            }
            const framework = `${MACOS_CEF_FRAMEWORK}/`;
            if (![...entries.keys()].some((rel) => `${rel}/`.startsWith(framework))) {
                throw lacks(MACOS_CEF_FRAMEWORK);
            }
            base.executable = names.executable;
            base.bundleIcns = names.icns;
        } else if (platform === "linux") {
            const sandbox = entries.get("chrome-sandbox");
            if (sandbox?.mode === undefined || (sandbox.mode & 0o111) === 0) {
                throw new RovesError(
                    "chrome-sandbox lost its execute bit: the linux player package was not zipped with its Unix modes",
                );
            }
            base.executable = base.linuxExecutable();
        }
        const steamLibrary = layout.steamLibrary;
        const hasSteam = base.isFile(steamLibrary);
        if (steam && !hasSteam) throw lacks(steamLibrary);
        if (!steam && hasSteam) {
            throw new RovesError(
                `the standard ${platform} player package unexpectedly contains ${steamLibrary}`,
            );
        }
        if (base.isFile(CHECKSUMS)) base.checksums = await base.verifyChecksums();
        const mcp = mcpDir(platform);
        base.mcpCapable =
            MCP_REQUIRED.every((file) => base.isFile(joinRel(mcp, file))) &&
            (!base.isFile(PROVENANCE) ||
                (await base.read(PROVENANCE))
                    .toString("utf8")
                    .split(/\r?\n/)
                    .some((line) => line.replace(/^﻿/, "").startsWith(MCP_PROVENANCE_HEADER)));
        return base;
    }

    /**
     * The only root-level file with an execute bit that is neither a CEF helper nor a shared
     * library (the release zip keeps Unix modes, made with Info-ZIP).
     */
    private linuxExecutable(): string {
        const candidates = [...this.entries]
            .filter(
                ([rel, entry]) =>
                    !entry.isDirectory &&
                    !rel.includes("/") &&
                    entry.mode !== undefined &&
                    (entry.mode & 0o111) !== 0 &&
                    !LINUX_NOT_THE_PLAYER.includes(rel) &&
                    !rel.includes(".so"),
            )
            .map(([rel]) => rel);
        if (candidates.length === 1) return candidates[0] as string;
        if (candidates.length === 0) {
            throw new RovesError(
                "the linux player package has no executable (were its Unix modes lost?)",
            );
        }
        throw new RovesError(
            `the linux player package has more than one candidate executable: ${candidates.join(", ")}`,
        );
    }

    isFile(rel: string): boolean {
        const entry = this.entries.get(rel);
        return entry !== undefined && !entry.isDirectory;
    }

    async read(rel: string): Promise<Buffer> {
        const entry = this.entries.get(rel);
        if (!entry) throw new RovesError(`the player package lacks ${rel}`);
        return this.zip.read(entry);
    }

    private async verifyChecksums(): Promise<Map<string, string>> {
        const text = (await this.read(CHECKSUMS)).toString("utf8").replace(/^﻿/, "");
        const listed = new Map<string, string>();
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const at = line.indexOf("  ");
            if (at < 0) throw new RovesError(`malformed ${CHECKSUMS} line: ${line}`);
            const rel = line.slice(at + 2).trimEnd();
            if (/(^|\/)\.\.?(\/|$)/.test(rel) || /^[/\\]/.test(rel) || rel.includes(":")) {
                throw new RovesError(`${CHECKSUMS} lists an unsafe path: ${rel}`);
            }
            listed.set(rel, line.slice(0, at).toLowerCase());
        }
        const files = [...this.entries].filter(
            ([rel, entry]) => !entry.isDirectory && rel !== CHECKSUMS,
        );
        for (const [rel] of files) {
            if (!listed.has(rel)) {
                throw new RovesError(
                    `the player package contains ${rel}, which its ${CHECKSUMS} does not list`,
                );
            }
        }
        for (const rel of listed.keys()) {
            if (!this.isFile(rel)) {
                throw new RovesError(`the player package lacks ${rel}, listed in its ${CHECKSUMS}`);
            }
        }
        for (const [rel, entry] of files) {
            if ((await this.zip.sha256(entry)) !== listed.get(rel)) {
                throw new RovesError(`${rel} does not match the player package's ${CHECKSUMS}`);
            }
        }
        return listed;
    }

    close(): void {
        this.zip.close();
    }
}
