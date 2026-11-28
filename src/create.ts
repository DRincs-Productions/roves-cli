/**
 * `roves mod create`: a new TypeScript mod or DLC project (tsup, Biome, Vitest), for one game.
 * The game is an unzipped Roves package (mods) or the game's source project (DLC); the libraries
 * it shares become the add-on's peerDependencies, which the generated tsup config points at the
 * game's own copies (`/__mods/_shared/<lib>.js`).
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { RovesError } from "./errors";
import {
    type AddonKind,
    addonFileName,
    detectSharedLibraries,
    findPackagedGame,
    isSingleInstanceLibrary,
    validPackageName,
} from "./mods";
import agentsTemplate from "./templates/mod/AGENTS.md.tmpl";
import biomeTemplate from "./templates/mod/biome.json.tmpl";
import gitignoreTemplate from "./templates/mod/gitignore.tmpl";
import indexTemplate from "./templates/mod/index.ts.tmpl";
import readmeTemplate from "./templates/mod/README.md.tmpl";
import releaseTemplate from "./templates/mod/release.yml.tmpl";
import testTemplate from "./templates/mod/start.test.ts.tmpl";
import tsconfigTemplate from "./templates/mod/tsconfig.json.tmpl";
import tsupTemplate from "./templates/mod/tsup.config.ts.tmpl";
import vitestTemplate from "./templates/mod/vitest.config.ts.tmpl";
import vscodeExtensionsTemplate from "./templates/mod/vscode-extensions.json.tmpl";
import vscodeSettingsTemplate from "./templates/mod/vscode-settings.json.tmpl";

/** Versions the generated project starts from (the add-on side of the Roves tooling). */
export const CREATE_VERSIONS = {
    "@drincs/roves-api": "^0.11.0",
    "@drincs/roves-cli": "^0.6.0",
    "@biomejs/biome": "^2.5.14",
    jsdom: "^27.4.0",
    tsup: "^9.0.0",
    typescript: "^6.0.3",
    vitest: "^4.1.5",
};

/** What the game offers to a new add-on. */
export interface GameForAddon {
    name: string;
    version: string;
    /** Library -> the exact version the game ships. */
    shared: Record<string, string>;
    warnings: string[];
}

/**
 * Reads the game: an unzipped package for a mod (`game/roves-game.json`), the source project for a
 * DLC (`package.json`, and the shared libraries found in its built `dist/`, or, without a build,
 * its single-instance dependencies, with a warning).
 */
export async function readGameForAddon(kind: AddonKind, game: string): Promise<GameForAddon> {
    if (kind === "mod") {
        const packaged = await findPackagedGame(game);
        if (!packaged.identity) {
            throw new RovesError(
                `${game} was packaged without mod support (no game/roves-game.json): package it again with roves-cli 0.6 or later`,
            );
        }
        const shared: Record<string, string> = {};
        for (const [lib, entry] of Object.entries(packaged.identity.shared ?? {})) {
            const version = typeof entry === "string" ? entry : entry.version;
            shared[lib] = version;
        }
        return {
            name: packaged.identity.name,
            version: packaged.identity.version,
            shared,
            warnings: [],
        };
    }
    const projectDir = resolve(game);
    const manifest = JSON.parse(
        await readFile(join(projectDir, "package.json"), "utf8").catch(() => {
            throw new RovesError(
                `${projectDir} has no package.json: a DLC starts from the game's source project`,
            );
        }),
    ) as { name?: string; version?: string; dependencies?: Record<string, string> };
    if (!manifest.name || !manifest.version) {
        throw new RovesError(`${projectDir}/package.json has no name or version`);
    }
    const warnings: string[] = [];
    const shared: Record<string, string> = {};
    const dist = join(projectDir, "dist");
    if ((await stat(join(dist, "index.html")).catch(() => null))?.isFile()) {
        const detected = await detectSharedLibraries(projectDir, dist);
        for (const [lib, entry] of Object.entries(detected.shared)) shared[lib] = entry.version;
        warnings.push(...detected.warnings);
    } else {
        for (const lib of Object.keys(manifest.dependencies ?? {})) {
            if (!isSingleInstanceLibrary(lib)) continue;
            const installed = await readFile(
                join(projectDir, "node_modules", lib, "package.json"),
                "utf8",
            )
                .then((text) => (JSON.parse(text) as { version?: string }).version)
                .catch(() => undefined);
            if (installed) shared[lib] = installed;
        }
        warnings.push(
            `${projectDir} has no build (dist/index.html): the shared libraries were guessed from its dependencies. Build the game to confirm its entry chunks.`,
        );
    }
    return { name: manifest.name, version: manifest.version, shared, warnings };
}

