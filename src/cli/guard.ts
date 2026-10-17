import { resolve } from "node:path";
import { loadProjectConfig } from "../config/load.js";
import type { ProjectConfig } from "../config/types.js";
import type { GuardConfig } from "../engine/guard/core.js";
import { claudeHook } from "../engine/guard/hook-claude.js";
import { repoRoot } from "../engine/root.js";
import { flag } from "./args.js";
import type { Io } from "./main.js";

export interface GuardDeps {
  stdin: () => Promise<string>;
  root: (cwd: string) => string;
  load: (projectRoot: string) => ProjectConfig;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The limit of the hook's git call. The call is synchronous, so the hook entry's watchdog cannot
 * interrupt it; this limit is what does, well inside Claude Code's hook timeout, which reads a
 * hook that never answered as "allow".
 */
export const HOOK_GIT_TIMEOUT_MS = 15_000;

/** The main checkout of the worktree, asked of git within the hook's limit; a timeout throws. */
export const hookRoot = (cwd: string): string => repoRoot(cwd, { timeoutMs: HOOK_GIT_TIMEOUT_MS });

export const DEFAULT_DEPS: GuardDeps = {
  stdin: readStdin,
  root: hookRoot,
  load: loadProjectConfig,
};

/**
 * `autoclaude guard --runtime claude --worktree <path>`: the process Claude Code starts
 * before every Bash command. The pending call arrives on stdin; the exit code is the
 * verdict.
 *
 * A PreToolUse hook blocks on exit 2 and only on exit 2, so this returns 0 only when
 * `claudeHook` proved the command allowed. Every other outcome is 2 with a reason on
 * stderr: a missing or repeated flag, an unknown runtime, an unreadable stdin, a root or a
 * configuration that cannot be loaded, a git call that did not answer within 15 s. The configuration is read from the main checkout of
 * the worktree (ruling R28), never the worktree's own copy, so a stage cannot loosen the
 * fence it runs under.
 */
export async function guardVerb(
  args: string[],
  io: Io,
  deps: GuardDeps = DEFAULT_DEPS,
): Promise<number> {
  try {
    for (let i = 0; i < args.length; i += 2)
      if (args[i] !== "--runtime" && args[i] !== "--worktree")
        throw new Error(`unknown argument: ${args[i]}`);
    const runtime = flag(args, "--runtime");
    const worktree = flag(args, "--worktree");
    if (runtime === undefined || worktree === undefined)
      throw new Error("usage: autoclaude guard --runtime claude --worktree <path>");
    if (runtime === "codex") throw new Error("--runtime codex is not available before phase 3");
    if (runtime !== "claude") throw new Error(`unknown runtime: ${runtime}`);

    const wt = resolve(worktree);
    const cfg = deps.load(deps.root(wt));
    const guardCfg: GuardConfig = {
      forbiddenPaths: cfg.forbiddenPaths,
      fenceAllow: cfg.fence.allow,
      worktree: wt,
    };
    const verdict = claudeHook(await deps.stdin(), guardCfg);
    if (verdict.stderr !== "") io.err(verdict.stderr);
    return verdict.exit === 0 ? 0 : 2;
  } catch (e) {
    try {
      io.err(`autoclaude guard: ${e instanceof Error ? e.message : String(e)}\n`);
    } catch {
      // stderr itself is gone; the exit code still blocks.
    }
    return 2;
  }
}
