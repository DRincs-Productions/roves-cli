/**
 * Mods and DLC (engine README "Mods and DLC", wiki "Mods and DLC"): the game identity written
 * into `game/` (name, version, mods flag, official DLC), packing `.rovesmod` add-ons, the
 * registry of official DLC in the game project (`roves-dlc.json`: id -> version -> SHA-256 of
 * the `.rovesmod`), checking an add-on against a packaged game and running a packaged game with
 * an unpacked add-on (`mod dev`). The player (`support/cef-windows-player/src/mods.rs`) lists a
 * DLC only when its file's SHA-256 is the registered one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { glob } from "tinyglobby";
import { macosBundleNames } from "./base";
import { STORED_EXTENSIONS } from "./content";
import { RovesError } from "./errors";
import { S_IFREG, sha256File, walkDirectory, ZipReader, ZipWriter } from "./zip";

export const ADDON_MANIFEST = "package.json";
export const GAME_IDENTITY_FILE = "roves-game.json";
export const GAME_IDENTITY_FORMAT = 1;
/** The game project's registry of official DLC, next to its `package.json`. */
export const DLC_REGISTRY_FILE = "roves-dlc.json";
export const ADDON_EXTENSION = ".rovesmod";
export const DEV_MOD_SWITCH = "--roves-dev-mod=";
/** First player release that loads mods and DLC. */
export const MODS_MIN_SHELL = "v0.9.2";
const COVERS = ["cover.png", "cover.jpg", "cover.webp"];
/** Never packed: dependencies, VCS data and packed add-ons. */
const ALWAYS_IGNORED = [
    "**/node_modules/**",
    "**/.git/**",
    `**/*${ADDON_EXTENSION}`,
    "**/.gitkeep",
];
/** Fixed entry time, so packing the same add-on twice gives the same archive. */
const ENTRY_TIME = new Date(Date.UTC(2020, 0, 1));

export type AddonKind = "mod" | "dlc";

/** id -> version -> SHA-256 (lowercase hex) of the `.rovesmod` file. */
export type DlcRegistry = Record<string, Record<string, string>>;

/** `game/roves-game.json`: what the player checks add-ons against. */
export interface GameIdentity {
    format: number;
    name: string;
    version: string;
    mods: boolean;
    /** Official DLC: id -> version -> SHA-256 of the `.rovesmod`. */
    dlc: DlcRegistry;
    /** Libraries the game exposes to add-ons (see {@link detectSharedLibraries}). */
    shared: Record<string, SharedLibrary>;
}

/** A library the game built as its own named entry chunk, for add-ons to import. */
export interface SharedLibrary {
    /** The installed version (from `node_modules/<lib>/package.json`). */
    version: string;
    /** The chunk, relative to the game root (`assets/pixi.js-DHJl7f-w.js`). */
    file: string;
    /** Whether the chunk has a default export. */
    default: boolean;
}

/**
 * Libraries that must run as one instance per page (global state, registries, one WebGL or
 * audio context, `instanceof` across modules): an add-on with its own copy breaks the game.
 * Matched by exact name or, for entries ending in `/`, by scope prefix.
 */
export const SINGLE_INSTANCE_LIBRARIES = [
    "pixi.js",
    "@pixi/",
    "@drincs/pixi-vn",
    "phaser",
    "three",
    "@babylonjs/core",
    "excalibur",
    "kaboom",
    "kaplay",
    "matter-js",
    "planck",
    "tone",
    "howler",
    "motion",
    "framer-motion",
    "gsap",
    "react",
    "react-dom",
    "vue",
    "solid-js",
];

export function isSingleInstanceLibrary(name: string): boolean {
    return SINGLE_INSTANCE_LIBRARIES.some((lib) =>
        lib.endsWith("/") ? name.startsWith(lib) : name === lib,
    );
}

/** The chunk name a library is exposed under: the package name without its scope. */
export function sharedChunkName(lib: string): string {
    return lib.startsWith("@") ? (lib.split("/")[1] ?? lib) : lib;
}

export interface AddonManifest {
    id: string;
    kind: AddonKind;
    version: string;
    displayName: string;
    main?: string;
    files?: string[];
    game?: { name: string; version: string };
    requires: Record<string, string>;
    peer: Record<string, string>;
    bundled: Record<string, string>;
    steamAppId?: number;
    raw: Record<string, unknown>;
}

