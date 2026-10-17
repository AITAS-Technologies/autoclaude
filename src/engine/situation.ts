/**
 * Everything one orchestrator tick needs, as one value. Reconciles the ledger from the
 * forge first and, unless asked to read only, saves it, so the file on disk is never
 * older than the last tick.
 *
 * The pure functions below decide; `computeSituation` at the end composes them with the
 * ledger, the control files, the profile and the worktree list. The `autoclaude
 * situation` verb prints its result.
 */

import { existsSync } from "node:fs";
import type { ProjectConfig } from "../config/types.js";
import type { Exec } from "../forge/exec.js";
import type { Forge, IssueSummary, PrSummary } from "../forge/github.js";
import { samePath } from "../platform/paths.js";
import { branchPrefixFor } from "./branch-names.js";
import { controlState } from "./control.js";
import {
  appendTransitions,
  gatherFacts,
  loadLedger,
  reconcile,
  saveLedger,
  TERMINAL,
  withLedgerLock,
  type IssueState,
  type Ledger,
  type LedgerEntry,
} from "./ledger/ledger.js";
import { instantInZone, profileAt, wallClockIn, type Profile } from "./profile.js";
import type { Stage } from "./review/reports.js";
import { listWorktrees } from "./worktree.js";

export { controlState } from "./control.js";

export function selectQueue(
  ready: IssueSummary[],
  ledger: Ledger,
  prs: PrSummary[],
  cfg: ProjectConfig,
): Array<{ number: number; title: string }> {
  // The position of the first configured priority label an issue carries; an issue with
  // none sorts after every prioritised one (design section 10, first row).
  const rank = (i: IssueSummary): number => {
    const at = cfg.queue.priority.findIndex((p) => i.labels.some((l) => l.name === p));
    return at === -1 ? cfg.queue.priority.length : at;
  };
  return ready
    .filter((i) => i.state === "OPEN")
    .filter((i) => i.assignees.length === 0)
    .filter((i) => !i.labels.some((l) => l.name === cfg.labels.working))
    .filter(
      (i) =>
        !prs.some(
          (p) => p.state === "OPEN" && p.headRefName.startsWith(branchPrefixFor(i.number, cfg)),
        ),
    )
    .filter((i) => {
      const e = ledger.issues[String(i.number)];
      return !e || TERMINAL.has(e.state);
    })
    .sort((a, b) => rank(a) - rank(b) || a.number - b.number)
    .map((i) => ({ number: i.number, title: i.title }));
}

export function countRunning(
  working: IssueSummary[],
  prs: PrSummary[],
  cfg: ProjectConfig,
): number {
  return working.filter(
    (i) =>
      i.state === "OPEN" &&
      !prs.some(
        (p) => p.state === "OPEN" && p.headRefName.startsWith(branchPrefixFor(i.number, cfg)),
      ),
  ).length;
}

/**
 * Issues this machine has in flight: everything Step 2 or Step 2b owns, which is a live
 * stage or a working state waiting to be re-dispatched. Defined through `ownerStep` so
 * it cannot drift from `stalledEntries` again: the two answered the same question with
 * different predicates, and an entry that was stalled but not counted let Step 4 claim
 * past the concurrency limit.
 */
export function countInFlight(entries: Array<Pick<LedgerEntry, "stage" | "state">>): number {
  return entries.filter((e) => {
    const owner = ownerStep(e.state, (e.stage ?? null) !== null);
    return owner === "2" || owner === "2b";
  }).length;
}

/**
 * States `reconcile` writes by itself and that leave the forge half-finished: the working
 * label is still on the issue, the worktree still on disk. Every one of them needs a
 * step that releases the claim, or the issue keeps a concurrency slot for good.
 */
export const CLEANUP_STATES: ReadonlySet<IssueState> = new Set([
  "merged",
  "closed",
  "blocked",
  "needs-shaping",
]);

/** States the pull request loop owns once no stage is running. */
export const PR_STATES: ReadonlySet<IssueState> = new Set(["pr-open", "fixing-ci", "mergeable"]);

