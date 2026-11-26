/**
 * Detection of the external toolchains of the Android/iOS paths. This package never installs
 * them: it finds what is on the machine, passes the detected settings (JAVA_HOME,
 * ANDROID_SDK_ROOT/ANDROID_HOME) only to the processes it starts, and otherwise fails listing
 * every missing tool with a concrete install hint. roves-action installs all of them on its
 * runners (setup-java, the Android SDK command-line tools and packages, setup-uv, XcodeGen)
 * before it calls this CLI.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { RovesError } from "./errors";
import { type CommandProbe, probeCommand } from "./process";

/** The JDK major version the engine's Gradle project needs (roves-action: Temurin 17). */
export const JDK_MAJOR = 17;
/** The engine's `servoapp/build.gradle.kts` at the mobile pin (compileSdk, buildToolsVersion). */
export const ANDROID_COMPILE_SDK = "37";
export const ANDROID_BUILD_TOOLS = "36.0.0";

export const ROVES_ACTION_NOTE =
    "roves-action (DRincs-Productions/roves-action) installs all of them automatically on its runners.";

export interface ToolStatus {
    name: string;
    found: boolean;
    /** Where it was found, or why it is missing. */
    detail: string;
    /** How to install it (missing tools only). */
    hint?: string;
}

export interface ToolchainOptions {
    /** Host OS (tests). */
    host?: NodeJS.Platform;
    /** Environment the tools are looked up in (tests). */
    env?: NodeJS.ProcessEnv;
    /** Detection probe (tests). */
    probe?: CommandProbe;
    /** git is needed to clone the engine (false with `--engine-dir`). Default true. */
    needsGit?: boolean;
    /** Home directory, for the default Android SDK locations (tests). */
    home?: string;
    log?: (message: string) => void;
}

/** The detected toolchain: the environment for the processes that use it. */
export interface Toolchain {
    tools: ToolStatus[];
    /** Variables for the mach/xcodegen/python processes only (never exported globally). */
    env: Record<string, string>;
    /** iOS: how to run Python (`python3`, or uv's managed Python). */
    python?: string[];
}

const exe = (host: NodeJS.Platform, name: string) => (host === "win32" ? `${name}.exe` : name);

