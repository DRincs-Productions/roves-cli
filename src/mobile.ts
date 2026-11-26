/**
 * Android and iOS: the native WebView path of the Servo-era engine at the MOBILE pin
 * (`MOBILE_ENGINE_VERSION`), exactly as roves-action runs it: `mach bundle --android`, or for
 * iOS `support/ios/bundle.py` + XcodeGen + an unsigned Simulator build, or `mach bundle --ios
 * --ios-release`. Nothing is compiled. The external toolchains (a JDK and the Android SDK, uv,
 * git, or Xcode and XcodeGen) must be installed; `toolchains.ts` detects them before anything
 * runs and lists every missing one. roves-action installs them on its runners.
 */
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENGINE_REPOSITORY, MOBILE_ENGINE_VERSION, validateName } from "./constants";
import { DEFAULT_NAME } from "./desktop";
import { defaultCacheDir } from "./download";
import { RovesError } from "./errors";
import {
    type CommandProbe,
    type CommandRunner,
    type CommandSpec,
    formatCommand,
    probeCommand,
    runCommand,
} from "./process";
import { detectAndroidToolchain, detectIosToolchain, type Toolchain } from "./toolchains";
import { zipDirectory } from "./zip";

/** Web app manifest `orientation` vocabulary, accepted by `--android-orientation`. */
export const ANDROID_ORIENTATIONS = [
    "any",
    "natural",
    "landscape",
    "landscape-primary",
    "landscape-secondary",
    "portrait",
    "portrait-primary",
    "portrait-secondary",
] as const;

interface CommonMobileOptions {
    /** The built web game, with `index.html` at its root. */
    contentDir: string;
    /** Base name of the output folder and zip (default `roves-game`). */
    name?: string;
    /** Where the folder and the zip are written (default: the current directory). */
    outDir?: string;
    /** An existing engine checkout at the mobile pin (default: a cached shallow clone). */
    engineDir?: string;
    /** Engine tag to clone (default: the mobile pin). */
    engineVersion?: string;
    cacheDir?: string;
    log?: (message: string) => void;
    /** Replaces command execution (tests). */
    runner?: CommandRunner;
    /** Replaces the tool detection probes (tests). */
    probe?: CommandProbe;
    /** Host OS (tests). */
    host?: NodeJS.Platform;
    /** Environment the tools are looked up in (tests). */
    env?: NodeJS.ProcessEnv;
    /** Home directory, for Android Studio's default SDK folder (tests). */
    home?: string;
}

export interface AndroidOptions extends CommonMobileOptions {
    /** Square PNG launcher icon. */
    iconPng?: string;
    appName?: string;
    orientation?: string;
    themeColor?: string;
    /** Signed release `.apk` instead of the debug one (needs the keystore options). */
    release?: boolean;
    /** Keystore file. */
    keystore?: string;
    /** Base64-encoded keystore (alternative to `keystore`, e.g. from a CI secret). */
    keystoreBase64?: string;
    keystorePassword?: string;
    keyAlias?: string;
    keyPassword?: string;
    /** Run `mach bootstrap` first (default true, like roves-action). */
    bootstrap?: boolean;
}

export interface IosOptions extends CommonMobileOptions {
    appName?: string;
    bundleId?: string;
    /** Signed `.ipa` through `mach bundle --ios --ios-release` (needs the signing options). */
    release?: boolean;
    /** Apple Distribution certificate + private key (.p12). */
    certificateP12?: string;
    certificateP12Base64?: string;
    certificateP12Password?: string;
    /** `.mobileprovision` matching the certificate and bundle ID. */
    provisioningProfile?: string;
    provisioningProfileBase64?: string;
    teamId?: string;
}

export interface MobileBundleResult {
    platform: "android" | "ios";
    /** The tools that were detected and used. */
    tools?: Toolchain["tools"];
    /** Absolute path of the output folder (named `name`). */
    bundleDir: string;
    /** Absolute path of `<name>.zip`, which holds that folder. */
    archivePath: string;
    engineDir: string;
}

