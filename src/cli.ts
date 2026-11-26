/**
 * The `roves` command: a thin commander layer over the programmatic API (`src/index.ts`).
 * Logs go to stderr; results (paths, `--json`) go to stdout, so scripts can capture them.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { version as cliVersion } from "../package.json";
import {
    assetName,
    DESKTOP_PLATFORMS,
    hostPlatform,
    MOBILE_ENGINE_VERSION,
    PINNED_SHELL_VERSION,
    parsePlatforms,
    validateShellVersion,
} from "./constants";
import { bundleDesktop, DEFAULT_NAME } from "./desktop";
import { type DownloadProgress, defaultCacheDir, ensureShellAsset } from "./download";
import { RovesError } from "./errors";
import { ANDROID_ORIENTATIONS, buildAndroid, buildIos } from "./mobile";
import { prepareAndroidToolchain, prepareIosToolchain, type ToolStatus } from "./toolchains";

/** The API functions the commands call; replaceable in tests. */
export interface CliDependencies {
    bundleDesktop: typeof bundleDesktop;
    buildAndroid: typeof buildAndroid;
    buildIos: typeof buildIos;
    ensureShellAsset: typeof ensureShellAsset;
    prepareAndroidToolchain: typeof prepareAndroidToolchain;
    prepareIosToolchain: typeof prepareIosToolchain;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const defaultDependencies: CliDependencies = {
    bundleDesktop,
    buildAndroid,
    buildIos,
    ensureShellAsset,
    prepareAndroidToolchain,
    prepareIosToolchain,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

/** Download progress on an interactive terminal: one line per 10%. */
function progressLogger(stderr: (text: string) => void, label: string) {
    let last = -1;
    return (progress: DownloadProgress) => {
        if (!process.stderr.isTTY || progress.total === 0) return;
        const percent = Math.floor((progress.received / progress.total) * 10) * 10;
        if (percent !== last) {
            last = percent;
            stderr(`${label}: ${percent}% of ${(progress.total / 1048576).toFixed(0)} MiB\n`);
        }
    };
}

export function createProgram(overrides: Partial<CliDependencies> = {}): Command {
    const deps: CliDependencies = { ...defaultDependencies, ...overrides };
    const log = (message: string) => deps.stderr(`${message}\n`);
    const program = new Command();
    program
        .name("roves")
        .description(
            `Package a built web game as a native Roves app.\n\nDesktop (Windows, macOS, Linux): the prebuilt CEF player of engine release ${PINNED_SHELL_VERSION} (pinned; --shell-version overrides it), from any host OS.\nAndroid/iOS: the engine's WebView tooling at ${MOBILE_ENGINE_VERSION} (needs the platform toolchains).`,
        )
        .version(cliVersion, "-v, --version", "print the roves-cli version")
        .showHelpAfterError()
        .exitOverride()
        .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr });

