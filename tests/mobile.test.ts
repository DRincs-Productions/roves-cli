import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    androidBundleArgs,
    androidSigningEnv,
    buildAndroid,
    buildIos,
    engineCloneCommand,
    iosReleaseArgs,
    iosSigningEnv,
    machBootstrapArgs,
    machCommand,
    validateAndroidOptions,
    validateIosOptions,
} from "../src/mobile";
import type { CommandSpec } from "../src/process";
import { dist, readZip, tempDir, write } from "./helpers";

/** Every tool "installed" (the JDK answering as Java 17). */
const allTools = () => 'openjdk version "17.0.1"';

/** An Android SDK folder with the packages the engine needs. */
async function sdkEnv(root: string): Promise<{ ANDROID_HOME: string }> {
    for (const dir of ["platform-tools", "platforms/android-37", "build-tools/36.0.0"]) {
        await mkdir(join(root, dir), { recursive: true });
    }
    return { ANDROID_HOME: root };
}

describe("mach invocation", () => {
    it("runs mach like the engine's own launchers", () => {
        expect(machCommand("/src", ["bundle"], "linux")).toEqual({
            command: "sh",
            args: ["mach", "bundle"],
            cwd: "/src",
        });
        const windows = machCommand("C:\\src", ["bundle"], "win32");
        expect(windows.command).toBe("uv");
        expect(windows.args.slice(0, 3)).toEqual(["run", "--frozen", "python"]);
        expect(windows.args.slice(-1)).toEqual(["bundle"]);
    });

    it("skips the platform packages of mach bootstrap only on Windows", () => {
        expect(machBootstrapArgs("linux")).toEqual([
            "bootstrap",
            "--force",
            "--yes",
            "--skip-lints",
            "--skip-nextest",
        ]);
        expect(machBootstrapArgs("win32").at(-1)).toBe("--skip-platform");
    });

    it("clones the engine shallowly at the pinned tag", () => {
        expect(engineCloneCommand("v0.7.15", "/cache/engine/v0.7.15").args).toEqual([
            "-c",
            "core.autocrlf=false",
            "clone",
            "--depth",
            "1",
            "--branch",
            "v0.7.15",
            "https://github.com/DRincs-Productions/roves.git",
            "/cache/engine/v0.7.15",
        ]);
    });
});

