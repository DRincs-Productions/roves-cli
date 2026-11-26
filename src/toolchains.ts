/**
 * The external toolchains of the Android/iOS paths, mirroring what roves-action installs on its
 * runners: a Temurin JDK 17 (actions/setup-java), the Android SDK command-line tools revision
 * 15859902 plus `platform-tools`, the newest `platforms;android-37*` and `build-tools;36.0.0`
 * through `sdkmanager --channel=3` (the action's "Install Android SDK" steps; no NDK, nothing is
 * compiled), uv (astral-sh/setup-uv) and XcodeGen (`brew install xcodegen`).
 *
 * Each tool is reused when a suitable one is already on the machine (environment variables,
 * PATH); otherwise it is downloaded once into `<cacheDir>/toolchains`, verified (SHA-256) and
 * extracted, per user and without admin rights. Nothing changes the user's global environment:
 * the returned `env` is passed only to the processes this tool starts. Xcode and macOS itself
 * cannot be installed that way and stay hard requirements of the iOS path.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCacheDir } from "./download";
import { RovesError } from "./errors";
import { defaultNet, downloadVerified, extractArchive, type Net } from "./net";
import {
    type CommandCapture,
    type CommandProbe,
    type CommandRunner,
    captureCommand,
    formatCommand,
    probeCommand,
    runCommand,
} from "./process";

/** The JDK major version roves-action sets up (actions/setup-java, Temurin). */
export const JDK_MAJOR = 17;
export const ADOPTIUM_API = "https://api.adoptium.net/v3";

/** Android SDK command-line tools revision of roves-action's "Install Android SDK cmdline-tools". */
export const CMDLINE_TOOLS_REVISION = "15859902";
/**
 * SHA-256 of each archive of that revision, computed from the files whose SHA-1 and size match
 * Google's repository manifest (https://dl.google.com/android/repository/repository2-3.xml).
 */
export const CMDLINE_TOOLS_SHA256: Record<string, string> = {
    linux: "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
    mac_x86_64: "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3",
    mac_arm64: "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e",
    win: "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a",
};
/** The engine's `servoapp/build.gradle.kts` at the mobile pin (compileSdk, buildToolsVersion). */
export const ANDROID_COMPILE_SDK = "37";
export const ANDROID_BUILD_TOOLS = "36.0.0";

/** uv release (astral-sh/setup-uv installs the latest one; pinned here for reproducibility). */
export const UV_VERSION = "0.13.10";
export const UV_SHA256: Record<string, string> = {
    "x86_64-pc-windows-msvc.zip":
        "297b3881fe1adfb922becc2c1613202abb41dc83ea5ff43d472aa087ca1f8683",
    "aarch64-pc-windows-msvc.zip":
        "f223bcd3fa010174ffeeb885cc1d5334bb81388640c65baa5b8b42b47017337e",
    "x86_64-apple-darwin.tar.gz":
        "153e03197588204c04fc4c81cc4bafbfa4280222a385e4ee36a87aeec0ae63b4",
    "aarch64-apple-darwin.tar.gz":
        "e419bf07533bdbf48795fc793601c834dd79db57a8c49ce8e25cfe3a8639958d",
    "x86_64-unknown-linux-gnu.tar.gz":
        "bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c",
    "aarch64-unknown-linux-gnu.tar.gz":
        "14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2",
};

/** XcodeGen release (what `brew install xcodegen` installs today), official GitHub release zip. */
export const XCODEGEN_VERSION = "2.49.0";
export const XCODEGEN_SHA256 = "ae5598b33a19ad1e23e775d6648f97375c3529c970905f489358a21055b65e53";

export type ToolSource = "system" | "cache" | "installed" | "missing";

export interface ToolStatus {
    name: string;
    source: ToolSource;
    /** Path, version or why it is missing. */
    detail: string;
}

export interface ToolchainOptions {
    /** Install missing tools into the cache (default true); false: fail listing them. */
    install?: boolean;
    cacheDir?: string;
    /** Host OS and CPU (tests). */
    host?: NodeJS.Platform;
    arch?: string;
    /** Environment the existing tools are looked up in (tests). */
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    runner?: CommandRunner;
    capture?: CommandCapture;
    probe?: CommandProbe;
    net?: Net;
}

