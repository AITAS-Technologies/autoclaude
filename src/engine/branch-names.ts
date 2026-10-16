/**
 * The names an issue's branch and worktree directory are built from, and the one check
 * that a stored branch name really is an issue's.
 *
 * A leaf module (it imports nothing of the engine's except the exec seam), so the ledger
 * and the worktree code can both read it without a cycle.
 */

import { realExec, type Exec } from "../forge/exec.js";
import type { ProjectConfig } from "../config/types.js";

/** `agent/` on the branch is `agent+` in the directory name. */
export function worktreeDirPrefix(cfg: Pick<ProjectConfig, "branchPrefix">): string {
  return cfg.branchPrefix.replace(/\//g, "+");
}

/** `agent/<issue>-`, the prefix every branch of an issue starts with; the one place it is spelled. */
export function branchPrefixFor(issue: number, cfg: Pick<ProjectConfig, "branchPrefix">): string {
  return `${cfg.branchPrefix}${issue}-`;
}

/**
 * Why `branch` is not a branch of this issue, in a clause a caller can put in a sentence,
 * or null when it is one.
 *
 * One rule, two callers, because one of them deletes what the other one stores: a
 * rollback pushes `--delete` on the branch its ledger row names, and `ledger set --branch`
 * is what writes that row from text the orchestrator composes. The two configured
 * branches are named separately from the prefix rule, because they are the names that
 * matter.
 *
 * Two equality checks and a prefix are not enough, because the row is not only deleted,
 * it is also pushed. A colon makes the name a *refspec*: a stored `agent/9-x:develop`
 * passes a prefix check and would send the worktree's branch to the remote's `develop`.
 * And git itself is asked last, because `git check-ref-format --branch` refuses a name a
 * prefix check accepts (a space, a `~`, a control character).
 *
 * `exec` is injectable for that one git call; `check-ref-format` needs no repository.
 */
export function notIssueBranch(
  branch: string,
  issue: number,
  cfg: Pick<ProjectConfig, "branchPrefix" | "branches" | "forge">,
  exec: Exec = realExec,
): string | null {
  if (branch === cfg.branches.integration)
    return `${branch} is this repository's integration branch`;
  if (branch === cfg.branches.production) return `${branch} is this repository's production branch`;
  const prefix = branchPrefixFor(issue, cfg);
  if (!branch.startsWith(prefix))
    return `a name outside ${prefix} is a mistyped or hand-edited row rather than a branch of issue ${issue}`;
  if (branch.includes(":")) {
    const destination = branch.slice(branch.indexOf(":") + 1);
    return `a colon makes ${branch} a refspec rather than a branch name, and a push of it would send this worktree's branch to ${destination || "the remote's default"} on ${cfg.forge.remote}`;
  }
  const checked = exec("git", ["check-ref-format", "--branch", branch]);
  // A process that never started is not a verdict on the name: a git missing from PATH
  // must not be reported as "git refuses this name", the one sentence that sends an
  // operator to edit a row that was fine. Fail-closed either way: an unchecked name is
  // not a name this may act on.
  if (checked.status === null) {
    return `git could not be run to check ${branch} as a branch name (${checked.stderr.trim() || "the process could not be started"}), and an unchecked name is not one to push or delete on`;
  }
  if (checked.status !== 0) {
    return `git refuses ${branch} as a branch name (git check-ref-format --branch says so), so it is a hand-edited row rather than a branch of issue ${issue}`;
  }
  return null;
}
