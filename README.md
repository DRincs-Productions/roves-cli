# roves-cli

`@drincs/roves-cli` packages your already-built web game as a native
[Roves](https://github.com/DRincs-Productions/roves) app, from the command line (`roves`) or from
Node.js:

- **Desktop (Windows, macOS, Linux)**: the prebuilt Roves CEF player (Chromium Embedded
  Framework, SDL3, wgpu) of a pinned engine release, with your game in its `game/` folder and
  your icon applied. Standard, Steam and MCP (development) variants. Nothing is compiled, and
  **any host builds any desktop platform** (pure JavaScript; Unix modes, the setuid
  `chrome-sandbox` and macOS framework symlinks are preserved).
- **Android and iOS (experimental)**: the native WebView tooling of the engine at `v0.7.15`
  (`mach bundle --android`, `support/ios/bundle.py` + XcodeGen, `mach bundle --ios --ios-release`).
  These need the platform toolchains.

It does what the [`roves-action`](https://github.com/DRincs-Productions/roves-action) GitHub
Action and Roves Packmaster do, so it works on a developer machine and in any CI.

## Install

```bash
npm install -g @drincs/roves-cli
roves --help
```

Requires Node.js 20.19 or newer. `npx @drincs/roves-cli <command>` works without installing.

## Usage

Build your game first (e.g. `npm run build` producing `dist/` with `index.html` at its root),
then:

### `roves bundle` (desktop)

```bash
roves bundle -c dist                                   # host platform -> ./roves-game.zip + ./roves-game/
roves bundle -c dist -p windows,macos,linux -n my-game -o release   # release/my-game_<platform>.zip
roves bundle -c dist --steam --steam-app-id 480        # Steam variant + steam_appid.txt
roves bundle -c dist --enable-mcp -n my-game_mcp       # MCP development player (never ship it)
roves bundle -c dist --icon-png icon.png --icon-ico icon.ico
roves bundle -c dist -p linux --json                   # machine-readable result
```

| Option                      | Description                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `-c, --content-dir <dir>`   | Built web game with `index.html` at its root (required).                                |
| `-p, --platform <platform>` | `windows`, `macos`, `linux`; repeatable or comma separated. Default: host.              |
| `--icon-png <file>`         | Square PNG project icon (16-2048 px, at most 8 MiB). Default: `<content-dir>/icon.png`. |
| `--icon-ico <file>`         | `.ico` for `play.exe`. Default: generated from the PNG, else `icon.ico`/`favicon.ico`.  |
| `--steam`                   | Steam variant (Steamworks redistributable next to the executable).                      |
| `--steam-app-id <id>`       | Writes `steam_appid.txt` next to the executable (development). Requires `--steam`.      |
| `--enable-mcp`              | MCP-enabled development player. Not with `--steam`.                                     |
| `-n, --name <name>`         | Zip/folder base name (default `roves-game`).                                            |
| `-o, --out-dir <dir>`       | Output directory (default `.`).                                                         |
| `--no-extract`              | Only the zip, no unzipped folder.                                                       |
| `--shell-version <tag>`     | Engine release of the player (default: pinned, see below).                              |
| `--shell-zip <file>`        | Local player zip instead of a download (one platform).                                  |
| `--no-cache` / `--refresh`  | Skip the cache / re-download.                                                           |
| `--json`                    | JSON results on stdout.                                                                 |

Outputs: one platform gives `<name>.zip` (one `<name>/` folder inside, or `<name>.app/` at the
root on macOS) and the unzipped `<name>/` (`<name>.app`); several platforms give
`<name>_<platform>.zip` and `<name>_<platform>/`. Each result reports `archive-path`,
`bundle-dir`, `mcp-enabled` and `icon-source`, like roves-action's outputs.

Windows packages are verified against the player's `SHA256SUMS.txt` and get a regenerated one
plus a "game replaced" note in `PROVENANCE.txt`; `play.exe`'s icon is patched in pure JS.
macOS `.app` bundles are not signed or notarized; on Linux hosts that restrict user namespaces
run `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` after unzipping.

### `roves android`

```bash
roves android -c dist --app-name "My Game" --orientation landscape
ROVES_ANDROID_KEYSTORE_PASSWORD=... ROVES_ANDROID_KEY_PASSWORD=... \
  roves android -c dist --release --keystore release.jks --key-alias upload
```

Uses a JDK 17, the Android SDK and uv, installing the missing ones into the cache (see
below). Options: `--icon-png`, `--app-name`, `--orientation`, `--theme-color`,
`--release`, `--keystore`/`--keystore-base64`, `--keystore-password`, `--key-alias`,
`--key-password` (each signing value also from `ROVES_ANDROID_*` environment variables),
`--no-bootstrap`, `--no-install`, `-n`, `-o`, `--engine-dir`, `--json`.

### `roves ios` (macOS only)

```bash
roves ios -c dist --app-name "My Game" --bundle-id com.example.mygame      # .xcodeproj + Simulator .app
roves ios -c dist --release --certificate-p12 dist.p12 --provisioning-profile app.mobileprovision --team-id ABCDE12345
```

Needs Xcode (installed by you); XcodeGen (default mode) and uv (`--release`, or when `python3` is
missing) are installed into the cache when absent. Signing values can come from `ROVES_IOS_*`
environment variables, and certificate/profile also as base64. `--no-install` as for Android.

### Mobile toolchains: automatic install, `roves setup`, `--no-install`

`roves android` and `roves ios` reuse the tools already on the machine and install only what is
missing, per user and without admin rights, into `<cache>/toolchains` (the same versions
roves-action installs): a Temurin JDK 17 from the Adoptium API (SHA-256 checked), the Android
SDK command-line tools revision 15859902 (SHA-256 pinned) with `platform-tools`, the newest
`platforms;android-37*` and `build-tools;36.0.0` (licenses accepted non-interactively, canary
channel as in the action), uv 0.13.10, and on macOS XcodeGen 2.49.0 (release zip; `brew` only as a
fallback). They are used only by the processes `roves` starts (`JAVA_HOME`, `ANDROID_SDK_ROOT`,
`ANDROID_HOME`, `PATH`); your shell profile and global environment are never changed. Without
git, the engine source is downloaded as the tag's archive. Xcode cannot be installed this way
and stays a requirement for iOS.

```bash
roves setup android          # prepare the Android toolchain only (about 850 MB on disk)
roves setup ios              # macOS: XcodeGen (+ uv when python3 is missing); --release: uv
roves setup android --no-install   # only check; lists what is missing
roves android -c dist --no-install # fail instead of installing
```

### `roves download`

```bash
roves download -p linux --steam            # prints the cached zip path
roves download -p windows --output base.zip --no-cache
```

The cache is the user cache directory (`ROVES_CACHE_DIR` overrides it), keyed by release and
asset.

### Shell version pin

`src/shell-version.txt` pins the desktop player release (currently **v0.9.0**); every CLI
release uses that pin unless `--shell-version` overrides it. Android/iOS use the engine at
`v0.7.15`.

The full reference, with every option and the common errors, is the agent skill in
[`skills/core/SKILL.md`](https://github.com/DRincs-Productions/roves/blob/main/skills/core/SKILL.md)
in the Roves engine repository (installable with `npx skills add DRincs-Productions/roves`).

## Programmatic API

```ts
import { bundleDesktop, buildAndroid, ensureShellAsset, assetName } from "@drincs/roves-cli";

const [windows] = await bundleDesktop({
    contentDir: "dist",
    platforms: ["windows"],
    name: "my-game",
    outDir: "release",
    log: (message) => console.error(message),
});
console.log(windows.archivePath, windows.iconSource);

const shell = await ensureShellAsset(assetName("linux", true)); // cached roves_shell_linux_steam.zip
```

Main exports: `bundleDesktop`, `buildAndroid`, `buildIos`, `ensureShellAsset`, `assetName`,
`assetUrl`, `PINNED_SHELL_VERSION`, `MOBILE_ENGINE_VERSION`; lower level: `PlayerBase`,
`assemble`, `resolveProjectIcon`, `setExeIcon`, `generateIco`, `generateIcns`, the mobile
argument builders (`androidBundleArgs`, `machCommand`, ...), `runCli`/`createProgram`. Expected
failures throw `RovesError`. The package is ESM; Node.js 20.19+ can also `require()` it.

## Development

```bash
npm install
npm run build            # tsup -> dist/ (cli.mjs with shebang, index.mjs, index.d.ts)
npm run check            # Biome lint + format check (npm run format to fix formatting)
npm run typecheck        # tsc --noEmit
npm test -- --run        # Vitest (synthetic player zips, no network)
node dist/cli.mjs --help
```

CI: `Test: build, lint and unit tests` runs on every push on Windows only; Linux and macOS run at
release time in the `Release` workflow. `Validate Agent Skills` checks the skill on every push.

## Releasing

Bump `version` in `package.json`, commit, then push a tag `v<version>` (e.g. `v0.1.0`). The
`Release` workflow tests on Node 20.19/22.18/24, publishes to npm (needs the `NPM_TOKEN`
repository secret) and creates a GitHub Release.

When the engine publishes a new desktop player release, bump `src/shell-version.txt` and release
the CLI.

## License

[MPL-2.0](LICENSE)
