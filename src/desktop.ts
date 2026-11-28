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
import {
    type ContentLayout,
    DEFAULT_COMPRESSION_LEVEL,
    DEFAULT_MAX_ARCHIVE_SIZE,
    PACKED_CONTENT_MIN_SHELL,
    type PackedContent,
    packContent,
    parseArchiveSize,
    shellReadsPackedContent,
    validateCompressionLevel,
} from "./content";
import { type DownloadProgress, ensureShellAsset } from "./download";
import { RovesError } from "./errors";
import { resolveProjectIcon } from "./icon";
import {
    addonFileName,
    findProjectDir,
    GAME_IDENTITY_FILE,
    type GameIdentity,
    MODS_MIN_SHELL,
    packMod,
    readDlcRegistry,
    readGameIdentity,
    recognizedDlc,
    scratchDir,
    shellLoadsMods,
} from "./mods";
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
    /**
     * `archive` (default from player v0.9.1): `game/` holds a few archives and
     * `roves-content.json` (code in one archive, assets grouped by top-level folder); `files`:
     * the build copied as loose files.
     */
    contentLayout?: ContentLayout;
    /** Archive compression, 0 (none, default: fastest in game) to 9 (smallest). */
    compressionLevel?: number;
    /** Largest asset archive in bytes, or a size such as `300MB` (default 300 MB). */
    maxArchiveSize?: number | string;
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
    /**
     * Allow third-party mods (default: the game's `package.json` `roves.mods`, else true). DLC
     * load either way.
     */
    mods?: boolean;
    /**
     * The game's project folder, with its `package.json` (default: the nearest one upwards from
     * `contentDir`). Its `name` and `version` are what add-ons are checked against.
     */
    projectDir?: string;
    /**
     * DLC to ship in `dlc/` next to the game: DLC folders (packed and registered in the project's
     * `roves-dlc.json`) or `.rovesmod` files already registered there.
     */
    dlc?: string[];
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
    /** How the game is stored in `game/`. */
    contentLayout: ContentLayout;
    /** Where the icons came from, e.g. `window project (game icon.png 512x512); executable ...`. */
    iconSource: string;
    /** Third-party mods allowed (`null`: no game identity, so no mods or DLC). */
    mods: boolean | null;
    /** DLC shipped in the package, as `dlc/<file>`. */
    dlc: string[];
    warnings: string[];
}

/** Checks the option combination before any download (roves-action's "Validate inputs"). */
export async function validateDesktopOptions(options: BundleDesktopOptions): Promise<{
    platforms: DesktopPlatform[];
    name: string;
    shellVersion: string;
    steamAppId?: string;
    contentLayout: ContentLayout;
    compressionLevel: number;
    maxArchiveSize: number;
    warnings: string[];
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
    const compressionLevel = validateCompressionLevel(
        options.compressionLevel ?? DEFAULT_COMPRESSION_LEVEL,
    );
    const maxArchiveSize = parseArchiveSize(options.maxArchiveSize ?? DEFAULT_MAX_ARCHIVE_SIZE);
    if (options.contentLayout && !["archive", "files"].includes(options.contentLayout)) {
        throw new RovesError(
            `invalid content layout "${options.contentLayout}" (expected archive or files)`,
        );
    }
    // A local --shell-zip is trusted to be a current player; a downloaded one must be recent.
    const readsArchives = Boolean(options.shellZip) || shellReadsPackedContent(shellVersion);
    const warnings: string[] = [];
    let contentLayout: ContentLayout = options.contentLayout ?? "archive";
    if (contentLayout === "archive" && !readsArchives) {
        if (options.contentLayout === "archive") {
            throw new RovesError(
                `--content-layout archive needs the player ${PACKED_CONTENT_MIN_SHELL} or later (--shell-version ${shellVersion})`,
            );
        }
        contentLayout = "files";
        warnings.push(
            `the player ${shellVersion} predates packed content (${PACKED_CONTENT_MIN_SHELL}): the game is copied as loose files`,
        );
    }
    return {
        platforms,
        name,
        shellVersion,
        steamAppId,
        contentLayout,
        compressionLevel,
        maxArchiveSize,
        warnings,
    };
}