export interface CreateModOptions {
    kind: AddonKind;
    /** An unzipped Roves package of the game (mod) or the game's source project (DLC). */
    game: string;
    /** The add-on id: its npm package name. */
    id: string;
    /** Display name (default: the id). */
    name?: string;
    description?: string;
    author?: string;
    /**
     * Where to create it (default: `<id without scope>` in the current folder; for a DLC,
     * `dlc-src/<id without scope>` inside the game project).
     */
    dir?: string;
    /** Shared libraries to use (default: the single-instance ones the game shares). */
    shared?: string[];
    /** Run `npm install` afterwards. */
    install?: boolean;
    /** Run `git init` afterwards. */
    git?: boolean;
    log?: (message: string) => void;
    /** Runs a command in the new project (tests). */
    run?: (command: string, args: string[], cwd: string) => Promise<void>;
}

export interface CreateModResult {
    dir: string;
    files: string[];
    /** The libraries the add-on uses from the game, with the game's versions. */
    shared: Record<string, string>;
    warnings: string[];
}

/** The default folder of a new add-on. */
export function defaultAddonDir(kind: AddonKind, id: string, game: string): string {
    const stem = id.replace(/^@/, "").replace("/", "-");
    return kind === "dlc" ? join(resolve(game), "dlc-src", stem) : resolve(stem);
}

/** `{{key}}` placeholders (no spaces, so GitHub's `${{ expr }}` stays as it is). */
function render(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        key in values ? (values[key] as string) : match,
    );
}

function posix(path: string): string {
    return path.split(sep).join("/");
}

function quote(path: string): string {
    return /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

function defaultRun(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        child.on("error", reject);
        child.on("exit", (code) =>
            code === 0
                ? resolvePromise()
                : reject(new RovesError(`${command} ${args.join(" ")} exited with ${code}`)),
        );
    });
}

/** A 1280x720 placeholder cover. */
async function placeholderCover(): Promise<Buffer> {
    const Jimp = createJimp({ formats: [png] });
    const image = new Jimp({ width: 1280, height: 720, color: 0x2b2d42ff });
    return image.getBuffer("image/png");
}

