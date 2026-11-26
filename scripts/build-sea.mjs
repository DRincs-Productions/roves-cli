/**
 * Builds the standalone `roves` executable for the host with Node.js's official Single
 * Executable Applications (https://nodejs.org/api/single-executable-applications.html):
 *
 *   1. tsup bundles the CLI and every dependency into one CommonJS script (tsup.sea.config.ts);
 *   2. `node --experimental-sea-config` turns it into a preparation blob;
 *   3. a copy of the running `node` binary gets the blob injected with postject (the tool the
 *      Node.js docs use), after removing (macOS: and re-adding, ad hoc) its code signature.
 *
 * Output: `dist-sea/roves-<target-triple>[.exe]`, named like Tauri sidecars
 * (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, ...), so
 * Roves Packmaster can bundle it as `externalBin` as is. The executable embeds the Node.js that
 * runs this script: build with the Node.js version you want to ship (CI uses Node 22 LTS).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-sea");

/** Rust/Tauri target triple of this host. */
export function targetTriple(platform = process.platform, arch = process.arch) {
    const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
    const os = {
        win32: "pc-windows-msvc",
        darwin: "apple-darwin",
        linux: "unknown-linux-gnu",
    }[platform];
    if (!cpu || !os) throw new Error(`no SEA target for ${platform}/${arch}`);
    return `${cpu}-${os}`;
}

function run(command, args, options = {}) {
    console.log(`> ${command} ${args.join(" ")}`);
    execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });
}

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const require = createRequire(import.meta.url);
// Node.js runs the tools directly (no shell, so paths with spaces are fine).
run(process.execPath, [
    require.resolve("tsup/dist/cli-default.js"),
    "--config",
    "tsup.sea.config.ts",
]);

const blob = join(out, "sea-prep.blob");
const config = join(out, "sea-config.json");
writeFileSync(
    config,
    JSON.stringify(
        {
            main: join(out, "roves.cjs"),
            output: blob,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
        },
        null,
        2,
    ),
);
run(process.execPath, ["--experimental-sea-config", config]);

const exe = join(out, `roves-${targetTriple()}${isWindows ? ".exe" : ""}`);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (isMac) run("codesign", ["--remove-signature", exe]);
// On Windows, postject warns that the signature of the copied node.exe becomes invalid: expected.
const { inject } = require("postject");
console.log(`> postject ${exe} NODE_SEA_BLOB`);
await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(isMac ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (isMac) run("codesign", ["--sign", "-", exe]);

execFileSync(exe, ["--version"], { stdio: "inherit" });
console.log(
    `${exe} (${(statSync(exe).size / 1048576).toFixed(1)} MiB, Node.js ${process.version})`,
);