// ---------------------------------------------------------------- package.json and identity

/** An npm package name: optional `@scope/`, then lowercase URL-safe characters. */
export function validPackageName(id: string): boolean {
    const part = (p: string) => /^[a-z0-9\-_.~]+$/.test(p) && !p.startsWith(".");
    if (id.length === 0 || id.length > 214) return false;
    if (!id.startsWith("@")) return part(id);
    const [scope, name, ...rest] = id.slice(1).split("/");
    return rest.length === 0 && part(scope ?? "") && part(name ?? "");
}

function stringMap(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
    );
}

async function readJson(path: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch {
        throw new RovesError(`${path} not found`);
    }
    try {
        const json = JSON.parse(text) as unknown;
        if (!json || typeof json !== "object" || Array.isArray(json))
            throw new Error("not an object");
        return json as Record<string, unknown>;
    } catch (error) {
        throw new RovesError(`${path}: ${(error as Error).message}`);
    }
}

/** Reads and checks an add-on's `package.json` (`where` names it in errors). */
export function parseAddonManifest(json: Record<string, unknown>, where: string): AddonManifest {
    const roves = (json.roves && typeof json.roves === "object" ? json.roves : {}) as Record<
        string,
        unknown
    >;
    const id = typeof json.name === "string" ? json.name : "";
    if (!validPackageName(id)) {
        throw new RovesError(`${where}: "name" ${JSON.stringify(id)} is not a valid package name`);
    }
    const version = typeof json.version === "string" ? json.version : "";
    if (!semver.valid(version)) {
        throw new RovesError(`${where}: "version" ${JSON.stringify(version)} is not semver`);
    }
    const kind = roves.kind ?? "mod";
    if (kind !== "mod" && kind !== "dlc") {
        throw new RovesError(`${where}: "roves.kind" must be "mod" or "dlc"`);
    }
    const game =
        roves.game && typeof roves.game === "object"
            ? (roves.game as Record<string, unknown>)
            : undefined;
    if (!game || typeof game.name !== "string" || !game.name) {
        throw new RovesError(
            `${where}: "roves.game" must name the game: { "name": "<the game's package name>", "version": "^1.0.0" }`,
        );
    }
    const gameRange = typeof game.version === "string" ? game.version : "*";
    if (!semver.validRange(gameRange)) {
        throw new RovesError(`${where}: "roves.game.version" ${gameRange} is not a version range`);
    }
    const main = typeof json.main === "string" ? json.main.replace(/^\.\//, "") : undefined;
    const files = Array.isArray(json.files)
        ? json.files.filter((f): f is string => typeof f === "string")
        : undefined;
    return {
        id,
        kind,
        version,
        displayName: typeof json.displayName === "string" ? json.displayName : id,
        main,
        files,
        game: { name: game.name, version: gameRange },
        requires: stringMap(roves.mods),
        peer: stringMap(json.peerDependencies),
        bundled: stringMap(json.dependencies),
        steamAppId: typeof roves.steamAppId === "number" ? roves.steamAppId : undefined,
        raw: json,
    };
}

/** The nearest folder holding a `package.json`, from `start` upwards. */
export async function findProjectDir(start: string): Promise<string | undefined> {
    let dir = resolve(start);
    for (;;) {
        if ((await stat(join(dir, ADDON_MANIFEST)).catch(() => null))?.isFile()) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * The game identity from the game's `package.json` (`name`, `version`, `roves.mods`)
 * and its `roves-dlc.json`; `mods` overrides `roves.mods` (default true). `shared` is filled by
 * {@link detectSharedLibraries} from the build.
 */
export async function readGameIdentity(
    projectDir: string,
    options: { mods?: boolean } = {},
): Promise<GameIdentity> {
    const path = join(projectDir, ADDON_MANIFEST);
    const json = await readJson(path);
    const roves = (json.roves && typeof json.roves === "object" ? json.roves : {}) as Record<
        string,
        unknown
    >;
    const name = typeof json.name === "string" ? json.name : "";
    if (!validPackageName(name)) {
        throw new RovesError(`${path}: "name" ${JSON.stringify(name)} is not a valid package name`);
    }
    const version = typeof json.version === "string" ? json.version : "";
    if (!semver.valid(version)) {
        throw new RovesError(`${path}: "version" ${JSON.stringify(version)} is not semver`);
    }
    return {
        format: GAME_IDENTITY_FORMAT,
        name,
        version,
        mods: options.mods ?? (roves.mods === undefined ? true : roves.mods !== false),
        dlc: await readDlcRegistry(projectDir),
        shared: {},
    };
}

/** Names a chunk exports (`export { a as B, c }` statements). */
function exportedNames(code: string): string[] {
    const names: string[] = [];
    for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of (match[1] ?? "").split(",")) {
            const name = part
                .trim()
                .split(/\s+as\s+/)
                .pop()
                ?.trim();
            if (name) names.push(name);
        }
    }
    if (/export\s+default\b/.test(code)) names.push("default");
    return names;
}

/**
 * The libraries the game exposes to add-ons. Roves does not change the build: the developer
 * gives each library to share its own entry chunk named after the package without its scope
 * (`pixi.js` -> `assets/pixi.js-<hash>.js`, `@drincs/pixi-vn` -> `assets/pixi-vn-<hash>.js`),
 * with `preserveEntrySignatures: "strict"` so the chunk exports the library's public API. For
 * every `dependencies` entry of the game's `package.json` this finds that chunk in the build.
 * A chunk made with `manualChunks` only exports a few minified internal names: it is refused
 * with a warning, as is a missing chunk of a library that must run as a single instance.
 */
export async function detectSharedLibraries(
    projectDir: string,
    contentDir: string,
): Promise<{ shared: Record<string, SharedLibrary>; warnings: string[] }> {
    const json = await readJson(join(projectDir, ADDON_MANIFEST));
    const dependencies = Object.keys(stringMap(json.dependencies));
    const files = (await walkDirectory(contentDir)).filter((rel) => rel.endsWith(".js"));
    const shared: Record<string, SharedLibrary> = {};
    const warnings: string[] = [];
    for (const lib of dependencies) {
        const chunk = sharedChunkName(lib);
        const escaped = chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`^${escaped}(-[A-Za-z0-9_-]{8})?\\.js$`);
        const candidates = files.filter((rel) => pattern.test(rel.split("/").pop() ?? ""));
        if (candidates.length === 0) {
            if (isSingleInstanceLibrary(lib)) {
                warnings.push(
                    `${lib} is not shared with mods (no "${chunk}" entry chunk): a mod that uses it would load a second copy, which breaks the game. See the roves-mods skill or the wiki "Mods and DLC".`,
                );
            }
            continue;
        }
        if (candidates.length > 1) {
            throw new RovesError(
                `more than one chunk is named after ${lib}: ${candidates.join(", ")} (build it once, as an entry with preserveEntrySignatures "strict", not also in manualChunks)`,
            );
        }
        const file = candidates[0] as string;
        const names = exportedNames(await readFile(join(contentDir, file), "utf8"));
        if (names.filter((n) => n !== "default").every((n) => n.length <= 2)) {
            warnings.push(
                `${lib}: ${file} only exports internal names (${names.join(", ") || "none"}), so it is not shared. Build it as an entry chunk with preserveEntrySignatures "strict" instead of manualChunks.`,
            );
            continue;
        }
        const installed = await readJson(
            join(projectDir, "node_modules", lib, ADDON_MANIFEST),
        ).catch(() => undefined);
        if (typeof installed?.version !== "string" || !semver.valid(installed.version)) {
            throw new RovesError(`${lib} is not installed in ${projectDir} (run npm install)`);
        }
        shared[lib] = { version: installed.version, file, default: names.includes("default") };
    }
    return { shared, warnings };
}

