/**
 * Worktrees for agent work, named deterministically so the issue-to-worktree mapping
 * lives in the directory name and not only in the ledger.
 *
 * One worktree per issue, under `worktrees.root` (resolved against the project root when
 * relative). The branch `agent/<issue>-<slug>` becomes the directory `agent+<issue>-<slug>`,
 * so the prefix on disk is derived from the configured branch prefix, never hardcoded.
 *
 * The issue title is GitHub-controlled text. It only ever becomes a slug (lowercase ASCII
 * letters, digits and single hyphens) and argv elements; no command line here goes
 * through a shell.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectConfig } from "../config/types.js";
import { git, realExec, type Exec } from "../forge/github.js";
import { samePath, toPosix } from "../platform/paths.js";
import { branchPrefixFor, worktreeDirPrefix } from "./branch-names.js";
// `review/rules.ts` imports a leaf module and nothing else, so this closes no loop, which
// matters because `rules.ts` calls `escapeRegExp` at module scope.
import { escapeRegExp } from "./review/rules.js";

const MAX_SLUG = 40;

export function slugify(title: string): string {
  const s = title
    .replace(/[äÄ]/g, "ae")
    .replace(/[öÖ]/g, "oe")
    .replace(/[üÜ]/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    // Strip the combining marks NFKD split off (é -> e + U+0301); \p{M} keeps the source ASCII.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return s || "issue";
}

/** The branch and the absolute (forward-slash) worktree directory of an issue. */
export function namesFor(
  issue: number,
  title: string,
  cfg: ProjectConfig,
  root: string,
): { branch: string; worktree: string } {
  const slug = slugify(title);
  return {
    branch: `${branchPrefixFor(issue, cfg)}${slug}`,
    worktree: toPosix(
      join(resolve(root, cfg.worktrees.root), `${worktreeDirPrefix(cfg)}${issue}-${slug}`),
    ),
  };
}

export function parseWorktrees(porcelain: string): Array<{ path: string; branch: string | null }> {
  const out: Array<{ path: string; branch: string | null }> = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null;
    out.push({ path: path.trim(), branch });
  }
  return out;
}

export function listWorktrees(
  root: string,
  exec: Exec = realExec,
): Array<{ path: string; branch: string | null }> {
  return parseWorktrees(git(["worktree", "list", "--porcelain"], exec, root));
}

export function findWorktree(
  root: string,
  issue: number,
  cfg: ProjectConfig,
  exec: Exec = realExec,
): { path: string; branch: string | null } | null {
  const re = new RegExp(`[\\\\/]${escapeRegExp(worktreeDirPrefix(cfg))}(\\d+)-`);
  return listWorktrees(root, exec).find((w) => re.exec(w.path)?.[1] === String(issue)) ?? null;
}

export interface CreatedWorktree {
  branch: string;
  /** Absolute, forward slashes. */
  worktree: string;
  /** The `worktrees.copy` entries that were copied in, as configured. */
  copied: string[];
  /**
   * The `worktrees.copy` entries that were skipped, not an error: not in the project root, or
   * a symbolic link (never followed), each with its reason.
   */
  missing: NotCopied[];
  /** Things the caller should log: a fallback that was taken, a remote tip that moved. */
  notes: string[];
  /**
   * The worktree starts at `<remote>/<integration>`, not at a pushed agent branch: what it holds
   * was fetched, not written by a stage. The caller records it for the bootstrap (R69).
   */
  fromIntegration: boolean;
}

/**
 * @param opts.replace discard an existing worktree or a branch left without one
 * @param opts.pushedSha the head the ledger recorded as pushed for this issue; when set and
 *   `<remote>/<branch>` exists, the worktree is created on that remote branch rather than
 *   on the integration branch, so the already pushed commits are in it and the publish
 *   lease check against the remote head still holds
 * @param opts.root the project root (explicit: nothing here depends on the working directory)
 */
