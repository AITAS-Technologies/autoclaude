/**
 * Getting a checkout ready for a stage or a review: the project's `bootstrap` command, run by
 * the engine with the normal environment and recorded in a marker so it runs once per
 * worktree. One helper, used by the stage runner and by `autoclaude review --pr`, so an
 * attended review sees the same installed checkout the unattended pipeline does.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../config/types.js";
import { runShell } from "../platform/shell.js";

export const BOOTSTRAP_MARKER = join(".autoclaude", "state", "bootstrapped");

const tail = (text: string, max = 600): string => {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
};

/** Runs `cfg.bootstrap` in `worktree` unless the marker is there. Returns the failure, or null. */
export async function bootstrapWorktree(
  cfg: Pick<ProjectConfig, "bootstrap" | "caps">,
  worktree: string,
  now: Date,
): Promise<string | null> {
  const marker = join(worktree, BOOTSTRAP_MARKER);
  if (!cfg.bootstrap || existsSync(marker)) return null;
  const b = await runShell(cfg.bootstrap, {
    cwd: worktree,
    timeoutMs: cfg.caps.wallClockMinutesPerStage * 60_000,
  });
  if (b.status !== 0 || b.timedOut)
    return `bootstrap ${b.timedOut ? "timed out" : `failed (exit ${b.status})`}: ${tail(`${b.stderr}\n${b.stdout}`)}`;
  mkdirSync(join(worktree, ".autoclaude", "state"), { recursive: true });
  writeFileSync(marker, `${now.toISOString()}\n`);
  return null;
}
