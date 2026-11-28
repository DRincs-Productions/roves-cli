/**
 * Mods and DLC (engine README "Mods and DLC", wiki "Mods and DLC"): the game identity written
 * into `game/`, the DLC key pair, packing and signing `.rovesmod` add-ons, checking an add-on
 * against a packaged game and running a packaged game with an unpacked add-on (`mod dev`).
 *
 * The signature format is the player's (`support/cef-windows-player/src/mods.rs`): Ed25519 over
 * `roves-dlc-signature-v1\n` plus one `<sha256 hex>  <path>\n` line per file in path order,
 * stored with the hashes in `roves-signature.json` at the add-on's root.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    type KeyObject,
    sign,
    verify,
} from "node:crypto";
import { watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import { glob } from "tinyglobby";
import { macosBundleNames } from "./base";
import { STORED_EXTENSIONS } from "./content";
import { RovesError } from "./errors";
import { S_IFREG, sha256File, walkDirectory, ZipReader, ZipWriter } from "./zip";

export const ADDON_MANIFEST = "package.json";
export const SIGNATURE_FILE = "roves-signature.json";
export const GAME_IDENTITY_FILE = "roves-game.json";
export const GAME_IDENTITY_FORMAT = 1;
export const DLC_KEY_FILE = "roves-dlc-key.pem";
export const DLC_KEY_ENV = "ROVES_DLC_KEY";
export const ADDON_EXTENSION = ".rovesmod";
export const DEV_MOD_SWITCH = "--roves-dev-mod=";
/** First player release that loads mods and DLC. */
export const MODS_MIN_SHELL = "v0.9.2";
const SIGNATURE_DOMAIN = "roves-dlc-signature-v1\n";
const COVERS = ["cover.png", "cover.jpg", "cover.webp"];
/** Never packed: dependencies, VCS data, outputs and the private key. */
const ALWAYS_IGNORED = [
    "**/node_modules/**",
    "**/.git/**",
    `**/*${ADDON_EXTENSION}`,
    SIGNATURE_FILE,
    `**/${DLC_KEY_FILE}`,
];
/** Fixed entry time, so packing the same add-on twice gives the same archive. */
const ENTRY_TIME = new Date(Date.UTC(2020, 0, 1));
/** PKCS#8 DER prefix of a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type AddonKind = "mod" | "dlc";

/** `game/roves-game.json`: what the player checks add-ons against. */
export interface GameIdentity {
    format: number;
    name: string;
    version: string;
    mods: boolean;
    dlcPublicKey?: string;
    shared: Record<string, string>;
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
 * The game identity from the game's `package.json` (`name`, `version`, `roves.mods`,
 * `roves.dlcPublicKey`, `roves.shared`); `mods` overrides `roves.mods` (default true).
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
    const dlcPublicKey = typeof roves.dlcPublicKey === "string" ? roves.dlcPublicKey : undefined;
    if (dlcPublicKey !== undefined && Buffer.from(dlcPublicKey, "base64").length !== 32) {
        throw new RovesError(`${path}: "roves.dlcPublicKey" is not a base64 Ed25519 public key`);
    }
    const shared = stringMap(roves.shared);
    for (const [lib, exact] of Object.entries(shared)) {
        if (!semver.valid(exact)) {
            throw new RovesError(`${path}: "roves.shared".${lib} must be an exact version`);
        }
    }
    return {
        format: GAME_IDENTITY_FORMAT,
        name,
        version,
        mods: options.mods ?? (roves.mods === undefined ? true : roves.mods !== false),
        ...(dlcPublicKey ? { dlcPublicKey } : {}),
        shared,
    };
}

/** `v0.9.2` >= `v0.9.2`; pre-release suffixes are ignored. */
export function shellLoadsMods(shellVersion: string): boolean {
    const clean = (tag: string) => semver.coerce(tag)?.version ?? "0.0.0";
    return semver.gte(clean(shellVersion), clean(MODS_MIN_SHELL));
}

// ---------------------------------------------------------------- keys and signatures

/** Raw base64 public key of an Ed25519 key. */
export function publicKeyBase64(key: KeyObject): string {
    const spki = createPublicKey(key).export({ format: "der", type: "spki" });
    return spki.subarray(spki.length - 32).toString("base64");
}

/** An Ed25519 private key from a raw 32-byte seed (tests, fixed vectors). */
export function privateKeyFromSeed(seed: Buffer): KeyObject {
    return createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
}

function parsePrivateKey(text: string, where: string): KeyObject {
    const pem = text.includes("-----BEGIN")
        ? text
        : Buffer.from(text.trim(), "base64").toString("utf8");
    try {
        const key = createPrivateKey(pem);
        if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
        return key;
    } catch (error) {
        throw new RovesError(`${where}: not an Ed25519 private key (${(error as Error).message})`);
    }
}