/** `v0.9.2` >= `v0.9.2`; pre-release suffixes are ignored. */
export function shellLoadsMods(shellVersion: string): boolean {
    const clean = (tag: string) => semver.coerce(tag)?.version ?? "0.0.0";
    return semver.gte(clean(shellVersion), clean(MODS_MIN_SHELL));
}

// ---------------------------------------------------------------- DLC registry

/** The project's `roves-dlc.json` (empty without one). */
export async function readDlcRegistry(projectDir: string): Promise<DlcRegistry> {
    const path = join(projectDir, DLC_REGISTRY_FILE);
    if (!(await stat(path).catch(() => null))?.isFile()) return {};
    const json = await readJson(path);
    const dlc = json.dlc && typeof json.dlc === "object" ? json.dlc : {};
    const registry: DlcRegistry = {};
    for (const [id, versions] of Object.entries(dlc as Record<string, unknown>)) {
        const hashes = stringMap(versions);
        for (const [version, hash] of Object.entries(hashes)) {
            if (!/^[0-9a-f]{64}$/i.test(hash)) {
                throw new RovesError(`${path}: dlc.${id}.${version} is not a SHA-256`);
            }
            hashes[version] = hash.toLowerCase();
        }
        registry[id] = hashes;
    }
    return registry;
}