/** `mach <args>` as the engine runs it: `mach.bat`'s `uv run` on Windows, `sh mach` elsewhere. */
export function machCommand(
    engineDir: string,
    args: string[],
    host: NodeJS.Platform = process.platform,
): CommandSpec {
    return host === "win32"
        ? {
              command: "uv",
              args: ["run", "--frozen", "python", join(engineDir, "mach"), ...args],
              cwd: engineDir,
          }
        : { command: "sh", args: ["mach", ...args], cwd: engineDir };
}

/**
 * `mach bootstrap` flags; on Windows `--skip-platform`, because its GStreamer MSI installer
 * waits on a UAC prompt forever without an interactive desktop.
 */
export function machBootstrapArgs(host: NodeJS.Platform = process.platform): string[] {
    const args = ["bootstrap", "--force", "--yes", "--skip-lints", "--skip-nextest"];
    if (host === "win32") args.push("--skip-platform");
    return args;
}

/** `mach bundle --android ...` arguments. */
export function androidBundleArgs(options: {
    contentDir: string;
    output: string;
    iconPng?: string;
    appName?: string;
    orientation?: string;
    themeColor?: string;
    release?: boolean;
}): string[] {
    const args = ["bundle", "--android", "--content-dir", options.contentDir];
    args.push("--output", options.output);
    if (options.iconPng) args.push("--icon-png", options.iconPng);
    if (options.appName) args.push("--android-app-name", options.appName);
    if (options.orientation) args.push("--android-orientation", options.orientation);
    if (options.themeColor) args.push("--android-theme-color", options.themeColor);
    if (options.release) args.push("--android-release");
    return args;
}

/** The four variables the Gradle project's `getSigningKeyInfo` reads. */
export function androidSigningEnv(options: {
    keystorePath: string;
    keystorePassword: string;
    keyAlias: string;
    keyPassword: string;
}): Record<string, string> {
    return {
        APK_SIGNING_KEY_STORE_PATH: options.keystorePath,
        APK_SIGNING_KEY_STORE_PASS: options.keystorePassword,
        APK_SIGNING_KEY_ALIAS: options.keyAlias,
        APK_SIGNING_KEY_PASS: options.keyPassword,
    };
}

/** `support/ios/bundle.py` arguments (the raw `.xcodeproj` path). */
export function iosBundlePyArgs(options: {
    engineDir: string;
    contentDir: string;
    output: string;
    appName?: string;
    bundleId?: string;
}): string[] {
    const args = [join(options.engineDir, "support", "ios", "bundle.py")];
    args.push("--content-dir", options.contentDir, "--output", options.output);
    if (options.appName) args.push("--app-name", options.appName);
    if (options.bundleId) args.push("--bundle-id", options.bundleId);
    return args;
}

/** The unsigned iOS Simulator build of the generated project. */
export function iosSimulatorBuildArgs(derivedDataPath: string): string[] {
    return [
        "-project",
        "RovesGame.xcodeproj",
        "-scheme",
        "RovesGame",
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-derivedDataPath",
        derivedDataPath,
        "CODE_SIGN_IDENTITY=",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
    ];
}

/** `mach bundle --ios --ios-release ...` arguments. */
export function iosReleaseArgs(options: {
    contentDir: string;
    output: string;
    appName?: string;
    bundleId?: string;
}): string[] {
    const args = ["bundle", "--ios", "--ios-release", "--content-dir", options.contentDir];
    args.push("--output", options.output);
    if (options.appName) args.push("--ios-app-name", options.appName);
    if (options.bundleId) args.push("--ios-bundle-id", options.bundleId);
    return args;
}

/** The variables `mach bundle --ios --ios-release` reads. */
export function iosSigningEnv(options: {
    certificateP12Path: string;
    certificateP12Password?: string;
    provisioningProfilePath: string;
    teamId: string;
}): Record<string, string> {
    return {
        IOS_SIGNING_CERTIFICATE_P12_PATH: options.certificateP12Path,
        IOS_SIGNING_CERTIFICATE_P12_PASSWORD: options.certificateP12Password ?? "",
        IOS_SIGNING_PROVISIONING_PROFILE_PATH: options.provisioningProfilePath,
        IOS_SIGNING_TEAM_ID: options.teamId,
    };
}