/**
 * The DLC private key: `keyFile`, else the `ROVES_DLC_KEY` environment variable (PEM, or the
 * PEM in base64, for CI secrets), else `roves-dlc-key.pem` in `searchFrom` or a parent folder.
 */
export async function loadDlcKey(
    options: { keyFile?: string; searchFrom?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<KeyObject | undefined> {
    if (options.keyFile) {
        const text = await readFile(options.keyFile, "utf8").catch(() => {
            throw new RovesError(`DLC key ${options.keyFile} not found`);
        });
        return parsePrivateKey(text, options.keyFile);
    }
    const env = (options.env ?? process.env)[DLC_KEY_ENV];
    if (env) return parsePrivateKey(env, DLC_KEY_ENV);
    if (!options.searchFrom) return undefined;
    let dir = resolve(options.searchFrom);
    for (;;) {
        const candidate = join(dir, DLC_KEY_FILE);
        const text = await readFile(candidate, "utf8").catch(() => undefined);
        if (text !== undefined) return parsePrivateKey(text, candidate);
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

export interface DlcKeyResult {
    keyFile: string;
    publicKey: string;
    created: boolean;
}

/**
 * Creates the game's DLC key pair (once): the private key in `<project>/roves-dlc-key.pem`
 * (added to `.gitignore`), the public key in the game's `package.json` (`roves.dlcPublicKey`).
 * An existing key is kept and its public key written again.
 */
export async function initDlcKey(projectDir: string): Promise<DlcKeyResult> {
    const dir = resolve(projectDir);
    const manifestPath = join(dir, ADDON_MANIFEST);
    const manifestText = await readFile(manifestPath, "utf8").catch(() => {
        throw new RovesError(`${manifestPath} not found: run it in the game's project folder`);
    });
    const keyFile = join(dir, DLC_KEY_FILE);
    const existing = await readFile(keyFile, "utf8").catch(() => undefined);
    const key =
        existing === undefined
            ? generateKeyPairSync("ed25519").privateKey
            : parsePrivateKey(existing, keyFile);
    if (existing === undefined) {
        const pem = key.export({ format: "pem", type: "pkcs8" }).toString();
        await writeFile(keyFile, pem, { mode: 0o600 });
        const gitignore = join(dir, ".gitignore");
        const ignored = await readFile(gitignore, "utf8").catch(() => "");
        if (!ignored.split(/\r?\n/).includes(DLC_KEY_FILE)) {
            const prefix = ignored && !ignored.endsWith("\n") ? "\n" : "";
            await appendFile(
                gitignore,
                `${prefix}# Roves DLC signing key: keep it secret\n${DLC_KEY_FILE}\n`,
            );
        }
    }
    const publicKey = publicKeyBase64(key);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const roves = (
        manifest.roves && typeof manifest.roves === "object" ? manifest.roves : {}
    ) as Record<string, unknown>;
    if (roves.dlcPublicKey !== publicKey) {
        manifest.roves = { ...roves, dlcPublicKey: publicKey };
        const indent = /^[ \t]+(?=")/m.exec(manifestText)?.[0] ?? "  ";
        const eol = manifestText.includes("\r\n") ? "\r\n" : "\n";
        await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, indent).replace(/\n/g, eol)}${eol}`,
        );
    }
    return { keyFile, publicKey, created: existing === undefined };
}

/** The signed text: the domain line, then `sha256sum`-style lines in path order. */
export function signedMessage(hashes: Record<string, string>): string {
    const paths = Object.keys(hashes).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return SIGNATURE_DOMAIN + paths.map((path) => `${hashes[path]}  ${path}\n`).join("");
}

/** `roves-signature.json` for these file hashes. */
export function signatureFile(hashes: Record<string, string>, key: KeyObject): string {
    const signature = sign(null, Buffer.from(signedMessage(hashes), "utf8"), key);
    const sorted = Object.fromEntries(
        Object.keys(hashes)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .map((path) => [path, hashes[path]]),
    );
    return `${JSON.stringify({ format: 1, files: sorted, signature: signature.toString("base64") }, null, 2)}\n`;
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

/** Why a DLC's signature is not valid for `publicKey` (empty: valid). */
async function signatureProblems(files: AddonFiles, publicKey: string): Promise<string[]> {
    const text = await files.read(SIGNATURE_FILE);
    if (!text) return [`not signed (${SIGNATURE_FILE} missing)`];
    let parsed: { files?: unknown; signature?: unknown };
    try {
        parsed = JSON.parse(text.toString("utf8")) as typeof parsed;
    } catch {
        return [`${SIGNATURE_FILE} is not JSON`];
    }
    const hashes = stringMap(parsed.files);
    const key = createPublicKey({
        key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(publicKey, "base64"),
        ]),
        format: "der",
        type: "spki",
    });
    const signature = Buffer.from(
        typeof parsed.signature === "string" ? parsed.signature : "",
        "base64",
    );
    if (!verify(null, Buffer.from(signedMessage(hashes), "utf8"), key, signature)) {
        return ["the signature does not match this game's DLC key"];
    }
    const problems: string[] = [];
    for (const rel of await files.list()) {
        if (rel !== SIGNATURE_FILE && !(rel in hashes)) problems.push(`${rel} is not signed`);
    }
    for (const [rel, hash] of Object.entries(hashes)) {
        const found = await files.sha256(rel).catch(() => undefined);
        if (found === undefined) problems.push(`${rel} is missing`);
        else if (found !== hash) problems.push(`${rel} was modified after signing`);
    }
    return problems;
}

// ---------------------------------------------------------------- pack

export interface PackModOptions {
    /** The add-on folder (with `package.json`). */
    modDir: string;
    /** Where the `.rovesmod` file is written (default: the current directory). */
    outDir?: string;
    /** DLC private key file (default: `ROVES_DLC_KEY`, then `roves-dlc-key.pem` upwards). */
    keyFile?: string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}

export interface PackModResult {
    path: string;
    id: string;
    kind: AddonKind;
    version: string;
    files: number;
    signed: boolean;
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
 * Packs an add-on folder into `<id>-<version>.rovesmod` (a ZIP of the selected files, the same
 * layout as the folder). A DLC is signed with the game's private key.
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

    let signed = false;
    if (manifest.kind === "dlc") {
        const key = await loadDlcKey({
            keyFile: options.keyFile,
            searchFrom: dir,
            env: options.env,
        });
        if (!key) {
            throw new RovesError(
                `a DLC must be signed with the game's key: pass --dlc-key, set ${DLC_KEY_ENV}, or run "roves dlc keygen" in the game's project`,
            );
        }
        const hashes: Record<string, string> = {};
        for (const [rel, source] of contents) {
            hashes[rel] =
                typeof source === "string"
                    ? await sha256File(source)
                    : createHash("sha256").update(source).digest("hex");
        }
        contents.set(SIGNATURE_FILE, Buffer.from(signatureFile(hashes, key)));
        signed = true;
        log(`${manifest.id}: signed with the DLC key ${publicKeyBase64(key)}`);
    }

    const outDir = resolve(options.outDir ?? ".");
    await mkdir(outDir, { recursive: true });
    const fileName = `${manifest.id.replace(/^@/, "").replace("/", "-")}-${manifest.version}${ADDON_EXTENSION}`;
    const path = join(outDir, fileName);
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
    return {
        path,
        id: manifest.id,
        kind: manifest.kind,
        version: manifest.version,
        files: contents.size,
        signed,
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
    const dir = resolve(bundleDir);
    const exists = async (path: string) => Boolean(await stat(path).catch(() => null));
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
            const shared = identity.shared?.[lib];
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
            if (!identity.dlcPublicKey) problems.push("this game accepts no DLC (no DLC key)");
            else
                problems.push(
                    ...(await signatureProblems(files, identity.dlcPublicKey)).map(
                        (p) => `DLC ${p}`,
                    ),
                );
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

/** Checks a DLC file or folder for `roves bundle --dlc` (signature against the game's key). */
export async function verifyDlc(path: string, publicKey: string): Promise<AddonManifest> {
    const files = await openAddon(path);
    try {
        const text = await files.read(ADDON_MANIFEST);
        if (!text) throw new RovesError(`${path} has no ${ADDON_MANIFEST}`);
        const manifest = parseAddonManifest(
            JSON.parse(text.toString("utf8")) as Record<string, unknown>,
            `${path}/${ADDON_MANIFEST}`,
        );
        if (manifest.kind !== "dlc") {
            throw new RovesError(`${path} is a mod, not a DLC (set "roves": { "kind": "dlc" })`);
        }
        const problems = await signatureProblems(files, publicKey);
        if (problems.length > 0) {
            throw new RovesError(`DLC ${manifest.id}: ${problems.join("; ")}`);
        }
        return manifest;
    } finally {
        files.close();
    }
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
    if (options.game) {
        const game = await findPackagedGame(options.game);
        if (!game.identity) {
            throw new RovesError(
                `${options.game} was packaged without mod support (no game/${GAME_IDENTITY_FILE})`,
            );
        }
        gameName = game.identity.name;
        gameRange = `^${game.identity.version}`;
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
    return { manifest: manifestPath, created };
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