/**
 * Records a DLC version in the project's `roves-dlc.json` (created when missing; older versions
 * stay, so an installed older DLC is still recognized). Returns the hash it replaced, if any.
 */
export async function registerDlc(
    projectDir: string,
    id: string,
    version: string,
    sha256: string,
): Promise<{ file: string; replaced?: string }> {
    const registry = await readDlcRegistry(projectDir);
    const previous = registry[id]?.[version];
    registry[id] = { ...registry[id], [version]: sha256 };
    const sorted = Object.fromEntries(
        Object.keys(registry)
            .sort()
            .map((key) => [
                key,
                Object.fromEntries(
                    Object.entries(registry[key] ?? {}).sort(([a], [b]) => semver.compare(a, b)),
                ),
            ]),
    );
    const file = join(projectDir, DLC_REGISTRY_FILE);
    await writeFile(file, `${JSON.stringify({ format: 1, dlc: sorted }, null, 2)}\n`);
    return { file, ...(previous && previous !== sha256 ? { replaced: previous } : {}) };
}

/** The game project of a DLC: `projectDir`, else the nearest `package.json` named `gameName`. */
export async function findGameProject(
    start: string,
    gameName: string,
    projectDir?: string,
): Promise<string> {
    if (projectDir) {
        const dir = resolve(projectDir);
        const json = await readJson(join(dir, ADDON_MANIFEST));
        if (json.name !== gameName) {
            throw new RovesError(
                `${dir} is the project of ${String(json.name)}, not of ${gameName}`,
            );
        }
        return dir;
    }
    let dir = resolve(start);
    for (;;) {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        const json = await readJson(join(dir, ADDON_MANIFEST)).catch(() => undefined);
        if (json?.name === gameName) return dir;
    }
    throw new RovesError(
        `cannot find the project of the game ${gameName} above ${start}: a DLC is packed from the game's project (--project-dir <game project>)`,
    );
}

/** `<id>.rovesmod` for a DLC, `<id>-<version>.rovesmod` for a mod (`@scope/name` -> `scope-name`). */
export function addonFileName(id: string, kind: AddonKind, version: string): string {
    const stem = id.replace(/^@/, "").replace("/", "-");
    return kind === "dlc" ? `${stem}${ADDON_EXTENSION}` : `${stem}-${version}${ADDON_EXTENSION}`;
}

// ---------------------------------------------------------------- add-on files

/** The files of an add-on folder or `.rovesmod` archive. */
interface AddonFiles {
    list(): Promise<string[]>;
    read(path: string): Promise<Buffer | undefined>;
    sha256(path: string): Promise<string>;
    close(): void;
}

async function openAddon(path: string): Promise<AddonFiles> {
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
        return {
            list: async () => (await walkDirectory(path)).filter((rel) => !rel.endsWith("/")),
            read: (rel) => readFile(join(path, rel)).catch(() => undefined),
            sha256: (rel) => sha256File(join(path, rel)),
            close: () => {},
        };
    }
    if (!info?.isFile()) throw new RovesError(`${path} is not an add-on folder or file`);
    const zip = await ZipReader.open(path);
    const entries = new Map(zip.entries.filter((e) => !e.isDirectory).map((e) => [e.name, e]));
    return {
        list: async () => [...entries.keys()].sort(),
        read: async (rel) => {
            const entry = entries.get(rel);
            return entry ? zip.read(entry) : undefined;
        },
        sha256: async (rel) => {
            const entry = entries.get(rel);
            if (!entry) throw new RovesError(`${path}: ${rel} is missing`);
            return zip.sha256(entry);
        },
        close: () => zip.close(),
    };
}

// ---------------------------------------------------------------- pack

