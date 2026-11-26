/**
 * Entry point of the standalone executable (Node.js Single Executable Application, see
 * `scripts/build-sea.mjs`). A SEA runs one CommonJS script without top-level await, so this
 * wraps `runCli` instead of reusing `bin.ts`. Inside a SEA, `process.argv` is
 * `[executable, executable, ...arguments]`, the same shape commander expects from `node cli.mjs`.
 */
import { runCli } from "./cli";

runCli(process.argv).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(`roves: unexpected error: ${String(error)}\n`);
        process.exitCode = 1;
    },
);