/** The prepared toolchain: what to run and the environment for the processes that use it. */
export interface Toolchain {
    tools: ToolStatus[];
    /** Variables for the mach/xcodegen/python processes only (never exported globally). */
    env: Record<string, string>;
    /** The `uv` executable (`uv` when it is on PATH). */
    uv: string;
    /** Whether git is available (otherwise the engine source is downloaded as a tarball). */
    git: boolean;
    /** iOS: how to run Python (`python3`, or uv's managed Python). */
    python?: string[];
    /** iOS: the `xcodegen` executable. */
    xcodegen?: string;
}

interface Context {
    install: boolean;
    root: string;
    host: NodeJS.Platform;
    arch: string;
    env: NodeJS.ProcessEnv;
    log: (message: string) => void;
    run: CommandRunner;
    capture: CommandCapture;
    probe: CommandProbe;
    net: Net;
}

function context(options: ToolchainOptions): Context {
    return {
        install: options.install ?? true,
        root: join(options.cacheDir ?? defaultCacheDir(), "toolchains"),
        host: options.host ?? process.platform,
        arch: options.arch ?? process.arch,
        env: options.env ?? process.env,
        log: options.log ?? (() => {}),
        run: options.runner ?? runCommand,
        capture: options.capture ?? captureCommand,
        probe: options.probe ?? probeCommand,
        net: options.net ?? defaultNet,
    };
}

const exe = (host: NodeJS.Platform, name: string) => (host === "win32" ? `${name}.exe` : name);

async function exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
}

/** Reads a completed install's marker (`.roves-complete`, JSON). */
async function readMarker<T>(dir: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(join(dir, ".roves-complete"), "utf8")) as T;
    } catch {
        return undefined;
    }
}

async function writeMarker(dir: string, data: unknown): Promise<void> {
    await writeFile(join(dir, ".roves-complete"), JSON.stringify(data, null, 2));
}

/**
 * Downloads and extracts an archive into `dir` atomically: everything happens in a sibling
 * staging folder that is renamed into place, so an interrupted install is never reused.
 */
async function installArchive(
    ctx: Context,
    dir: string,
    url: string,
    sha256: string,
    label: string,
    fileName: string,
): Promise<void> {
    const staging = `${dir}.partial`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const archive = join(staging, fileName);
    await downloadVerified(ctx.net, url, archive, sha256, ctx.log, label);
    ctx.log(`${label}: extracting`);
    await extractArchive(archive, join(staging, "content"));
    await rm(archive, { force: true });
    await rm(dir, { recursive: true, force: true });
    await rename(join(staging, "content"), dir);
    await rm(staging, { recursive: true, force: true });
}

/** First directory (depth-first, at most `depth` levels) containing `rel`. */
async function findDirWith(root: string, rel: string, depth = 4): Promise<string | undefined> {
    if (await exists(join(root, rel))) return root;
    if (depth === 0) return undefined;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await findDirWith(join(root, entry.name), rel, depth - 1);
        if (found) return found;
    }
    return undefined;
}

/** The major version in `java -version` output (`"17.0.9"` -> 17, `"1.8.0_392"` -> 8). */
export function parseJavaMajor(output: string): number | undefined {
    const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
    if (!match) return undefined;
    const first = Number(match[1]);
    return first === 1 ? Number(match[2]) : first;
}

/** Adoptium `os`/`architecture` values for a host. */
export function adoptiumTarget(host: NodeJS.Platform, arch: string): { os: string; arch: string } {
    const os = { win32: "windows", darwin: "mac", linux: "linux" }[host as string];
    const cpu = { x64: "x64", arm64: "aarch64" }[arch];
    if (!os || !cpu) throw new RovesError(`no JDK ${JDK_MAJOR} is published for ${host}/${arch}`);
    return { os, arch: cpu };
}

export function adoptiumAssetsUrl(host: NodeJS.Platform, arch: string): string {
    const target = adoptiumTarget(host, arch);
    return `${ADOPTIUM_API}/assets/latest/${JDK_MAJOR}/hotspot?architecture=${target.arch}&image_type=jdk&os=${target.os}&vendor=eclipse`;
}

/** The JDK package of an Adoptium `assets/latest` response. */
export function selectAdoptiumPackage(response: unknown): {
    release: string;
    name: string;
    link: string;
    sha256: string;
    size: number;
} {
    const first = Array.isArray(response) ? response[0] : undefined;
    const pkg = first?.binary?.package;
    if (!pkg?.link || !/^[0-9a-f]{64}$/i.test(pkg.checksum ?? "") || !pkg.name) {
        throw new RovesError("the Adoptium API returned no usable JDK package");
    }
    return {
        release: String(first.release_name ?? pkg.name),
        name: String(pkg.name),
        link: String(pkg.link),
        sha256: String(pkg.checksum),
        size: Number(pkg.size ?? 0),
    };
}