export interface PackModOptions {
    /** The add-on folder (with `package.json`). */
    modDir: string;
    /** Where the `.rovesmod` file is written (default: the current directory). */
    outDir?: string;
    /** The game's project, where a DLC is registered (default: the nearest `package.json`
     * named like `roves.game.name`, above the DLC folder). */
    projectDir?: string;
    log?: (message: string) => void;
}

export interface PackModResult {
    path: string;
    id: string;
    kind: AddonKind;
    version: string;
    files: number;
    /** DLC only: the `roves-dlc.json` it was registered in. */
    registered?: string;
    sha256: string;
}

/** `files` patterns as npm reads them: a folder means everything inside it. */
async function selectFiles(dir: string, manifest: AddonManifest): Promise<string[]> {
    const include: string[] = [];
    const ignore = [...ALWAYS_IGNORED];
    if (manifest.files) {
        for (const pattern of manifest.files) {
            const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
            const target = clean.startsWith("!") ? ignore : include;
            const body = clean.replace(/^!/, "");
            target.push(body, `${body}/**`);
        }
    } else {
        include.push("**");
    }
    const selected = new Set(
        await glob(include, {
            cwd: dir,
            ignore,
            dot: Boolean(manifest.files),
            onlyFiles: true,
        }),
    );
    selected.add(ADDON_MANIFEST);
    for (const cover of COVERS) {
        if ((await stat(join(dir, cover)).catch(() => null))?.isFile()) selected.add(cover);
    }
    return [...selected].map((rel) => rel.split(sep).join("/")).sort();
}

/** `dependencies` with the exact versions installed in `node_modules` (bundled libraries). */
async function exactDependencies(
    dir: string,
    ranges: Record<string, string>,
): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [lib, range] of Object.entries(ranges)) {
        const installed = await readJson(join(dir, "node_modules", lib, ADDON_MANIFEST)).catch(
            () => undefined,
        );
        out[lib] = typeof installed?.version === "string" ? installed.version : range;
    }
    return out;
}

/**
 * Packs an add-on folder into a `.rovesmod` (a ZIP of the selected files, the same layout as the
 * folder; deterministic): `<id>-<version>.rovesmod` for a mod, `<id>.rovesmod` for a DLC, which
 * is also registered in the game project's `roves-dlc.json`.
 */
export async function packMod(options: PackModOptions): Promise<PackModResult> {
    const dir = resolve(options.modDir);
    const log = options.log ?? (() => {});
    const raw = await readJson(join(dir, ADDON_MANIFEST));
    const manifest = parseAddonManifest(raw, join(dir, ADDON_MANIFEST));
    const files = await selectFiles(dir, manifest);
    if (manifest.main && !files.includes(manifest.main)) {
        throw new RovesError(
            `"main" ${manifest.main} is not in the packed files (build the add-on first, or add it to "files")`,
        );
    }
    const packedManifest: Record<string, unknown> = { ...raw };
    if (Object.keys(manifest.bundled).length > 0) {
        packedManifest.dependencies = await exactDependencies(dir, manifest.bundled);
    }
    const contents = new Map<string, Buffer | string>();
    for (const rel of files) contents.set(rel, join(dir, rel));
    contents.set(ADDON_MANIFEST, Buffer.from(`${JSON.stringify(packedManifest, null, 2)}\n`));

    // A DLC is packed from the game's project: find it before writing anything.
    const projectDir =
        manifest.kind === "dlc"
            ? await findGameProject(dir, manifest.game?.name ?? "", options.projectDir)
            : undefined;

    const outDir = resolve(options.outDir ?? ".");
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, addonFileName(manifest.id, manifest.kind, manifest.version));
    await rm(path, { force: true });
    const writer = new ZipWriter(path);
    try {
        for (const rel of [...contents.keys()].sort()) {
            const source = contents.get(rel) as Buffer | string;
            const dot = rel.lastIndexOf(".");
            const compress = !STORED_EXTENSIONS.has(dot >= 0 ? rel.slice(dot).toLowerCase() : "");
            const entry = { mode: S_IFREG | 0o644, mtime: ENTRY_TIME, compress };
            if (typeof source === "string") writer.addFile(source, rel, entry);
            else writer.addBuffer(rel, source, entry);
        }
        await writer.finish();
    } catch (error) {
        await writer.abort();
        throw error;
    }
    log(`${manifest.id}: wrote ${path} (${contents.size} files)`);
    const sha256 = await sha256File(path);
    let registered: string | undefined;
    if (projectDir) {
        const result = await registerDlc(projectDir, manifest.id, manifest.version, sha256);
        registered = result.file;
        log(
            `${manifest.id} ${manifest.version}: registered in ${result.file}${result.replaced ? " (replaced a different build of the same version)" : ""}`,
        );
    }
    return {
        path,
        id: manifest.id,
        kind: manifest.kind,
        version: manifest.version,
        files: contents.size,
        ...(registered ? { registered } : {}),
        sha256,
    };
}

