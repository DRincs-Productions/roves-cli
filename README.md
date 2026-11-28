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
roves bundle -c dist --compression-level 6 --max-archive-size 500MB   # smaller download
roves bundle -c dist --content-layout files            # loose files instead of archives
```

| Option                      | Description                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --content-dir <dir>`   | Built web game with `index.html` at its root (required).                                                                                                        |
| `-p, --platform <platform>` | `windows`, `macos`, `linux`; repeatable or comma separated. Default: host.                                                                                      |
| `--content-layout <layout>` | `archive` (default with player v0.9.1+) or `files` (loose copy). See "Packed game content".                                                                     |
| `--compression-level <0-9>` | Archive compression: `0` (default, stored: fastest in game) to `9` (smallest download). Media are always stored.                                                |
| `--max-archive-size <size>` | Largest asset archive, e.g. `300MB` (default), `1GiB`; bigger folders are split. At least `1MB`.                                                                |
| `--icon-png <file>`         | Square PNG project icon (16-2048 px, at most 8 MiB). Default: `<content-dir>/icon.png`.                                                                         |
| `--icon-ico <file>`         | `.ico` for `play.exe`. Default: generated from the PNG, else `icon.ico`/`favicon.ico`.                                                                          |
| `--steam`                   | Steam variant (Steamworks redistributable next to the executable).                                                                                              |
| `--steam-app-id <id>`       | Writes `steam_appid.txt` next to the executable (development). Requires `--steam`.                                                                              |
| `--enable-mcp`              | MCP-enabled development player. Not with `--steam`.                                                                                                             |
| `--no-mods`                 | Do not load third-party mods (default: the game's `package.json` `roves.mods`, else allowed). DLC still load. See "Mods and DLC".                               |
| `--dlc <path>`              | Ship an official DLC in `dlc/` next to `game/`: a DLC folder (packed and registered in the project's `roves-dlc.json`) or a registered `.rovesmod`. Repeatable. |
| `--project-dir <dir>`       | The game's project folder with its `package.json`. Default: the nearest one above the content dir.                                                              |
| `-n, --name <name>`         | Zip/folder base name (default `roves-game`).                                                                                                                    |
| `-o, --out-dir <dir>`       | Output directory (default `.`).                                                                                                                                 |
| `--no-extract`              | Only the zip, no unzipped folder.                                                                                                                               |
| `--shell-version <tag>`     | Engine release of the player (default: pinned, see below).                                                                                                      |
| `--shell-zip <file>`        | Local player zip instead of a download (one platform).                                                                                                          |
| `--no-cache` / `--refresh`  | Skip the cache / re-download.                                                                                                                                   |
| `--json`                    | JSON results on stdout.                                                                                                                                         |
| `--progress <format>`       | `plain` (default; download percentages on a terminal) or `json`: one `{"type":"progress","platform","stage","fraction"}` line per event on stderr, for tools.   |

Outputs: one platform gives `<name>.zip` (one `<name>/` folder inside, or `<name>.app/` at the
root on macOS) and the unzipped `<name>/` (`<name>.app`); several platforms give
`<name>_<platform>.zip` and `<name>_<platform>/`. Each result reports `archive-path`,
`bundle-dir`, `mcp-enabled` and `icon-source`, like roves-action's outputs (`--json` adds
`topFolder`, `executable`, `asset`, `base`, `shellVersion`, `contentLayout`, `mods`, `dlc` and
`warnings`).

### Mods and DLC

`roves bundle` writes `game/roves-game.json` from the game's `package.json` (found above the
content dir, or `--project-dir`): its `name` and `version` (what add-ons are checked against),
whether mods are allowed (`roves.mods`, or `--no-mods`), the libraries the game shares
(entry chunks named after the game's `dependencies`, e.g. `assets/pixi.js-<hash>.js`, made
with `preserveEntrySignatures: "strict"`; a warning names single-instance libraries without
one) and the official DLC from the project's `roves-dlc.json`. Without a
`package.json` the package has no mod or DLC support (a warning). The player loads add-ons from
player v0.9.2: it lists a DLC only when its `.rovesmod` file is the registered build (same
SHA-256), and enables it by default; with the same id twice, the highest version wins.

