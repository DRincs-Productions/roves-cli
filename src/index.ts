/**
 * Programmatic API of @drincs/roves-cli: everything the `roves` command does, for tools such as
 * roves-action and Roves Packmaster.
 */
export {
    type AssembleOptions,
    assemble,
    type ProvenanceOptions,
    rewriteProvenance,
} from "./assemble";
export {
    CHECKSUMS,
    GAME_DIR,
    LAYOUT,
    locateRoot,
    MCP_PROVENANCE_HEADER,
    MCP_REQUIRED,
    macosBundleNames,
    mcpDir,
    PlayerBase,
    PROJECT_ICON_FILE,
    PROVENANCE,
    ROVES_FALLBACK_ICO,
    STEAM_APP_ID_FILE,
    WINDOWS_EXE,
} from "./base";
export { type CliDependencies, createProgram, runCli } from "./cli";
export {
    assetName,
    assetUrl,
    DESKTOP_PLATFORMS,
    type DesktopPlatform,
    ENGINE_REPOSITORY,
    hostPlatform,
    isDesktopPlatform,
    MOBILE_ENGINE_VERSION,
    PINNED_SHELL_VERSION,
    parsePlatforms,
    RELEASE_DOWNLOAD_BASE,
    validateName,
    validateShellVersion,
    validateSteamAppId,
} from "./constants";
export {
    type BundleDesktopOptions,
    bundleDesktop,
    DEFAULT_NAME,
    type DesktopBundleResult,
    type DesktopStage,
    validateDesktopOptions,
} from "./desktop";
export {
    type DownloadProgress,
    defaultCacheDir,
    type EnsureShellAssetOptions,
    ensureShellAsset,
    type ShellAsset,
    shellCachePath,
} from "./download";
export { RovesError } from "./errors";
export { setExeIcon } from "./exe-icon";
export {
    checkIco,
    checkPng,
    generateIcns,
    generateIco,
    ICO_SIZES,
    type IconChoice,
    IconError,
    type IconSource,
    MAX_ICON_BYTES,
    MAX_ICON_PX,
    MIN_ICON_PX,
    type ProjectIcon,
    type ResolveIconOptions,
    resolveProjectIcon,
} from "./icon";
export {
    ANDROID_ORIENTATIONS,
    type AndroidOptions,
    androidBundleArgs,
    androidSigningEnv,
    buildAndroid,
    buildIos,
    engineCloneCommand,
    ensureEngineSource,
    type IosOptions,
    iosBundlePyArgs,
    iosReleaseArgs,
    iosSigningEnv,
    iosSimulatorBuildArgs,
    type MobileBundleResult,
    machBootstrapArgs,
    machCommand,
    validateAndroidOptions,
    validateIosOptions,
} from "./mobile";
export {
    type CommandProbe,
    type CommandRunner,
    type CommandSpec,
    formatCommand,
    mergeEnv,
    runCommand,
} from "./process";
export {
    ANDROID_BUILD_TOOLS,
    ANDROID_COMPILE_SDK,
    ANDROID_SDK_PACKAGES,
    defaultSdkLocation,
    detectAndroidToolchain,
    detectIosToolchain,
    JDK_MAJOR,
    missingSdkPackages,
    parseJavaHome,
    parseJavaMajor,
    ROVES_ACTION_NOTE,
    type Toolchain,
    type ToolchainOptions,
    type ToolStatus,
} from "./toolchains";
export { extractZip, ZipReader, ZipWriter, zipDirectory } from "./zip";
