import shellVersionText from "./shell-version.txt";
import { RovesError } from "./errors";

/**
 * DESKTOP PLAYER PIN: the engine release whose `roves_shell_<platform>[_steam|_mcp].zip` CEF
 * player assets are downloaded by default. Single source of truth: `src/shell-version.txt`,
 * bumped on every engine release that changes the desktop player.
 */
export const PINNED_SHELL_VERSION: string = shellVersionText.trim();

/**
 * MOBILE ENGINE PIN: the Servo-era engine tag that still has `mach bundle --android`/`--ios`
 * and `support/ios/bundle.py` (the CEF-era engine has no mach packaging). Do not move it to a
 * newer tag without checking that tooling still exists there.
 */
export const MOBILE_ENGINE_VERSION = "v0.7.15";

export const ENGINE_REPOSITORY = "https://github.com/DRincs-Productions/roves";
export const RELEASE_DOWNLOAD_BASE = `${ENGINE_REPOSITORY}/releases/download`;

export const DESKTOP_PLATFORMS = ["windows", "macos", "linux"] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

export function isDesktopPlatform(value: string): value is DesktopPlatform {
    return (DESKTOP_PLATFORMS as readonly string[]).includes(value);
}

/** The desktop platform of the machine running this code, if it is one. */
export function hostPlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
    switch (platform) {
        case "win32":
            return "windows";
        case "darwin":
            return "macos";
        case "linux":
            return "linux";
        default:
            throw new RovesError(
                `unsupported host OS ${platform}: pass --platform windows|macos|linux explicitly`,
            );
    }
}

/**
 * Splits and validates `--platform` values (repeatable, comma separated); empty means the host
 * platform. Duplicates are removed, the order is kept.
 */
export function parsePlatforms(values: readonly string[] | undefined): DesktopPlatform[] {
    const parts = (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    if (parts.length === 0) return [hostPlatform()];
    const platforms: DesktopPlatform[] = [];
    for (const part of parts) {
        if (!isDesktopPlatform(part)) {
            throw new RovesError(
                `unknown platform "${part}" (expected ${DESKTOP_PLATFORMS.join(", ")})`,
            );
        }
        if (!platforms.includes(part)) platforms.push(part);
    }
    return platforms;
}

/**
 * The engine release asset for a platform and variant: `roves_shell_<platform>.zip`, the Steam
 * build `..._steam.zip` or the local-MCP development build `..._mcp.zip`. No Steam + MCP package
 * is published, so that combination is an error, never a silent fallback.
 */
export function assetName(platform: DesktopPlatform, steam = false, mcp = false): string {
    if (steam && mcp) {
        throw new RovesError(
            "the local MCP bridge and Steam can't be combined: no Steam package with the MCP bridge is published",
        );
    }
    const suffix = steam ? "_steam" : mcp ? "_mcp" : "";
    return `roves_shell_${platform}${suffix}.zip`;
}

export function assetUrl(
    asset: string,
    version: string = PINNED_SHELL_VERSION,
    baseUrl: string = RELEASE_DOWNLOAD_BASE,
): string {
    return `${baseUrl.replace(/\/+$/, "")}/${version}/${asset}`;
}

/** Engine release tags look like `v0.9.0` (optionally with a pre-release suffix). */
export function validateShellVersion(version: string): string {
    const trimmed = version.trim();
    if (!/^v\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(trimmed)) {
        throw new RovesError(`invalid shell version "${version}" (expected a tag such as v0.9.0)`);
    }
    return trimmed;
}

/**
 * A package/archive base name: one path segment that is valid on Windows, macOS and Linux.
 */
export function validateName(name: string, what = "name"): string {
    const trimmed = name.trim();
    if (
        !trimmed ||
        trimmed === "." ||
        trimmed === ".." ||
        /[<>:"/\\|?*]/.test(trimmed) ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
        /[\u0000-\u001f]/.test(trimmed) ||
        /[. ]$/.test(trimmed)
    ) {
        throw new RovesError(
            `invalid ${what} "${name}": use a single file name without / \\ : * ? " < > | and not ending in a dot or space`,
        );
    }
    return trimmed;
}

/** Steam App IDs are positive integers. */
export function validateSteamAppId(appId: string): string {
    const trimmed = appId.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
        throw new RovesError(`invalid Steam App ID "${appId}": expected a positive number`);
    }
    return trimmed;
}