| Command                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roves mod init [dir] --game <package> \| --game-name <name> [--kind dlc]` | Creates `package.json` (`name`, `version`, `main`, `files`, `roves.game` with `^<game version>`), `index.js` (a `defineMod` starter) and `overrides/`; in an existing project only adds the `roves` section.                                                                                                                                                                                                                              |
| `roves mod dev [dir] --game <package>`                                     | Runs an unzipped package of the game with the folder loaded unpacked (`--roves-dev-mod`; a DLC there needs no registration). `overrides/` is read live; other changes restart the game (`--no-watch` to turn it off).                                                                                                                                                                                                                     |
| `roves mod check [mod] --game <package> [--json]`                          | The player's checks against that package: game name and version range, shared libraries, `main`, and for a DLC whether that `.rovesmod` is registered. Exit code 1 when incompatible.                                                                                                                                                                                                                                                     |
| `roves mod pack [dir] [-o <dir>] [--project-dir <game>] [--json]`          | Writes the files `npm pack` would take (`files`, plus `package.json` and `cover.*`; never `node_modules` or `.git`), `dependencies` rewritten to the installed versions, deterministic. A mod becomes `<id>-<version>.rovesmod`; a DLC becomes `<id>.rovesmod` and is registered (id, version, SHA-256) in the game project's `roves-dlc.json` (found above the DLC folder, or `--project-dir`). Keep `roves-dlc.json` in the repository. |
| `roves bundle --dlc <path>`                                                | Ships an official DLC in `dlc/` next to `game/`: a DLC folder (packed and registered first) or a `.rovesmod` already registered. Repeatable. A new DLC, or a new version, is recognized only by game builds made after it was registered.                                                                                                                                                                                                 |

An add-on's `package.json`: `name` (id), `displayName`, `description`, `author`, `version`,
`main`, `files`, `peerDependencies` (libraries reused from the game), `dependencies` (bundled),
and `roves`: `kind` (`mod`/`dlc`), `game: {name, version}` (npm range), `mods` (required
add-ons), `steamAppId` (DLC). The cover is `cover.png`/`cover.jpg`/`cover.webp`; files in
`overrides/` replace the game's.

#### Packed game content

By default `game/` holds `roves-content.json`, `code.pack` (every code file: JS chunks, CSS,
HTML, JSON, WASM, source maps) and `data-<top folder>[-N].pack` archives (all other files,
grouped by their top-level folder, `data-root` for root files, split at `--max-archive-size`).
They are ZIP archives the player memory-maps and serves straight from memory, reading ahead the
next files of the same folder; stored (level 0) is the fastest in game, a level 1-9 makes the
download smaller and costs CPU the first time each file is read (compressed code is inflated
once at startup). Images, audio, video, fonts and archives are always stored. Packing is done
once for all platforms and is deterministic. With a `--shell-version` older than v0.9.1 the
default falls back to loose files (a warning says so); `--content-layout archive` then fails.
Symlinks inside the game folder can only be shipped with `--content-layout files`.

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

Needs a JDK 17+, the Android SDK packages, uv and git (see [Mobile prerequisites](#mobile-prerequisites)).
Options: `--icon-png`, `--app-name`, `--orientation`, `--theme-color`,
`--release`, `--keystore`/`--keystore-base64`, `--keystore-password`, `--key-alias`,
`--key-password` (each signing value also from `ROVES_ANDROID_*` environment variables),
`--no-bootstrap`, `-n`, `-o`, `--engine-dir`, `--json`.

### `roves ios` (macOS only)

```bash
roves ios -c dist --app-name "My Game" --bundle-id com.example.mygame      # .xcodeproj + Simulator .app
roves ios -c dist --release --certificate-p12 dist.p12 --provisioning-profile app.mobileprovision --team-id ABCDE12345
```

Needs Xcode, XcodeGen and Python (default mode) or uv (`--release`), see
[Mobile prerequisites](#mobile-prerequisites). Signing values can come from `ROVES_IOS_*`
environment variables, and certificate/profile also as base64.

### Mobile prerequisites

`roves android` and `roves ios` do not install toolchains: they detect them first and stop with
the full list of what is missing and how to install it. The detected settings (`JAVA_HOME`,
`ANDROID_SDK_ROOT`/`ANDROID_HOME`) are passed only to the processes `roves` starts.

| Path            | Needs                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android         | a JDK 17+ (`JAVA_HOME`, else `java` on PATH), the Android SDK with `platform-tools`, `platforms;android-37` and `build-tools;36.0.0` (`ANDROID_SDK_ROOT`, `ANDROID_HOME` or Android Studio's default folder), [uv](https://docs.astral.sh/uv/), and git (unless `--engine-dir`) |
| iOS (default)   | macOS, Xcode, XcodeGen, `python3` (or uv), git (unless `--engine-dir`)                                                                                                                                                                                                          |
| iOS `--release` | macOS, Xcode, uv, git (unless `--engine-dir`)                                                                                                                                                                                                                                   |

The [roves-action](https://github.com/DRincs-Productions/roves-action) GitHub Action installs
all of them on its runners before calling this CLI.

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

## Standalone executable

Every GitHub Release of roves-cli also attaches `roves-<target-triple>[.exe]`
(`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`): the CLI as a
single executable with Node.js inside (a Node.js
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html),
about 85 MB), so it runs where Node.js is not installed. Roves Packmaster bundles it as its
Tauri sidecar. It behaves exactly like `roves`:

```bash
./roves-x86_64-unknown-linux-gnu bundle -c dist -p linux --json
```

The binaries are not code-signed (macOS: ad hoc signature only).

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
npm run build:sea        # standalone executable for this host: dist-sea/roves-<target-triple>[.exe]
```

`build:sea` (`scripts/build-sea.mjs`) bundles the CLI and all its dependencies into one CommonJS
file (`tsup.sea.config.ts`, entry `src/sea.ts`), makes a SEA blob with
`node --experimental-sea-config` and injects it into a copy of the running `node` with postject
(macOS: signature removed and re-added ad hoc). The executable embeds the Node.js that ran the
script; the Release workflow uses Node.js 22 LTS. On Windows postject warns that the copied
`node.exe` signature is now invalid: expected.

CI: `Test: build, lint and unit tests` runs on every push on Windows only; Linux and macOS run at
release time in the `Release` workflow. `Validate Agent Skills` checks the skill on every push.

## Releasing

Bump `version` in `package.json`, commit, then push a tag `v<version>` (e.g. `v0.1.0`). The
`Release` workflow tests on Node 20.19/22.18/24, publishes to npm (needs the `NPM_TOKEN`
repository secret), creates a GitHub Release and attaches the standalone executables for
Windows (x64), macOS (arm64) and Linux (x64).

When the engine publishes a new desktop player release, bump `src/shell-version.txt` and release
the CLI.

## License

[MPL-2.0](LICENSE)