// ---------------------------------------------------------------- packaged games

export interface PackagedGame {
    /** The player executable (absolute). */
    executable: string;
    /** The game folder inside the package (absolute). */
    gameDir: string;
    identity?: GameIdentity;
}

/** The player and `game/` of an unzipped package folder (`<name>` or `<name>.app`). */
export async function findPackagedGame(bundleDir: string): Promise<PackagedGame> {
    const exists = async (path: string) => Boolean(await stat(path).catch(() => null));
    // `-n game` makes `game/` on Windows/Linux and `game.app` on macOS: accept either name.
    let dir = resolve(bundleDir);
    if (!(await exists(dir)) && (await exists(`${dir}.app`))) dir = `${dir}.app`;
    let executable: string;
    let gameDir: string;
    if (await exists(join(dir, "play.exe"))) {
        executable = join(dir, "play.exe");
        gameDir = join(dir, "game");
    } else if (await exists(join(dir, "Contents", "Info.plist"))) {
        const names = macosBundleNames(await readFile(join(dir, "Contents", "Info.plist"), "utf8"));
        executable = join(dir, names.executable);
        gameDir = join(dir, "Contents", "Resources", "game");
    } else if (await exists(join(dir, "libcef.so"))) {
        const roots: string[] = [];
        for (const rel of await walkDirectory(dir)) {
            if (rel.includes("/") || rel.includes(".so")) continue;
            if (["chrome-sandbox", "chrome_crashpad_handler"].includes(rel)) continue;
            roots.push(rel);
        }
        const executables: string[] = [];
        for (const rel of roots) {
            if (((await stat(join(dir, rel))).mode & 0o111) !== 0) executables.push(rel);
        }
        // Unzipped on Windows the modes are lost: the player is the root file without extension.
        const candidates = executables.length
            ? executables
            : roots.filter((rel) => !rel.includes("."));
        if (candidates.length !== 1) {
            throw new RovesError(
                `${dir}: cannot tell the Linux player executable (${candidates.join(", ") || "none"})`,
            );
        }
        executable = join(dir, candidates[0] as string);
        gameDir = join(dir, "game");
    } else {
        throw new RovesError(
            `${dir} is not an unzipped Roves package (play.exe, a .app or libcef.so)`,
        );
    }
    const identityPath = join(gameDir, GAME_IDENTITY_FILE);
    const identity = (await exists(identityPath))
        ? ((await readJson(identityPath)) as unknown as GameIdentity)
        : undefined;
    return { executable, gameDir, identity };
}

// ---------------------------------------------------------------- check

export interface CheckModResult {
    id: string;
    kind: AddonKind;
    version: string;
    compatible: boolean;
    problems: string[];
    /** Checked only by the player: required add-ons and Steam ownership. */
    notChecked: string[];
}

