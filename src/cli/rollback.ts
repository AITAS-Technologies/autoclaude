/**
 * Roll one agent run back by hand, in the order that cannot leave a claim standing.
 *
 *   autoclaude rollback <issue> [--to <blocked|needs-shaping|ready|done|none> --reason "<text>"]
 *       [--keep-branch-as <name>]
 *   exit 0  rolled back; the JSON on stdout says what was done
 *   exit 1  a gate refused it and nothing ran, the release itself failed part-way, or a step
 *           after the release failed: stderr says which and prints what is left
 *   exit 64 the command line was wrong: nothing ran
 *
 * A run once rolled back by hand (worktree removed, branch deleted, ledger edited) kept a
 * standing claim comment, because the release is the only step that leaves nothing on disk to
 * notice. So the release goes first here, before anything destructive, and a failure after it
 * prints the remaining steps as commands a human can run.
 *
 * Clearing leftovers (design: the engine refuses to claim an issue with a leftover worktree or
 * remote branch and names this verb): the verb works without a ledger entry, and without
 * `--to`, in which case it only clears the issue's worktree and branches and posts nothing.
 * It is idempotent. The issue's remote branch is deleted only when no open pull request uses
 * it; with one open, the worktree and local branch go, the remote branch stays, and the
 * result says so. Closing a pull request stays a human's verb.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { flag, issueArg } from "./args.js";
import { branchPrefixFor, notIssueBranch } from "../engine/branch-names.js";
import { RELEASE_TARGETS, releaseIssue, type ReleaseTarget } from "../engine/claims.js";
import type { ProjectConfig } from "../config/types.js";
import { controlState } from "../engine/control.js";
import {
  appendNote,
  appendNoteBestEffort,
  foldNote,
  loadLedger,
  machineId,
  runDir,
  transition,
  transitionText,
  updateLedger,
  type IssueState,
} from "../engine/ledger/ledger.js";
import { STATE_DIR } from "../engine/ledger/lock.js";
import { findWorktree, removeWorktree } from "../engine/worktree.js";
import { git, type Exec, type Forge } from "../forge/github.js";
import { liveInstance } from "../orchestrator/instance.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

export interface RollbackOpts {
  /** Where the issue goes; null only clears worktree and branches (and needs no ledger entry). */
  to: ReleaseTarget | null;
  reason: string;
  /** A name outside the agent prefix to keep the branch under, or nothing to let it go. */
  keepBranchAs?: string | null;
}

export interface RollbackDeps {
  exec: Exec;
  /** The main working directory, whose `.autoclaude/state/` holds the ledger and the runs. */
  root: string;
  cfg: ProjectConfig;
  forge: Forge;
  machine: string;
  now?: Date;
  /** Where this process stands, for the gate that refuses to remove the ground underneath. */
  cwd?: string;
}

export interface RollbackDone {
  kind: "done";
  code: 0;
  issue: number;
  to: ReleaseTarget | null;
  released: boolean;
  keptBranchAs: string | null;
  /** A worktree was registered before and none is after. */
  worktreeRemoved: boolean;
  /**
   * The remote no longer has the branch; `null` when nothing can be said (the verification
   * call failed, the row named no branch, or the remote branch was deliberately kept).
   */
  remoteDeleted: boolean | null;
  /** The branch the question above was asked about, or `null` when the row named none. */
  remoteBranch: string | null;
  /** Why the remote branch was left alone, when it was: an open pull request uses it. */
  remoteKept: string | null;
  ledgerState: IssueState | null;
  /** Where the run archive went, or null when there was no ledger entry. */
  runsMovedTo: string | null;
}

export type RollbackResult =
  | RollbackDone
  /** A gate said no. Nothing ran, so there is nothing to finish by hand. */
  | { kind: "refused"; code: 1; issue: number; refused: string }
  /** The release itself threw: nothing destructive ran, and `remaining` finishes the release. */
  | {
      kind: "release-failed";
      code: 1;
      issue: number;
      released: false;
      failure: string;
      remaining: string[];
    }
  /** The release is posted (or none was asked for) and a later step failed; `remaining` is what is left. */
  | {
      kind: "incomplete";
      code: 1;
      issue: number;
      released: boolean;
      failure: string;
      remaining: string[];
    };

