/**
 * What every verb shares: where its inputs come from (the project root, the configuration,
 * the process runner, the forge, the clock) as one seam a test can replace, and the one
 * way a verb refuses its arguments.
 */
import { loadProjectConfig } from "../config/load.js";
import type { ProjectConfig } from "../config/types.js";
import { repoRoot } from "../engine/root.js";
import { Forge, realExec, resolveRepo, type Exec } from "../forge/github.js";
import { bashPath } from "../platform/shell.js";
import type { Io } from "./main.js";

export interface Env {
  /** The main working directory of the project that contains `cwd`. */
  root(cwd: string): string;
  config(root: string): ProjectConfig;
  /** Runs `git`, `gh` and the vendor CLIs, with the normal environment. */
  exec: Exec;
  /** The forge for a project: every call carries `-R <owner>/<repo>` from `forge.remote`. */
  forge(cfg: ProjectConfig, root: string): Forge;
  now(): Date;
  /** The process environment, for the checks that read it. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Path of the bash project commands run through; throws when there is none. */
  bash(): string;
}

export const realEnv: Env = {
  root: repoRoot,
  config: loadProjectConfig,
  exec: realExec,
  forge: (cfg, root) => new Forge(resolveRepo(cfg.forge.remote, root, realExec), realExec),
  now: () => new Date(),
  env: process.env,
  platform: process.platform,
  bash: () => bashPath(),
};

/** The usage error every verb answers a wrong command line with: the message, the usage, exit 64. */
export function usageError(io: Io, usage: string, message?: string): 64 {
  io.err(`${message === undefined ? "" : `${message}\n`}${usage}\n`);
  return 64;
}

/**
 * Whether an error thrown by a shared argument parser (`flag`, `issueArg`, `prArg`, the
 * ledger's enum checks) is the caller's mistake in the command line rather than a failure
 * of the work. Those parsers throw plain errors; their messages are the contract.
 */
export function isArgumentError(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error);
  return /was given more than once|needs a value|is not an? (issue|pull request) number|is not a process id|must be one of|^Usage|usage:|expected fix, retry|^archive: |unknown option|unknown argument/.test(
    m,
  );
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