export function createWorktree(
  issue: number,
  title: string,
  opts: { replace: boolean; pushedSha?: string; root: string },
  cfg: ProjectConfig,
  exec: Exec = realExec,
): CreatedWorktree {
  const root = opts.root;
  const remote = cfg.forge.remote;
  const existing = findWorktree(root, issue, cfg, exec);
  if (existing) {
    if (!opts.replace)
      throw new Error(
        `issue ${issue} already has a worktree at ${existing.path}; run autoclaude rollback ${issue} to discard it`,
      );
    removeWorktree(root, issue, cfg, { deleteRemote: false }, exec);
  }
  const names = namesFor(issue, title, cfg, root);
  git(["fetch", remote, cfg.branches.integration, "--quiet"], exec, root);
  // A branch left behind without its worktree (a failed `branch -D`, a detached checkout)
  // would make `worktree add -b` die on "already exists"; with replace it is discarded
  // like the worktree would have been, without it the error names the way out.
  if (git(["branch", "--list", names.branch], exec, root).trim()) {
    if (!opts.replace)
      throw new Error(
        `branch ${names.branch} already exists without a worktree; run autoclaude rollback ${issue} to discard it`,
      );
    git(["branch", "-D", names.branch], exec, root);
  }

  const notes: string[] = [];
  let base = `${remote}/${cfg.branches.integration}`;
  if (opts.pushedSha) {
    const tracked = fetchPushedBranch(root, names.branch, remote, exec);
    if (tracked) {
      base = `${remote}/${names.branch}`;
      const tip = git(["rev-parse", base], exec, root).trim();
      if (tip !== opts.pushedSha)
        notes.push(
          `${base} is at ${tip}, not at the recorded ${opts.pushedSha}; the worktree starts at the remote head`,
        );
    } else {
      notes.push(
        `${names.branch} is not on ${remote} although ${opts.pushedSha} was recorded as pushed; the worktree starts at ${base}`,
      );
    }
  }
  // Before the worktree exists, so a failure here leaves nothing behind, and so nothing the
  // engine is about to place in it can ever show up as untracked there.
  ensureEngineExcludes(root, cfg, exec);
  git(["worktree", "add", names.worktree, "-b", names.branch, base], exec, root);

  let copy: ReturnType<typeof copyIntoWorktree>;
  try {
    copy = copyIntoWorktree(root, names.worktree, cfg);
  } catch (error) {
    // A failed copy is a failed creation, the way a failed `worktree add` is: undone, so the
    // next attempt does not meet a worktree and a branch that no ledger entry names.
    const undone = [
      exec("git", ["worktree", "remove", "--force", names.worktree], { cwd: root }),
      exec("git", ["branch", "-D", names.branch], { cwd: root }),
    ]
      .filter((r) => r.status !== 0)
      .map((r) => r.stderr.trim());
    const left = undone.length > 0 ? `; undoing it failed too: ${undone.join("; ")}` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${left}`);
  }
  mkdirSync(join(names.worktree, ".autoclaude", "state", "reports"), { recursive: true });
  return {
    branch: names.branch,
    worktree: names.worktree,
    ...copy,
    notes,
    fromIntegration: base === `${remote}/${cfg.branches.integration}`,
  };
}

/**
 * Fetch one branch into its remote-tracking ref, so the `worktree add` that follows sees
 * the remote's current head. True when the remote has it. A remote that answers "no such
 * ref" is a state to fall back from; any other failure (unreachable remote) is thrown,
 * because falling back then would quietly recreate the very state this exists to avoid.
 */
function fetchPushedBranch(root: string, branch: string, remote: string, exec: Exec): boolean {
  const r = exec(
    "git",
    ["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd: root },
  );
  if (r.status === 0) return true;
  if (/couldn't find remote ref/i.test(r.stderr)) return false;
  throw new Error(`git fetch ${remote} ${branch} failed (exit ${r.status}): ${r.stderr.trim()}`);
}

/**
 * Every local branch of this issue: `git branch --list "<prefix>*"`, that namespace and
 * nothing else, split into the ones a deletion may touch and the ones git has checked out.
 *
 * A marked line is left out, not stripped. The listing marks the checked-out branch with
 * `* ` and one checked out in another worktree with `+ `, and `git branch -D` refuses both
 * with "Cannot delete branch checked out at", through the throwing `git()`, which in a
 * rollback lands after the release and in a replacing create kills the create. Left alone
 * and said out loud, because a branch silently kept is what the next `createWorktree` for
 * the issue dies on.
 *
 * The marked names are returned as well as reported, because the caller has a second
 * deletion to keep them out of: a branch kept locally has to keep its copy on the remote
 * too, or the skip trades a throw for a branch with nothing behind it.
 *
 * Colour and columns are turned off for the parsing's sake. `color.branch` and
 * `column.branch` are the operator's own git config, and this listing is read by hand: a
 * decorated line wraps escape sequences around the name, in front of the marker, so the
 * skip above stops seeing it, and a columnised one puts several names on one line.
 *
 * The prefix is then asked about again: a pattern git widened, or a marker it adds
 * tomorrow, must not put a foreign name in front of `branch -D`.
 */
function localIssueBranches(
  root: string,
  issue: number,
  cfg: ProjectConfig,
  exec: Exec = realExec,
): { deletable: string[]; checkedOut: string[] } {
  const prefix = branchPrefixFor(issue, cfg);
  const deletable: string[] = [];
  const checkedOut: string[] = [];
  for (const line of git(
    ["branch", "--no-color", "--no-column", "--list", `${prefix}*`],
    exec,
    root,
  ).split(/\r?\n/)) {
    const marked = /^\s*([*+])\s+(\S.*)$/.exec(line);
    const name = (marked ? (marked[2] ?? line) : line).trim();
    if (!name.startsWith(prefix)) continue;
    if (marked) {
      console.error(
        `issue ${issue}: leaving ${name} alone — git marks it "${marked[1]}", so it is checked out in a worktree and git branch -D would refuse it. Remove that worktree, then delete the branch.`,
      );
      checkedOut.push(name);
      continue;
    }
    deletable.push(name);
  }
  return { deletable, checkedOut };
}

/**
 * The same namespace on the remote: `git ls-remote --heads <remote> "<prefix>*"`.
 *
 * Asked instead of inferred from the local branches, because the two can disagree in the
 * one direction that matters. The remote delete runs after the local one, and a push that
 * fails on something the tolerance below does not cover throws with `branch -D` already
 * done, so a re-run would iterate a local namespace that is now empty, exit 0, and leave
 * the branch on the remote, where the next attempt meets the publish lease refusal. A
 * human who removed the directory and the branch by hand is in the same position.
 *
 * The lines are `<sha>\trefs/heads/<branch>`; the ref prefix is stripped and the
 * namespace asked about again, the way `localIssueBranches` re-filters. Through the
 * throwing `git()`, deliberately: an unreachable remote has to fail loudly here, because a
 * silent empty listing is exactly the missed deletion this exists for.
 */
export function remoteIssueBranches(
  root: string,
  issue: number,
  cfg: ProjectConfig,
  exec: Exec = realExec,
): string[] {
  const prefix = branchPrefixFor(issue, cfg);
  return git(["ls-remote", "--heads", cfg.forge.remote, `${prefix}*`], exec, root)
    .split(/\r?\n/)
    .map((l) => l.split(/\s+/)[1] ?? "")
    .map((ref) => ref.replace(/^refs\/heads\//, "").trim())
    .filter((b) => b.startsWith(prefix));
}

export function removeWorktree(
  root: string,
  issue: number,
  cfg: ProjectConfig,
  opts: { deleteRemote: boolean },
  exec: Exec = realExec,
): void {
  const remote = cfg.forge.remote;
  // A registration whose directory was deleted by hand makes `worktree remove` fail;
  // pruning first turns that case into "nothing to remove".
  git(["worktree", "prune"], exec, root);
  const wt = findWorktree(root, issue, cfg, exec);
  // The issue's own prefix, not the configured one. `findWorktree` matches on the
  // directory name, so a directory `agent+9-foo` switched by hand to `agent/91-bar` would
  // pass `startsWith("agent/")` and be removed by issue 9's teardown, branch and all.
  const prefix = branchPrefixFor(issue, cfg);
  if (wt?.branch && !wt.branch.startsWith(prefix)) {
    throw new Error(
      `refusing to remove ${wt.path}: its branch ${wt.branch} is not under ${prefix}, so the directory name and the branch disagree about which issue this is`,
    );
  }
  if (wt) git(["worktree", "remove", "--force", wt.path], exec, root);
  // The branches, whether or not a registration was there to name them. A teardown that
  // returned as soon as its own prune had dropped a stale registration never ran
  // `branch -D` or the remote delete, and a branch left on the remote is not cosmetic:
  // the next attempt pushes the same name and the publish lease refuses a remote head the
  // new worktree never had.
  //
  // The names come from the issue rather than from the caller: every branch of an issue
  // starts with `branchPrefixFor(issue, cfg)`, and that is the only namespace this deletes
  // in. The registration's own branch is taken as well, because a directory name and a
  // branch name can disagree, and it is the branch the removal above just freed.
  //
  // Both sides are asked, not one derived from the other, and each deletes only what it
  // found: `git branch -D` on a name that is not there fails outright.
  //
  // Local first, and the remote listing only afterwards: with the remote unreachable the
  // local half still finishes, so a retry has only the remote side left to do.
  //
  // The registration's own branch is subject to the same skip as the listed ones: when a
  // removal git reported as done left the checkout alive, an unconditional `branch -D` on
  // it is the throw the skip exists to avoid.
  const listed = localIssueBranches(root, issue, cfg, exec);
  const kept = new Set(listed.checkedOut);
  const local = new Set([
    ...(wt?.branch && !kept.has(wt.branch) ? [wt.branch] : []),
    ...listed.deletable,
  ]);
  for (const branch of local) git(["branch", "-D", branch], exec, root);
  if (!opts.deleteRemote) return;
  // Still a throw, deliberately; what the message adds is which half is done.
  let remoteBranches: string[];
  try {
    remoteBranches = remoteIssueBranches(root, issue, cfg, exec);
  } catch (error) {
    throw new Error(
      `issue ${issue}: the local branches are deleted (${[...local].join(", ") || "none"}) and ${remote} could not be asked about ${prefix}* — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const branch of remoteBranches) {
    // The other half of the local skip: a branch left alone because git has it checked out
    // somewhere keeps its copy on the remote as well. Deleting only the remote half is the
    // state the publish lease refuses.
    if (kept.has(branch)) {
      console.error(
        `issue ${issue}: leaving ${branch} on ${remote} as well, because the local copy is checked out in a worktree and was kept. Remove that worktree, then run autoclaude rollback ${issue} again.`,
      );
      continue;
    }
    const r = exec("git", ["push", remote, "--delete", branch], { cwd: root });
    // A remote that turns out not to have the branch is the state this wants, not a
    // failure to report: the listing above and this push are two round trips.
    if (r.status !== 0 && !/remote ref does not exist|unable to delete/.test(r.stderr)) {
      throw new Error(`git push ${remote} --delete ${branch}: ${r.stderr.trim()}`);
    }
  }
}