/** What the CLI prints: the result's fields and nothing else (`kind` and `code` are the exit code's business). */
export function doneAsJson(result: RollbackDone): Record<string, unknown> {
  return {
    issue: result.issue,
    to: result.to,
    released: result.released,
    keptBranchAs: result.keptBranchAs,
    worktreeRemoved: result.worktreeRemoved,
    // A word rather than `null`, which reads on a terminal as a field the command forgot to
    // fill in; the two nulls are different words and the reason is printed with each.
    remoteDeleted:
      result.remoteDeleted ??
      (result.remoteKept !== null
        ? `kept: ${result.remoteKept}`
        : result.remoteBranch === null
          ? "not applicable: the row named no branch, and the issue's remote namespace was deleted anyway"
          : "unknown"),
    ledgerState: result.ledgerState,
    runsMovedTo: result.runsMovedTo,
  };
}

function runsOldDir(root: string): string {
  return join(root, STATE_DIR, "runs-old");
}

/**
 * Where the ledger entry lands. `blocked` and `needs-shaping` keep their meaning; `ready`,
 * `done` and `none` all say this run is over, and `done` is that word.
 */
export function ledgerStateFor(to: ReleaseTarget): IssueState {
  return to === "blocked" || to === "needs-shaping" ? to : "done";
}

/** The one line the events log and the ledger event both carry, folded once. */
export function rollbackNote(
  to: ReleaseTarget | null,
  keptBranchAs: string | null,
  reason: string,
): string {
  return foldNote(`rollback to=${to ?? "-"} keep=${keptBranchAs ?? "-"} reason=${reason}`);
}

/**
 * `runs-old/<issue>-<date>`, and `-2`, `-3` … when that directory is already there: a second
 * rollback of the same issue on the same day must not overwrite the first one's archive.
 */