    program
        .command("bundle")
        .description(
            "package the game with the desktop CEF player: one zip (and folder) per platform",
        )
        .requiredOption(
            "-c, --content-dir <dir>",
            "your built web game (e.g. dist/), with index.html at its root",
        )
        .option(
            "-p, --platform <platform>",
            `target platform: ${DESKTOP_PLATFORMS.join(", ")}; repeatable or comma separated (default: this host, ${safeHost()})`,
            collect,
        )
        .option(
            "--icon-png <file>",
            "square PNG project icon, 16-2048 px, at most 8 MiB (default: <content-dir>/icon.png)",
        )
        .option(
            "--icon-ico <file>",
            "project .ico for play.exe (default: generated from the PNG, else <content-dir>/icon.ico or favicon.ico)",
        )
        .option("--steam", "package the Steam variant (Steamworks redistributable included)")
        .option(
            "--steam-app-id <id>",
            "write steam_appid.txt with this App ID next to the executable (development; requires --steam)",
        )
        .option(
            "--enable-mcp",
            "package the MCP-enabled development player (AI agents can drive the game; never ship it)",
        )
        .option(
            "-n, --name <name>",
            "base name of the zip and of the folder inside it (<name>.app on macOS)",
            DEFAULT_NAME,
        )
        .option("-o, --out-dir <dir>", "where the zips and folders are written", ".")
        .option("--no-extract", "write only the zip, not the unzipped package folder")
        .option(
            "--shell-version <tag>",
            "engine release of the player to download",
            PINNED_SHELL_VERSION,
        )
        .option(
            "--shell-zip <file>",
            "use this local player zip instead of downloading one (exactly one --platform)",
        )
        .option("--no-cache", "download into a temporary directory instead of the cache")
        .option("--refresh", "download again even if the player is cached")
        .option("--json", "print the results as JSON")
        .action(async (options) => {
            const platforms = parsePlatforms(options.platform);
            const progress = new Map(
                platforms.map((platform) => [
                    platform,
                    progressLogger(deps.stderr, `${platform}: download`),
                ]),
            );
            const results = await deps.bundleDesktop({
                contentDir: options.contentDir,
                platforms,
                iconPng: options.iconPng,
                iconIco: options.iconIco,
                steam: Boolean(options.steam),
                steamAppId: options.steamAppId,
                enableMcp: Boolean(options.enableMcp),
                name: options.name,
                outDir: options.outDir,
                extract: options.extract,
                shellVersion: validateShellVersion(options.shellVersion),
                shellZip: options.shellZip,
                noCache: options.cache === false,
                refresh: Boolean(options.refresh),
                log,
                onProgress: (platform, value) => progress.get(platform)?.(value),
            });
            if (options.json) {
                deps.stdout(`${JSON.stringify(results, null, 2)}\n`);
                return;
            }
            for (const result of results) {
                deps.stdout(
                    [
                        `${result.platform}:`,
                        `  archive-path: ${result.archivePath}`,
                        ...(result.bundleDir ? [`  bundle-dir: ${result.bundleDir}`] : []),
                        `  mcp-enabled: ${result.mcpEnabled}`,
                        `  icon-source: ${result.iconSource}`,
                        "",
                    ].join("\n"),
                );
            }
        });

    program
        .command("android")
        .description(
            `package the game as an Android WebView APK (engine ${MOBILE_ENGINE_VERSION}, mach bundle --android)`,
        )
        .requiredOption(
            "-c, --content-dir <dir>",
            "your built web game, with index.html at its root",
        )
        .option("--icon-png <file>", "square PNG launcher icon")
        .option("--app-name <name>", "launcher label (default: the web manifest's short_name/name)")
        .addOption(
            new Option(
                "--orientation <value>",
                "locked screen orientation (default: the manifest's)",
            ).choices([...ANDROID_ORIENTATIONS]),
        )
        .option(
            "--theme-color <color>",
            'status bar color, e.g. "#ffffff" (default: the manifest\'s theme_color)',
        )
        .option("--release", "signed release .apk instead of the debug one")
        .addOption(
            new Option("--keystore <file>", "release keystore file").env("ROVES_ANDROID_KEYSTORE"),
        )
        .addOption(
            new Option("--keystore-base64 <data>", "base64-encoded release keystore").env(
                "ROVES_ANDROID_KEYSTORE_BASE64",
            ),
        )
        .addOption(
            new Option("--keystore-password <password>", "keystore store password").env(
                "ROVES_ANDROID_KEYSTORE_PASSWORD",
            ),
        )
        .addOption(
            new Option("--key-alias <alias>", "signing key alias").env("ROVES_ANDROID_KEY_ALIAS"),
        )
        .addOption(
            new Option("--key-password <password>", "signing key password").env(
                "ROVES_ANDROID_KEY_PASSWORD",
            ),
        )
        .option(
            "--no-bootstrap",
            "skip `mach bootstrap` (you provisioned its dependencies yourself)",
        )
        .option("-n, --name <name>", "name of the output folder and zip", DEFAULT_NAME)
        .option("-o, --out-dir <dir>", "where the folder and zip are written", ".")
        .option(
            "--engine-dir <dir>",
            `existing engine checkout at ${MOBILE_ENGINE_VERSION} (default: a cached shallow clone)`,
        )
        .option(NO_INSTALL, NO_INSTALL_HELP)
        .option("--json", "print the result as JSON")
        .action(async (options) => {
            const result = await deps.buildAndroid({
                install: options.install,
                contentDir: options.contentDir,
                iconPng: options.iconPng,
                appName: options.appName,
                orientation: options.orientation,
                themeColor: options.themeColor,
                release: Boolean(options.release),
                keystore: options.keystore,
                keystoreBase64: options.keystoreBase64,
                keystorePassword: options.keystorePassword,
                keyAlias: options.keyAlias,
                keyPassword: options.keyPassword,
                bootstrap: options.bootstrap,
                name: options.name,
                outDir: options.outDir,
                engineDir: options.engineDir,
                log,
            });
            printMobile(deps, result, options.json);
        });

