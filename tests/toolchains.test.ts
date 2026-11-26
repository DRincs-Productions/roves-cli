import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create as createTar } from "tar";
import { describe, expect, it } from "vitest";
import { ensureEngineSource } from "../src/mobile";
import type { Net } from "../src/net";
import type { CommandSpec } from "../src/process";
import {
    adoptiumAssetsUrl,
    cmdlineToolsArchive,
    parseJavaMajor,
    prepareAndroidToolchain,
    prepareIosToolchain,
    sdkmanagerCommand,
    selectAdoptiumPackage,
    selectPlatformPackage,
    uvAsset,
} from "../src/toolchains";
import { ZipWriter } from "../src/zip";
import { tempDir, write } from "./helpers";

const sha256 = async (path: string) =>
    createHash("sha256")
        .update(await readFile(path))
        .digest("hex");

async function zipFixture(path: string, files: Record<string, string>): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    const writer = new ZipWriter(path);
    for (const [name, content] of Object.entries(files)) {
        writer.addBuffer(name, Buffer.from(content), { mode: 0o100755 });
    }
    await writer.finish();
    return path;
}

async function tarFixture(path: string, root: string, entries: string[]): Promise<string> {
    await createTar({ gzip: true, file: path, cwd: root }, entries);
    return path;
}

/** A fake network serving local files by URL; records the requested URLs. */
function fakeNet(files: Record<string, string>, json: Record<string, unknown> = {}) {
    const requests: string[] = [];
    const net: Net = {
        fetchJson: async (url) => {
            requests.push(url);
            if (!(url in json)) throw new Error(`unexpected JSON request ${url}`);
            return json[url];
        },
        fetchText: async (url) => {
            throw new Error(`unexpected request ${url}`);
        },
        download: async (url, dest) => {
            requests.push(url);
            const source = files[url];
            if (!source) throw new Error(`unexpected download ${url}`);
            await writeFile(dest, await readFile(source));
        },
    };
    return { net, requests };
}

/** Probe answers by command name (undefined: not installed). */
const probeWith =
    (answers: Record<string, string>) =>
    (command: string): string | undefined =>
        answers[command] ?? answers[command.replace(/\\/g, "/").split("/").pop() ?? ""];

async function fakeSdk(root: string): Promise<string> {
    for (const dir of ["platform-tools", "platforms/android-37", "build-tools/36.0.0"]) {
        await mkdir(join(root, dir), { recursive: true });
    }
    return root;
}

