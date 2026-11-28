/**
 * The interactive questions of `roves mod create` (@clack/prompts); the work is `createMod`.
 */
import { basename } from "node:path";
import {
    cancel,
    confirm,
    intro,
    isCancel,
    log,
    multiselect,
    outro,
    select,
    text,
} from "@clack/prompts";
import {
    type CreateModOptions,
    defaultAddonDir,
    type GameForAddon,
    readGameForAddon,
} from "./create";
import { RovesError } from "./errors";
import { type AddonKind, isSingleInstanceLibrary, validPackageName } from "./mods";

function answer<T>(value: T): Exclude<T, symbol> {
    if (isCancel(value)) {
        cancel("Cancelled.");
        throw new RovesError("cancelled");
    }
    return value as Exclude<T, symbol>;
}

/** A package name from a display name: lowercase, URL-safe. */
export function packageNameFrom(name: string): string {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\-_.~@/]+/g, "-")
            .replace(/^[-_.]+|[-_.]+$/g, "") || "my-mod"
    );
}

/** Asks whatever `given` lacks; values already given are not asked again. */
export async function askCreateOptions(
    given: Partial<CreateModOptions>,
): Promise<CreateModOptions> {
    intro("Create a Roves mod or DLC");
    const kind =
        given.kind ??
        answer(
            await select<AddonKind>({
                message: "What do you want to make?",
                options: [
                    {
                        value: "mod",
                        label: "Mod",
                        hint: "anyone can make one, for a packaged game",
                    },
                    {
                        value: "dlc",
                        label: "DLC",
                        hint: "the game's developer, from the game's source project",
                    },
                ],
            }),
        );
    let game: GameForAddon | undefined;
    let gamePath = given.game;
    while (!game) {
        gamePath =
            gamePath ??
            answer(
                await text({
                    message:
                        kind === "mod"
                            ? "Folder of the packaged game (the unzipped Roves package, or the .app)"
                            : "Folder of the game's source project (with its package.json)",
                    validate: (value) => (value?.trim() ? undefined : "Required"),
                }),
            ).trim();
        try {
            game = await readGameForAddon(kind, gamePath);
        } catch (error) {
            log.error((error as Error).message);
            gamePath = undefined;
        }
    }
    if (!gamePath) throw new RovesError("no game");
    for (const warning of game.warnings) log.warn(warning);
    log.info(
        `${game.name} ${game.version}; shared libraries: ${
            Object.entries(game.shared)
                .map(([lib, v]) => `${lib}@${v}`)
                .join(", ") || "none"
        }`,
    );
    const name =
        given.name ??
        answer(
            await text({
                message: "Name shown to players",
                placeholder: "New ending",
                validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
        ).trim();
    const id =
        given.id ??
        answer(
            await text({
                message: "Id (npm package name, e.g. @your-name/new-ending)",
                initialValue: packageNameFrom(name),
                validate: (value) =>
                    value && validPackageName(value.trim())
                        ? undefined
                        : "Lowercase letters, digits, - _ . ~, optionally @scope/",
            }),
        ).trim();
    const description =
        given.description ??
        answer(await text({ message: "Description", placeholder: "Optional" })).trim();
    const author =
        given.author ?? answer(await text({ message: "Author", placeholder: "Optional" })).trim();
    const libs = Object.keys(game.shared);
    const shared =
        given.shared ??
        (libs.length === 0
            ? []
            : answer(
                  await multiselect<string>({
                      message: "Libraries of the game this add-on uses (shared, never bundled)",
                      options: libs.map((lib) => ({
                          value: lib,
                          label: `${lib} ${game.shared[lib]}`,
                          hint: isSingleInstanceLibrary(lib) ? "single instance" : undefined,
                      })),
                      initialValues: libs.filter((lib) => isSingleInstanceLibrary(lib)),
                      required: false,
                  }),
              ));
    const dir =
        given.dir ??
        answer(
            await text({
                message: "Create it in",
                initialValue: defaultAddonDir(kind, id, gamePath),
            }),
        ).trim();
    const git = given.git ?? answer(await confirm({ message: "Initialize a git repository?" }));
    const install =
        given.install ??
        answer(await confirm({ message: "Install the dependencies (npm install)?" }));
    outro(`Creating ${basename(dir)}...`);
    return {
        kind,
        game: gamePath,
        id,
        name,
        description,
        author,
        shared,
        dir,
        git,
        install,
    };
}