/**
 * `create <issue> [--replace] -- <title words>`: the options stop at `--` and the title
 * is everything after it, verbatim. The title is GitHub-controlled text; read from the
 * same word list as the options, a title containing "--replace" armed the removal of
 * an earlier attempt's worktree and branch.
 */
export function parseCreateArgs(rest: string[]): { title: string; replace: boolean } {
  const sep = rest.indexOf("--");
  if (sep < 0)
    throw new Error('create <issue> [--replace] -- <title words>: the title follows "--"');
  const options = rest.slice(0, sep);
  const unknown = options.find((o) => o !== "--replace");
  if (unknown) throw new Error(`create: unknown option ${unknown}`);
  const title = rest
    .slice(sep + 1)
    .join(" ")
    .trim();
  if (!title) throw new Error("create: the title after -- is empty");
  return { title, replace: options.includes("--replace") };
}

/**
 * Why the engine must not run its fetch, rebase or push in `worktree`, or null when it may (R73).
 *
 * In a linked worktree `.git` is a file naming the git directory. A stage that rewrote it would
 * point the engine's credentialed git calls, and the hooks and config those read, at a
 * directory of the stage's choosing. So the common directory git resolves from the worktree
 * has to be the project's own, compared as normalised paths. Every such call site asks here
 * first; a reason is a refusal, and the entry goes the way of any failed step.
 */