/** States a stage works in. With no stage they are Step 2b's, whatever else is true. */
export const WORKING_STATES: ReadonlySet<IssueState> = new Set([
  "claimed",
  "planning",
  "plan-reviewing",
  "fixing-plan",
  "implementing",
  "code-reviewing",
  "fixing-local",
  "resume-needed",
]);

/**
 * The step that owns an entry, from the pair (state, stage) rather than from the state
 * alone. Three states have now fallen through a name-keyed list: `merged`, `blocked` and
 * `fixing-ci`, the last one while its own stage was running, so the implement subagent
 * finished and nothing ever read its report. Here every
 * pair maps to exactly one step, and the orchestrator skill test checks the product
 * against the skill.
 */
export function ownerStep(state: IssueState, hasStage: boolean): "2" | "2b" | "3" | "none" {
  // A live stage is Step 2's, whatever the state: it is the step that reads the report,
  // stops the task on the wall clock, and hands a torn-down issue to Step 3.
  if (hasStage) return "2";
  if (WORKING_STATES.has(state)) return "2b";
  if (PR_STATES.has(state) || CLEANUP_STATES.has(state)) return "3";
  return "none"; // done
}

/**
 * An entry in a working state whose stage is gone: the limit pause writes one
 * deliberately, a crashed session leaves one behind. Without a step of its own it is
 * invisible to every loop and holds its slot forever, so the situation names it.
 */
export function stalledEntries(
  entries: Array<Pick<LedgerEntry, "issue" | "state" | "stage">>,
): Array<{ issue: number; state: IssueState }> {
  return entries
    .filter((e) => ownerStep(e.state, (e.stage ?? null) !== null) === "2b")
    .map((e) => ({ issue: e.issue, state: e.state }));
}

/**
 * The entries whose GitHub or disk side still has to be released. Two proofs, not one:
 * the working label is still on the issue, **or** the worktree is still there. Requiring
 * the label alone meant a release that stripped it without removing the worktree could
 * never reach the cleanup that would remove it, so the worktree, the branch and the
 * remote head leaked.
 */