    program
        .command("ios")
        .description(
            `package the game for iOS (macOS only, engine ${MOBILE_ENGINE_VERSION}): .xcodeproj + Simulator .app, or a signed .ipa with --release`,
        )
        .requiredOption(
            "-c, --content-dir <dir>",
            "your built web game, with index.html at its root",
        )
        .option("--app-name <name>", 'display name (default "Roves Game")')
        .option("--bundle-id <id>", 'bundle identifier (default "org.roves.game")')
        .option("--release", "archive and export a signed .ipa (mach bundle --ios --ios-release)")
        .addOption(
            new Option(
                "--certificate-p12 <file>",
                "Apple Distribution certificate + private key (.p12)",
            ).env("ROVES_IOS_CERTIFICATE_P12"),
        )
        .addOption(
            new Option("--certificate-p12-base64 <data>", "base64-encoded .p12").env(
                "ROVES_IOS_CERTIFICATE_P12_BASE64",
            ),
        )
        .addOption(
            new Option("--certificate-p12-password <password>", "the .p12 export password").env(
                "ROVES_IOS_CERTIFICATE_P12_PASSWORD",
            ),
        )
        .addOption(
            new Option(
                "--provisioning-profile <file>",
                ".mobileprovision matching the certificate and bundle ID",
            ).env("ROVES_IOS_PROVISIONING_PROFILE"),
        )
        .addOption(
            new Option(
                "--provisioning-profile-base64 <data>",
                "base64-encoded .mobileprovision",
            ).env("ROVES_IOS_PROVISIONING_PROFILE_BASE64"),
        )
        .addOption(
            new Option("--team-id <id>", "Apple Developer Program Team ID").env(
                "ROVES_IOS_TEAM_ID",
            ),
        )
        .option("-n, --name <name>", "name of the output folder and zip", DEFAULT_NAME)
        .option("-o, --out-dir <dir>", "where the folder and zip are written", ".")
        .option(
            "--engine-dir <dir>",
            `existing engine checkout at ${MOBILE_ENGINE_VERSION} (default: a cached shallow clone)`,
        )
        .option(NO_INSTALL, NO_INSTALL_HELP)
        .option("--json", "print the result as JSON")
        .action(async (options) => {
            const result = await deps.buildIos({
                install: options.install,
                contentDir: options.contentDir,
                appName: options.appName,
                bundleId: options.bundleId,
                release: Boolean(options.release),
                certificateP12: options.certificateP12,
                certificateP12Base64: options.certificateP12Base64,
                certificateP12Password: options.certificateP12Password,
                provisioningProfile: options.provisioningProfile,
                provisioningProfileBase64: options.provisioningProfileBase64,
                teamId: options.teamId,
                name: options.name,
                outDir: options.outDir,
                engineDir: options.engineDir,
                log,
            });
            printMobile(deps, result, options.json);
        });

