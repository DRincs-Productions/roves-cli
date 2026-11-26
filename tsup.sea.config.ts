import { defineConfig } from "tsup";

/**
 * One self-contained CommonJS script for the Node.js Single Executable Application: a SEA can
 * only run a single CommonJS file with built-in modules, so every dependency is inlined.
 */
export default defineConfig({
    entry: { roves: "src/sea.ts" },
    outDir: "dist-sea",
    format: ["cjs"],
    platform: "node",
    target: "node22",
    bundle: true,
    noExternal: [/.*/],
    splitting: false,
    treeshake: true,
    minify: false,
    sourcemap: false,
    dts: false,
    clean: true,
    loader: { ".txt": "text" },
    esbuildPlugins: [
        {
            // `debug` (a transitive dependency) optionally requires supports-color inside a
            // try/catch; in a SEA that require() of a non-built-in module prints a warning, so it
            // is bundled as an empty module instead.
            name: "empty-optional-modules",
            setup(build) {
                build.onResolve({ filter: /^supports-color$/ }, () => ({
                    path: "supports-color",
                    namespace: "empty-module",
                }));
                build.onLoad({ filter: /.*/, namespace: "empty-module" }, () => ({
                    contents: "module.exports = {};",
                    loader: "js",
                }));
            },
        },
    ],
    outExtension() {
        return { js: ".cjs" };
    },
});
