/**
 * The main working directory of a repository, from anywhere inside it.
 *
 * The ledger, the config, the control files and the agent worktrees belong to the main
 * working directory, the one place every process on this machine shares. A process may
 * run inside a worktree, so nothing trusts the working directory for those; git is asked,
 * and its common dir is the main directory's `.git` from every worktree.
 */

import { dirname, resolve } from "node:path";
import { runSync } from "../platform/spawn.js";

/** @param cwd where to ask from; explicit, never the process's working directory */
export function repoRoot(cwd: string): string {
  // No --path-format=absolute: some gits echo the flag back instead of honouring it. The
  // answer is ".git" in the main directory and an absolute path in a worktree, so it is
  // resolved against cwd either way.
  const r = runSync("git", ["rev-parse", "--git-common-dir"], { cwd });
  // A missing git or a removed cwd comes back as a null status with the spawn error in
  // stderr; either way this message is what is thrown.
  if (r.status !== 0) {
    throw new Error(`not inside a git repository (${cwd}): ${r.stderr.trim()}`);
  }
  return dirname(resolve(cwd, r.stdout.trim()));
}
