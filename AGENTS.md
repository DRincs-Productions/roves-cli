# Developing roves-cli

`@drincs/roves-cli` is the `roves` command and Node.js API that package a built web game as a
native Roves app: the engine's prebuilt CEF desktop players (downloaded from engine releases),
and the engine's Android/iOS WebView tooling at the mobile pin. The CLI (`src/cli.ts`) is a thin
commander layer over the API exported from `src/index.ts`; keep logic in the API.

## Parity with roves-action and Roves Packmaster

This package must be able to do everything `DRincs-Productions/roves-action` does, so the
action and Roves Packmaster can depend on it. Desktop assembly mirrors Packmaster's
`src-tauri/src/cef_player.rs` (zip-to-zip copy keeping modes/symlinks, Windows
`SHA256SUMS.txt` verify and regenerate, `PROVENANCE.txt` rewrite, icon precedence, Steam and MCP
rules); mobile mirrors the action's `action.yml` steps. When one of them changes a rule, change
it here too (and the other way round), and update the tests.

## Pins

- `src/shell-version.txt`: the desktop player release (`roves_shell_<platform>[_steam|_mcp].zip`).
  Bump it on every engine release that changes the desktop player, then release the CLI.
- `MOBILE_ENGINE_VERSION` in `src/constants.ts` (`v0.7.15`): an engine tag that still has
  `mach bundle --android`/`--ios` and `support/ios/bundle.py`. Do not move it without checking.
- Mobile toolchains: `src/toolchains.ts` only DETECTS them (JDK major, compileSdk and
  build-tools from the engine's `build.gradle.kts` at the mobile pin, uv, git, Xcode, XcodeGen,
  Python) and fails listing every missing one with an install hint. It never installs anything:
  roves-action installs the toolchains on its runners and then calls this CLI. Keep the required
  versions in step with roves-action's install steps.

## Conventions

- TypeScript, ESM only (Node >= 20.19). English for code, comments and docs.
- Prefer maintained libraries over hand-written code; justify every new dependency.
- Expected failures throw `RovesError` (printed without a stack by the CLI).
- Logs go to stderr, results to stdout.
- Before finishing: `npm run build`, `npm run check` (Biome; fix findings), `npm run typecheck`,
  `npm test -- --run`.
- Tests use synthetic player zips (`tests/helpers.ts`), never the network. Add tests for every
  behavior change.
- Keep `README.md` and the agent skill `skills/core/SKILL.md` in the Roves engine repository
  (DRincs-Productions/roves) accurate for every command and option.

## CI

- `Test: build, lint and unit tests` (`.github/workflows/test.yml`): every push, Windows only.
- `Release` (`.github/workflows/npm-publish.yml`): on `v*` tags; Linux tests on Node
  20.19/22.18/24, npm publish (`NPM_TOKEN` secret), GitHub Release. Linux/macOS CI runs only here.
