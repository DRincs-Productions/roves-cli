/**
 * Desktop packaging (Windows, macOS, Linux): download the pinned CEF player, verify it, put the
 * game in its `game/` folder, apply the project icon and zip the result, for any target from any
 * host. The same flow as roves-action's desktop path and Roves Packmaster's `bundle.rs`.
 */
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assemble } from "./assemble";
import { PlayerBase, ROVES_FALLBACK_ICO } from "./base";
import {
    assetName,
    type DesktopPlatform,
    hostPlatform,
    PINNED_SHELL_VERSION,
    validateName,
    validateShellVersion,
    validateSteamAppId,
} from "./constants";
import { type DownloadProgress, ensureShellAsset } from "./download";
import { RovesError } from "./errors";
import { resolveProjectIcon } from "./icon";
import { extractZip } from "./zip";

export const DEFAULT_NAME = "roves-game";

/** Stages of one platform's packaging, in order. */
export type DesktopStage = "downloading" | "assembling" | "extracting" | "done";

export interface BundleDesktopOptions {
    /** The built web game, with `index.html` at its root. */
    contentDir: string;
    /** Target platforms (default: the host's). */
    platforms?: DesktopPlatform[];
    /** Square PNG project icon (window icon, macOS app icon, source of `play.exe`'s icon). */
    iconPng?: string;
    /** Project `.ico` (`play.exe`'s icon; window icon source when there is no PNG). */
    iconIco?: string;
    /** Package the Steam variant (`roves_shell_<platform>_steam.zip`). */
    steam?: boolean;
    /** Development App ID written to `steam_appid.txt` next to the executable (requires `steam`). */
    steamAppId?: string;
    /** Package the MCP-enabled development player (`roves_shell_<platform>_mcp.zip`). */
    enableMcp?: boolean;
    /** Base name of the zip and of the folder inside it (default `roves-game`). */
    name?: string;
    /** Where the zips and folders are written (default: the current directory). */
    outDir?: string;
    /** Also write the unzipped package folder next to the zip (default true). */
    extract?: boolean;
    /** Engine release tag of the player (default: the pinned version). */
    shellVersion?: string;
    /** A local player zip to use instead of downloading one (exactly one platform). */
    shellZip?: string;
    noCache?: boolean;
    refresh?: boolean;
    cacheDir?: string;
    /** Release download base URL (tests, mirrors). */
    baseUrl?: string;
    log?: (message: string) => void;
    onProgress?: (platform: DesktopPlatform, progress: DownloadProgress) => void;
    /** Called when a platform enters a stage (for progress bars, e.g. Roves Packmaster's). */
    onStage?: (platform: DesktopPlatform, stage: DesktopStage) => void;
    /** Overrides how `play.exe`'s icon is patched (tests). */
    patchExe?: (exe: string, ico: string) => Promise<void>;
}

export interface DesktopBundleResult {
    platform: DesktopPlatform;
    /** The release asset the package was built from. */
    asset: string;
    /** Where the base came from: its URL, or the `shellZip` path. */
    base: string;
    shellVersion: string;
    /** Absolute path of the zip. */
    archivePath: string;
    /** Absolute path of the unzipped package (`<name>` folder, or `<name>.app` on macOS). */
    bundleDir?: string;
    /** Top-level entry of the zip. */
    topFolder: string;
    /** The player executable, relative to the package root (`play.exe`, the macOS
     * `Contents/MacOS/<CFBundleExecutable>`, the Linux player), e.g. for installers. */
    executable: string;
    mcpEnabled: boolean;
    /** Where the icons came from, e.g. `window project (game icon.png 512x512); executable ...`. */
    iconSource: string;
    warnings: string[];
}

/** Checks the option combination before any download (roves-action's "Validate inputs"). */
export async function validateDesktopOptions(options: BundleDesktopOptions): Promise<{
    platforms: DesktopPlatform[];
    name: string;
    shellVersion: string;
    steamAppId?: string;
}> {
    const platforms = options.platforms?.length ? options.platforms : [hostPlatform()];
    const name = validateName(options.name ?? DEFAULT_NAME);
    const shellVersion = validateShellVersion(options.shellVersion ?? PINNED_SHELL_VERSION);
    if (options.steam && options.enableMcp) {
        throw new RovesError(
            "--enable-mcp and --steam can't be combined: no Steam package with the MCP bridge is published",
        );
    }
    if (options.steamAppId !== undefined && !options.steam) {
        throw new RovesError("--steam-app-id requires --steam");
    }
    const steamAppId =
        options.steamAppId === undefined ? undefined : validateSteamAppId(options.steamAppId);
    if (options.shellZip && platforms.length !== 1) {
        throw new RovesError("--shell-zip needs exactly one --platform");
    }
    if (options.shellZip && !(await stat(options.shellZip).catch(() => null))?.isFile()) {
        throw new RovesError(`--shell-zip ${options.shellZip} is not a file`);
    }
    if (!(await stat(join(options.contentDir, "index.html")).catch(() => null))?.isFile()) {
        throw new RovesError(`content dir ${options.contentDir} has no index.html at its root`);
    }
    for (const [flag, path] of [
        ["--icon-png", options.iconPng],
        ["--icon-ico", options.iconIco],
    ] as const) {
        if (path && !(await stat(path).catch(() => null))?.isFile()) {
            throw new RovesError(`${flag} ${path} is not a file`);
        }
    }
    return { platforms, name, shellVersion, steamAppId };
}

