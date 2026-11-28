import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDesktop } from "../src/desktop";
import {
    addonFileName,
    checkMod,
    findPackagedGame,
    initMod,
    packMod,
    readGameIdentity,
    validPackageName,
} from "../src/mods";
import { sha256File } from "../src/zip";
import { dist, fileNames, linuxBase, readZip, tempDir, windowsBase, write } from "./helpers";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** One zip entry as text (a missing entry fails the test). */
function text(zip: Awaited<ReturnType<typeof readZip>>, name: string): string {
    const entry = zip.get(name);
    if (!entry) throw new Error(`${name} is not in the zip`);
    return entry.bytes.toString("utf8");
}

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

const dlcManifest = (version = "1.0.0") => ({
    name: "chapter-6",
    version,
    roves: { kind: "dlc", game: { name: "mygame", version: "^1.5.0" } },
});

describe("names", () => {
    it("package names follow npm; DLC files have no version", () => {
        for (const good of ["mod", "@author/new-ending", "a.b_c~d"]) {
            expect(validPackageName(good)).toBe(true);
        }
        for (const bad of ["", "Mod", "@author", "@a/b/c", ".x", "a b"]) {
            expect(validPackageName(bad)).toBe(false);
        }
        expect(addonFileName("@me/x", "mod", "1.2.0")).toBe("me-x-1.2.0.rovesmod");
        expect(addonFileName("@me/x", "dlc", "1.2.0")).toBe("me-x.rovesmod");
    });
});

describe("mod pack", () => {
    it("packs the files npm would, with exact bundled versions, deterministically", async () => {
        const tmp = await tempDir();
        const mod = await modFolder(join(tmp, "mod"), {
            files: ["dist", "overrides"],
            dependencies: { "lodash-es": "^4.17.0" },
        });
        const result = await packMod({ modDir: mod, outDir: join(tmp, "out") });
        expect(result).toMatchObject({ id: "@me/new-ending", kind: "mod" });
        expect(result.registered).toBeUndefined();
        expect(result.path).toBe(join(tmp, "out", "me-new-ending-1.0.0.rovesmod"));
        const zip = await readZip(result.path);
        expect(fileNames(zip).sort()).toEqual([
            "cover.png",
            "dist/index.js",
            "overrides/a.txt",
            "package.json",
        ]);
        expect(JSON.parse(text(zip, "package.json")).dependencies).toEqual({
            "lodash-es": "4.17.21",
        });
        const again = await packMod({ modDir: mod, outDir: join(tmp, "out2") });
        expect(again.sha256).toBe(result.sha256);
        expect(await sha256File(result.path)).toBe(result.sha256);
    });

    it("refuses a missing main; a DLC is named without version and registered per version", async () => {
        const tmp = await tempDir();
        const broken = await modFolder(join(tmp, "broken"), { files: ["overrides"] });
        await expect(packMod({ modDir: broken, outDir: tmp })).rejects.toThrow(
            /"main" dist\/index.js/,
        );
        // A DLC outside the game's project cannot be registered.
        const stray = await modFolder(join(tmp, "stray"), dlcManifest());
        await expect(packMod({ modDir: stray, outDir: tmp })).rejects.toThrow(/--project-dir/);

        const project = await gameProject(join(tmp, "game"));
        const dlc = await modFolder(join(project, "dlc-src", "chapter-6"), dlcManifest());
        const first = await packMod({ modDir: dlc, outDir: join(tmp, "v1") });
        expect(first.path).toBe(join(tmp, "v1", "chapter-6.rovesmod"));
        expect(first.registered).toBe(join(project, "roves-dlc.json"));
        await write(dlc, "package.json", json({ ...dlcManifest("1.1.0"), main: "dist/index.js" }));
        const second = await packMod({ modDir: dlc, outDir: join(tmp, "v2") });
        const registry = JSON.parse(await readFile(join(project, "roves-dlc.json"), "utf8"));
        expect(registry).toEqual({
            format: 1,
            dlc: { "chapter-6": { "1.0.0": first.sha256, "1.1.0": second.sha256 } },
        });
        expect((await readGameIdentity(project)).dlc).toEqual(registry.dlc);
        // An explicit project of another game is refused.
        await write(join(tmp, "other"), "package.json", json({ name: "other", version: "1.0.0" }));
        await expect(
            packMod({ modDir: dlc, outDir: tmp, projectDir: join(tmp, "other") }),
        ).rejects.toThrow(/not of mygame/);
    });
});