/** Packages the game for every requested desktop platform, one zip (and folder) each. */
export async function bundleDesktop(options: BundleDesktopOptions): Promise<DesktopBundleResult[]> {
    const valid = await validateDesktopOptions(options);
    const { platforms, name, shellVersion, steamAppId, contentLayout } = valid;
    const log = options.log ?? (() => {});
    for (const warning of valid.warnings) log(warning);
    const outDir = resolve(options.outDir ?? ".");
    const contentDir = resolve(options.contentDir);
    await mkdir(outDir, { recursive: true });
    const addons = await prepareAddons(options, contentDir, shellVersion, log);
    for (const warning of addons.warnings) log(warning);
    valid.warnings.push(...addons.warnings);
    // Packed once for every platform (the archives are platform independent).
    const packDir =
        contentLayout === "archive" ? await mkdtemp(join(tmpdir(), "roves-content-")) : undefined;
    try {
        let packed: PackedContent | undefined;
        if (packDir) {
            packed = await packContent(contentDir, packDir, {
                compressionLevel: valid.compressionLevel,
                maxArchiveSize: valid.maxArchiveSize,
            });
            log(`content: packed ${packed.summary}`);
        }
        const results: DesktopBundleResult[] = [];
        for (const platform of platforms) {
            const stem = platforms.length === 1 ? name : `${name}_${platform}`;
            const result = await bundleOne(platform, {
                ...options,
                contentDir,
                outDir,
                name,
                stem,
                shellVersion,
                steamAppId,
                packed,
                identity: addons.identity,
                dlcFiles: addons.dlc,
                log,
            });
            result.warnings.unshift(...valid.warnings);
            results.push(result);
        }
        return results;
    } finally {
        if (packDir) await rm(packDir, { recursive: true, force: true });
        await addons.cleanup();
    }
}

/**
 * The game identity (`game/roves-game.json`) and the signed DLC files, once for every platform.
 * Without a `package.json` the package has no mod support (a warning, as for older packages).
 */
async function prepareAddons(
    options: BundleDesktopOptions,
    contentDir: string,
    shellVersion: string,
    log: (message: string) => void,
): Promise<{
    identity?: GameIdentity;
    dlc: { name: string; file: string }[];
    warnings: string[];
    cleanup: () => Promise<void>;
}> {
    const none = async () => {};
    const dlcPaths = (options.dlc ?? []).map((path) => resolve(path));
    const projectDir = options.projectDir
        ? resolve(options.projectDir)
        : await findProjectDir(contentDir);
    if (!projectDir) {
        if (dlcPaths.length > 0 || options.mods !== undefined) {
            throw new RovesError(
                `mods and DLC need the game's package.json (none found from ${contentDir} upwards): pass --project-dir`,
            );
        }
        return {
            dlc: [],
            warnings: [
                `no package.json found from ${contentDir} upwards: the package has no mod or DLC support (--project-dir)`,
            ],
            cleanup: none,
        };
    }
    const identity = await readGameIdentity(projectDir, { mods: options.mods });
    log(
        `mods: ${GAME_IDENTITY_FILE} ${identity.name}@${identity.version} mods=${identity.mods} official-dlc=${Object.keys(identity.dlc).length}`,
    );
    if (dlcPaths.length === 0) return { identity, dlc: [], warnings: [], cleanup: none };
    if (!options.shellZip && !shellLoadsMods(shellVersion)) {
        throw new RovesError(
            `--dlc needs the player ${MODS_MIN_SHELL} or later (--shell-version ${shellVersion})`,
        );
    }
    const scratch = await scratchDir("roves-dlc-");
    const cleanup = () => rm(scratch, { recursive: true, force: true });
    try {
        // Folders are packed (and registered) first, then every DLC must be registered.
        const files: string[] = [];
        for (const path of dlcPaths) {
            const isDir = (await stat(path).catch(() => null))?.isDirectory();
            files.push(
                isDir
                    ? (await packMod({ modDir: path, outDir: scratch, projectDir, log })).path
                    : path,
            );
        }
        identity.dlc = await readDlcRegistry(projectDir);
        const dlc: { name: string; file: string }[] = [];
        for (const file of files) {
            const manifest = await recognizedDlc(file, identity.dlc);
            const name = addonFileName(manifest.id, "dlc", manifest.version);
            if (dlc.some((d) => d.name === name)) throw new RovesError(`two DLC are named ${name}`);
            dlc.push({ name, file });
            log(`dlc: ${manifest.id}@${manifest.version} is an official DLC of this game`);
        }
        return { identity, dlc, warnings: [], cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

async function bundleOne(
    platform: DesktopPlatform,
    options: BundleDesktopOptions & {
        contentDir: string;
        outDir: string;
        name: string;
        stem: string;
        shellVersion: string;
        packed?: PackedContent;
        identity?: GameIdentity;
        dlcFiles: { name: string; file: string }[];
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
                packed: options.packed,
                topFolder,
                enableMcp: mcp,
                steamAppId: options.steamAppId,
                icon,
                workDir: join(work, "exe"),
                baseNote: shell.url,
                patchExe: options.patchExe,
                gameIdentity: options.identity
                    ? Buffer.from(`${JSON.stringify(options.identity, null, 2)}\n`, "utf8")
                    : undefined,
                dlc: options.dlcFiles,
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
            contentLayout: options.packed ? "archive" : "files",
            iconSource: icon.summary,
            mods: options.identity ? options.identity.mods : null,
            dlc: options.dlcFiles.map((d) => d.name),
            warnings,
        };
    } finally {
        base?.close();
        await rm(work, { recursive: true, force: true });
        await shell.cleanup();
    }
}
