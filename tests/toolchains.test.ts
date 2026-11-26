import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    defaultSdkLocation,
    detectAndroidToolchain,
    detectIosToolchain,
    missingSdkPackages,
    parseJavaHome,
    parseJavaMajor,
} from "../src/toolchains";
import { tempDir } from "./helpers";

/** Probe answers by command (path or name); undefined: not installed. */
const probeWith =
    (answers: Record<string, string>) =>
    (command: string): string | undefined =>
        answers[command] ?? answers[command.replace(/\\/g, "/").split("/").pop() ?? ""];

async function fakeSdk(
    root: string,
    packages = ["platform-tools", "platforms/android-37.2", "build-tools/36.0.0"],
) {
    for (const dir of packages) await mkdir(join(root, dir), { recursive: true });
    return root;
}

const JAVA_17 =
    'openjdk version "17.0.12" 2024-07-16\nProperty settings:\n    java.home = /opt/jdk-17\n';

describe("parsing", () => {
    it("reads java -version and java.home", () => {
        expect(parseJavaMajor('openjdk version "17.0.12" 2024-07-16')).toBe(17);
        expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
        expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
        expect(parseJavaMajor("nothing")).toBeUndefined();
        expect(parseJavaHome(JAVA_17)).toBe("/opt/jdk-17");
        expect(parseJavaHome("java.home missing")).toBeUndefined();
    });

    it("knows Android Studio's default SDK folders", () => {
        expect(defaultSdkLocation("darwin", "/Users/u", {})).toBe(
            join("/Users/u", "Library", "Android", "sdk"),
        );
        expect(defaultSdkLocation("linux", "/home/u", {})).toBe(join("/home/u", "Android", "Sdk"));
        expect(defaultSdkLocation("win32", "C:\\Users\\u", { LOCALAPPDATA: "C:\\L" })).toBe(
            join("C:\\L", "Android", "Sdk"),
        );
        expect(defaultSdkLocation("win32", "C:\\Users\\u", {})).toBeUndefined();
    });

    it("lists the SDK packages a folder lacks", async () => {
        const tmp = await tempDir();
        expect(await missingSdkPackages(await fakeSdk(join(tmp, "full")))).toEqual([]);
        expect(
            await missingSdkPackages(
                await fakeSdk(join(tmp, "partial"), ["platform-tools", "platforms/android-36"]),
            ),
        ).toEqual(["platforms;android-37", "build-tools;36.0.0"]);
    });
});

