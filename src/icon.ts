/**
 * Project icon contract of the desktop packages (engine `support/cef-windows-player/packaging/
 * project_icon.py`, roves-action `cef/project_icon.py`, Roves Packmaster `cef_player.rs`; keep
 * them in step). The game's icon comes first, the official Roves icon is the fallback.
 *
 * Sources, first match wins (the PNG and the ICO are resolved independently):
 *
 *   window PNG  1. iconPng (explicit)          2. <content>/icon.png
 *               3. the largest frame of a project ICO (explicit, else found)
 *               4. none: no icon.png in the package, the player shows the Roves logo
 *   play.exe    1. iconIco (explicit)          2. an ICO generated from the resolved window PNG
 *               3. <content>/icon.ico          4. <content>/favicon.ico
 *               5. the base's roves.ico        6. none: play.exe keeps the base's icon
 *   macOS app   an .icns generated from the resolved window PNG, else the base's Roves .icns
 *
 * Rules (the player's `src/icon_rules.rs`): at most 8 MiB; PNG square, 16..=2048 px, fully
 * decodable; ICO a valid icon directory with every frame decodable and a square largest frame
 * of at least 16 px. An explicit file that breaks them is an error; a file found in the content
 * directory that breaks them is a warning and the next source is tried.
 *
 * Everything is pure JavaScript (jimp for PNG decoding/resampling/encoding, decode-ico for ICO
 * frames, resedit for the ICO container), so every host produces every platform's icons.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJimp } from "@jimp/core";
import png from "@jimp/js-png";
import { methods as resizeMethods } from "@jimp/plugin-resize";
import decodeIco from "decode-ico";
import { Data } from "resedit";
import type { DesktopPlatform } from "./constants";
import { RovesError } from "./errors";

export const MAX_ICON_BYTES = 8 * 1024 * 1024;
export const MIN_ICON_PX = 16;
export const MAX_ICON_PX = 2048;
/** Frames of a generated `play.exe` icon (those not larger than the source). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = Buffer.from([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const Jimp = createJimp({ formats: [png], plugins: [resizeMethods] });
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/** An icon file that breaks the project icon rules. */
export class IconError extends Error {}

async function readIconFile(path: string): Promise<Buffer> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new IconError("not a file");
    if (info.size > MAX_ICON_BYTES) {
        throw new IconError(`${info.size} bytes exceeds the ${MAX_ICON_BYTES}-byte limit`);
    }
    return readFile(path);
}

function checkEdge(width: number, height: number): void {
    if (width !== height) throw new IconError(`${width}x${height} is not square`);
    if (width < MIN_ICON_PX || width > MAX_ICON_PX) {
        throw new IconError(`${width}x${height} is outside ${MIN_ICON_PX}..=${MAX_ICON_PX} px`);
    }
}

async function decodePng(data: Uint8Array): Promise<JimpImage> {
    try {
        return await Jimp.read(Buffer.from(data));
    } catch (error) {
        throw new IconError(`decode: ${(error as Error).message}`);
    }
}