    program
        .command("setup")
        .description(
            "prepare the Android or iOS toolchain only: reuse installed tools, install missing ones into the cache",
        )
        .argument("<platform>", "android or ios")
        .option("--release", "iOS: prepare for --release (uv instead of XcodeGen)")
        .option(NO_INSTALL, "only check, listing the missing tools")
        .option("--json", "print the tool list as JSON")
        .addHelpText(
            "after",
            `\nInstalled tools go to ${join(defaultCacheDir(), "toolchains")} (override the cache with ROVES_CACHE_DIR). The Android toolchain takes about 850 MB.`,
        )
        .action(async (platform: string, options) => {
            const common = { install: options.install, log };
            let tools: ToolStatus[];
            if (platform === "android") {
                tools = (await deps.prepareAndroidToolchain(common)).tools;
            } else if (platform === "ios") {
                tools = (
                    await deps.prepareIosToolchain({ ...common, release: Boolean(options.release) })
                ).tools;
            } else {
                throw new RovesError(
                    `unknown setup platform "${platform}" (expected android or ios)`,
                );
            }
            if (options.json) {
                deps.stdout(`${JSON.stringify(tools, null, 2)}\n`);
            } else {
                for (const tool of tools) {
                    deps.stdout(`${tool.name}: ${tool.source} (${tool.detail})\n`);
                }
            }
        });

    program
        .command("download")
        .description("download (or reuse from the cache) a desktop player zip and print its path")
        .option(
            "-p, --platform <platform>",
            `${DESKTOP_PLATFORMS.join(", ")} (default: this host, ${safeHost()})`,
        )
        .option("--steam", "the Steam variant")
        .option("--enable-mcp", "the MCP-enabled development variant")
        .option(
            "--shell-version <tag>",
            "engine release of the player to download",
            PINNED_SHELL_VERSION,
        )
        .option("--output <file>", "also copy the zip to this path (printed instead)")
        .option("--no-cache", "download into a temporary directory (requires --output)")
        .option("--refresh", "download again even if the player is cached")
        .option("--json", "print the result as JSON")
        .addHelpText("after", `\nCache: ${defaultCacheDir()} (override with ROVES_CACHE_DIR)`)
        .action(async (options) => {
            const [platform] = parsePlatforms(options.platform ? [options.platform] : []);
            const asset = assetName(
                platform as (typeof DESKTOP_PLATFORMS)[number],
                Boolean(options.steam),
                Boolean(options.enableMcp),
            );
            if (options.cache === false && !options.output) {
                throw new RovesError("--no-cache requires --output (nothing would be kept)");
            }
            const shell = await deps.ensureShellAsset(asset, {
                version: validateShellVersion(options.shellVersion),
                noCache: options.cache === false,
                refresh: Boolean(options.refresh),
                log,
                onProgress: progressLogger(deps.stderr, `${asset}: download`),
            });
            let path = shell.path;
            try {
                if (options.output) {
                    path = resolve(options.output);
                    await mkdir(dirname(path), { recursive: true });
                    await copyFile(shell.path, path);
                }
            } finally {
                await shell.cleanup();
            }
            if (options.json) {
                deps.stdout(
                    `${JSON.stringify({ asset, url: shell.url, version: shell.version, path, fromCache: shell.fromCache }, null, 2)}\n`,
                );
            } else {
                deps.stdout(`${path}\n`);
            }
        });

    return program;
}

const NO_INSTALL = "--no-install";
const NO_INSTALL_HELP =
    "do not install missing toolchains (JDK, Android SDK, uv, XcodeGen) into the cache; fail listing them";

function safeHost(): string {
    try {
        return hostPlatform();
    } catch {
        return "unsupported";
    }
}

function printMobile(
    deps: CliDependencies,
    result: { platform: string; bundleDir: string; archivePath: string },
    json: boolean | undefined,
): void {
    if (json) {
        deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    deps.stdout(
        `${result.platform}:\n  archive-path: ${result.archivePath}\n  bundle-dir: ${result.bundleDir}\n`,
    );
}

/** Runs the CLI; returns the process exit code. */
export async function runCli(
    argv: string[] = process.argv,
    overrides: Partial<CliDependencies> = {},
): Promise<number> {
    const program = createProgram(overrides);
    const stderr = overrides.stderr ?? defaultDependencies.stderr;
    try {
        await program.parseAsync(argv);
        return 0;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (typeof code === "string" && code.startsWith("commander.")) {
            return (error as { exitCode?: number }).exitCode ?? 1;
        }
        if (error instanceof RovesError) {
            stderr(`roves: error: ${error.message}\n`);
        } else {
            stderr(`roves: unexpected error: ${(error as Error)?.stack ?? String(error)}\n`);
        }
        return 1;
    }
}
