import { createHash, verify, createPublicKey } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDesktop } from "../src/desktop";
import {
    checkMod,
    findPackagedGame,
    initDlcKey,
    initMod,
    packMod,
    privateKeyFromSeed,
    publicKeyBase64,
    readGameIdentity,
    signatureFile,
    signedMessage,
    validPackageName,
} from "../src/mods";
import { dist, fileNames, linuxBase, readZip, tempDir, windowsBase, write } from "./helpers";

const SEED = Buffer.alloc(32, 7);

/** One zip entry as text (a missing entry fails the test). */
function text(zip: Awaited<ReturnType<typeof readZip>>, name: string): string {
    const entry = zip.get(name);
    if (!entry) throw new Error(`${name} is not in the zip`);
    return entry.bytes.toString("utf8");
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A game project: package.json + dist/. */
async function gameProject(root: string, roves: Record<string, unknown> = {}): Promise<string> {
    await write(root, "package.json", json({ name: "mygame", version: "1.5.2", roves }));
    await dist(join(root, "dist"));
    return root;
}

async function modFolder(root: string, pkg: Record<string, unknown>): Promise<string> {
    await write(
        root,
        "package.json",
        json({
            name: "@me/new-ending",
            version: "1.0.0",
            main: "dist/index.js",
            roves: { game: { name: "mygame", version: "^1.4.0" } },
            ...pkg,
        }),
    );
    await write(root, "dist/index.js", "export default {}");
    await write(root, "overrides/a.txt", "mod a");
    await write(root, "cover.png", "png");
    await write(root, "src/index.ts", "source");
    await write(root, "node_modules/lodash-es/package.json", json({ version: "4.17.21" }));
    return root;
}

describe("signatures", () => {
    // The same vector as the player's `signature_matches_roves_cli` (mods.rs).
    it("matches the player's format", () => {
        const key = privateKeyFromSeed(SEED);
        expect(publicKeyBase64(key)).toBe("6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=");
        const hello = createHash("sha256").update("hello").digest("hex");
        const file = JSON.parse(signatureFile({ "a.txt": hello }, key));
        expect(file.signature).toBe(
            "EP/2mIItr5dbtcYTndI9032Noh1FI5nGnIlFaz4GzmBCJ7zsrQT65JiU9Za0uFyEhWJRAvP9wYNYqDOafuB0Cg==",
        );
        expect(signedMessage({ "b/c": "2", a: "1" })).toBe(
            "roves-dlc-signature-v1\n1  a\n2  b/c\n",
        );
    });

    it("package names follow npm", () => {
        for (const good of ["mod", "@author/new-ending", "a.b_c~d"])
            expect(validPackageName(good)).toBe(true);
        for (const bad of ["", "Mod", "@author", "@a/b/c", ".x", "a b"])
            expect(validPackageName(bad)).toBe(false);
    });
});

describe("DLC key", () => {
    it("creates the key once, ignores it in git and writes the public key", async () => {
        const project = await gameProject(await tempDir());
        await write(project, ".gitignore", "node_modules");
        const first = await initDlcKey(project);
        expect(first.created).toBe(true);
        expect(await readFile(join(project, ".gitignore"), "utf8")).toContain(
            "\nroves-dlc-key.pem\n",
        );
        const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
        expect(pkg.roves.dlcPublicKey).toBe(first.publicKey);
        const second = await initDlcKey(project);
        expect(second).toEqual({ ...first, created: false });
        const identity = await readGameIdentity(project);
        expect(identity).toEqual({
            format: 1,
            name: "mygame",
            version: "1.5.2",
            mods: true,
            dlcPublicKey: first.publicKey,
            shared: {},
        });
        expect((await readGameIdentity(project, { mods: false })).mods).toBe(false);
    });
});

describe("mod pack", () => {
    it("packs the files npm would, with exact bundled versions", async () => {
        const tmp = await tempDir();
        const mod = await modFolder(join(tmp, "mod"), {
            files: ["dist", "overrides"],
            dependencies: { "lodash-es": "^4.17.0" },
        });
        const result = await packMod({ modDir: mod, outDir: join(tmp, "out") });
        expect(result).toMatchObject({ id: "@me/new-ending", kind: "mod", signed: false });
        expect(result.path).toBe(join(tmp, "out", "me-new-ending-1.0.0.rovesmod"));
        const zip = await readZip(result.path);
        expect(fileNames(zip).sort()).toEqual([
            "cover.png",
            "dist/index.js",
            "overrides/a.txt",
            "package.json",
        ]);
        const packed = JSON.parse(text(zip, "package.json"));
        expect(packed.dependencies).toEqual({ "lodash-es": "4.17.21" });
        // Packing again gives the same bytes.
        const again = await packMod({ modDir: mod, outDir: join(tmp, "out2") });
        expect(await readFile(again.path)).toEqual(await readFile(result.path));
    });

    it("refuses a missing main and an unsigned DLC; signs a DLC with the key", async () => {
        const tmp = await tempDir();
        const broken = await modFolder(join(tmp, "broken"), { files: ["overrides"] });
        await expect(packMod({ modDir: broken, outDir: tmp })).rejects.toThrow(
            /"main" dist\/index.js/,
        );
        const dlc = await modFolder(join(tmp, "dlc"), {
            roves: { kind: "dlc", game: { name: "mygame" } },
        });
        await expect(packMod({ modDir: dlc, outDir: tmp, env: {} })).rejects.toThrow(
            /roves dlc keygen/,
        );
        const key = privateKeyFromSeed(SEED);
        const pem = key.export({ format: "pem", type: "pkcs8" }).toString();
        const result = await packMod({
            modDir: dlc,
            outDir: join(tmp, "out"),
            env: { ROVES_DLC_KEY: Buffer.from(pem).toString("base64") },
        });
        expect(result.signed).toBe(true);
        const zip = await readZip(result.path);
        expect(fileNames(zip)).not.toContain("node_modules/lodash-es/package.json");
        const signature = JSON.parse(text(zip, "roves-signature.json"));
        expect(Object.keys(signature.files).sort()).toEqual(
            fileNames(zip)
                .filter((n) => n !== "roves-signature.json")
                .sort(),
        );
        expect(
            verify(
                null,
                Buffer.from(signedMessage(signature.files)),
                createPublicKey(key),
                Buffer.from(signature.signature, "base64"),
            ),
        ).toBe(true);
    });
});

describe("bundle with mods and DLC", () => {
    it("writes the game identity and ships signed DLC; check and dev find the game", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        await initDlcKey(project);
        const dlc = await modFolder(join(project, "dlc-src", "chapter-6"), {
            name: "chapter-6",
            roves: { kind: "dlc", game: { name: "mygame", version: "^1.5.0" } },
        });
        const [result] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["windows"],
            shellZip: await windowsBase(tmp),
            dlc: [dlc],
            outDir: join(tmp, "out"),
            env: {},
            patchExe: async () => {},
        });
        expect(result?.mods).toBe(true);
        expect(result?.dlc).toEqual(["chapter-6-1.0.0.rovesmod"]);
        const bundleDir = result?.bundleDir as string;
        const identity = JSON.parse(
            await readFile(join(bundleDir, "game", "roves-game.json"), "utf8"),
        );
        expect(identity).toMatchObject({ name: "mygame", version: "1.5.2", mods: true });
        expect(await stat(join(bundleDir, "dlc", "chapter-6-1.0.0.rovesmod"))).toBeTruthy();
        const zip = await readZip(result?.archivePath as string);
        const sums = text(zip, "roves-game/SHA256SUMS.txt");
        expect(sums).toContain("  game/roves-game.json\r\n");
        expect(sums).toContain("  dlc/chapter-6-1.0.0.rovesmod\r\n");

        const game = await findPackagedGame(bundleDir);
        expect(game.executable).toBe(join(bundleDir, "play.exe"));
        const shipped = await checkMod({
            mod: join(bundleDir, "dlc", "chapter-6-1.0.0.rovesmod"),
            game: bundleDir,
        });
        expect(shipped).toMatchObject({ compatible: true, problems: [] });

        // A mod for an older game, with a library the game does not share.
        const mod = await modFolder(join(tmp, "mod"), {
            roves: { game: { name: "mygame", version: "^2.0.0" }, mods: { other: "*" } },
            peerDependencies: { "pixi.js": "^8" },
        });
        const checked = await checkMod({ mod, game: bundleDir });
        expect(checked.compatible).toBe(false);
        expect(checked.problems).toEqual([
            "needs game version ^2.0.0, this is 1.5.2",
            "needs library pixi.js ^8, not shared by the game",
        ]);
        expect(checked.notChecked).toEqual(["required add-on other"]);

        // A DLC someone else signed is refused at bundle time.
        const foreign = await packMod({
            modDir: dlc,
            outDir: join(tmp, "foreign"),
            env: {
                ROVES_DLC_KEY: privateKeyFromSeed(SEED)
                    .export({ format: "pem", type: "pkcs8" })
                    .toString(),
            },
        });
        await expect(
            bundleDesktop({
                contentDir: join(project, "dist"),
                platforms: ["windows"],
                shellZip: await windowsBase(join(tmp, "b2")),
                dlc: [foreign.path],
                outDir: join(tmp, "out2"),
                patchExe: async () => {},
            }),
        ).rejects.toThrow(/does not match this game's DLC key/);
    });

    it("--no-mods, no package.json, and DLC without a key", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"), { mods: true });
        const [off] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["linux"],
            shellZip: await linuxBase(tmp),
            mods: false,
            outDir: join(tmp, "out"),
        });
        expect(off?.mods).toBe(false);
        await expect(
            bundleDesktop({
                contentDir: join(project, "dist"),
                platforms: ["linux"],
                shellZip: await linuxBase(join(tmp, "b")),
                dlc: [join(tmp, "nothing")],
                outDir: join(tmp, "out2"),
            }),
        ).rejects.toThrow(/roves dlc keygen/);
        const loose = await dist(join(await tempDir(), "dist"));
        const [none] = await bundleDesktop({
            contentDir: loose,
            platforms: ["linux"],
            shellZip: await linuxBase(join(tmp, "c")),
            outDir: join(tmp, "out3"),
        });
        expect(none?.mods).toBeNull();
        expect(none?.warnings.join("\n")).toContain("no mod or DLC support");
    });
});