function pathEnv(ctx: Context, dirs: string[]): Record<string, string> {
    const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    return {
        [key]: [...dirs, ctx.env[key] ?? ""].filter(Boolean).join(ctx.host === "win32" ? ";" : ":"),
    };
}

interface ToolResult {
    status: ToolStatus;
    env?: Record<string, string>;
    /** Directories to prepend to PATH. */
    path?: string[];
    command?: string;
}

const missing = (name: string, detail: string): ToolResult => ({
    status: { name, source: "missing", detail },
});

/** Temurin JDK 17+: JAVA_HOME, then java on PATH, then the cache, else installed there. */
async function ensureJdk(ctx: Context): Promise<ToolResult> {
    const name = `JDK ${JDK_MAJOR}`;
    const javaHome = ctx.env.JAVA_HOME;
    if (javaHome) {
        const major = parseJavaMajor(
            ctx.probe(join(javaHome, "bin", exe(ctx.host, "java")), ["-version"]) ?? "",
        );
        if (major !== undefined && major >= JDK_MAJOR) {
            return {
                status: { name, source: "system", detail: `JAVA_HOME ${javaHome} (Java ${major})` },
                command: join(javaHome, "bin", exe(ctx.host, "java")),
            };
        }
    }
    const pathMajor = parseJavaMajor(ctx.probe("java", ["-version"]) ?? "");
    if (pathMajor !== undefined && pathMajor >= JDK_MAJOR) {
        return {
            status: { name, source: "system", detail: `java on PATH (Java ${pathMajor})` },
            command: "java",
        };
    }
    const target = adoptiumTarget(ctx.host, ctx.arch);
    const dir = join(ctx.root, `jdk-${JDK_MAJOR}-${target.os}-${target.arch}`);
    const useHome = (home: string, source: ToolSource, release: string): ToolResult => ({
        status: { name, source, detail: `${release} at ${home}` },
        env: { JAVA_HOME: home },
        path: [join(home, "bin")],
        command: join(home, "bin", exe(ctx.host, "java")),
    });
    const marker = await readMarker<{ release: string; home: string }>(dir);
    if (marker && (await exists(join(dir, marker.home)))) {
        return useHome(join(dir, marker.home), "cache", marker.release);
    }
    if (!ctx.install) {
        return missing(name, `no Java ${JDK_MAJOR}+ in JAVA_HOME or on PATH`);
    }
    const pkg = selectAdoptiumPackage(
        await ctx.net.fetchJson(adoptiumAssetsUrl(ctx.host, ctx.arch)),
    );
    await installArchive(ctx, dir, pkg.link, pkg.sha256, name, pkg.name);
    const home = await findDirWith(dir, join("bin", exe(ctx.host, "java")));
    if (!home) throw new RovesError(`${pkg.name} contains no bin/java`);
    const rel = home.slice(dir.length + 1);
    await writeMarker(dir, { release: pkg.release, home: rel });
    return useHome(home, "installed", pkg.release);
}

/** `commandlinetools-<os>-<revision>_latest.zip` for a host. */
export function cmdlineToolsArchive(host: NodeJS.Platform, arch: string) {
    const os =
        host === "win32"
            ? "win"
            : host === "linux"
              ? "linux"
              : host === "darwin"
                ? arch === "arm64"
                    ? "mac_arm64"
                    : "mac_x86_64"
                : undefined;
    if (!os) throw new RovesError(`no Android command-line tools are published for ${host}`);
    const name = `commandlinetools-${os}-${CMDLINE_TOOLS_REVISION}_latest.zip`;
    return {
        name,
        url: `https://dl.google.com/android/repository/${name}`,
        sha256: CMDLINE_TOOLS_SHA256[os] as string,
    };
}

/**
 * The newest `platforms;android-<sdk>[.minor][-extN]` package that `sdkmanager --list` advertises
 * (`grep -oE ... | sort -V | tail -1` in roves-action).
 */