export function runsDestination(root: string, issue: number, now: Date): string {
  const base = join(runsOldDir(root), `${issue}-${now.toISOString().slice(0, 10)}`);
  if (!existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * A value inside a printed command line, single-quoted the way **bash** quotes one. These
 * lines exist to be copied into a shell, and the operator's own reason must survive the trip
 * unchanged; the escape is bash's `'\''`, and the printed block says it is bash.
 */
function quoted(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The sentence a refusal adds when its remedy is a line to paste. */
const BASH_NOTE = "The commands in this message are quoted for bash.";

/** Whether `cwd` is the given directory or sits inside it, segment-wise and case-folded on Windows. */
function inside(cwd: string, directory: string): boolean {
  const fold = (p: string): string =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  const a = fold(cwd);
  const b = fold(directory);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** A ref name as the ref store compares it: folded on win32, untouched elsewhere. */
function foldRef(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

function underPrefix(name: string, prefix: string): boolean {
  return foldRef(name).startsWith(foldRef(prefix));
}

function protectedBranchRole(
  name: string,
  cfg: ProjectConfig,
): "integration" | "production" | null {
  if (foldRef(name) === foldRef(cfg.branches.integration)) return "integration";
  if (foldRef(name) === foldRef(cfg.branches.production)) return "production";
  return null;
}

/** The local branch of this name as the ref store spells it, or null when there is none. */
function existingBranch(name: string, exec: Exec, root: string): string | null {
  return (
    git(["branch", "--no-color", "--format=%(refname:short)"], exec, root)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((b) => b !== "" && foldRef(b) === foldRef(name)) ?? null
  );
}

/** One step after the release: what it does, and the command a human would run instead. */
interface Step {
  /** Resolved when it is printed or run, never before. */
  command: () => string;
  run: () => void;
}

/** The whole rollback as a function over injected deps, so the order is under test without `gh` or the network. */
export function rollback(issue: number, opts: RollbackOpts, deps: RollbackDeps): RollbackResult {
  const { exec, root, cfg, machine, forge } = deps;
  const now = deps.now ?? new Date();
  const cwd = deps.cwd ?? process.cwd();
  const keptBranchAs = opts.keepBranchAs ?? null;
  const reason = foldNote(opts.reason);
  const refuse = (refused: string): RollbackResult => ({
    kind: "refused",
    code: 1,
    issue,
    refused,
  });
  const refuseWithCommand = (refused: string): RollbackResult => refuse(`${refused} ${BASH_NOTE}`);
  const refuseCwd = (path: string): RollbackResult =>
    refuse(
      `this is running inside ${path}, the worktree it would remove — a process cannot remove its own directory, and the failure would land after the release; run it from the main working directory`,
    );
  const releaseCommand = (to: ReleaseTarget) =>
    `autoclaude release ${issue} --to ${to} --reason ${quoted(reason)}`;

  // --- 1. The gates. A refusal here runs nothing at all.
  if (keptBranchAs !== null && underPrefix(keptBranchAs, cfg.branchPrefix)) {
    return refuse(
      `--keep-branch-as ${keptBranchAs} is under ${cfg.branchPrefix}: a copy kept there is read as an agent branch again by the worktree teardown, by reconcile and by the claim protocol; choose a name outside that prefix`,
    );
  }
  const role = keptBranchAs === null ? null : protectedBranchRole(keptBranchAs, cfg);
  if (keptBranchAs !== null && role !== null) {
    return refuse(
      `--keep-branch-as ${keptBranchAs} is this repository's ${role} branch: a copy kept there is pushed by the next hand or workflow that pushes ${keptBranchAs}; choose a name outside the two configured branches`,
    );
  }
  if (
    keptBranchAs !== null &&
    exec("git", ["check-ref-format", "--branch", keptBranchAs], { cwd: root }).status !== 0
  ) {
    return refuse(
      `--keep-branch-as ${keptBranchAs}: git refuses that as a branch name (git check-ref-format --branch says so), so the copy would fail after the release is posted; choose a name git accepts`,
    );
  }
  const taken = keptBranchAs === null ? null : existingBranch(keptBranchAs, exec, root);
  if (taken !== null) {
    return refuse(
      `--keep-branch-as ${keptBranchAs}: that branch already exists${taken === keptBranchAs ? "" : ` as ${taken}, which is the same ref where the file system ignores case`} — the copy would fail after the release is posted; choose another name, or delete it first with git branch -D ${taken}`,
    );
  }
  const ledger = loadLedger(root, machine);
  const entry = ledger.issues[String(issue)];
  // An entry is a run this machine owns: it is released with the ledger, so `--to` is needed.
  // Without an entry there is only leftover state to clear.
  if (entry && opts.to === null) {
    return refuse(
      `issue ${issue} is in this machine's ledger (${entry.state}); give --to <target> and --reason <text> so the run is released with its worktree: autoclaude rollback ${issue} --to blocked --reason "<why>"`,
    );
  }
  if (entry?.worktree && inside(cwd, entry.worktree)) return refuseCwd(entry.worktree);

  const live = liveInstance(root, now);
  // `ready` and `none` put the issue back within a claim's reach before the worktree, the
  // branch and the ledger entry come down: a ticking orchestrator would start a second
  // attempt on top of the first one's teardown. A pause lifts it.
  if (live !== null && !controlState(root).paused && (opts.to === "ready" || opts.to === "none")) {
    return refuse(
      `--to ${opts.to} would make issue ${issue} claimable again while orchestrator instance ${live.instance} is live, and the release happens before the teardown: stop it taking work first (autoclaude pause), or roll back to blocked or needs-shaping, which leave the issue unclaimable`,
    );
  }
  // A stage of the live instance is a process still editing that worktree; removing it under
  // a running agent loses the work it had done. A stage of an instance that is gone blocks
  // nothing: that is the state a rollback is most often needed in.
  if (entry?.stage && live !== null && entry.stage.instance === live.instance) {
    return refuse(
      `issue ${issue}: stage ${entry.stage.stage} is running in orchestrator instance ${live.instance} (pid ${live.pid}); stop the orchestrator (end the autoclaude run process, or autoclaude service uninstall) or wait for the stage to finish, then run this again`,
    );
  }

  const registration = findWorktree(root, issue, cfg, exec);
  const registeredAtStart = registration !== null;
  // A registration whose directory is gone is evidence of nothing.
  const wt = registration !== null && existsSync(registration.path) ? registration : null;
  if (wt && inside(cwd, wt.path)) return refuseCwd(wt.path);
  const branch = wt?.branch ?? (entry?.branch || null);
  // The name this is about to delete on the remote, checked before the release: with no
  // worktree registered, `branch` is the ledger row verbatim, and a hand-edited row is as
  // sticky as anything else.
  if (branch !== null) {
    const outside = notIssueBranch(branch, issue, cfg, exec);
    if (outside !== null) {
      return refuseWithCommand(
        `issue ${issue}: the ledger names branch ${quoted(branch)}, and the removal step deletes that branch on ${cfg.forge.remote} — ${outside}. Correct the row first (autoclaude ledger set ${issue} ${entry?.state ?? "claimed"} --branch ${branchPrefixFor(issue, cfg)}<slug>)${opts.to === null ? "" : `, or release the claim alone: ${releaseCommand(opts.to)}`}`,
      );
    }
  }
  if (keptBranchAs !== null && branch === null) {
    return refuse(
      `--keep-branch-as ${keptBranchAs}: no branch to copy for issue ${issue} — neither a worktree nor the ledger names one`,
    );
  }
  if (
    keptBranchAs !== null &&
    branch !== null &&
    exec("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: root }).status !== 0
  ) {
    return refuseWithCommand(
      `--keep-branch-as ${keptBranchAs}: branch ${branch} does not resolve here, so there is nothing local to copy — cut the copy from the remote instead (git fetch ${cfg.forge.remote} ${quoted(branch)} && git branch ${keptBranchAs} ${quoted(`${cfg.forge.remote}/${branch}`)}), then run this again without --keep-branch-as`,
    );
  }

  // The remote branch goes only when no open pull request uses it. A listing that fails is
  // a refusal: guessing "none open" could delete the branch of a pull request.
  let open;
  try {
    open = forge
      .listPrs("open")
      .filter((p) => p.state === "OPEN" && p.headRefName.startsWith(branchPrefixFor(issue, cfg)));
  } catch (error) {
    return refuse(
      `issue ${issue}: the open pull requests could not be listed (${messageOf(error)}), so no remote branch can be judged safe to delete`,
    );
  }
  const remoteKept =
    open.length > 0
      ? `pull request #${open[0]!.number} is still open (${open[0]!.url}); its branch stays on ${cfg.forge.remote} — closing it is a human's decision, and the branch can be removed with autoclaude rollback ${issue} once it is closed`
      : null;

  // --- 2. The release: labels and the comment, the silent step first.
  const release = opts.to;
  if (release !== null) {
    try {
      releaseIssue(issue, release, `rolled back by hand: ${reason}`, { forge, cfg, machine, now });
    } catch (error) {
      return {
        kind: "release-failed",
        code: 1,
        issue,
        released: false,
        failure: messageOf(error),
        remaining: [releaseCommand(release)],
      };
    }
  }

  // --- 3. Everything destructive, each step paired with the command that does it by hand.
  const note = rollbackNote(release, keptBranchAs, reason);
  const ledgerState = release === null ? null : ledgerStateFor(release);
  const runsFrom = runDir(root, issue);
  let runsTo: string | null = null;
  const destination = (): string => (runsTo ??= runsDestination(root, issue, now));
  const stillRegistered = (): boolean => {
    try {
      return findWorktree(root, issue, cfg, exec) !== null;
    } catch {
      return true;
    }
  };
  // `null` when the call itself failed, which is not the same answer as "still there".
  const remoteGone = (b: string): boolean | null => {
    const r = exec("git", ["ls-remote", "--heads", cfg.forge.remote, b], { cwd: root });
    return r.status === 0 ? r.stdout.trim() === "" : null;
  };
  let worktreeRemoved = false;
  let remoteDeleted: boolean | null = null;
  const steps: Step[] = [];

  if (keptBranchAs !== null && branch !== null) {
    steps.push({
      // The branch's tip, so what the worktree committed is kept and what it left uncommitted is not.
      command: () => `git branch ${keptBranchAs} ${quoted(branch)}`,
      run: () => {
        git(["branch", keptBranchAs, branch], exec, root);
      },
    });
  }
  steps.push({
    command: () => `autoclaude worktree remove ${issue}${remoteKept === null ? " --remote" : ""}`,
    run: () => {
      removeWorktree(root, issue, cfg, { deleteRemote: remoteKept === null }, exec);
      // Asked afresh, never derived from the snapshot above.
      worktreeRemoved = registeredAtStart && !stillRegistered();
      remoteDeleted = branch === null || remoteKept !== null ? null : remoteGone(branch);
    },
  });
  if (entry && release !== null && ledgerState !== null) {
    const keepPr = remoteKept !== null && open[0] !== undefined;
    steps.push({
      command: () => `autoclaude note ${issue} ${quoted(note)}`,
      run: () => {
        // Before the ledger step: the stage is read from the ledger, and the ledger step clears it.
        appendNote(root, issue, note, entry.stage?.stage ?? null, now);
      },
    });
    steps.push({
      command: () =>
        `autoclaude ledger set ${issue} ${ledgerState}${keepPr ? "" : " --pr none"} --stage none --note ${quoted(note)}`,
      run: () => {
        updateLedger(
          root,
          (l) => {
            const before = l.issues[String(issue)];
            const after = transition(
              l,
              issue,
              ledgerState,
              { ...(keepPr ? {} : { pr: null }), stage: null, note },
              now,
            );
            // The transition's own log line, through the writer `ledger set` uses, so the
            // scripted and the printed route agree. Best-effort: the release is posted by now.
            appendNoteBestEffort(
              root,
              issue,
              transitionText({ from: before?.state ?? null, to: ledgerState, note }),
              after.stage?.stage ?? null,
              now,
            );
            return after;
          },
          now,
          machine,
        );
      },
    });
    steps.push({
      command: () =>
        `mkdir -p ${quoted(runsOldDir(root))} ; mv ${quoted(runsFrom)} ${quoted(destination())}`,
      run: () => {
        mkdirSync(runsOldDir(root), { recursive: true });
        renameSync(runsFrom, destination());
      },
    });
  }

  for (let i = 0; i < steps.length; i++) {
    try {
      steps[i]!.run();
    } catch (error) {
      return {
        kind: "incomplete",
        code: 1,
        issue,
        released: release !== null,
        failure: `${steps[i]!.command()}: ${messageOf(error)}`,
        remaining: steps.slice(i).map((s) => s.command()),
      };
    }
  }
  return {
    kind: "done",
    code: 0,
    issue,
    to: release,
    released: release !== null,
    keptBranchAs,
    worktreeRemoved,
    remoteDeleted,
    remoteBranch: branch,
    remoteKept,
    ledgerState,
    runsMovedTo: entry && release !== null ? destination() : null,
  };
}