export function cleanupEntries(
  entries: Array<Pick<LedgerEntry, "issue" | "state" | "pr" | "stage" | "worktree">>,
  working: IssueSummary[],
  worktrees: string[] = [],
): Array<{ issue: number; state: IssueState; pr: number | null }> {
  const labelled = new Set(working.map((i) => i.number));
  // The file system's own case rules decide whether two paths are one directory, never a
  // blanket lowercase (design section 10, defect 2).
  const hasWorktree = (e: { worktree?: string }) =>
    !!e.worktree && worktrees.some((w) => samePath(w, e.worktree as string));
  return entries
    .filter(
      (e) =>
        CLEANUP_STATES.has(e.state) &&
        (labelled.has(e.issue) || hasWorktree(e)) &&
        // A stage still running on it is Step 2's to stop first; Step 3 removes the
        // worktree, and doing that under a live subagent is what the pair rule prevents.
        (e.stage ?? null) === null,
    )
    .map((e) => ({ issue: e.issue, state: e.state, pr: e.pr }));
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * When the current profile window began: today's day.from by day, the last day.to by
 * night. Read on the wall clock of `schedule.timezone`, the zone `profileAt` decides the
 * profile in, so the two cannot disagree on a machine set to another zone.
 */
export function windowStart(now: Date, cfg: ProjectConfig, profile: Profile): Date {
  const { timezone, profiles } = cfg.schedule;
  const wall = wallClockIn(now, timezone);
  const at = (dayOffset: number, hhmm: string) => {
    const m = minutesOf(hhmm);
    return instantInZone(
      wall.year,
      wall.month,
      wall.day + dayOffset,
      Math.floor(m / 60),
      m % 60,
      timezone,
    );
  };
  if (profile.name === "day") return at(0, profiles.day.from);
  const to = at(0, profiles.day.to);
  if (to <= now) return to;
  return at(-1, profiles.day.to);
}

export interface NewWorkGate {
  allowed: boolean;
  reasons: string[];
  claimedThisWindow: number;
}

/**
 * Whether Step 4 may take a new issue, decided here and not in prose: every spend and
 * safety lever in one place, so a tick cannot misread one, and `caps.issuesPerNight`
 * gets the consumer it never had.
 */
export function newWorkGate(
  input: {
    profile: Profile;
    control: { paused: boolean; draining: boolean };
    limitedUntil: string | null;
    counts: { inFlight: number; repoWorking: number; openAgentPrs: number };
    queueLength: number;
    claimedThisWindow: number;
  },
  cfg: ProjectConfig,
  now: Date,
): NewWorkGate {
  const { profile, control, limitedUntil, counts, queueLength, claimedThisWindow } = input;
  const reasons: string[] = [];
  if (!profile.takesNewWork) reasons.push(`the ${profile.name} profile takes no new work now`);
  if (control.paused) reasons.push("paused");
  if (control.draining) reasons.push("draining");
  if (limitedUntil && new Date(limitedUntil) > now) reasons.push(`limited until ${limitedUntil}`);
  if (counts.inFlight >= profile.concurrency)
    reasons.push(`inFlight ${counts.inFlight} >= concurrency ${profile.concurrency}`);
  if (counts.repoWorking >= profile.concurrency)
    reasons.push(`repoWorking ${counts.repoWorking} >= concurrency ${profile.concurrency}`);
  if (counts.openAgentPrs >= cfg.caps.openPullRequests)
    reasons.push(
      `openAgentPrs ${counts.openAgentPrs} >= caps.openPullRequests ${cfg.caps.openPullRequests}`,
    );
  if (profile.name === "night" && claimedThisWindow >= cfg.caps.issuesPerNight)
    reasons.push(
      `claimed ${claimedThisWindow} this night >= caps.issuesPerNight ${cfg.caps.issuesPerNight}`,
    );
  if (queueLength === 0) reasons.push("queue empty");
  return { allowed: reasons.length === 0, reasons, claimedThisWindow };
}

export interface SituationIssue {
  issue: number;
  state: IssueState;
  pr: number | null;
  prState: PrSummary["state"] | null;
  prUpdatedAt: string | null;
  stage: LedgerEntry["stage"];
  attempts: LedgerEntry["attempts"];
  worktree: string;
  worktreeExists: boolean;
  branch: string;
  claimedAt: string;
  pushedSha: string | null;
  updatedAt: string;
  lastError: string | null;
  /** The stage a usage limit interrupted, to be resumed without a counter once it has passed. */
  limitedStage: Stage | null;
}

export interface Situation {
  profile: Profile;
  control: { paused: boolean; draining: boolean };
  limitedUntil: string | null;
  issues: SituationIssue[];
  foreign: Ledger["foreign"];
  counts: { inFlight: number; repoWorking: number; openAgentPrs: number };
  queue: Array<{ number: number; title: string }>;
  cleanup: Array<{ issue: number; state: IssueState; pr: number | null }>;
  stalled: Array<{ issue: number; state: IssueState }>;
  newWork: NewWorkGate;
  caps: ProjectConfig["caps"];
}

export interface SituationDeps {
  forge: Forge;
  /** Runs the one `git worktree list`. */
  exec: Exec;
  now: Date;
  /** The live orchestrator instance, or null; stages of any other instance are dead. */
  liveInstance: string | null;
  /**
   * True writes nothing at all: no ledger, no `status.md`, no events log, no lock file.
   * What a human looking over the tick's shoulder (the dry run) passes.
   */
  readOnly: boolean;
}

/**
 * Everything one tick needs. Reconciles the ledger from the forge's complete listings
 * and, unless `readOnly`, saves it under the ledger lock so a `ledger set` from another
 * process cannot interleave. The transitions the reconcile made by itself go into the
 * issues' events logs before the save renders `status.md` from them: they are the ones
 * nobody typed, so they are the ones a human has to be able to find.
 */
export function computeSituation(root: string, cfg: ProjectConfig, deps: SituationDeps): Situation {
  const { forge, exec, now, liveInstance, readOnly } = deps;
  // Only the working query needs the comments, for the claim markers; the queue does not.
  const { working, prs } = gatherFacts(forge, cfg);
  const ready = forge.listIssues(cfg.queue.ready, "open", { comments: false });
  const worktrees = listWorktrees(root, exec).map((w) => w.path);
  const reconciled = (base: Ledger) =>
    reconcile({ ...base, instance: liveInstance }, { working, prs }, worktrees, cfg, now);
  const ledger = readOnly
    ? reconciled(loadLedger(root))
    : withLedgerLock(root, () => {
        const before = loadLedger(root);
        const l = reconciled(before);
        appendTransitions(root, before, l, now);
        saveLedger(root, l, now);
        return l;
      });
  const prOf = (n: number | null) =>
    n === null ? null : (prs.find((p) => p.number === n) ?? null);
  /**
   * Is the directory there — asked of the file system, not of git's registry.
   *
   * `cleanupEntries` asks git's worktree list, because what it decides is whether there
   * is a registered worktree for `worktree remove` to remove. This asks whether the path
   * an entry names can be entered, because that is what every stage does first, and
   * `git worktree list` still names a directory somebody deleted until `git worktree
   * prune` runs.
   */
  const worktreeExists = (p: string) => !!p && existsSync(p);
  const entries = Object.values(ledger.issues).sort((a, b) => a.issue - b.issue);
  // Compact: the tick needs a handful of fields per issue, and every tick's output stays
  // in the orchestrator's context until compaction. `prState` is here so the pull request
  // step does not ask the forge for what this tick already fetched. `prUpdatedAt` is the
  // pull request's own clock, not the ledger's: the tick rewrites `updatedAt` on every
  // same-state write, so nothing about the entry can measure how long the gates have
  // been silent.
  const issues: SituationIssue[] = entries.map((e) => ({
    issue: e.issue,
    state: e.state,
    pr: e.pr,
    prState: prOf(e.pr)?.state ?? null,
    prUpdatedAt: prOf(e.pr)?.updatedAt ?? null,
    stage: e.stage,
    attempts: e.attempts,
    worktree: e.worktree,
    worktreeExists: worktreeExists(e.worktree),
    branch: e.branch,
    claimedAt: e.claimedAt,
    pushedSha: e.pushedSha,
    updatedAt: e.updatedAt,
    // The pull request step quotes it when it releases a blocked entry.
    lastError: e.lastError,
    limitedStage: e.limitedStage ?? null,
  }));
  const profile = profileAt(now, cfg);
  const control = controlState(root);
  const openAgentPrs = prs.filter(
    (p) => p.state === "OPEN" && p.headRefName.startsWith(cfg.branchPrefix),
  ).length;
  // Repository-wide running work: working issues that have no open pull request yet. An
  // issue whose pull request waits for a human draws on nobody's quota, and the working
  // label stays on it until the merge, so counting the label alone would freeze the
  // night at concurrency after the second pull request opened.
  const counts = {
    inFlight: countInFlight(entries),
    repoWorking: countRunning(working, prs, cfg),
    openAgentPrs,
  };
  const queue = selectQueue(ready, ledger, prs, cfg);
  const since = windowStart(now, cfg, profile).toISOString();
  // Distinct issues that became claimed in this window. `from !== "claimed"` because
  // reconcile refreshes an entry that is already claimed, and counting those exhausted
  // the night's cap on one issue.
  const claimedThisWindow = new Set(
    ledger.events
      .filter((ev) => ev.to === "claimed" && ev.from !== "claimed" && ev.at >= since)
      .map((ev) => ev.issue),
  ).size;
  return {
    profile,
    control,
    limitedUntil: ledger.limitedUntil,
    issues,
    foreign: ledger.foreign,
    counts,
    queue,
    cleanup: cleanupEntries(entries, working, worktrees),
    stalled: stalledEntries(entries),
    newWork: newWorkGate(
      {
        profile,
        control,
        limitedUntil: ledger.limitedUntil,
        counts,
        queueLength: queue.length,
        claimedThisWindow,
      },
      cfg,
      now,
    ),
    caps: cfg.caps,
  };
}