/** The player's checks that need only the add-on and the game. */
export async function checkMod(options: { mod: string; game: string }): Promise<CheckModResult> {
    const game = await findPackagedGame(options.game);
    if (!game.identity) {
        throw new RovesError(
            `${options.game} was packaged without mod support (no game/${GAME_IDENTITY_FILE}: package it again with roves-cli 0.6 or later)`,
        );
    }
    const identity = game.identity;
    const files = await openAddon(resolve(options.mod));
    try {
        const text = await files.read(ADDON_MANIFEST);
        if (!text) throw new RovesError(`${options.mod} has no ${ADDON_MANIFEST}`);
        const manifest = parseAddonManifest(
            JSON.parse(text.toString("utf8")) as Record<string, unknown>,
            `${options.mod}/${ADDON_MANIFEST}`,
        );
        const problems: string[] = [];
        if (manifest.kind === "mod" && !identity.mods)
            problems.push("this game does not allow mods");
        if (manifest.game?.name !== identity.name) {
            problems.push(`made for the game ${manifest.game?.name}, not ${identity.name}`);
        } else if (!semver.satisfies(identity.version, manifest.game.version)) {
            problems.push(
                `needs game version ${manifest.game.version}, this is ${identity.version}`,
            );
        }
        for (const [lib, range] of Object.entries(manifest.peer)) {
            const entry = identity.shared?.[lib] as SharedLibrary | string | undefined;
            const shared = typeof entry === "string" ? entry : entry?.version;
            if (!shared || !semver.satisfies(shared, range)) {
                problems.push(
                    `needs library ${lib} ${range}, ${shared ? `the game shares ${shared}` : "not shared by the game"}`,
                );
            }
        }
        if (manifest.main && !(await files.read(manifest.main))) {
            problems.push(`"main" ${manifest.main} is missing`);
        }
        if (manifest.kind === "dlc") {
            const problem = await unrecognizedDlc(resolve(options.mod), manifest, identity.dlc);
            if (problem) problems.push(problem);
        }
        const notChecked = [
            ...Object.keys(manifest.requires).map((id) => `required add-on ${id}`),
            ...(manifest.steamAppId ? [`Steam ownership of DLC ${manifest.steamAppId}`] : []),
        ];
        return {
            id: manifest.id,
            kind: manifest.kind,
            version: manifest.version,
            compatible: problems.length === 0,
            problems,
            notChecked,
        };
    } finally {
        files.close();
    }
}

/** Why a DLC is not one of the registered official DLC (`undefined`: it is). */
async function unrecognizedDlc(
    path: string,
    manifest: AddonManifest,
    registry: DlcRegistry,
): Promise<string | undefined> {
    if (!(await stat(path).catch(() => null))?.isFile()) {
        return "a DLC must be a .rovesmod file (roves mod pack)";
    }
    const expected = registry[manifest.id]?.[manifest.version];
    if (!expected) {
        return `DLC ${manifest.id} ${manifest.version} is not registered for this game (roves mod pack in the game project, then roves bundle)`;
    }
    if ((await sha256File(path)) !== expected) {
        return `DLC ${manifest.id} ${manifest.version} differs from the registered build`;
    }
    return undefined;
}

/** A registered DLC file for `roves bundle --dlc`: its manifest, or an error. */
export async function recognizedDlc(path: string, registry: DlcRegistry): Promise<AddonManifest> {
    const files = await openAddon(path);
    let manifest: AddonManifest;
    try {
        const text = await files.read(ADDON_MANIFEST);
        if (!text) throw new RovesError(`${path} has no ${ADDON_MANIFEST}`);
        manifest = parseAddonManifest(
            JSON.parse(text.toString("utf8")) as Record<string, unknown>,
            `${path}/${ADDON_MANIFEST}`,
        );
    } finally {
        files.close();
    }
    if (manifest.kind !== "dlc") {
        throw new RovesError(`${path} is a mod, not a DLC (set "roves": { "kind": "dlc" })`);
    }
    const problem = await unrecognizedDlc(path, manifest, registry);
    if (problem) throw new RovesError(problem);
    return manifest;
}

// ---------------------------------------------------------------- init

export interface InitModOptions {
    dir: string;
    /** An unzipped package of the game: fills `roves.game` from its identity. */
    game?: string;
    gameName?: string;
    kind?: AddonKind;
    name?: string;
    displayName?: string;
}

export interface InitModResult {
    manifest: string;
    created: string[];
    /** Libraries the game shares (from `--game`): name -> version, for `peerDependencies`. */
    shared: Record<string, string>;
}

const STARTER_MAIN = `import { defineMod } from "@drincs/roves-api/mods";

export default defineMod({
    activate(api, mod) {
        console.log(\`\${mod.name} \${mod.version} loaded\`);
    },
});
`;

/**
 * Creates `package.json` (or adds the `roves` section to an existing one), a starter `index.js`
 * and an empty `overrides/` folder.
 */
