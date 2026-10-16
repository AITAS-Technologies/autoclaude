import { existsSync } from "node:fs";
import { join } from "node:path";
import { realExec, type Exec } from "../forge/exec.js";

/**
 * The files this branch changed against `base`, for the gates: the working tree against
 * the merge base (so uncommitted work counts, which a `base...HEAD` diff would miss on a
 * worktree full of work not yet committed), plus untracked files, deduplicated, repo-
 * relative with forward slashes, and still present on disk. No extension filter: which
 * files matter is each gate's `when`, not this function's.
 *
 * Fails loudly when git cannot answer: an empty list from a failed call would be a green
 * gate that checked nothing.
 */
export function changedFiles(worktree: string, base: string, exec: Exec = realExec): string[] {
  // core.quotePath=false: otherwise git prints non-ASCII names quoted and octal-escaped,
  // and the file would be dropped in silence.
  const git = (args: string[]): string => {
    const r = exec("git", ["-c", "core.quotePath=false", ...args], { cwd: worktree });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
    }
    return r.stdout;
  };
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const changed = git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...changed, ...untracked]) {
    const file = raw.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(join(worktree, file))) continue;
    out.push(file);
  }
  return out;
}
