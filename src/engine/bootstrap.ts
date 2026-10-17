/**
 * Getting a checkout ready for a stage or a review: the project's `bootstrap` command, run by
 * the engine and recorded in a marker so it runs once per worktree. One helper, used by the
 * stage runner and by `autoclaude review --pr`, so an attended review sees the same installed
 * checkout the unattended pipeline does.
 *
 * Which environment it runs in is the caller's to say, never guessed here (R69). A bootstrap
 * executes what the checkout holds (an `npm ci` runs the lifecycle scripts of its
 * `package.json`), so a checkout a stage wrote into, or a pull request's head, gets the stage
 * environment: no forge credential. Only a fresh worktree of the integration branch as fetched
 * keeps the engine's own.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "../config/types.js";
import { runShell } from "../platform/shell.js";
import { stageEnv } from "../runtimes/stage-env.js";

export const BOOTSTRAP_MARKER = join(".autoclaude", "state", "bootstrapped");

const tail = (text: string, max = 600): string => {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
};

/**
 * Runs `cfg.bootstrap` in `worktree` unless the marker is there. Returns the failure, or null.
 *
 * @param opts.env `engine`: the worktree holds `<remote>/<integration>` exactly as the engine
 *   checked it out, and nothing has run in it; the engine's environment. `stage`: anything
 *   else; the stage environment, with a scratch directory of its own that is removed afterwards.
 */
export async function bootstrapWorktree(
  cfg: Pick<ProjectConfig, "bootstrap" | "caps">,
  worktree: string,
  now: Date,
  opts: { env: "engine" | "stage" },
): Promise<string | null> {
  const marker = join(worktree, BOOTSTRAP_MARKER);
  if (!cfg.bootstrap || existsSync(marker)) return null;
  const scratch =
    opts.env === "stage" ? mkdtempSync(join(tmpdir(), "autoclaude-bootstrap-")) : null;
  try {
    const b = await runShell(cfg.bootstrap, {
      cwd: worktree,
      timeoutMs: cfg.caps.wallClockMinutesPerStage * 60_000,
      ...(scratch !== null && { env: stageEnv(process.env, { scratchDir: scratch }) }),
    });
    if (b.status !== 0 || b.timedOut)
      return `bootstrap ${b.timedOut ? "timed out" : `failed (exit ${b.status})`}: ${tail(`${b.stderr}\n${b.stdout}`)}`;
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
  mkdirSync(join(worktree, ".autoclaude", "state"), { recursive: true });
  writeFileSync(marker, `${now.toISOString()}\n`);
  return null;
}