describe("Android detection", () => {
    it("uses JAVA_HOME, ANDROID_SDK_ROOT, uv and git, passing only the detected variables", async () => {
        const tmp = await tempDir();
        const sdk = await fakeSdk(join(tmp, "sdk"));
        const toolchain = await detectAndroidToolchain({
            host: "linux",
            home: tmp,
            env: { JAVA_HOME: "/jdk", ANDROID_SDK_ROOT: sdk },
            probe: probeWith({ java: JAVA_17, uv: "uv 0.9.0", git: "git version 2.47" }),
        });
        expect(toolchain.tools.map((t) => `${t.name}:${t.found}`)).toEqual([
            "JDK 17+:true",
            "Android SDK:true",
            "uv:true",
            "git:true",
        ]);
        expect(toolchain.env).toEqual({
            JAVA_HOME: "/jdk",
            ANDROID_SDK_ROOT: sdk,
            ANDROID_HOME: sdk,
        });
    });

    it("prefers java on PATH over a too old JAVA_HOME and exports its java.home", async () => {
        const tmp = await tempDir();
        const sdk = await fakeSdk(join(tmp, "sdk"));
        const toolchain = await detectAndroidToolchain({
            host: "linux",
            home: tmp,
            needsGit: false,
            env: { JAVA_HOME: "/old-jdk", ANDROID_HOME: sdk },
            probe: (command, args) =>
                command === join("/old-jdk", "bin", "java")
                    ? 'java version "1.8.0_392"'
                    : command === "java" && args.includes("-XshowSettings:properties")
                      ? JAVA_17
                      : command === "uv"
                        ? "uv 0.9"
                        : undefined,
        });
        expect(toolchain.env.JAVA_HOME).toBe("/opt/jdk-17");
        expect(toolchain.tools.map((t) => t.name)).toEqual(["JDK 17+", "Android SDK", "uv"]);
    });

    it("finds the SDK in Android Studio's default folder", async () => {
        const tmp = await tempDir();
        const sdk = await fakeSdk(join(tmp, "Android", "Sdk"));
        const toolchain = await detectAndroidToolchain({
            host: "linux",
            home: tmp,
            needsGit: false,
            env: {},
            probe: probeWith({ java: JAVA_17, uv: "uv" }),
        });
        expect(toolchain.env.ANDROID_SDK_ROOT).toBe(sdk);
        expect(toolchain.tools[1]?.detail).toMatch(/Android Studio's default folder/);
    });

    it("fails listing every missing tool with install hints", async () => {
        const tmp = await tempDir();
        const partial = await fakeSdk(join(tmp, "sdk"), ["platform-tools"]);
        const error = await detectAndroidToolchain({
            host: "linux",
            home: tmp,
            env: { ANDROID_HOME: partial },
            probe: probeWith({ java: 'java version "1.8.0_392"' }),
        }).catch((e: Error) => e);
        const message = (error as Error).message;
        expect(message).toMatch(/^Android prerequisites missing:/);
        expect(message).toMatch(
            /JDK 17\+: java on PATH is Java 8\n {4}install: install a JDK 17\+/,
        );
        expect(message).toMatch(
            /Android SDK: ANDROID_HOME .* lacks platforms;android-37, build-tools;36\.0\.0/,
        );
        expect(message).toMatch(
            /sdkmanager "platform-tools" "platforms;android-37" "build-tools;36\.0\.0"/,
        );
        expect(message).toMatch(/uv: uv not found on PATH\n {4}install: install uv/);
        expect(message).toMatch(/git: git not found on PATH/);
        expect(message).toMatch(/roves-action .* installs all of them automatically/);
    });
});

describe("iOS detection", () => {
    it("requires macOS", async () => {
        await expect(detectIosToolchain({ host: "linux" })).rejects.toThrow(/requires macOS/);
    });

    it("needs Xcode and XcodeGen, and uses python3 or uv's Python", async () => {
        const withPython = await detectIosToolchain({
            host: "darwin",
            needsGit: false,
            probe: probeWith({
                xcodebuild: "Xcode 26.1",
                xcodegen: "Version: 2.49.0",
                python3: "Python 3.12",
            }),
        });
        expect(withPython.python).toEqual(["python3"]);
        expect(withPython.env).toEqual({});
        const withUv = await detectIosToolchain({
            host: "darwin",
            needsGit: false,
            probe: probeWith({ xcodebuild: "Xcode 26.1", xcodegen: "2.49.0", uv: "uv 0.13" }),
        });
        expect(withUv.python).toEqual(["uv", "run", "--no-project", "python"]);
        const release = await detectIosToolchain({
            host: "darwin",
            release: true,
            probe: probeWith({ xcodebuild: "Xcode 26.1", uv: "uv 0.13", git: "git" }),
        });
        expect(release.tools.map((t) => t.name)).toEqual(["Xcode", "uv", "git"]);
    });

    it("lists Xcode, XcodeGen and Python with hints when missing", async () => {
        await expect(
            detectIosToolchain({ host: "darwin", needsGit: false, probe: () => undefined }),
        ).rejects.toThrow(
            /Xcode: xcodebuild not found[\s\S]*App Store[\s\S]*XcodeGen[\s\S]*brew install xcodegen[\s\S]*Python 3/,
        );
    });
});