/** The steps that did not run, one runnable command per line, under a heading that names the shell. */
export function renderRemaining(remaining: string[], root: string): string {
  return [
    `these steps did not run. From ${root}, in bash (the quoting below is bash's):`,
    ...remaining,
  ].join("\n");
}

/** The release itself failed: which half may have happened, and the command that finishes it. */
export function renderReleaseFailed(remaining: string[], root: string): string {
  return [
    "the release failed part-way: the labels may already have been changed and the release comment may be missing. Nothing destructive ran.",
    `From ${root}, in bash (the quoting below is bash's):`,
    ...remaining,
  ].join("\n");
}

// --- the verb -------------------------------------------------------------------

const USAGE =
  'usage: autoclaude rollback <issue> [--to <blocked|needs-shaping|ready|done|none> --reason "<text>"] [--keep-branch-as <name>]';
const KNOWN_FLAGS = ["--to", "--reason", "--keep-branch-as"];

export function parseRollbackArgs(argv: string[]): {
  issue: number;
  to: ReleaseTarget | null;
  reason: string;
  keepBranchAs: string | null;
} {
  const issue = issueArg(argv[0], "rollback");
  // An unknown option is refused rather than ignored: `--keep-branch <name>` would otherwise
  // drop the branch copy silently, on a command whose next step deletes it.
  const unknown = argv.slice(1).find((a) => a.startsWith("--") && !KNOWN_FLAGS.includes(a));
  if (unknown) throw new Error(`rollback: unknown option ${unknown}`);
  const to = flag(argv, "--to");
  const reason = flag(argv, "--reason");
  if (to === undefined && reason !== undefined)
    throw new Error("--reason needs --to: without a target nothing is released");
  if (to !== undefined && !(RELEASE_TARGETS as readonly string[]).includes(to))
    throw new Error(`--to must be one of ${RELEASE_TARGETS.join(", ")}, got "${to}"`);
  if (to !== undefined && (reason === undefined || reason.trim() === ""))
    throw new Error("--reason <text> is required: a release comment with no reason says nothing");
  return {
    issue,
    to: (to as ReleaseTarget | undefined) ?? null,
    reason: reason?.trim() ?? "",
    keepBranchAs: flag(argv, "--keep-branch-as") ?? null,
  };
}

export async function rollbackVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  let opts: ReturnType<typeof parseRollbackArgs>;
  try {
    opts = parseRollbackArgs(args);
  } catch (e) {
    // A typo in the command line is the caller's mistake and nothing has happened.
    return usageError(io, USAGE, messageOf(e));
  }
  let root: string;
  let result: RollbackResult;
  try {
    root = env.root(cwd);
    const cfg = env.config(root);
    result = rollback(opts.issue, opts, {
      exec: env.exec,
      root,
      cfg,
      forge: env.forge(cfg, root),
      machine: machineId(),
      now: env.now(),
      cwd,
    });
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
  if (result.kind === "done") {
    io.out(`${JSON.stringify(doneAsJson(result))}\n`);
    if (result.remoteKept !== null) io.err(`note: ${result.remoteKept}\n`);
    return 0;
  }
  if (result.kind === "refused") {
    io.err(`refused: ${result.refused}\n`);
    return 1;
  }
  if (result.kind === "release-failed") {
    io.err(
      `the release failed: ${result.failure}\n${renderReleaseFailed(result.remaining, root)}\n`,
    );
    return 1;
  }
  io.err(
    `failed after the release: ${result.failure}\n${renderRemaining(result.remaining, root)}\n`,
  );
  return 1;
}