describe("bundle with mods and DLC", () => {
    it("writes the game identity with the official DLC; check finds the game", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        const dlc = await modFolder(join(project, "dlc-src", "chapter-6"), dlcManifest());
        const [result] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["windows"],
            shellZip: await windowsBase(tmp),
            dlc: [dlc],
            outDir: join(tmp, "out"),
            patchExe: async () => {},
        });
        expect(result?.mods).toBe(true);
        expect(result?.dlc).toEqual(["chapter-6.rovesmod"]);
        const bundleDir = result?.bundleDir as string;
        const shipped = join(bundleDir, "dlc", "chapter-6.rovesmod");
        const identity = JSON.parse(
            await readFile(join(bundleDir, "game", "roves-game.json"), "utf8"),
        );
        expect(identity).toEqual({
            format: 1,
            name: "mygame",
            version: "1.5.2",
            mods: true,
            dlc: { "chapter-6": { "1.0.0": await sha256File(shipped) } },
            shared: {},
        });
        const zip = await readZip(result?.archivePath as string);
        const sums = text(zip, "roves-game/SHA256SUMS.txt");
        expect(sums).toContain("  game/roves-game.json\r\n");
        expect(sums).toContain("  dlc/chapter-6.rovesmod\r\n");

        const game = await findPackagedGame(bundleDir);
        expect(game.executable).toBe(join(bundleDir, "play.exe"));
        expect(await checkMod({ mod: shipped, game: bundleDir })).toMatchObject({
            compatible: true,
            problems: [],
        });

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

        // A DLC built elsewhere (same id and version, other content) is not the official one.
        const elsewhere = await gameProject(join(tmp, "copy"));
        const fake = await modFolder(join(elsewhere, "chapter-6"), dlcManifest());
        await write(fake, "overrides/a.txt", "not official");
        const forged = await packMod({ modDir: fake, outDir: join(tmp, "fake-out") });
        expect((await checkMod({ mod: forged.path, game: bundleDir })).problems).toEqual([
            "DLC chapter-6 1.0.0 differs from the registered build",
        ]);
        await expect(
            bundleDesktop({
                contentDir: join(project, "dist"),
                platforms: ["windows"],
                shellZip: await windowsBase(join(tmp, "b2")),
                dlc: [forged.path],
                outDir: join(tmp, "out2"),
                patchExe: async () => {},
            }),
        ).rejects.toThrow(/differs from the registered build/);
        // check takes only packed DLC.
        expect((await checkMod({ mod: dlc, game: bundleDir })).problems).toEqual([
            "a DLC must be a .rovesmod file (roves mod pack)",
        ]);
    });

    it("--no-mods, and no package.json", async () => {
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
        expect(off?.dlc).toEqual([]);
        const loose = await dist(join(await tempDir(), "dist"));
        const [none] = await bundleDesktop({
            contentDir: loose,
            platforms: ["linux"],
            shellZip: await linuxBase(join(tmp, "c")),
            outDir: join(tmp, "out3"),
        });
        expect(none?.mods).toBeNull();
        expect(none?.warnings.join("\n")).toContain("no mod or DLC support");
        const identity = join(tmp, "out3", "roves-game", "game", "roves-game.json");
        expect(await stat(identity).catch(() => null)).toBeNull();
    });
});

describe("shared libraries", () => {
    /** A game whose build exposes some libraries as named entry chunks. */
    async function sharingGame(root: string): Promise<string> {
        await write(
            root,
            "package.json",
            json({
                name: "mygame",
                version: "1.5.2",
                dependencies: {
                    "pixi.js": "^8.19.0",
                    "@drincs/pixi-vn": "^1.3.0",
                    tone: "^15.0.0",
                    howler: "^2.2.0",
                    lodash: "^4.17.0",
                },
            }),
        );
        for (const [lib, version] of [
            ["pixi.js", "8.19.0"],
            ["@drincs/pixi-vn", "1.3.4"],
            ["tone", "15.1.0"],
            ["howler", "2.2.4"],
            ["lodash", "4.17.21"],
        ]) {
            await write(root, `node_modules/${lib}/package.json`, json({ name: lib, version }));
        }
        await dist(join(root, "dist"));
        // Entry chunks with preserveEntrySignatures "strict": the public API.
        await write(
            root,
            "dist/assets/pixi.js-DHJl7f-w.js",
            'import{a as e}from"./lib-B29efWtk.js";export{e as Application,e as Sprite};',
        );
        await write(
            root,
            "dist/assets/pixi-vn-AbCdEf12.js",
            "export{x as canvas,y as narration};export default z;",
        );
        // A manualChunks chunk: a few minified internal names only.
        await write(root, "dist/assets/tone-Q1w2E3r4.js", "export{a as n,b as t};");
        return root;
    }

    it("finds the entry chunks named after the libraries and writes them to the game identity", async () => {
        const tmp = await tempDir();
        const project = await sharingGame(join(tmp, "game"));
        const [result] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["linux"],
            shellZip: await linuxBase(tmp),
            outDir: join(tmp, "out"),
        });
        const identity = JSON.parse(
            await readFile(join(tmp, "out", "roves-game", "game", "roves-game.json"), "utf8"),
        );
        expect(identity.shared).toEqual({
            "pixi.js": { version: "8.19.0", file: "assets/pixi.js-DHJl7f-w.js", default: false },
            "@drincs/pixi-vn": {
                version: "1.3.4",
                file: "assets/pixi-vn-AbCdEf12.js",
                default: true,
            },
        });
        const warnings = result?.warnings.join("\n") ?? "";
        // tone: made with manualChunks; howler: single-instance library without a chunk.
        expect(warnings).toContain("tone: assets/tone-Q1w2E3r4.js only exports internal names");
        expect(warnings).toContain("howler is not shared with mods");
        // lodash can be bundled by mods: no warning.
        expect(warnings).not.toContain("lodash");

        // mod check uses the shared versions.
        const mod = await modFolder(join(tmp, "mod"), {
            peerDependencies: { "pixi.js": "^8.0.0", "@drincs/pixi-vn": "^2.0.0" },
        });
        const checked = await checkMod({ mod, game: result?.bundleDir as string });
        expect(checked.problems).toEqual([
            "needs library @drincs/pixi-vn ^2.0.0, the game shares 1.3.4",
        ]);
        const created = await initMod({ dir: join(tmp, "new-mod"), game: result?.bundleDir });
        expect(created.shared).toEqual({ "pixi.js": "8.19.0", "@drincs/pixi-vn": "1.3.4" });
    });

    it("refuses two chunks named after the same library", async () => {
        const tmp = await tempDir();
        const project = await sharingGame(join(tmp, "game"));
        await write(project, "dist/assets/pixi.js-ZZZZZZZZ.js", "export{a as Application};");
        await expect(
            bundleDesktop({
                contentDir: join(project, "dist"),
                platforms: ["linux"],
                shellZip: await linuxBase(tmp),
                outDir: join(tmp, "out"),
            }),
        ).rejects.toThrow(/more than one chunk is named after pixi.js/);
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