export function selectPlatformPackage(listOutput: string, compileSdk = ANDROID_COMPILE_SDK) {
    const pattern = new RegExp(`platforms;android-${compileSdk}(\\.[0-9]+)?(-ext[0-9]+)?`, "g");
    const found = [...new Set(listOutput.match(pattern) ?? [])];
    return found.sort(versionCompare).at(-1);
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Character order of GNU `sort -V` (Debian version comparison): letters before symbols. */
function versionOrder(c: string | undefined): number {
    if (c === undefined || isDigit(c)) return 0;
    if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
    if (c === "~") return -1;
    return c.charCodeAt(0) + 256;
}

/** GNU `sort -V` order of two strings (alternating non-digit and numeric runs). */
export function versionCompare(a: string, b: string): number {
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
            const diff = versionOrder(a[i]) - versionOrder(b[j]);
            if (diff !== 0) return diff;
            i++;
            j++;
        }
        while (a[i] === "0") i++;
        while (b[j] === "0") j++;
        let firstDiff = 0;
        while (isDigit(a[i]) && isDigit(b[j])) {
            if (firstDiff === 0)
                firstDiff = (a[i] as string).charCodeAt(0) - (b[j] as string).charCodeAt(0);
            i++;
            j++;
        }
        if (isDigit(a[i])) return 1;
        if (isDigit(b[j])) return -1;
        if (firstDiff !== 0) return firstDiff;
    }
    return 0;
}

/** Whether an SDK folder already holds the packages the engine's Gradle project needs. */
async function sdkHasPackages(sdk: string): Promise<boolean> {
    const platforms = await readdir(join(sdk, "platforms")).catch(() => [] as string[]);
    return (
        (await exists(join(sdk, "platform-tools"))) &&
        (await exists(join(sdk, "build-tools", ANDROID_BUILD_TOOLS))) &&
        platforms.some((dir) => new RegExp(`^android-${ANDROID_COMPILE_SDK}([.-].*)?$`).test(dir))
    );
}

/**
 * `sdkmanager` run through the JDK directly (what `bin/sdkmanager[.bat]` does), so no shell or
 * `.bat` quoting is involved on any host.
 */
export function sdkmanagerCommand(
    sdk: string,
    java: string,
    args: string[],
): { command: string; args: string[] } {
    const tools = join(sdk, "cmdline-tools", "latest");
    return {
        command: java,
        args: [
            `-Dcom.android.sdklib.toolsdir=${tools}`,
            "-classpath",
            join(tools, "lib", "sdkmanager-classpath.jar"),
            "com.android.sdklib.tool.sdkmanager.SdkManagerCli",
            `--sdk_root=${sdk}`,
            "--channel=3",
            ...args,
        ],
    };
}

/** The Android SDK: ANDROID_SDK_ROOT/ANDROID_HOME with every package, else the cache. */
async function ensureAndroidSdk(ctx: Context, jdk: ToolResult): Promise<ToolResult> {
    const name = "Android SDK";
    const sdkEnv = (sdk: string) => ({ ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk });
    for (const variable of ["ANDROID_SDK_ROOT", "ANDROID_HOME"]) {
        const sdk = ctx.env[variable];
        if (sdk && (await sdkHasPackages(sdk))) {
            return {
                status: { name, source: "system", detail: `${variable} ${sdk}` },
                env: sdkEnv(sdk),
            };
        }
    }
    const sdk = join(ctx.root, "android-sdk");
    const marker = await readMarker<{ packages: string[] }>(sdk);
    if (marker && (await sdkHasPackages(sdk))) {
        return {
            status: { name, source: "cache", detail: `${sdk} (${marker.packages.join(", ")})` },
            env: sdkEnv(sdk),
        };
    }
    if (!ctx.install) {
        return missing(
            name,
            `ANDROID_SDK_ROOT/ANDROID_HOME unset or without platform-tools, platforms;android-${ANDROID_COMPILE_SDK} and build-tools;${ANDROID_BUILD_TOOLS}`,
        );
    }
    if (jdk.status.source === "missing") return missing(name, "needs the JDK");
    const java = jdk.command ?? "java";
    const tools = join(sdk, "cmdline-tools", "latest");
    if (!(await exists(join(tools, "lib", "sdkmanager-classpath.jar")))) {
        const archive = cmdlineToolsArchive(ctx.host, ctx.arch);
        const staging = join(ctx.root, "cmdline-tools");
        await installArchive(
            ctx,
            staging,
            archive.url,
            archive.sha256,
            "Android cmdline-tools",
            archive.name,
        );
        await mkdir(join(sdk, "cmdline-tools"), { recursive: true });
        await rm(tools, { recursive: true, force: true });
        await rename(join(staging, "cmdline-tools"), tools);
        await rm(staging, { recursive: true, force: true });
        if (ctx.host !== "win32") {
            for (const file of await readdir(join(tools, "bin"))) {
                await chmod(join(tools, "bin", file), 0o755);
            }
        }
    }
    const sdkmanager = (args: string[], input?: string) => ({
        ...sdkmanagerCommand(sdk, java, args),
        env: { ...sdkEnv(sdk), ...(jdk.env ?? {}) },
        input,
    });
    ctx.log(`${name}: accepting the SDK licenses`);
    // `yes | sdkmanager --licenses || true` in roves-action.
    await ctx.run(sdkmanager(["--licenses"], "y\n".repeat(100))).catch(() => {});
    const list = await ctx.capture(sdkmanager(["--list"]));
    const platform = selectPlatformPackage(list);
    if (!platform) {
        throw new RovesError(
            `no platforms;android-${ANDROID_COMPILE_SDK}* package advertised by sdkmanager --list`,
        );
    }
    const packages = ["platform-tools", platform, `build-tools;${ANDROID_BUILD_TOOLS}`];
    const install = sdkmanager(packages, "y\n".repeat(20));
    ctx.log(`${name}: ${formatCommand({ command: "sdkmanager", args: packages })}`);
    await ctx.run(install);
    if (!(await sdkHasPackages(sdk))) {
        throw new RovesError(`${name}: sdkmanager finished but ${sdk} lacks the packages`);
    }
    await writeMarker(sdk, { cmdlineTools: CMDLINE_TOOLS_REVISION, packages });
    return {
        status: { name, source: "installed", detail: `${sdk} (${packages.join(", ")})` },
        env: sdkEnv(sdk),
    };
}

