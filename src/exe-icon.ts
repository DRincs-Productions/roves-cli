/**
 * Replaces the main icon group of a Windows executable, like electron/rcedit's `--set-icon`
 * (roves-action) or editpe (Roves Packmaster), but in pure JavaScript with resedit, so it
 * works on every host OS.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { RovesError } from "./errors";

const RT_GROUP_ICON = 14;
/** LANG_ENGLISH / SUBLANG_ENGLISH_US, for executables without any icon group. */
const DEFAULT_LANG = 1033;

/**
 * The group Windows shows for the executable: the first `RT_GROUP_ICON` in resource directory
 * order (named entries first, case-insensitively, then numeric IDs ascending).
 */
function mainGroupKey(
    entries: { type: string | number; id: string | number; lang: string | number }[],
): { id: string | number; lang: string | number } | undefined {
    const groups = entries.filter((entry) => entry.type === RT_GROUP_ICON);
    groups.sort((a, b) => {
        if (typeof a.id === "string" && typeof b.id === "string") {
            return a.id.toUpperCase() < b.id.toUpperCase() ? -1 : 1;
        }
        if (typeof a.id === "string") return -1;
        if (typeof b.id === "string") return 1;
        return a.id - b.id || Number(a.lang) - Number(b.lang);
    });
    return groups[0];
}

/**
 * Replaces, in place, the main icon group of `exePath` with the frames of `icoPath`. The icons
 * only the previous group used are removed (an older sample game's icon must not survive);
 * every other resource (version info, manifest, other icon groups) is kept.
 */
export async function setExeIcon(exePath: string, icoPath: string): Promise<void> {
    try {
        const exe = NtExecutable.from(await readFile(exePath), { ignoreCert: true });
        const resources = NtExecutableResource.from(exe);
        const ico = Data.IconFile.from(await readFile(icoPath));
        const main = mainGroupKey(resources.entries) ?? { id: 1, lang: DEFAULT_LANG };
        Resource.IconGroupEntry.replaceIconsForResource(
            resources.entries,
            main.id,
            main.lang,
            ico.icons.map((icon) => icon.data),
        );
        resources.outputResource(exe);
        await writeFile(exePath, Buffer.from(exe.generate()));
    } catch (error) {
        throw new RovesError(`setting the icon of ${exePath}: ${(error as Error).message}`);
    }
}