describe("Android arguments", () => {
    it("forwards only the options that are set", () => {
        expect(androidBundleArgs({ contentDir: "/c", output: "/o" })).toEqual([
            "bundle",
            "--android",
            "--content-dir",
            "/c",
            "--output",
            "/o",
        ]);
        expect(
            androidBundleArgs({
                contentDir: "/c",
                output: "/o",
                iconPng: "/i.png",
                appName: "My Game",
                orientation: "landscape",
                themeColor: "#000000",
                release: true,
            }),
        ).toEqual([
            "bundle",
            "--android",
            "--content-dir",
            "/c",
            "--output",
            "/o",
            "--icon-png",
            "/i.png",
            "--android-app-name",
            "My Game",
            "--android-orientation",
            "landscape",
            "--android-theme-color",
            "#000000",
            "--android-release",
        ]);
        expect(
            androidSigningEnv({
                keystorePath: "/k",
                keystorePassword: "sp",
                keyAlias: "a",
                keyPassword: "kp",
            }),
        ).toEqual({
            APK_SIGNING_KEY_STORE_PATH: "/k",
            APK_SIGNING_KEY_STORE_PASS: "sp",
            APK_SIGNING_KEY_ALIAS: "a",
            APK_SIGNING_KEY_PASS: "kp",
        });
    });

    it("validates release signing, orientation and content", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await expect(
            validateAndroidOptions({ contentDir: content, release: true }),
        ).rejects.toThrow(/no debug-signed fallback/);
        await expect(
            validateAndroidOptions({ contentDir: content, orientation: "sideways" }),
        ).rejects.toThrow(/invalid --android-orientation/);
        await expect(validateAndroidOptions({ contentDir: tmp })).rejects.toThrow(/no index.html/);
        await expect(
            validateAndroidOptions({ contentDir: content, keystore: "a", keystoreBase64: "b" }),
        ).rejects.toThrow(/either --keystore or --keystore-base64/);
        expect(await validateAndroidOptions({ contentDir: content, keyAlias: "a" })).toEqual([
            "signing options are ignored without --release (debug .apk)",
        ]);
    });

    it("runs bootstrap and mach bundle with the decoded keystore, then zips the output", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const engine = join(tmp, "engine");
        await write(engine, "mach", "#!/bin/sh");
        const calls: CommandSpec[] = [];
        let keystoreBytes = "";
        const result = await buildAndroid({
            contentDir: content,
            engineDir: engine,
            outDir: join(tmp, "out"),
            name: "my-game_android",
            release: true,
            keystoreBase64: Buffer.from("KEYSTORE").toString("base64"),
            keystorePassword: "sp",
            keyAlias: "alias",
            keyPassword: "kp",
            host: "linux",
            env: await sdkEnv(join(tmp, "sdk")),
            probe: allTools,
            runner: async (spec) => {
                calls.push(spec);
                if (spec.args.includes("--android")) {
                    keystoreBytes = await readFile(
                        spec.env?.APK_SIGNING_KEY_STORE_PATH ?? "",
                        "utf8",
                    );
                    await write(join(tmp, "out", "my-game_android"), "app-release.apk", "apk");
                }
            },
        });
        expect(calls.map((c) => c.command)).toEqual(["rustup", "sh", "sh"]);
        expect(calls[1]?.args.slice(0, 2)).toEqual(["mach", "bootstrap"]);
        const bundle = calls[2] as CommandSpec;
        expect(bundle.args).toContain("--android-release");
        expect(bundle.env).toMatchObject({
            APK_SIGNING_KEY_STORE_PASS: "sp",
            APK_SIGNING_KEY_ALIAS: "alias",
            APK_SIGNING_KEY_PASS: "kp",
            ANDROID_SDK_ROOT: join(tmp, "sdk"),
            ANDROID_HOME: join(tmp, "sdk"),
        });
        expect(keystoreBytes).toBe("KEYSTORE");
        // The decoded keystore is removed afterwards.
        expect(
            await stat(bundle.env?.APK_SIGNING_KEY_STORE_PATH ?? "").catch(() => null),
        ).toBeNull();
        expect(result.archivePath).toBe(join(tmp, "out", "my-game_android.zip"));
        const zip = await readZip(result.archivePath);
        expect(zip.get("my-game_android/app-release.apk")?.bytes.toString()).toBe("apk");
    });

    it("skips bootstrap with bootstrap: false and fails clearly without prerequisites", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const engine = join(tmp, "engine");
        await write(engine, "mach", "#!/bin/sh");
        const calls: CommandSpec[] = [];
        await buildAndroid({
            contentDir: content,
            engineDir: engine,
            outDir: join(tmp, "out"),
            bootstrap: false,
            host: "linux",
            env: await sdkEnv(join(tmp, "sdk")),
            probe: (command) => (command === "rustup" ? undefined : 'openjdk version "17.0.1"'),
            runner: async (spec) => {
                calls.push(spec);
                await write(join(tmp, "out", "roves-game"), "app-debug.apk", "apk");
            },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).not.toContain("--android-release");
        await expect(
            buildAndroid({
                contentDir: content,
                engineDir: engine,
                install: false,
                cacheDir: join(tmp, "cache"),
                probe: () => undefined,
                env: {},
            }),
        ).rejects.toThrow(/Android toolchain incomplete[\s\S]*JDK 17[\s\S]*Android SDK[\s\S]*uv/);
    });
});

