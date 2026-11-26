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

/** Runs a command with inherited stdio; fails on a non-zero exit or a missing executable. */
export const runCommand: CommandRunner = (spec) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn(spec.command, spec.args, {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env },
            stdio: "inherit",
        });
        child.on("error", (error) =>
            reject(new RovesError(`cannot run ${spec.command}: ${error.message}`)),
        );
        child.on("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else
                reject(
                    new RovesError(
                        `${formatCommand(spec)} failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
                    ),
                );
        });
    });

/** Whether `command args` starts and exits with status 0 (used for prerequisite checks). */
export type CommandProbe = (command: string, args: string[]) => boolean;

export const probeCommand: CommandProbe = (command, args) => {
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 60_000 });
    return !result.error && result.status === 0;
};
