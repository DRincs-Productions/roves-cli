import { defineConfig } from "tsup";

export default defineConfig([
    {
        // Node >= 20.19 loads ES modules from both `import` and `require()`, so one ESM build
        // serves the library and the CLI. `src/bin.ts` starts with a shebang, which tsup keeps
        // (and marks the output executable).
        target: "node20",
        platform: "node",
        entry: {
            index: "src/index.ts",
            cli: "src/bin.ts",
        },
        format: ["esm"],
        dts: { entry: { index: "src/index.ts" } },
        treeshake: true,
        clean: true,
        bundle: true,
        splitting: true,
        loader: { ".txt": "text" },
        outExtension() {
            return { js: ".mjs" };
        },
    },
]);