/** Edge of a valid project PNG. */
export async function checkPng(path: string): Promise<number> {
    const data = await readIconFile(path);
    if (
        data.length < 33 ||
        !data.subarray(0, 8).equals(PNG_SIGNATURE) ||
        !data.subarray(8, 16).equals(IHDR)
    ) {
        throw new IconError("not a PNG file (signature or IHDR missing)");
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    checkEdge(width, height);
    const image = await decodePng(data);
    if (image.bitmap.width !== width || image.bitmap.height !== height) {
        throw new IconError(`decoded as ${image.bitmap.width}x${image.bitmap.height}`);
    }
    return width;
}

/** Every frame of an ICO, decoded (PNG frames through jimp, BMP frames through decode-ico). */
async function icoFrames(data: Buffer): Promise<JimpImage[]> {
    if (data.length < 22 || data.readUInt32LE(0) !== 0x00010000 || data.readUInt16LE(4) === 0) {
        throw new IconError("not an ICO file (icon directory header missing)");
    }
    const count = data.readUInt16LE(4);
    const directoryEnd = 6 + count * 16;
    if (directoryEnd > data.length) throw new IconError("icon directory truncated");
    for (let i = 0; i < count; i++) {
        const size = data.readUInt32LE(6 + i * 16 + 8);
        const offset = data.readUInt32LE(6 + i * 16 + 12);
        if (size === 0 || offset < directoryEnd || offset + size > data.length) {
            throw new IconError(`frame ${i} lies outside the file`);
        }
    }
    let decoded: ReturnType<typeof decodeIco>;
    try {
        decoded = decodeIco(data);
    } catch (error) {
        throw new IconError(`decode: ${(error as Error).message}`);
    }
    const frames: JimpImage[] = [];
    for (const [i, frame] of decoded.entries()) {
        try {
            frames.push(
                frame.type === "png"
                    ? await decodePng(frame.data)
                    : Jimp.fromBitmap({
                          data: Buffer.from(frame.data),
                          width: frame.width,
                          height: frame.height,
                      }),
            );
        } catch (error) {
            throw new IconError(`decode frame ${i}: ${(error as Error).message}`);
        }
    }
    return frames;
}

function largestFrame(frames: JimpImage[]): JimpImage | undefined {
    let best: JimpImage | undefined;
    for (const frame of frames) {
        if (
            !best ||
            frame.bitmap.width * frame.bitmap.height > best.bitmap.width * best.bitmap.height
        ) {
            best = frame;
        }
    }
    return best;
}

/** Largest frame edge of a valid project ICO. */
export async function checkIco(path: string): Promise<number> {
    const largest = largestFrame(await icoFrames(await readIconFile(path)));
    if (!largest) throw new IconError("no frame");
    const { width, height } = largest.bitmap;
    if (width !== height || width < MIN_ICON_PX) {
        throw new IconError(
            `largest frame ${width}x${height} is not a square of at least ${MIN_ICON_PX} px`,
        );
    }
    return width;
}

async function resizedPng(image: JimpImage, size: number): Promise<Buffer> {
    const copy = image.clone();
    if (copy.bitmap.width !== size || copy.bitmap.height !== size) {
        copy.resize({ w: size, h: size });
    }
    return copy.getBuffer("image/png");
}

/** Writes a `.ico` with one PNG-encoded frame per entry of `sizes` (1..=256 px each). */
export async function generateIco(
    sourcePng: string,
    destIco: string,
    sizes: readonly number[],
): Promise<void> {
    if (sizes.length === 0) throw new RovesError("no icon size to generate");
    const image = await Jimp.read(sourcePng);
    const ico = new Data.IconFile();
    for (const size of sizes) {
        const frame = await resizedPng(image, size);
        ico.icons.push({
            width: size,
            height: size,
            colors: 0,
            planes: 1,
            bitCount: 32,
            data: Data.RawIconItem.from(frame, size, size, 32),
        });
    }
    await writeFile(destIco, Buffer.from(ico.generate()));
}

/**
 * The element types of an `iconutil` `.iconset` (16, 32, 128, 256 and 512 pt at 1x and 2x),
 * as `(OSType, pixel edge)`, every one PNG-encoded.
 */
export const ICNS_TYPES: readonly (readonly [string, number])[] = [
    ["icp4", 16],
    ["ic11", 32],
    ["icp5", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024],
];

/**
 * Writes a `.icns` from a square PNG. Like the engine's `packaging/icns.sh`, sizes above the
 * source edge are left out rather than upscaled. The container is a 8-byte header followed by
 * `(OSType, length, PNG)` elements; the npm encoders for it are unmaintained 0.0.x packages,
 * so these few lines are written here instead.
 */
export async function generateIcns(sourcePng: string, destIcns: string): Promise<void> {
    const image = await Jimp.read(sourcePng);
    const edge = Math.min(image.bitmap.width, image.bitmap.height);
    const elements: Buffer[] = [];
    for (const [type, size] of ICNS_TYPES) {
        if (size > edge) continue;
        const data = await resizedPng(image, size);
        const header = Buffer.alloc(8);
        header.write(type, 0, "latin1");
        header.writeUInt32BE(8 + data.length, 4);
        elements.push(header, data);
    }
    if (elements.length === 0) throw new RovesError(`${sourcePng} is smaller than 16x16`);
    const body = Buffer.concat(elements);
    const header = Buffer.alloc(8);
    header.write("icns", 0, "latin1");
    header.writeUInt32BE(8 + body.length, 4);
    await writeFile(destIcns, Buffer.concat([header, body]));
}

/** Writes the largest frame of a valid ICO as an RGBA PNG. */
async function writeLargestFrame(icoPath: string, destPng: string): Promise<void> {
    const largest = largestFrame(await icoFrames(await readIconFile(icoPath)));
    if (!largest) throw new IconError("no frame");
    await writeFile(destPng, await largest.getBuffer("image/png"));
}

export type IconSource = "project" | "roves" | "unchanged";

export interface IconChoice {
    source: IconSource;
    detail: string;
}

/** Resolved project icon. */
export interface ProjectIcon {
    /** Written as the window `icon.png`; undefined: the player shows the Roves logo. */
    windowPng?: string;
    /** Windows: patched into `play.exe`; undefined: `play.exe` keeps the base's icon. */
    exeIco?: string;
    /** macOS: replaces the bundle `.icns`; undefined: the base's Roves icon stays. */
    appIcns?: string;
    window: IconChoice;
    executable?: IconChoice;
    appIcon?: IconChoice;
    /** `window <source> (<detail>)`, plus `; executable ...` (Windows) or `; app icon ...` (macOS). */
    summary: string;
    /** Invalid icon files found in the content directory and skipped. */
    warnings: string[];
}

export interface ResolveIconOptions {
    platform: DesktopPlatform;
    /** The developer's build output. */
    contentDir: string;
    /** Explicit square PNG (an invalid one is an error). */
    iconPng?: string;
    /** Explicit `.ico` (an invalid one is an error). */
    iconIco?: string;
    /** The Windows base's `roves.ico`. */
    fallbackIco?: string;
    /** Scratch directory for generated files (created if needed). */
    workDir: string;
}

interface Picked {
    path: string;
    label: string;
    edge: number;
}

async function pick(
    candidates: { path: string | undefined; label: string; explicit: boolean }[],
    check: (path: string) => Promise<number>,
    warnings: string[],
): Promise<Picked | undefined> {
    for (const { path, label, explicit } of candidates) {
        if (!path) continue;
        if (!explicit && !(await stat(path).catch(() => null))?.isFile()) continue;
        try {
            return { path, label, edge: await check(path) };
        } catch (error) {
            if (!(error instanceof IconError)) throw error;
            if (explicit) throw new RovesError(`${label} ${path}: ${error.message}`);
            warnings.push(`ignoring ${label} (${error.message}); trying the next source`);
        }
    }
    return undefined;
}

/** Resolves the project icon for `platform` (see the module documentation). */
export async function resolveProjectIcon(options: ResolveIconOptions): Promise<ProjectIcon> {
    const { platform, contentDir, workDir } = options;
    await mkdir(workDir, { recursive: true });
    const warnings: string[] = [];
    const pngPick = await pick(
        [
            { path: options.iconPng, label: "icon-png", explicit: true },
            { path: join(contentDir, "icon.png"), label: "game icon.png", explicit: false },
        ],
        checkPng,
        warnings,
    );
    const explicitIco = await pick(
        [{ path: options.iconIco, label: "icon-ico", explicit: true }],
        checkIco,
        warnings,
    );
    const foundIco = await pick(
        [
            { path: join(contentDir, "icon.ico"), label: "game icon.ico", explicit: false },
            { path: join(contentDir, "favicon.ico"), label: "game favicon.ico", explicit: false },
        ],
        checkIco,
        warnings,
    );

    let windowPng: Picked | undefined;
    let window: IconChoice;
    if (pngPick) {
        windowPng = pngPick;
        window = { source: "project", detail: `${pngPick.label} ${pngPick.edge}x${pngPick.edge}` };
    } else if (explicitIco ?? foundIco) {
        const ico = (explicitIco ?? foundIco) as Picked;
        const out = join(workDir, "icon.png");
        await writeLargestFrame(ico.path, out);
        const label = `largest frame of ${ico.label}`;
        windowPng = { path: out, label, edge: await checkPng(out) };
        window = { source: "project", detail: `${label} ${ico.edge}x${ico.edge}` };
    } else {
        window = { source: "roves", detail: "no project icon (embedded Roves logo)" };
    }

    const icon: ProjectIcon = { windowPng: windowPng?.path, window, summary: "", warnings };
    let second = "";
    if (platform === "windows") {
        let executable: IconChoice;
        if (explicitIco) {
            icon.exeIco = explicitIco.path;
            executable = { source: "project", detail: explicitIco.label };
        } else if (pngPick) {
            const out = join(workDir, "play.ico");
            await generateIco(
                pngPick.path,
                out,
                ICO_SIZES.filter((size) => size <= pngPick.edge),
            );
            await checkIco(out);
            icon.exeIco = out;
            executable = { source: "project", detail: `ICO generated from ${pngPick.label}` };
        } else if (foundIco) {
            icon.exeIco = foundIco.path;
            executable = { source: "project", detail: foundIco.label };
        } else if (options.fallbackIco) {
            try {
                await checkIco(options.fallbackIco);
            } catch (error) {
                throw new RovesError(`the base's roves.ico: ${(error as Error).message}`);
            }
            icon.exeIco = options.fallbackIco;
            executable = { source: "roves", detail: "Roves fallback icon" };
        } else {
            executable = {
                source: "unchanged",
                detail: "no project icon and no Roves fallback icon in the base",
            };
        }
        icon.executable = executable;
        second = `; executable ${executable.source} (${executable.detail})`;
    } else if (platform === "macos") {
        let appIcon: IconChoice;
        if (windowPng) {
            const out = join(workDir, "app.icns");
            await generateIcns(windowPng.path, out);
            icon.appIcns = out;
            appIcon = { source: "project", detail: `ICNS generated from ${windowPng.label}` };
        } else {
            appIcon = { source: "roves", detail: "the base's Roves icon" };
        }
        icon.appIcon = appIcon;
        second = `; app icon ${appIcon.source} (${appIcon.detail})`;
    }
    icon.summary = `window ${window.source} (${window.detail})${second}`;
    return icon;
}