async function isFile(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDir(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function checkContent(contentDir: string): Promise<void> {
    if (!(await isFile(join(contentDir, "index.html")))) {
        throw new RovesError(`content dir ${contentDir} has no index.html at its root`);
    }
}

/** Option checks of `roves android` (roves-action's "Validate inputs"); returns warnings. */
export async function validateAndroidOptions(options: AndroidOptions): Promise<string[]> {
    await checkContent(options.contentDir);
    validateName(options.name ?? DEFAULT_NAME);
    const warnings: string[] = [];
    if (
        options.orientation &&
        !(ANDROID_ORIENTATIONS as readonly string[]).includes(options.orientation)
    ) {
        throw new RovesError(
            `invalid --android-orientation "${options.orientation}" (expected one of ${ANDROID_ORIENTATIONS.join(", ")})`,
        );
    }
    if (options.iconPng && !(await isFile(options.iconPng))) {
        throw new RovesError(`--icon-png ${options.iconPng} is not a file`);
    }
    if (options.keystore && options.keystoreBase64) {
        throw new RovesError("pass either --keystore or --keystore-base64, not both");
    }
    const signing = [
        options.keystore || options.keystoreBase64,
        options.keystorePassword,
        options.keyAlias,
        options.keyPassword,
    ];
    if (options.release) {
        if (signing.some((value) => !value)) {
            throw new RovesError(
                "--release requires --keystore (or --keystore-base64), --keystore-password, --key-alias and --key-password -- no debug-signed fallback",
            );
        }
        if (options.keystore && !(await isFile(options.keystore))) {
            throw new RovesError(`--keystore ${options.keystore} is not a file`);
        }
    } else if (signing.some(Boolean)) {
        warnings.push("signing options are ignored without --release (debug .apk)");
    }
    return warnings;
}

/** Option checks of `roves ios`; returns warnings. */
export async function validateIosOptions(options: IosOptions): Promise<string[]> {
    await checkContent(options.contentDir);
    validateName(options.name ?? DEFAULT_NAME);
    const host = options.host ?? process.platform;
    if (host !== "darwin") {
        throw new RovesError(
            `iOS packaging requires macOS (this host is ${host}): Xcode and XcodeGen only exist there`,
        );
    }
    const warnings: string[] = [];
    for (const [a, b] of [
        ["certificateP12", "certificateP12Base64"],
        ["provisioningProfile", "provisioningProfileBase64"],
    ] as const) {
        if (options[a] && options[b]) {
            throw new RovesError(`pass either the ${a} file or its base64 form, not both`);
        }
    }
    const certificate = options.certificateP12 || options.certificateP12Base64;
    const profile = options.provisioningProfile || options.provisioningProfileBase64;
    if (options.release) {
        if (!certificate || !profile || !options.teamId) {
            throw new RovesError(
                "--release requires --certificate-p12 (or --certificate-p12-base64), --provisioning-profile (or --provisioning-profile-base64) and --team-id (and --certificate-p12-password unless the .p12 has none)",
            );
        }
        for (const path of [options.certificateP12, options.provisioningProfile]) {
            if (path && !(await isFile(path))) throw new RovesError(`${path} is not a file`);
        }
    } else if (certificate || profile || options.teamId || options.certificateP12Password) {
        warnings.push(
            "signing options are ignored without --release (unsigned Simulator build and .xcodeproj)",
        );
    }
    return warnings;
}

/**
 * The engine source at `version`: `engineDir` when given (it must contain `mach`), else a
 * cached shallow clone in `<cacheDir>/engine/<version>`.
 */
export async function ensureEngineSource(options: {
    engineDir?: string;
    version?: string;
    cacheDir?: string;
    runner?: CommandRunner;
    log?: (message: string) => void;
}): Promise<string> {
    if (options.engineDir) {
        const dir = resolve(options.engineDir);
        if (!(await isFile(join(dir, "mach")))) {
            throw new RovesError(`--engine-dir ${dir} is not a Roves engine checkout (no mach)`);
        }
        return dir;
    }
    const version = options.version ?? MOBILE_ENGINE_VERSION;
    const dir = join(options.cacheDir ?? defaultCacheDir(), "engine", version);
    const marker = join(dir, ".roves-cli-complete");
    if ((await isFile(marker)) && (await isFile(join(dir, "mach")))) {
        options.log?.(`Using cached engine source ${version}: ${dir}`);
        return dir;
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, ".."), { recursive: true });
    options.log?.(`Cloning ${ENGINE_REPOSITORY} at ${version} into ${dir}`);
    await (options.runner ?? runCommand)(engineCloneCommand(version, dir));
    await writeFile(marker, version);
    return dir;
}

export function engineCloneCommand(version: string, dir: string): CommandSpec {
    return {
        command: "git",
        args: [
            "-c",
            "core.autocrlf=false",
            "clone",
            "--depth",
            "1",
            "--branch",
            version,
            `${ENGINE_REPOSITORY}.git`,
            dir,
        ],
    };
}

/** Writes a base64 secret to a private temporary file. */
async function decodeSecret(dir: string, name: string, base64: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, Buffer.from(base64.replace(/\s+/g, ""), "base64"), { mode: 0o600 });
    return path;
}