/** The uv release asset for a host (`uv-<target>.zip` on Windows, `.tar.gz` elsewhere). */
export function uvAsset(host: NodeJS.Platform, arch: string) {
    const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
    const os = {
        win32: "pc-windows-msvc.zip",
        darwin: "apple-darwin.tar.gz",
        linux: "unknown-linux-gnu.tar.gz",
    }[host as string];
    const key = `${cpu}-${os}`;
    const sha256 = UV_SHA256[key];
    if (!cpu || !os || !sha256)
        throw new RovesError(`no uv build is published for ${host}/${arch}`);
    const name = `uv-${key}`;
    return {
        name,
        url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`,
        sha256,
    };
}

/** uv on PATH, else the cache, else the pinned release. */
async function ensureUv(ctx: Context): Promise<ToolResult> {
    const name = "uv";
    const version = ctx.probe("uv", ["--version"]);
    if (version)
        return { status: { name, source: "system", detail: version.trim() }, command: "uv" };
    const asset = uvAsset(ctx.host, ctx.arch);
    const dir = join(
        ctx.root,
        `uv-${UV_VERSION}-${asset.name.replace(/^uv-|\.(zip|tar\.gz)$/g, "")}`,
    );
    const use = (bin: string, source: ToolSource): ToolResult => ({
        status: { name, source, detail: `uv ${UV_VERSION} at ${bin}` },
        command: join(bin, exe(ctx.host, "uv")),
        path: [bin],
    });
    const marker = await readMarker<{ bin: string }>(dir);
    if (marker && (await exists(join(dir, marker.bin)))) return use(join(dir, marker.bin), "cache");
    if (!ctx.install) return missing(name, "uv is not on PATH");
    await installArchive(ctx, dir, asset.url, asset.sha256, name, asset.name);
    const bin = await findDirWith(dir, exe(ctx.host, "uv"), 2);
    if (!bin) throw new RovesError(`${asset.name} contains no uv executable`);
    await writeMarker(dir, { bin: bin.slice(dir.length + 1) });
    return use(bin, "installed");
}

/** XcodeGen on PATH, else the cache, else the official release zip (brew as a last resort). */
async function ensureXcodegen(ctx: Context): Promise<ToolResult> {
    const name = "XcodeGen";
    const version = ctx.probe("xcodegen", ["--version"]);
    if (version)
        return { status: { name, source: "system", detail: version.trim() }, command: "xcodegen" };
    const dir = join(ctx.root, `xcodegen-${XCODEGEN_VERSION}`);
    const binary = join(dir, "xcodegen", "bin", "xcodegen");
    const use = (source: ToolSource): ToolResult => ({
        status: { name, source, detail: `XcodeGen ${XCODEGEN_VERSION} at ${binary}` },
        command: binary,
    });
    if ((await readMarker(dir)) && (await exists(binary))) return use("cache");
    if (!ctx.install) return missing(name, "xcodegen is not on PATH");
    try {
        await installArchive(
            ctx,
            dir,
            `https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip`,
            XCODEGEN_SHA256,
            name,
            "xcodegen.zip",
        );
        await chmod(binary, 0o755);
        await writeMarker(dir, { version: XCODEGEN_VERSION });
        return use("installed");
    } catch (error) {
        // roves-action installs it with Homebrew; use that only if the release zip failed.
        if (!ctx.probe("brew", ["--version"])) throw error;
        ctx.log(`${name}: ${(error as Error).message}; falling back to brew install xcodegen`);
        await ctx.run({ command: "brew", args: ["install", "xcodegen"] });
        return {
            status: { name, source: "installed", detail: "brew install xcodegen" },
            command: "xcodegen",
        };
    }
}

function finish(
    results: ToolResult[],
    extra: Omit<Toolchain, "tools" | "env">,
    ctx: Context,
    platform: string,
): Toolchain {
    const tools = results.map((r) => r.status);
    const absent = tools.filter((t) => t.source === "missing");
    if (absent.length > 0) {
        throw new RovesError(
            `${platform} toolchain incomplete:\n  - ${absent.map((t) => `${t.name}: ${t.detail}`).join("\n  - ")}\n${
                ctx.install
                    ? ""
                    : `Run \`roves setup ${platform.toLowerCase()}\` or drop --no-install to install them into the cache.`
            }`.trimEnd(),
        );
    }
    let env: Record<string, string> = {};
    for (const result of results) env = { ...env, ...(result.env ?? {}) };
    const path = results.flatMap((r) => r.path ?? []);
    if (path.length > 0) env = { ...env, ...pathEnv(ctx, path) };
    for (const tool of tools) ctx.log(`${platform}: ${tool.name}: ${tool.source} (${tool.detail})`);
    return { tools, env, ...extra };
}

/** JDK 17, the Android SDK packages and uv, reused or installed into the cache. */
export async function prepareAndroidToolchain(options: ToolchainOptions = {}): Promise<Toolchain> {
    const ctx = context(options);
    const jdk = await ensureJdk(ctx);
    const sdk = await ensureAndroidSdk(ctx, jdk);
    const uv = await ensureUv(ctx);
    return finish(
        [jdk, sdk, uv],
        { uv: uv.command ?? "uv", git: Boolean(ctx.probe("git", ["--version"])) },
        ctx,
        "Android",
    );
}

/**
 * iOS (macOS only): Xcode must already be installed; XcodeGen (default mode) and uv (release
 * mode, and Python when there is no python3) are reused or installed into the cache.
 */
export async function prepareIosToolchain(
    options: ToolchainOptions & { release?: boolean } = {},
): Promise<Toolchain> {
    const ctx = context(options);
    if (ctx.host !== "darwin") {
        throw new RovesError(
            `iOS packaging requires macOS (this host is ${ctx.host}): Xcode and XcodeGen only exist there`,
        );
    }
    const results: ToolResult[] = [];
    const xcode = ctx.probe("xcodebuild", ["-version"]);
    results.push(
        xcode
            ? {
                  status: {
                      name: "Xcode",
                      source: "system",
                      detail: xcode.split("\n")[0] ?? "xcodebuild",
                  },
              }
            : missing(
                  "Xcode",
                  "xcodebuild not found: install Xcode from the App Store (needs an administrator), then run it once",
              ),
    );
    const python3 = !options.release && ctx.probe("python3", ["--version"]);
    let xcodegen: ToolResult | undefined;
    if (!options.release) {
        xcodegen = await ensureXcodegen(ctx);
        results.push(xcodegen);
    }
    let uv: ToolResult | undefined;
    if (options.release || !python3) {
        uv = await ensureUv(ctx);
        results.push(uv);
    }
    if (python3)
        results.push({ status: { name: "Python", source: "system", detail: python3.trim() } });
    const uvCommand = uv?.command ?? "uv";
    return finish(
        results,
        {
            uv: uvCommand,
            git: Boolean(ctx.probe("git", ["--version"])),
            xcodegen: xcodegen?.command,
            python: options.release
                ? undefined
                : python3
                  ? ["python3"]
                  : [uvCommand, "run", "--no-project", "python"],
        },
        ctx,
        "iOS",
    );
}