describe("mod init", () => {
    it("creates a mod for a packaged game, or adds the roves section", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        const [result] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["linux"],
            shellZip: await linuxBase(tmp),
            outDir: join(tmp, "out"),
        });
        const created = await initMod({ dir: join(tmp, "My Mod"), game: result?.bundleDir });
        expect(created.created).toEqual(["package.json", "index.js", "overrides/"]);
        const pkg = JSON.parse(await readFile(created.manifest, "utf8"));
        expect(pkg).toMatchObject({
            name: "my-mod",
            roves: { game: { name: "mygame", version: "^1.5.2" } },
        });
        expect(await readFile(join(tmp, "My Mod", "index.js"), "utf8")).toContain("defineMod");
        // The new mod packs as it is.
        await expect(
            packMod({ modDir: join(tmp, "My Mod"), outDir: join(tmp, "packed") }),
        ).resolves.toBeTruthy();

        const existing = join(tmp, "existing");
        await write(existing, "package.json", json({ name: "x", version: "2.0.0", main: "m.js" }));
        const added = await initMod({ dir: existing, gameName: "mygame", kind: "dlc" });
        expect(added.created).toEqual([]);
        expect(JSON.parse(await readFile(added.manifest, "utf8"))).toMatchObject({
            name: "x",
            main: "m.js",
            roves: { kind: "dlc", game: { name: "mygame", version: "*" } },
        });
        await writeFile(join(existing, "m.js"), "");
    });
});