/** Creates the add-on project. Fails on a non-empty target folder. */
export async function createMod(options: CreateModOptions): Promise<CreateModResult> {
    const log = options.log ?? (() => {});
    if (!validPackageName(options.id)) {
        throw new RovesError(
            `"${options.id}" is not a valid package name (lowercase, e.g. @me/new-ending)`,
        );
    }
    const game = await readGameForAddon(options.kind, options.game);
    const dir = resolve(options.dir ?? defaultAddonDir(options.kind, options.id, options.game));
    const existing = await readdir(dir).catch(() => []);
    if (existing.length > 0) throw new RovesError(`${dir} is not empty`);

    const chosen =
        options.shared ?? Object.keys(game.shared).filter((lib) => isSingleInstanceLibrary(lib));
    const shared: Record<string, string> = {};
    for (const lib of chosen) {
        const version = game.shared[lib];
        if (!version) {
            throw new RovesError(
                `the game does not share ${lib} (it shares: ${Object.keys(game.shared).join(", ") || "nothing"})`,
            );
        }
        shared[lib] = version;
    }

    const name = options.name?.trim() || options.id;
    const description = options.description?.trim() ?? "";
    const gameRange = `^${game.version}`;
    const gameArg = posix(relative(dir, resolve(options.game))) || ".";
    const isDlc = options.kind === "dlc";
    const scripts: Record<string, string> = {
        dev: "tsup --watch",
        build: "tsup",
        check: "biome check",
        lint: "biome lint",
        format: "biome format --write",
        test: "vitest",
    };
    if (isDlc) {
        // The DLC is tried in a package of the game built from its source project.
        scripts["game:package"] =
            `roves bundle -c ${quote(`${gameArg}/dist`)} --project-dir ${quote(gameArg)} -n game -o .roves`;
        scripts.start = "roves mod dev --game .roves/game";
        scripts.pack = `npm run build && roves mod pack --project-dir ${quote(gameArg)}`;
    } else {
        scripts.start = `roves mod dev --game ${quote(gameArg)}`;
        scripts.pack = "npm run build && roves mod pack";
    }
    const manifest = {
        name: options.id,
        displayName: name,
        description,
        version: "0.1.0",
        ...(options.author?.trim() ? { author: options.author.trim() } : {}),
        type: "module",
        main: "dist/index.js",
        files: ["dist", "overrides", "cover.png"],
        scripts,
        ...(Object.keys(shared).length > 0
            ? {
                  peerDependencies: Object.fromEntries(
                      Object.entries(shared).map(([lib, v]) => [lib, `^${v}`]),
                  ),
              }
            : {}),
        devDependencies: Object.fromEntries(
            Object.entries({ ...CREATE_VERSIONS, ...shared }).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
        roves: {
            ...(isDlc ? { kind: "dlc" } : {}),
            game: { name: game.name, version: gameRange },
        },
    };

    const sharedList = Object.entries(shared);
    const firstShared = sharedList[0]?.[0];
    const values: Record<string, string> = {
        name,
        description: description || `A ${options.kind} for ${game.name}.`,
        kindLabel: isDlc ? "DLC" : "mod",
        gameName: game.name,
        gameRange,
        packedFile: addonFileName(options.id, options.kind, "0.1.0"),
        sharedImportExample: firstShared
            ? `// The game's own ${firstShared} (shared, never bundled):\n// import * as shared from "${firstShared}";\n`
            : "",
        sharedNotes: sharedList.length
            ? `These come from the game (\`peerDependencies\`), never bundled: tsup points them at the\ngame's own copy, so the ${isDlc ? "DLC" : "mod"} and the game use the same instance.\n\n${sharedList.map(([lib, v]) => `- \`${lib}\` ${v}`).join("\n")}\n\nImport them from the package root only. Other libraries go in \`dependencies\` and are bundled.`
            : "The game shares no library. Any library you use goes in `dependencies` and is bundled.",
        devNotes: isDlc
            ? "Build the game first (`npm run build` in its project), then `npm run game:package`\npackages it into `.roves/game` for `npm start`."
            : `\`npm start\` uses the packaged game at \`${gameArg}\`.`,
        packNotes: isDlc
            ? `It also records this DLC version in the game project's \`roves-dlc.json\`: build the game\nagain (\`roves bundle --dlc ${posix(relative(resolve(options.game), dir)) || "."}\`) so it recognizes it.`
            : "Players put the `.rovesmod` file in the game's `mods/` folder.",
    };
    const files: Record<string, string | Buffer> = {
        "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
        "tsup.config.ts": tsupTemplate,
        "tsconfig.json": tsconfigTemplate,
        "biome.json": biomeTemplate,
        "vitest.config.ts": vitestTemplate,
        "src/index.ts": render(indexTemplate, values),
        "tests/start.test.ts": testTemplate,
        "overrides/.gitkeep": "",
        ".gitignore": gitignoreTemplate,
        ".vscode/settings.json": vscodeSettingsTemplate,
        ".vscode/extensions.json": vscodeExtensionsTemplate,
        "README.md": render(readmeTemplate, values),
        "AGENTS.md": render(agentsTemplate, values),
        "cover.png": await placeholderCover(),
        ...(isDlc ? {} : { ".github/workflows/release.yml": render(releaseTemplate, values) }),
    };
    for (const [rel, content] of Object.entries(files)) {
        const path = join(dir, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
    }
    log(`created ${basename(dir)} (${options.kind} for ${game.name} ${gameRange}) in ${dir}`);
    const run = options.run ?? defaultRun;
    if (options.git) await run("git", ["init", "-q"], dir);
    if (options.install) await run("npm", ["install"], dir);
    return { dir, files: Object.keys(files).sort(), shared, warnings: game.warnings };
}
