import { spawn, spawnSync } from "node:child_process";
import { RovesError } from "./errors";

/** A command to run, with arguments passed as an array (never through a shell). */
export interface CommandSpec {
    command: string;
    args: string[];
    cwd?: string;
    /** Extra environment variables, merged over the current environment. */
    env?: Record<string, string>;
}

/** Runs commands; replaceable in tests. */
export type CommandRunner = (spec: CommandSpec) => Promise<void>;

/** Shows a command line for logs, quoting arguments that need it. */
export function formatCommand(spec: CommandSpec): string {
    return [spec.command, ...spec.args]
        .map((part) => (/^[\w@%+=:,./\\-]+$/.test(part) ? part : JSON.stringify(part)))
        .join(" ");
}

/**
 * `{...process.env, ...extra}`, matching keys case-insensitively on Windows (where `Path` and
 * `PATH` are the same variable), so an overridden PATH never ends up twice in the child.
 */
export function mergeEnv(
    extra: Record<string, string> | undefined,
    base: NodeJS.ProcessEnv = process.env,
    host: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...base };
    for (const [key, value] of Object.entries(extra ?? {})) {
        if (host === "win32") {
            for (const existing of Object.keys(out)) {
                if (existing.toUpperCase() === key.toUpperCase()) delete out[existing];
            }
        }
        out[key] = value;
    }
    return out;
}

/** Runs a command, its stdout and stderr shown on our stderr (stdout carries only results). */
export const runCommand: CommandRunner = (spec) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: mergeEnv(spec.env),
            stdio: ["inherit", 2, "inherit"],
        });
        child.on("error", (error) =>
            reject(new RovesError(`cannot run ${spec.command}: ${error.message}`)),
        );
        child.on("close", (code, signal) => {
            if (code === 0) resolvePromise();
            else
                reject(
                    new RovesError(
                        `${formatCommand(spec)} failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
                    ),
                );
        });
    });

/**
 * Runs `command args` quickly for detection; returns its combined output when it exits with
 * status 0, undefined otherwise (missing executable included).
 */
export type CommandProbe = (command: string, args: string[]) => string | undefined;

export const probeCommand: CommandProbe = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
    if (result.error || result.status !== 0) return undefined;
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};