describe("iOS", () => {
    it("builds release arguments and signing variables", () => {
        expect(
            iosReleaseArgs({ contentDir: "/c", output: "/o", appName: "G", bundleId: "a.b" }),
        ).toEqual([
            "bundle",
            "--ios",
            "--ios-release",
            "--content-dir",
            "/c",
            "--output",
            "/o",
            "--ios-app-name",
            "G",
            "--ios-bundle-id",
            "a.b",
        ]);
        expect(
            iosSigningEnv({
                certificateP12Path: "/p12",
                provisioningProfilePath: "/mp",
                teamId: "T",
            }),
        ).toEqual({
            IOS_SIGNING_CERTIFICATE_P12_PATH: "/p12",
            IOS_SIGNING_CERTIFICATE_P12_PASSWORD: "",
            IOS_SIGNING_PROVISIONING_PROFILE_PATH: "/mp",
            IOS_SIGNING_TEAM_ID: "T",
        });
    });

    it("requires macOS and complete signing for --release", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        await expect(validateIosOptions({ contentDir: content, host: "linux" })).rejects.toThrow(
            /requires macOS/,
        );
        await expect(
            validateIosOptions({ contentDir: content, host: "darwin", release: true, teamId: "T" }),
        ).rejects.toThrow(/--release requires/);
        expect(await validateIosOptions({ contentDir: content, host: "darwin" })).toEqual([]);
    });

    it("runs bundle.py, XcodeGen and the unsigned Simulator build", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const engine = join(tmp, "engine");
        await write(engine, "mach", "#!/bin/sh");
        const calls: CommandSpec[] = [];
        const result = await buildIos({
            contentDir: content,
            engineDir: engine,
            outDir: join(tmp, "out"),
            appName: "My Game",
            host: "darwin",
            probe: allTools,
            runner: async (spec) => {
                calls.push(spec);
                if (spec.command === "python3") {
                    await write(join(tmp, "out", "roves-game"), "project.json", "{}");
                }
                if (spec.command === "xcodebuild") {
                    const derived = spec.args[spec.args.indexOf("-derivedDataPath") + 1] as string;
                    await write(
                        join(
                            derived,
                            "Build",
                            "Products",
                            "Debug-iphonesimulator",
                            "RovesGame.app",
                        ),
                        "Info.plist",
                        "x",
                    );
                }
            },
        });
        expect(calls.map((c) => c.command)).toEqual(["python3", "xcodegen", "xcodebuild"]);
        expect(calls[0]?.args).toContain("--app-name");
        expect(calls[2]?.args).toContain("CODE_SIGNING_ALLOWED=NO");
        expect(await stat(join(result.bundleDir, "RovesGame.app", "Info.plist"))).toBeTruthy();
    });

    it("runs mach bundle --ios --ios-release with decoded secrets", async () => {
        const tmp = await tempDir();
        const content = await dist(join(tmp, "dist"));
        const engine = join(tmp, "engine");
        await write(engine, "mach", "#!/bin/sh");
        const calls: CommandSpec[] = [];
        await buildIos({
            contentDir: content,
            engineDir: engine,
            outDir: join(tmp, "out"),
            release: true,
            certificateP12Base64: Buffer.from("P12").toString("base64"),
            certificateP12Password: "pw",
            provisioningProfileBase64: Buffer.from("PROFILE").toString("base64"),
            teamId: "TEAM",
            host: "darwin",
            probe: allTools,
            runner: async (spec) => {
                calls.push(spec);
                expect(
                    await readFile(spec.env?.IOS_SIGNING_CERTIFICATE_P12_PATH ?? "", "utf8"),
                ).toBe("P12");
                expect(
                    await readFile(spec.env?.IOS_SIGNING_PROVISIONING_PROFILE_PATH ?? "", "utf8"),
                ).toBe("PROFILE");
                await write(join(tmp, "out", "roves-game"), "RovesGame.ipa", "ipa");
            },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args.slice(0, 4)).toEqual(["mach", "bundle", "--ios", "--ios-release"]);
        expect(calls[0]?.env).toMatchObject({
            IOS_SIGNING_CERTIFICATE_P12_PASSWORD: "pw",
            IOS_SIGNING_TEAM_ID: "TEAM",
        });
    });
});