async function prepareOutput(options: CommonMobileOptions): Promise<{
    name: string;
    outDir: string;
    output: string;
    contentDir: string;
}> {
    const name = validateName(options.name ?? DEFAULT_NAME);
    const outDir = resolve(options.outDir ?? ".");
    await mkdir(outDir, { recursive: true });
    const output = join(outDir, name);
    // The leaf never pre-exists: mach bundle and support/ios/bundle.py create it themselves.
    await rm(output, { recursive: true, force: true });
    return { name, outDir, output, contentDir: resolve(options.contentDir) };
}

async function finish(
    platform: "android" | "ios",
    paths: { name: string; outDir: string; output: string },
    engineDir: string,
    log: (message: string) => void,
): Promise<MobileBundleResult> {
    const archivePath = join(paths.outDir, `${paths.name}.zip`);
    await zipDirectory(paths.output, archivePath, paths.name);
    log(`${platform}: wrote ${archivePath}`);
    return { platform, bundleDir: paths.output, archivePath, engineDir };
}

/** Packages the game as an Android WebView APK through the engine's `mach bundle --android`. */
export async function buildAndroid(options: AndroidOptions): Promise<MobileBundleResult> {
    const log = options.log ?? (() => {});
    const run = options.runner ?? runCommand;
    const host = options.host ?? process.platform;
    for (const warning of await validateAndroidOptions(options)) log(`android: ${warning}`);
    const toolchain = await detectAndroidToolchain({
        ...options,
        needsGit: !options.engineDir,
        log,
    });
    const engineDir = await ensureEngineSource({
        ...options,
        version: options.engineVersion,
        runner: run,
        log,
    });
    const paths = await prepareOutput(options);
    const toolEnv = toolchain.env;
    const probe = options.probe ?? probeCommand;
    // roves-action prefetches the engine's Rust toolchain; mach bundle compiles nothing, so this
    // runs only when rustup is already installed (mach bootstrap skips Rust without it too).
    if (probe("rustup", ["--version"])) {
        await run({ command: "rustup", args: ["show"], cwd: engineDir });
    }
    if (options.bootstrap ?? true) {
        const spec = machCommand(engineDir, machBootstrapArgs(host), host);
        log(`android: ${formatCommand(spec)}`);
        await run({ ...spec, env: toolEnv });
    }
    const secrets = await mkdtemp(join(tmpdir(), "roves-android-"));
    try {
        let signingEnv: Record<string, string> = {};
        if (options.release) {
            const keystorePath = options.keystore
                ? resolve(options.keystore)
                : await decodeSecret(secrets, "release.keystore", options.keystoreBase64 ?? "");
            signingEnv = androidSigningEnv({
                keystorePath,
                keystorePassword: options.keystorePassword ?? "",
                keyAlias: options.keyAlias ?? "",
                keyPassword: options.keyPassword ?? "",
            });
        }
        const spec = machCommand(
            engineDir,
            androidBundleArgs({
                contentDir: paths.contentDir,
                output: paths.output,
                iconPng: options.iconPng && resolve(options.iconPng),
                appName: options.appName,
                orientation: options.orientation,
                themeColor: options.themeColor,
                release: options.release,
            }),
            host,
        );
        log(`android: ${formatCommand(spec)}`);
        await run({ ...spec, env: { ...toolEnv, ...signingEnv } });
    } finally {
        await rm(secrets, { recursive: true, force: true });
    }
    return { ...(await finish("android", paths, engineDir, log)), tools: toolchain.tools };
}

