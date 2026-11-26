import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        {
            // tsup loads src/*.txt as text (the shell version pin); do the same under Vitest.
            name: "text-loader",
            enforce: "pre",
            async load(id) {
                if (!id.endsWith(".txt")) return null;
                return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
            },
        },
    ],
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        testTimeout: 60_000,
    },
});