export function foreignGitDir(
  root: string,
  worktree: string,
  exec: Exec = realExec,
): string | null {
  const commonDir = (cwd: string): string | null => {
    const r = exec("git", ["rev-parse", "--git-common-dir"], { cwd });
    const named = r.stdout.trim();
    return r.status === 0 && named ? resolve(cwd, named) : null;
  };
  const ours = commonDir(root);
  if (ours === null) return `git cannot say which git directory ${root} uses`;
  const theirs = commonDir(worktree);
  if (theirs === null) return `git cannot say which git directory the worktree ${worktree} uses`;
  if (!samePath(ours, theirs))
    return `the worktree ${worktree} uses the git directory ${theirs}, not this project's ${ours} (its .git was changed); the engine will not fetch, rebase or push there`;
  return null;
}

export const EXCLUDE_BEGIN = "# autoclaude: engine-owned paths (begin)";
export const EXCLUDE_END = "# autoclaude: engine-owned paths (end)";

/**
 * A `worktrees.copy` entry as a gitignore pattern for that path and nothing else: anchored with
 * a leading `/` (which also keeps a leading `!` or `#` literal), glob characters and trailing
 * spaces escaped. Null for an entry outside the project root, which is never copied either.
 */
function excludePattern(root: string, entry: string): string | null {
  const rel = relative(root, resolve(root, entry));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const escaped = toPosix(rel)
    .replace(/[*?[\]\\]/g, "\\$&")
    .replace(/ +$/, (s) => s.replaceAll(" ", "\\ "));
  return `/${escaped}`;
}