describe("version, URL and checksum selection", () => {
    it("parses java -version output", () => {
        expect(parseJavaMajor('openjdk version "17.0.12" 2024-07-16')).toBe(17);
        expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
        expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21);
        expect(parseJavaMajor("nothing")).toBeUndefined();
    });

    it("selects the Temurin 17 JDK per OS and CPU", () => {
        expect(adoptiumAssetsUrl("win32", "x64")).toBe(
            "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse",
        );
        expect(adoptiumAssetsUrl("darwin", "arm64")).toContain(
            "architecture=aarch64&image_type=jdk&os=mac",
        );
        expect(adoptiumAssetsUrl("linux", "x64")).toContain("os=linux");
        expect(() => adoptiumAssetsUrl("aix", "x64")).toThrow(/no JDK 17/);
        expect(() => selectAdoptiumPackage([])).toThrow(/no usable JDK/);
        expect(
            selectAdoptiumPackage([
                {
                    release_name: "jdk-17.0.21.1+2",
                    binary: {
                        package: {
                            name: "a.zip",
                            link: "https://x/a.zip",
                            checksum: "a".repeat(64),
                            size: 1,
                        },
                    },
                },
            ]),
        ).toMatchObject({ release: "jdk-17.0.21.1+2", link: "https://x/a.zip" });
    });

    it("pins the cmdline-tools 15859902 archive of every host", () => {
        expect(cmdlineToolsArchive("win32", "x64")).toEqual({
            name: "commandlinetools-win-15859902_latest.zip",
            url: "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip",
            sha256: "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a",
        });
        expect(cmdlineToolsArchive("linux", "x64").name).toBe(
            "commandlinetools-linux-15859902_latest.zip",
        );
        expect(cmdlineToolsArchive("darwin", "arm64").name).toBe(
            "commandlinetools-mac_arm64-15859902_latest.zip",
        );
        expect(cmdlineToolsArchive("darwin", "x64").name).toBe(
            "commandlinetools-mac_x86_64-15859902_latest.zip",
        );
        for (const [host, arch] of [
            ["win32", "x64"],
            ["linux", "x64"],
            ["darwin", "arm64"],
            ["darwin", "x64"],
        ] as const) {
            expect(cmdlineToolsArchive(host, arch).sha256).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it("pins the uv release asset of every host", () => {
        expect(uvAsset("win32", "x64").url).toBe(
            "https://github.com/astral-sh/uv/releases/download/0.13.10/uv-x86_64-pc-windows-msvc.zip",
        );
        expect(uvAsset("darwin", "arm64").name).toBe("uv-aarch64-apple-darwin.tar.gz");
        expect(uvAsset("linux", "arm64").name).toBe("uv-aarch64-unknown-linux-gnu.tar.gz");
        expect(() => uvAsset("linux", "ia32")).toThrow(/no uv build/);
    });

    it("picks the newest platforms;android-37 package like sort -V | tail -1", () => {
        const list = [
            "  platforms;android-36 | 1 | Android SDK Platform 36",
            "  platforms;android-37 | 1 | Android SDK Platform 37",
            "  platforms;android-37.0 | 2 | Android SDK Platform 37.0",
            "  platforms;android-37-ext19 | 1 | Android SDK Platform 37 ext 19",
            "  platforms;android-37.1 | 1 | Android SDK Platform 37.1",
            "  platforms;android-370 | 1 | not this",
        ].join("\n");
        expect(selectPlatformPackage(list)).toBe("platforms;android-37.1");
        expect(selectPlatformPackage("platforms;android-36")).toBeUndefined();
    });

    it("runs sdkmanager through the JDK, on the canary channel like roves-action", () => {
        const spec = sdkmanagerCommand("/sdk", "/jdk/bin/java", ["--list"]);
        expect(spec.command).toBe("/jdk/bin/java");
        expect(spec.args).toContain("com.android.sdklib.tool.sdkmanager.SdkManagerCli");
        expect(spec.args.slice(-3)).toEqual(["--sdk_root=/sdk", "--channel=3", "--list"]);
    });
});

describe("Android toolchain", () => {
    it("reuses a suitable JDK, SDK and uv without touching the network", async () => {
        const tmp = await tempDir();
        const sdk = await fakeSdk(join(tmp, "sdk"));
        const { net, requests } = fakeNet({});
        const toolchain = await prepareAndroidToolchain({
            cacheDir: join(tmp, "cache"),
            host: "linux",
            arch: "x64",
            env: { ANDROID_HOME: sdk, PATH: "/usr/bin" },
            probe: probeWith({
                java: 'openjdk version "21.0.4"',
                uv: "uv 0.9.0",
                git: "git version 2",
            }),
            net,
        });
        expect(requests).toEqual([]);
        expect(toolchain.tools.map((t) => `${t.name}:${t.source}`)).toEqual([
            "JDK 17:system",
            "Android SDK:system",
            "uv:system",
        ]);
        expect(toolchain.env).toEqual({ ANDROID_SDK_ROOT: sdk, ANDROID_HOME: sdk });
        expect(toolchain.uv).toBe("uv");
        expect(toolchain.git).toBe(true);
    });

    it("fails with the list of missing tools under --no-install", async () => {
        const tmp = await tempDir();
        const old = await mkdir(join(tmp, "partial-sdk", "platform-tools"), { recursive: true });
        expect(old).toBeTruthy();
        const error = await prepareAndroidToolchain({
            install: false,
            cacheDir: join(tmp, "cache"),
            host: "linux",
            arch: "x64",
            env: { ANDROID_HOME: join(tmp, "partial-sdk") },
            probe: probeWith({ java: 'java version "1.8.0_392"' }),
            net: fakeNet({}).net,
        }).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toMatch(/JDK 17: no Java 17\+/);
        expect(message).toMatch(/Android SDK: ANDROID_SDK_ROOT\/ANDROID_HOME/);
        expect(message).toMatch(/uv: uv is not on PATH/);
        expect(message).toMatch(/roves setup android/);
    });

    it("installs the JDK from Adoptium (checksum verified), the SDK packages, and reuses them next time", async () => {
        const tmp = await tempDir();
        const cacheDir = join(tmp, "cache");
        const jdkZip = await zipFixture(join(tmp, "fixtures", "jdk.zip"), {
            "jdk-17.0.21.1+2/bin/java.exe": "java",
            "jdk-17.0.21.1+2/release": "JAVA_VERSION=17",
        });
        const apiUrl = adoptiumAssetsUrl("win32", "x64");
        const { net, requests } = fakeNet(
            { "https://example/jdk.zip": jdkZip },
            {
                [apiUrl]: [
                    {
                        release_name: "jdk-17.0.21.1+2",
                        binary: {
                            package: {
                                name: "jdk.zip",
                                link: "https://example/jdk.zip",
                                checksum: await sha256(jdkZip),
                            },
                        },
                    },
                ],
            },
        );
        // cmdline-tools already extracted in the cache (its download is covered by the checksum test).
        const sdk = join(cacheDir, "toolchains", "android-sdk");
        await write(sdk, "cmdline-tools/latest/lib/sdkmanager-classpath.jar", "jar");
        const calls: CommandSpec[] = [];
        const options = {
            cacheDir,
            host: "win32" as const,
            arch: "x64",
            env: { Path: "C:\\Windows" },
            probe: probeWith({ uv: "uv 0.13.10", git: "git version 2" }),
            net,
            runner: async (spec: CommandSpec) => {
                calls.push(spec);
                if (spec.args.includes("platform-tools")) await fakeSdk(sdk);
            },
            capture: async (spec: CommandSpec) => {
                calls.push(spec);
                return "platforms;android-37 | 1\nplatforms;android-37.0 | 1\n";
            },
        };
        const first = await prepareAndroidToolchain(options);
        const home = join(cacheDir, "toolchains", "jdk-17-windows-x64", "jdk-17.0.21.1+2");
        expect(first.tools.map((t) => `${t.name}:${t.source}`)).toEqual([
            "JDK 17:installed",
            "Android SDK:installed",
            "uv:system",
        ]);
        expect(first.env).toEqual({
            JAVA_HOME: home,
            ANDROID_SDK_ROOT: sdk,
            ANDROID_HOME: sdk,
            Path: `${join(home, "bin")};C:\\Windows`,
        });
        const java = join(home, "bin", "java.exe");
        expect(calls.map((c) => c.command)).toEqual([java, java, java]);
        expect(calls.map((c) => c.args.slice(-2))).toEqual([
            ["--channel=3", "--licenses"],
            ["--channel=3", "--list"],
            ["platforms;android-37.0", "build-tools;36.0.0"],
        ]);
        expect(calls[2]?.args).toContain("platform-tools");
        expect(calls[0]?.input).toMatch(/^y\n/);
        expect(calls[0]?.env).toMatchObject({ JAVA_HOME: home, ANDROID_SDK_ROOT: sdk });
        expect(await stat(join(sdk, ".roves-complete"))).toBeTruthy();

        const second = await prepareAndroidToolchain(options);
        expect(second.tools.map((t) => t.source)).toEqual(["cache", "cache", "system"]);
        expect(requests.filter((url) => url.endsWith("jdk.zip"))).toHaveLength(1);
        expect(calls).toHaveLength(3);
    });

    it("extracts a .tar.gz JDK (macOS layout) and finds Contents/Home", async () => {
        const tmp = await tempDir();
        const root = join(tmp, "src");
        await write(root, "jdk-17.0.21+2/Contents/Home/bin/java", "java");
        const archive = await tarFixture(join(tmp, "jdk.tar.gz"), root, ["jdk-17.0.21+2"]);
        const apiUrl = adoptiumAssetsUrl("darwin", "arm64");
        const { net } = fakeNet(
            { "https://example/jdk.tar.gz": archive },
            {
                [apiUrl]: [
                    {
                        binary: {
                            package: {
                                name: "jdk.tar.gz",
                                link: "https://example/jdk.tar.gz",
                                checksum: await sha256(archive),
                            },
                        },
                    },
                ],
            },
        );
        const sdk = await fakeSdk(join(tmp, "sdk"));
        const toolchain = await prepareAndroidToolchain({
            cacheDir: join(tmp, "cache"),
            host: "darwin",
            arch: "arm64",
            env: { ANDROID_SDK_ROOT: sdk, PATH: "/usr/bin" },
            probe: probeWith({ uv: "uv", git: "git" }),
            net,
        });
        expect(toolchain.env.JAVA_HOME).toBe(
            join(
                tmp,
                "cache",
                "toolchains",
                "jdk-17-mac-aarch64",
                "jdk-17.0.21+2",
                "Contents",
                "Home",
            ),
        );
        expect(toolchain.env.PATH?.endsWith(":/usr/bin")).toBe(true);
    });

    it("refuses a download whose SHA-256 does not match the pin and caches nothing", async () => {
        const tmp = await tempDir();
        const archive = cmdlineToolsArchive("linux", "x64");
        const bogus = await zipFixture(join(tmp, "bogus.zip"), {
            "cmdline-tools/bin/sdkmanager": "x",
        });
        const { net } = fakeNet({ [archive.url]: bogus });
        await expect(
            prepareAndroidToolchain({
                cacheDir: join(tmp, "cache"),
                host: "linux",
                arch: "x64",
                env: {},
                probe: probeWith({ java: 'openjdk version "17.0.1"', uv: "uv" }),
                net,
            }),
        ).rejects.toThrow(/SHA-256 mismatch/);
        expect(
            await stat(join(tmp, "cache", "toolchains", "cmdline-tools")).catch(() => null),
        ).toBeNull();
    });
});

describe("iOS toolchain", () => {
    it("requires macOS and an installed Xcode", async () => {
        await expect(prepareIosToolchain({ host: "linux" })).rejects.toThrow(/requires macOS/);
        const tmp = await tempDir();
        await expect(
            prepareIosToolchain({
                host: "darwin",
                arch: "arm64",
                cacheDir: join(tmp, "cache"),
                probe: probeWith({ xcodegen: "2.49.0", python3: "Python 3.12" }),
                net: fakeNet({}).net,
            }),
        ).rejects.toThrow(/Xcode: xcodebuild not found/);
    });

    it("reuses xcodegen and python3, and falls back to uv's Python without python3", async () => {
        const tmp = await tempDir();
        const withPython = await prepareIosToolchain({
            host: "darwin",
            arch: "arm64",
            cacheDir: join(tmp, "cache"),
            env: {},
            probe: probeWith({
                xcodebuild: "Xcode 26.1",
                xcodegen: "Version: 2.49.0",
                python3: "Python 3.12",
            }),
            net: fakeNet({}).net,
        });
        expect(withPython.python).toEqual(["python3"]);
        expect(withPython.xcodegen).toBe("xcodegen");
        const withoutPython = await prepareIosToolchain({
            host: "darwin",
            arch: "arm64",
            cacheDir: join(tmp, "cache"),
            env: {},
            probe: probeWith({ xcodebuild: "Xcode 26.1", xcodegen: "2.49.0", uv: "uv 0.13" }),
            net: fakeNet({}).net,
        });
        expect(withoutPython.python).toEqual(["uv", "run", "--no-project", "python"]);
        const release = await prepareIosToolchain({
            host: "darwin",
            arch: "arm64",
            release: true,
            cacheDir: join(tmp, "cache"),
            env: {},
            probe: probeWith({ xcodebuild: "Xcode 26.1", uv: "uv 0.13" }),
            net: fakeNet({}).net,
        });
        expect(release.tools.map((t) => t.name)).toEqual(["Xcode", "uv"]);
    });

    it("lists XcodeGen as missing under --no-install", async () => {
        const tmp = await tempDir();
        await expect(
            prepareIosToolchain({
                host: "darwin",
                arch: "arm64",
                install: false,
                cacheDir: join(tmp, "cache"),
                env: {},
                probe: probeWith({ xcodebuild: "Xcode 26.1", python3: "Python 3" }),
                net: fakeNet({}).net,
            }),
        ).rejects.toThrow(/XcodeGen: xcodegen is not on PATH[\s\S]*roves setup ios/);
    });
});

describe("engine source without git", () => {
    it("downloads and extracts the tag's source archive", async () => {
        const tmp = await tempDir();
        const root = join(tmp, "src");
        await write(root, "roves-0.7.15/mach", "#!/bin/sh");
        await write(root, "roves-0.7.15/support/ios/bundle.py", "print()");
        const archive = await tarFixture(join(tmp, "src.tar.gz"), root, ["roves-0.7.15"]);
        const { net, requests } = fakeNet({
            "https://github.com/DRincs-Productions/roves/archive/refs/tags/v0.7.15.tar.gz": archive,
        });
        const dir = await ensureEngineSource({ cacheDir: join(tmp, "cache"), git: false, net });
        expect(await readFile(join(dir, "mach"), "utf8")).toBe("#!/bin/sh");
        expect(await ensureEngineSource({ cacheDir: join(tmp, "cache"), git: false, net })).toBe(
            dir,
        );
        expect(requests).toHaveLength(1);
    });
});