/** Packages the game for every requested desktop platform, one zip (and folder) each. */
export async function bundleDesktop(options: BundleDesktopOptions): Promise<DesktopBundleResult[]> {
    const { platforms, name, shellVersion, steamAppId } = await validateDesktopOptions(options);
    const log = options.log ?? (() => {});
    const outDir = resolve(options.outDir ?? ".");
    const contentDir = resolve(options.contentDir);
    await mkdir(outDir, { recursive: true });
    const results: DesktopBundleResult[] = [];
    for (const platform of platforms) {
        const stem = platforms.length === 1 ? name : `${name}_${platform}`;
        results.push(
            await bundleOne(platform, {
                ...options,
                contentDir,
                outDir,
                name,
                stem,
                shellVersion,
                steamAppId,
                log,
            }),
        );
    }
    return results;
}

async function bundleOne(
    platform: DesktopPlatform,
    options: BundleDesktopOptions & {
        contentDir: string;
        outDir: string;
        name: string;
        stem: string;
        shellVersion: string;
        log: (message: string) => void;
    },
): Promise<DesktopBundleResult> {
    const { log, outDir, stem } = options;
    const steam = options.steam ?? false;
    const mcp = options.enableMcp ?? false;
    const asset = assetName(platform, steam, mcp);
    const topFolder = platform === "macos" ? `${options.name}.app` : options.name;
    const archivePath = join(outDir, `${stem}.zip`);
    const bundleDir = join(outDir, platform === "macos" ? `${stem}.app` : stem);
    const stage = (name: DesktopStage) => options.onStage?.(platform, name);

    stage("downloading");
    const shell = options.shellZip
        ? {
              path: resolve(options.shellZip),
              url: resolve(options.shellZip),
              cleanup: async () => {},
          }
        : await ensureShellAsset(asset, {
              version: options.shellVersion,
              noCache: options.noCache,
              refresh: options.refresh,
              cacheDir: options.cacheDir,
              baseUrl: options.baseUrl,
              log,
              onProgress: options.onProgress && ((p) => options.onProgress?.(platform, p)),
          });
    const work = await mkdtemp(join(tmpdir(), `roves-${platform}-`));
    let base: PlayerBase | undefined;
    try {
        stage("assembling");
        base = await PlayerBase.open(shell.path, platform, steam);
        log(
            `${platform}: base ${asset} checked${base.checksums ? ` against its SHA256SUMS.txt (${base.checksums.size} files)` : ""}`,
        );
        let fallbackIco: string | undefined;
        if (platform === "windows" && base.isFile(ROVES_FALLBACK_ICO)) {
            fallbackIco = join(work, ROVES_FALLBACK_ICO);
            await writeFile(fallbackIco, await base.read(ROVES_FALLBACK_ICO));
        }
        const icon = await resolveProjectIcon({
            platform,
            contentDir: options.contentDir,
            iconPng: options.iconPng && resolve(options.iconPng),
            iconIco: options.iconIco && resolve(options.iconIco),
            fallbackIco,
            workDir: join(work, "icon"),
        });
        for (const warning of icon.warnings) log(`${platform}: project icon: ${warning}`);
        log(`${platform}: icons: ${icon.summary}`);
        await assemble(
            base,
            {
                contentDir: options.contentDir,
                topFolder,
                enableMcp: mcp,
                steamAppId: options.steamAppId,
                icon,
                workDir: join(work, "exe"),
                baseNote: shell.url,
                patchExe: options.patchExe,
            },
            archivePath,
        );
        log(`${platform}: wrote ${archivePath}`);
        const warnings = [...icon.warnings];
        let extracted: string | undefined;
        if (options.extract ?? true) {
            stage("extracting");
            const staging = `${bundleDir}.extracting`;
            await rm(staging, { recursive: true, force: true });
            await rm(bundleDir, { recursive: true, force: true });
            const { skippedSymlinks } = await extractZip(archivePath, staging);
            await rename(join(staging, topFolder), bundleDir);
            await rm(staging, { recursive: true, force: true });
            if (skippedSymlinks.length > 0) {
                const warning = `${skippedSymlinks.length} symlink(s) could not be created in ${bundleDir} on this host (the zip keeps them; ship the zip)`;
                warnings.push(warning);
                log(`${platform}: ${warning}`);
            }
            extracted = bundleDir;
            log(`${platform}: unzipped to ${bundleDir}`);
        }
        stage("done");
        return {
            platform,
            asset,
            base: shell.url,
            shellVersion: options.shellVersion,
            archivePath,
            bundleDir: extracted,
            topFolder,
            executable: base.executable,
            mcpEnabled: mcp,
            iconSource: icon.summary,
            warnings,
        };
    } finally {
        base?.close();
        await rm(work, { recursive: true, force: true });
        await shell.cleanup();
    }
}
