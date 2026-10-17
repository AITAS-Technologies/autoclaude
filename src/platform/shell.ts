import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  GIT_TIMEOUT_MS,
  nonInteractive,
  run,
  runSync,
  type RunOptions,
  type RunResult,
} from "./spawn.js";

/**
 * Path of the bash used for project commands. POSIX: `bash`. Windows: the bash of Git
 * for Windows, from `CLAUDE_CODE_GIT_BASH_PATH` or derived from `git --exec-path`.
 */
export function bashPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return "bash";
  const fromEnv = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (fromEnv) return fromEnv;
  // A local question, but an engine git call like any other (R70).
  const r = runSync("git", ["--exec-path"], { env: nonInteractive(), timeoutMs: GIT_TIMEOUT_MS });
  if (r.status === 0) {
    const candidate = resolve(r.stdout.trim(), "..", "..", "..", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Git Bash not found. Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH to bash.exe.",
  );
}

export function runShell(command: string, opts?: RunOptions): Promise<RunResult> {
  return run(bashPath(), ["-c", command], opts);
}

export function runShellSync(command: string, opts?: RunOptions): RunResult {
  return runSync(bashPath(), ["-c", command], opts);
}

/** POSIX single-quote quoting, safe for `{files}` substitution into a bash command. */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
