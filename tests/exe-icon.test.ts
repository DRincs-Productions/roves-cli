import { execFileSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { describe, expect, it } from "vitest";
import { setExeIcon } from "../src/exe-icon";
import { icoFile, tempDir } from "./helpers";

async function resources(path: string) {
    return NtExecutableResource.from(NtExecutable.from(await readFile(path), { ignoreCert: true }));
}

/**
 * A real PE with its own icon group, version info and manifest (a Windows system executable
 * copied to a temp dir): the main icon group is replaced by the ICO, the other resources are
 * kept, and the patched copy still runs.
 */
describe.skipIf(process.platform !== "win32")("setExeIcon on a real executable", () => {
    it("replaces the main icon group and keeps the other resources", async () => {
        const tmp = await tempDir();
        const exe = join(tmp, "play.exe");
        await copyFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), exe);
        const before = await resources(exe);
        const groupsBefore = Resource.IconGroupEntry.fromEntries(before.entries);
        const otherBefore = before.entries.filter((e) => e.type !== 3 && e.type !== 14);
        expect(groupsBefore.length).toBeGreaterThan(0);

        const ico = await icoFile(join(tmp, "game.ico"), 256);
        await setExeIcon(exe, ico);

        const after = await resources(exe);
        const groups = Resource.IconGroupEntry.fromEntries(after.entries);
        expect(groups).toHaveLength(groupsBefore.length);
        const main = groups.find((g) => g.id === groupsBefore[0]?.id);
        // 256 px is stored as 0 in an icon directory.
        expect(main?.icons.map((icon) => icon.width)).toEqual([16, 0]);
        // Only icons referenced by a group are left (the old main group's icons were removed).
        const used = new Set(groups.flatMap((g) => g.icons.map((icon) => icon.iconID)));
        const icons = after.entries.filter((e) => e.type === 3);
        expect(icons.every((e) => used.has(Number(e.id)))).toBe(true);
        const otherAfter = after.entries.filter((e) => e.type !== 3 && e.type !== 14);
        expect(otherAfter.map((e) => `${e.type}/${e.id}`)).toEqual(
            otherBefore.map((e) => `${e.type}/${e.id}`),
        );
        expect(execFileSync(exe, ["/d", "/c", "echo ok"]).toString().trim()).toBe("ok");
    });
});