async function isDir(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/** The major version in `java -version` output (`"17.0.9"` -> 17, `"1.8.0_392"` -> 8). */
export function parseJavaMajor(output: string): number | undefined {
    const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
    if (!match) return undefined;
    const first = Number(match[1]);
    return first === 1 ? Number(match[2]) : first;
}

/** `java.home` from `java -XshowSettings:properties -version`. */
export function parseJavaHome(output: string): string | undefined {
    return /^\s*java\.home = (.+?)\s*$/m.exec(output)?.[1];
}

const found = (name: string, detail: string): ToolStatus => ({ name, found: true, detail });
const missing = (name: string, detail: string, hint: string): ToolStatus => ({
    name,
    found: false,
    detail,
    hint,
});

const JDK_HINT = `install a JDK ${JDK_MAJOR}+ (e.g. Temurin ${JDK_MAJOR}: https://adoptium.net) and set JAVA_HOME to it`;

/**
 * JDK 17+: JAVA_HOME first, else `java` on PATH (its `java.home` then becomes JAVA_HOME for
 * the child processes, so an older JAVA_HOME never wins in Gradle).
 */
function detectJdk(
    probe: CommandProbe,
    env: NodeJS.ProcessEnv,
    host: NodeJS.Platform,
): { status: ToolStatus; env?: Record<string, string> } {
    const name = `JDK ${JDK_MAJOR}+`;
    const javaHome = env.JAVA_HOME;
    let rejected = "";
    if (javaHome) {
        const major = parseJavaMajor(
            probe(join(javaHome, "bin", exe(host, "java")), ["-version"]) ?? "",
        );
        if (major !== undefined && major >= JDK_MAJOR) {
            return {
                status: found(name, `JAVA_HOME ${javaHome} (Java ${major})`),
                env: { JAVA_HOME: javaHome },
            };
        }
        rejected =
            major === undefined
                ? `JAVA_HOME ${javaHome} has no working bin/java; `
                : `JAVA_HOME ${javaHome} is Java ${major}; `;
    }
    const output = probe("java", ["-XshowSettings:properties", "-version"]) ?? "";
    const major = parseJavaMajor(output);
    if (major !== undefined && major >= JDK_MAJOR) {
        const home = parseJavaHome(output);
        return {
            status: found(name, `java on PATH (Java ${major}${home ? `, ${home}` : ""})`),
            env: home ? { JAVA_HOME: home } : undefined,
        };
    }
    const onPath = major === undefined ? "no java on PATH" : `java on PATH is Java ${major}`;
    return { status: missing(name, `${rejected}${onPath}`, JDK_HINT) };
}

/** The packages of `ANDROID_SDK_PACKAGES` an SDK folder lacks (empty: complete). */
export async function missingSdkPackages(sdk: string): Promise<string[]> {
    const lacks: string[] = [];
    if (!(await isDir(join(sdk, "platform-tools")))) lacks.push("platform-tools");
    const platforms = await readdir(join(sdk, "platforms")).catch(() => [] as string[]);
    if (
        !platforms.some((dir) => new RegExp(`^android-${ANDROID_COMPILE_SDK}([.-].*)?$`).test(dir))
    ) {
        lacks.push(`platforms;android-${ANDROID_COMPILE_SDK}`);
    }
    if (!(await isDir(join(sdk, "build-tools", ANDROID_BUILD_TOOLS)))) {
        lacks.push(`build-tools;${ANDROID_BUILD_TOOLS}`);
    }
    return lacks;
}

/** The SDK packages the engine's Gradle project needs, as `sdkmanager` arguments. */
export const ANDROID_SDK_PACKAGES = [
    "platform-tools",
    `platforms;android-${ANDROID_COMPILE_SDK}`,
    `build-tools;${ANDROID_BUILD_TOOLS}`,
];

const SDK_HINT = `install the Android SDK command-line tools (https://developer.android.com/studio#command-line-tools-only) or Android Studio, run \`sdkmanager ${ANDROID_SDK_PACKAGES.map((p) => `"${p}"`).join(" ")}\` and set ANDROID_SDK_ROOT (or ANDROID_HOME) to the SDK folder`;

/** Android Studio's default SDK folder for a host. */
export function defaultSdkLocation(
    host: NodeJS.Platform,
    home: string,
    env: NodeJS.ProcessEnv,
): string | undefined {
    if (host === "win32") {
        return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Android", "Sdk") : undefined;
    }
    if (host === "darwin") return join(home, "Library", "Android", "sdk");
    return join(home, "Android", "Sdk");
}

/** The Android SDK: ANDROID_SDK_ROOT, ANDROID_HOME, then Android Studio's default folder. */
async function detectAndroidSdk(
    env: NodeJS.ProcessEnv,
    host: NodeJS.Platform,
    home: string,
): Promise<{ status: ToolStatus; env?: Record<string, string> }> {
    const name = "Android SDK";
    const problems: string[] = [];
    const candidates: [string, string | undefined][] = [
        ["ANDROID_SDK_ROOT", env.ANDROID_SDK_ROOT],
        ["ANDROID_HOME", env.ANDROID_HOME],
        ["Android Studio's default folder", defaultSdkLocation(host, home, env)],
    ];
    for (const [label, sdk] of candidates) {
        if (!sdk || !(await isDir(sdk))) continue;
        const lacks = await missingSdkPackages(sdk);
        if (lacks.length === 0) {
            return {
                status: found(name, `${label} ${sdk}`),
                env: { ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk },
            };
        }
        problems.push(`${label} ${sdk} lacks ${lacks.join(", ")}`);
    }
    return {
        status: missing(
            name,
            problems.length > 0 ? problems.join("; ") : "ANDROID_SDK_ROOT/ANDROID_HOME not set",
            SDK_HINT,
        ),
    };
}

function detectCommand(
    probe: CommandProbe,
    name: string,
    command: string,
    args: string[],
    hint: string,
): ToolStatus {
    const output = probe(command, args);
    return output
        ? found(name, (output.trim().split(/\r?\n/)[0] ?? command).trim())
        : missing(name, `${command} not found on PATH`, hint);
}

const UV_HINT =
    "install uv (https://docs.astral.sh/uv/getting-started/installation/: `pipx install uv`, `brew install uv`, or the standalone installer)";
const GIT_HINT =
    "install git (https://git-scm.com/downloads), or pass --engine-dir with an engine checkout";

function fail(platform: string, tools: ToolStatus[]): never {
    const absent = tools.filter((tool) => !tool.found);
    throw new RovesError(
        `${platform} prerequisites missing:\n${absent
            .map((tool) => `  - ${tool.name}: ${tool.detail}\n    install: ${tool.hint}`)
            .join("\n")}\n${ROVES_ACTION_NOTE}`,
    );
}

function report(platform: string, tools: ToolStatus[], log?: (message: string) => void): void {
    for (const tool of tools) {
        if (tool.found) log?.(`${platform}: ${tool.name}: ${tool.detail}`);
    }
    if (tools.some((tool) => !tool.found)) fail(platform, tools);
}

/** JDK 17+, the Android SDK packages, uv and (unless `needsGit` is false) git. */
export async function detectAndroidToolchain(options: ToolchainOptions = {}): Promise<Toolchain> {
    const probe = options.probe ?? probeCommand;
    const env = options.env ?? process.env;
    const host = options.host ?? process.platform;
    const jdk = detectJdk(probe, env, host);
    const sdk = await detectAndroidSdk(env, host, options.home ?? homedir());
    const tools = [
        jdk.status,
        sdk.status,
        detectCommand(probe, "uv", "uv", ["--version"], UV_HINT),
    ];
    if (options.needsGit ?? true) {
        tools.push(detectCommand(probe, "git", "git", ["--version"], GIT_HINT));
    }
    report("Android", tools, options.log);
    return { tools, env: { ...jdk.env, ...sdk.env } };
}

/**
 * iOS (macOS only): Xcode, XcodeGen and Python (default mode; uv's managed Python when there is
 * no python3), or uv (`release`), plus git unless `needsGit` is false.
 */
export async function detectIosToolchain(
    options: ToolchainOptions & { release?: boolean } = {},
): Promise<Toolchain> {
    const probe = options.probe ?? probeCommand;
    const host = options.host ?? process.platform;
    if (host !== "darwin") {
        throw new RovesError(
            `iOS packaging requires macOS (this host is ${host}): Xcode and XcodeGen only exist there`,
        );
    }
    const tools = [
        detectCommand(
            probe,
            "Xcode",
            "xcodebuild",
            ["-version"],
            "install Xcode from the App Store (or https://developer.apple.com/xcode/), open it once and run `sudo xcode-select -s /Applications/Xcode.app`",
        ),
    ];
    let python: string[] | undefined;
    const uv = () => detectCommand(probe, "uv", "uv", ["--version"], UV_HINT);
    if (options.release) {
        tools.push(uv());
    } else {
        tools.push(
            detectCommand(
                probe,
                "XcodeGen",
                "xcodegen",
                ["--version"],
                "`brew install xcodegen` (or the release zip from https://github.com/yonaskolb/XcodeGen/releases)",
            ),
        );
        const python3 = probe("python3", ["--version"]);
        if (python3) {
            tools.push(found("Python", python3.trim()));
            python = ["python3"];
        } else {
            const uvStatus = uv();
            tools.push(
                uvStatus.found
                    ? { ...uvStatus, name: "Python (through uv)" }
                    : missing(
                          "Python 3",
                          "neither python3 nor uv found on PATH",
                          `install Python 3 (https://www.python.org/downloads/) or ${UV_HINT.replace(/^install /, "")}`,
                      ),
            );
            python = ["uv", "run", "--no-project", "python"];
        }
    }
    if (options.needsGit ?? true) {
        tools.push(detectCommand(probe, "git", "git", ["--version"], GIT_HINT));
    }
    report("iOS", tools, options.log);
    return { tools, env: {}, python };
}