/**
 * The block of engine-owned paths in the repository's shared exclude file: `.autoclaude/state/`
 * and every `worktrees.copy` entry, between the two marker lines (R72).
 *
 * A worktree starts at `<remote>/<integration>`, so the ignore rules it reads are that branch's
 * `.gitignore`, which on a first run may not list `.autoclaude/state/` yet, and never has to
 * list a copied secret. The guard allows `git add -A`, so whatever the engine puts in a
 * worktree would be committed and pushed. The exclude file is git's own per-repository list,
 * read by the main checkout and every linked worktree alike (`git rev-parse --git-path
 * info/exclude` names the common directory's), and committed nowhere.
 *
 * Idempotent: the block is rewritten only when its entries changed, and nothing outside the
 * two markers is touched. Returns the file.
 */
export function ensureEngineExcludes(
  root: string,
  cfg: Pick<ProjectConfig, "worktrees">,
  exec: Exec = realExec,
): string {
  const named = git(["rev-parse", "--git-path", "info/exclude"], exec, root).trim();
  if (!named) throw new Error("git rev-parse --git-path info/exclude named no file");
  const file = resolve(root, named);
  const patterns = cfg.worktrees.copy
    .map((entry) => excludePattern(root, entry))
    .filter((p): p is string => p !== null);
  const block = [EXCLUDE_BEGIN, "/.autoclaude/state/", ...new Set(patterns), EXCLUDE_END];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
  // The block is the first end marker and the begin marker nearest above it: a begin a human
  // left without its end is a line outside the block, and stays.
  const end = lines.indexOf(EXCLUDE_END);
  const begin = end < 0 ? -1 : lines.lastIndexOf(EXCLUDE_BEGIN, end);
  const next =
    begin < 0
      ? [...lines, ...block]
      : [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
  const out = `${next.join(eol)}${eol}`;
  if (out !== text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out);
  }
  return file;
}

/** A `worktrees.copy` entry, or a link inside one, that was not copied, and why. */
export interface NotCopied {
  entry: string;
  reason: string;
}

/**
 * Copies `worktrees.copy` from the project root into a worktree; returns what was and was not
 * copied.
 *
 * A walk of its own (`lstat`, `readdir`, `mkdir`, `copyFile`), not `cpSync`: on Windows with
 * Node 24, `cpSync` of a directory kills the process (0xC0000409, no `finally` runs) when the
 * source path holds a non-ASCII character, and copies nothing without an error when only the
 * destination does. A symbolic link is never followed: a link to a file outside the project
 * would carry that file in. It is skipped and reported, like an entry that is not there.
 *
 * @throws when a copy fails, or an entry is not at the destination afterwards: a worktree
 *   without its configured files is not one a stage may run in
 */
export function copyIntoWorktree(
  root: string,
  worktree: string,
  cfg: Pick<ProjectConfig, "worktrees">,
): { copied: string[]; missing: NotCopied[] } {
  const copied: string[] = [];
  const missing: NotCopied[] = [];
  for (const entry of cfg.worktrees.copy) {
    const from = resolve(root, entry);
    const rel = relative(root, from);
    // Inside the project root only: a configured `../x` or an absolute path is not a file
    // of this project, so it is reported as not copied rather than followed.
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      missing.push({ entry, reason: "it is not inside the project root" });
      continue;
    }
    if (!existsSync(from) && !isLink(from)) {
      missing.push({ entry, reason: "the project root has no such file" });
      continue;
    }
    const to = join(worktree, rel);
    try {
      mkdirSync(dirname(to), { recursive: true });
      if (!copyTree(from, to, root, entry, missing)) continue;
    } catch (error) {
      throw new Error(
        `worktrees.copy: copying ${entry} into ${worktree} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Asked of the destination, not assumed from the copy: the failure this replaced was a
    // copy that reported success and left nothing behind.
    if (!existsSync(to) || lstatSync(to).isDirectory() !== lstatSync(from).isDirectory())
      throw new Error(`worktrees.copy: ${entry} is not at ${to} after copying`);
    copied.push(entry);
  }
  return { copied, missing };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Copies one file or directory tree; false when `from` itself was skipped (and reported). */
function copyTree(
  from: string,
  to: string,
  root: string,
  entry: string,
  missing: NotCopied[],
): boolean {
  const st = lstatSync(from);
  const shown = toPosix(relative(root, from));
  if (st.isSymbolicLink()) {
    missing.push({ entry, reason: `${shown} is a symbolic link, and links are not followed` });
    return false;
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from))
      copyTree(join(from, name), join(to, name), root, entry, missing);
    return true;
  }
  if (st.isFile()) {
    copyFileSync(from, to);
    return true;
  }
  missing.push({ entry, reason: `${shown} is neither a file nor a directory` });
  return false;
}
