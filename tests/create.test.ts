import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliDependencies, runCli } from "../src/cli";
import { createMod } from "../src/create";
import { bundleDesktop } from "../src/desktop";
import { dist, linuxBase, tempDir, write } from "./helpers";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A game project whose build shares pixi.js and @drincs/pixi-vn as entry chunks. */
async function gameProject(root: string): Promise<string> {
    await write(
        root,
        "package.json",
        json({
            name: "mygame",
            version: "1.5.2",
            dependencies: { "pixi.js": "^8.19.0", "@drincs/pixi-vn": "^1.3.0", lodash: "^4" },
        }),
    );
    for (const [lib, version] of [
        ["pixi.js", "8.19.0"],
        ["@drincs/pixi-vn", "1.3.4"],
        ["lodash", "4.17.21"],
    ]) {
        await write(root, `node_modules/${lib}/package.json`, json({ name: lib, version }));
    }
    await dist(join(root, "dist"));
    await write(root, "dist/assets/pixi.js-DHJl7f-w.js", "export{e as Application,e as Sprite};");
    await write(root, "dist/assets/pixi-vn-AbCdEf12.js", "export{x as canvas,y as narration};");
    return root;
}

describe("roves mod create", () => {
    it("creates a mod for a packaged game, with the game's shared libraries", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        const [bundle] = await bundleDesktop({
            contentDir: join(project, "dist"),
            platforms: ["linux"],
            shellZip: await linuxBase(tmp),
            outDir: join(tmp, "out"),
        });
        const result = await createMod({
            kind: "mod",
            game: bundle?.bundleDir as string,
            id: "@me/new-ending",
            name: "New ending",
            description: "An extra ending.",
            author: "Me",
            dir: join(tmp, "new-ending"),
        });
        expect(result.shared).toEqual({ "pixi.js": "8.19.0", "@drincs/pixi-vn": "1.3.4" });
        expect(result.files).toEqual(
            expect.arrayContaining([
                ".github/workflows/release.yml",
                ".gitignore",
                "AGENTS.md",
                "README.md",
                "biome.json",
                "cover.png",
                "overrides/.gitkeep",
                "package.json",
                "src/index.ts",
                "tests/start.test.ts",
                "tsconfig.json",
                "tsup.config.ts",
                "vitest.config.ts",
            ]),
        );
        const pkg = JSON.parse(await readFile(join(result.dir, "package.json"), "utf8"));
        expect(pkg).toMatchObject({
            name: "@me/new-ending",
            displayName: "New ending",
            description: "An extra ending.",
            author: "Me",
            main: "dist/index.js",
            peerDependencies: { "pixi.js": "^8.19.0", "@drincs/pixi-vn": "^1.3.4" },
            devDependencies: { "pixi.js": "8.19.0", "@drincs/pixi-vn": "1.3.4", tsup: "^9.0.0" },
            roves: { game: { name: "mygame", version: "^1.5.2" } },
            scripts: { start: "roves mod dev --game ../out/roves-game", build: "tsup" },
        });
        expect(pkg.roves.kind).toBeUndefined();
        const tsup = await readFile(join(result.dir, "tsup.config.ts"), "utf8");
        expect(tsup).toContain("/__mods/_shared/${lib}.js");
        expect(await readFile(join(result.dir, "src/index.ts"), "utf8")).toContain(
            'import * as shared from "pixi.js"',
        );
        const readme = await readFile(join(result.dir, "README.md"), "utf8");
        expect(readme).toContain("me-new-ending-0.1.0.rovesmod");
        expect(readme).not.toMatch(/\{\{\w+\}\}/);
        // GitHub expressions survive the placeholders.
        expect(await readFile(join(result.dir, ".github/workflows/release.yml"), "utf8")).toContain(
            "${{ github.ref_name }}",
        );
        expect((await stat(join(result.dir, "cover.png"))).size).toBeGreaterThan(100);
        await expect(
            createMod({ kind: "mod", game: bundle?.bundleDir as string, id: "x", dir: result.dir }),
        ).rejects.toThrow(/not empty/);
    });

    it("creates a DLC inside the game's source project", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        const commands: string[] = [];
        const result = await createMod({
            kind: "dlc",
            game: project,
            id: "chapter-6",
            shared: ["@drincs/pixi-vn"],
            git: true,
            install: true,
            run: async (command, args) => {
                commands.push([command, ...args].join(" "));
            },
        });
        expect(result.dir).toBe(join(project, "dlc-src", "chapter-6"));
        expect(commands).toEqual(["git init -q", "npm install"]);
        const pkg = JSON.parse(await readFile(join(result.dir, "package.json"), "utf8"));
        expect(pkg.roves).toEqual({ kind: "dlc", game: { name: "mygame", version: "^1.5.2" } });
        expect(pkg.peerDependencies).toEqual({ "@drincs/pixi-vn": "^1.3.4" });
        expect(pkg.scripts).toMatchObject({
            "game:package": "roves bundle -c ../../dist --project-dir ../.. -n game -o .roves",
            start: "roves mod dev --game .roves/game",
            pack: "npm run build && roves mod pack --project-dir ../..",
        });
        expect(result.files).not.toContain(".github/workflows/release.yml");
        await expect(
            createMod({
                kind: "dlc",
                game: project,
                id: "x",
                shared: ["three"],
                dir: join(tmp, "x"),
            }),
        ).rejects.toThrow(/does not share three/);
    });

    it("guesses a DLC's shared libraries from the dependencies without a build", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        await write(project, "dist/index.html", "");
        const unbuilt = join(tmp, "unbuilt");
        await write(unbuilt, "package.json", await readFile(join(project, "package.json"), "utf8"));
        for (const lib of ["pixi.js", "@drincs/pixi-vn", "lodash"]) {
            await write(
                unbuilt,
                `node_modules/${lib}/package.json`,
                await readFile(join(project, "node_modules", lib, "package.json"), "utf8"),
            );
        }
        const result = await createMod({ kind: "dlc", game: unbuilt, id: "extra" });
        expect(result.shared).toEqual({ "pixi.js": "8.19.0", "@drincs/pixi-vn": "1.3.4" });
        expect(result.warnings.join("\n")).toContain("has no build");
    });

    it("runs without questions with --yes", async () => {
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        const out: string[] = [];
        const deps: Partial<CliDependencies> = {
            stdout: (text) => out.push(text),
            stderr: () => {},
            isInteractive: () => true,
            askCreateOptions: async () => {
                throw new Error("must not ask");
            },
        };
        const argv = (...args: string[]) => ["node", "roves", ...args];
        expect(
            await runCli(
                argv(
                    "mod",
                    "create",
                    join(tmp, "d"),
                    "--kind",
                    "dlc",
                    "--game",
                    project,
                    "--id",
                    "d",
                    "-y",
                ),
                deps,
            ),
        ).toBe(0);
        expect(out.join("")).toBe(`${join(tmp, "d")}\n`);
        expect(await runCli(argv("mod", "create", "-y", "--kind", "mod"), deps)).toBe(1);
    });
});

describe("reduced shared chunks", () => {
    it("accepts an entry that re-exports only part of a library", async () => {
        const { detectSharedLibraries } = await import("../src/mods");
        const tmp = await tempDir();
        const project = await gameProject(join(tmp, "game"));
        // A reduced entry (src/shared/pixi.ts re-exporting a few names): public names, few of them.
        await write(project, "dist/assets/pixi.js-DHJl7f-w.js", "export{a as Assets,s as Sprite};");
        const { shared, warnings } = await detectSharedLibraries(project, join(project, "dist"));
        expect(shared["pixi.js"]?.file).toBe("assets/pixi.js-DHJl7f-w.js");
        expect(warnings).toEqual([]);
    });
});