export async function initMod(options: InitModOptions): Promise<InitModResult> {
    const dir = resolve(options.dir);
    await mkdir(dir, { recursive: true });
    const manifestPath = join(dir, ADDON_MANIFEST);
    const existing = await readJson(manifestPath).catch(() => undefined);
    let gameName = options.gameName;
    let gameRange = "*";
    const shared: Record<string, string> = {};
    if (options.game) {
        const game = await findPackagedGame(options.game);
        if (!game.identity) {
            throw new RovesError(
                `${options.game} was packaged without mod support (no game/${GAME_IDENTITY_FILE})`,
            );
        }
        gameName = game.identity.name;
        gameRange = `^${game.identity.version}`;
        for (const [lib, entry] of Object.entries(game.identity.shared ?? {})) {
            const version = typeof entry === "string" ? entry : entry.version;
            shared[lib] = version;
        }
    }
    if (!gameName)
        throw new RovesError("name the game: --game <unzipped package> or --game-name <name>");
    const kind = options.kind ?? "mod";
    const created: string[] = [];
    const base = existing ?? {
        name:
            options.name ??
            basename(dir)
                .toLowerCase()
                .replace(/[^a-z0-9\-_.~]/g, "-"),
        version: "0.1.0",
        displayName: options.displayName ?? basename(dir),
        description: "",
        type: "module",
        main: "index.js",
        files: ["index.js", "overrides"],
    };
    const roves = (base.roves && typeof base.roves === "object" ? base.roves : {}) as Record<
        string,
        unknown
    >;
    const manifest = {
        ...base,
        roves: {
            ...roves,
            ...(kind === "dlc" ? { kind } : {}),
            game: { name: gameName, version: gameRange },
        },
    };
    parseAddonManifest(manifest, manifestPath);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (!existing) {
        created.push(ADDON_MANIFEST);
        await writeFile(join(dir, "index.js"), STARTER_MAIN);
        created.push("index.js");
        await mkdir(join(dir, "overrides"), { recursive: true });
        created.push("overrides/");
    }
    return { manifest: manifestPath, created, shared };
}

// ---------------------------------------------------------------- dev

export interface DevModOptions {
    modDir: string;
    /** An unzipped package of the game. */
    game: string;
    /** Restart the game when a file outside `overrides/` changes (default true). */
    watch?: boolean;
    /** Extra player switches. */
    args?: string[];
    log?: (message: string) => void;
    /** Starts the player (tests). */
    spawnPlayer?: (executable: string, args: string[]) => ChildProcess;
}

/**
 * Runs the packaged game with the add-on folder loaded unpacked (`--roves-dev-mod`). Files in
 * `overrides/` are read again on every request; any other change restarts the game. Resolves
 * with the player's exit code when it closes by itself.
 */
export async function devMod(options: DevModOptions): Promise<number> {
    const modDir = resolve(options.modDir);
    const log = options.log ?? (() => {});
    parseAddonManifest(await readJson(join(modDir, ADDON_MANIFEST)), join(modDir, ADDON_MANIFEST));
    const game = await findPackagedGame(options.game);
    if (!game.identity) {
        throw new RovesError(
            `${options.game} was packaged without mod support (no game/${GAME_IDENTITY_FILE})`,
        );
    }
    const args = [`${DEV_MOD_SWITCH}${modDir}`, ...(options.args ?? [])];
    const start =
        options.spawnPlayer ??
        ((exe: string, argv: string[]) => spawn(exe, argv, { stdio: "inherit" }));
    return new Promise((resolvePromise, reject) => {
        let child: ChildProcess;
        let restarting = false;
        let timer: NodeJS.Timeout | undefined;
        const watcher =
            options.watch === false
                ? undefined
                : watch(modDir, { recursive: true }, (_event, file) => {
                      const rel = (file ?? "").toString().split(sep).join("/");
                      if (!rel || rel.startsWith("overrides/") || rel.includes("node_modules/"))
                          return;
                      clearTimeout(timer);
                      timer = setTimeout(() => {
                          log(`${rel} changed: restarting the game`);
                          restarting = true;
                          child.kill();
                      }, 300);
                  });
        const launch = () => {
            log(
                `starting ${relative(process.cwd(), game.executable) || game.executable} ${args.join(" ")}`,
            );
            child = start(game.executable, args);
            child.on("error", (error) => {
                watcher?.close();
                reject(new RovesError(`cannot start ${game.executable}: ${error.message}`));
            });
            child.on("exit", (code) => {
                if (restarting) {
                    restarting = false;
                    launch();
                    return;
                }
                watcher?.close();
                clearTimeout(timer);
                resolvePromise(code ?? 0);
            });
        };
        launch();
    });
}

/** A scratch folder for packing DLC during `roves bundle`. */
export function scratchDir(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
}