/**
 * Packages the game for iOS (macOS hosts only): by default the raw `.xcodeproj` plus an
 * unsigned iOS Simulator `.app`; with `release` a signed `.ipa`.
 */
export async function buildIos(options: IosOptions): Promise<MobileBundleResult> {
    const log = options.log ?? (() => {});
    const run = options.runner ?? runCommand;
    const host = options.host ?? process.platform;
    for (const warning of await validateIosOptions(options)) log(`ios: ${warning}`);
    const toolchain = await detectIosToolchain({ ...options, needsGit: !options.engineDir, log });
    const engineDir = await ensureEngineSource({
        ...options,
        version: options.engineVersion,
        runner: run,
        log,
    });
    const toolEnv = toolchain.env;
    const [python = "python3", ...pythonArgs] = toolchain.python ?? ["python3"];
    const paths = await prepareOutput(options);
    if (!options.release) {
        await run({
            command: python,
            env: toolEnv,
            args: [
                ...pythonArgs,
                ...iosBundlePyArgs({
                    engineDir,
                    contentDir: paths.contentDir,
                    output: paths.output,
                    appName: options.appName,
                    bundleId: options.bundleId,
                }),
            ],
        });
        await run({
            command: "xcodegen",
            env: toolEnv,
            args: ["generate", "--spec", "project.json"],
            cwd: paths.output,
        });
        const buildDir = await mkdtemp(join(tmpdir(), "roves-ios-build-"));
        try {
            await run({
                command: "xcodebuild",
                env: toolEnv,
                args: iosSimulatorBuildArgs(buildDir),
                cwd: paths.output,
            });
            const app = await findApp(join(buildDir, "Build", "Products"));
            if (!app) {
                throw new RovesError(
                    `no .app found under ${buildDir}/Build/Products after the Simulator build`,
                );
            }
            await cp(app.path, join(paths.output, app.name), {
                recursive: true,
                verbatimSymlinks: true,
            });
        } finally {
            await rm(buildDir, { recursive: true, force: true });
        }
        return { ...(await finish("ios", paths, engineDir, log)), tools: toolchain.tools };
    }
    const secrets = await mkdtemp(join(tmpdir(), "roves-ios-"));
    try {
        const certificateP12Path = options.certificateP12
            ? resolve(options.certificateP12)
            : await decodeSecret(secrets, "certificate.p12", options.certificateP12Base64 ?? "");
        const provisioningProfilePath = options.provisioningProfile
            ? resolve(options.provisioningProfile)
            : await decodeSecret(
                  secrets,
                  "profile.mobileprovision",
                  options.provisioningProfileBase64 ?? "",
              );
        const spec = machCommand(
            engineDir,
            iosReleaseArgs({
                contentDir: paths.contentDir,
                output: paths.output,
                appName: options.appName,
                bundleId: options.bundleId,
            }),
            host,
        );
        log(`ios: ${formatCommand(spec)}`);
        await run({
            ...spec,
            env: {
                ...toolEnv,
                ...iosSigningEnv({
                    certificateP12Path,
                    certificateP12Password: options.certificateP12Password,
                    provisioningProfilePath,
                    teamId: options.teamId ?? "",
                }),
            },
        });
    } finally {
        await rm(secrets, { recursive: true, force: true });
    }
    return { ...(await finish("ios", paths, engineDir, log)), tools: toolchain.tools };
}

/** The first `*.app` at most two levels below `dir` (like `find -maxdepth 2 -iname '*.app'`). */
async function findApp(dir: string): Promise<{ path: string; name: string } | undefined> {
    type Found = { path: string; name: string } | undefined;
    const level = async (current: string, depth: number): Promise<Found> => {
        const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.toLowerCase().endsWith(".app")) {
                return { path: join(current, entry.name), name: entry.name };
            }
        }
        if (depth < 2) {
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const found = await level(join(current, entry.name), depth + 1);
                if (found) return found;
            }
        }
        return undefined;
    };
    return (await isDir(dir)) ? level(dir, 1) : undefined;
}
