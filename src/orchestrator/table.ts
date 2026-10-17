/**
 * The orchestrator's decision table, as code (design C1, § 7.3).
 *
 * In the source pipeline a model re-read a long skill on every tick: Step 2 settled finished
 * stages through a table of stage × report → action, Step 2b re-dispatched entries whose stage
 * was gone, Step 3 handled pull requests and cleanup, Step 4 took new work. Here each row of
 * that table and each bullet of those steps is a branch of a pure function that returns the
 * actions to take; `actions.ts` executes them and `tick.ts` runs the steps. Nothing here reads
 * the disk, the forge or the clock: what a row needs is handed in.
 *
 * Rows of the source that only existed because a stage was an agent-tool task (design C1) are
 * gone: "waiting on its own command" (a process that exited has finished), task ids and late
 * notifications from a replaced task (one process per stage, and its exit is its end), and the
 * parser's usage error (no command line sits between the engine and the parser). Phase 1 never
 * merges: no action here can.
 */
import type { ProjectConfig } from "../config/types.js";
import type { ReleaseTarget } from "../engine/claims.js";
import type { IssueState, LedgerEntry } from "../engine/ledger/ledger.js";
import type { Verdict } from "../engine/merge/can-merge.js";
import type { Decision } from "../engine/review/decision.js";
import { parseImplementReport, parsePlanReport, type Stage } from "../engine/review/reports.js";
import { CLEANUP_STATES, PR_STATES, WORKING_STATES, type Situation } from "../engine/situation.js";
import type { Triage } from "./review/schemas.js";
import type { StageOutcome } from "./stage.js";

export type Mode = "fresh" | "fix" | "resume";

/** What a dispatch hands the stage beyond the issue: `runStage`'s `extra`. */
export interface DispatchExtra {
  findingsMarkdown?: string;
  carriedMarkdown?: string;
  gateLog?: string;
  escalated?: boolean;
}

/**
 * One step the engine takes. The brief's union, plus the optional fields the source's command
 * lines carried (`set --error`, `--pr none`, `--can-merge`), the limit marker, and
 * `recreate-worktree` for Step 2b's missing worktree; every GitHub write among them goes through
 * the forge.
 */
export type Action =
  | {
      kind: "dispatch";
      stage: Stage | "code-review" | "plan-review";
      mode: Mode;
      state: IssueState;
      extra?: DispatchExtra;
    }
  | { kind: "release"; to: ReleaseTarget; reason: string }
  | { kind: "label"; add: string }
  | { kind: "archive"; stage: Stage | "plan-file"; late?: boolean }
  | { kind: "publish"; update: boolean }
  | {
      kind: "set";
      state: IssueState;
      note?: string;
      bump?: "fix" | "retry" | "plan" | "implement";
      stage?: "none";
      error?: string;
      pr?: "none";
      canMerge?: string;
      /** Marks the stage a usage limit interrupted; any later dispatch clears it. */
      limitedStage?: Stage;
    }
  | { kind: "limit"; until: string }
  | { kind: "note"; text: string }
  | { kind: "stop-stage" }
  | { kind: "remove-worktree"; remote: boolean }
  | { kind: "comment"; body: string }
  | { kind: "recreate-worktree" };

/** The fields of an entry the table reads; a ledger entry and a situation issue both have them. */
export type TableEntry = Pick<
  LedgerEntry,
  "issue" | "state" | "attempts" | "pr" | "pushedSha" | "lastError" | "stage" | "limitedStage"
>;

/** Thrown when a handler is given an entry its step does not own. */
export class NotOwned extends Error {}

export type Owner = "onStageFinished" | "onStalled" | "onPullRequest" | "none";

/**
 * Which handler owns which entry, by the pair (state, has a stage) — the source skill's
 * ownership table, row for row. A live stage is Step 2's whatever the state; an entry without
 * one belongs to the step its state names. The test checks it against `ownerStep`.
 */
export const OWNERSHIP: Readonly<Record<IssueState, { withStage: Owner; withoutStage: Owner }>> = {
  claimed: { withStage: "onStageFinished", withoutStage: "onStalled" },
  planning: { withStage: "onStageFinished", withoutStage: "onStalled" },
  "plan-reviewing": { withStage: "onStageFinished", withoutStage: "onStalled" },
  "fixing-plan": { withStage: "onStageFinished", withoutStage: "onStalled" },
  implementing: { withStage: "onStageFinished", withoutStage: "onStalled" },
  "code-reviewing": { withStage: "onStageFinished", withoutStage: "onStalled" },
  "fixing-local": { withStage: "onStageFinished", withoutStage: "onStalled" },
  "resume-needed": { withStage: "onStageFinished", withoutStage: "onStalled" },
  "fixing-ci": { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  "pr-open": { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  mergeable: { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  merged: { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  closed: { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  blocked: { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  "needs-shaping": { withStage: "onStageFinished", withoutStage: "onPullRequest" },
  done: { withStage: "onStageFinished", withoutStage: "none" },
};

export function ownerOf(state: IssueState, hasStage: boolean): Owner {
  const row = OWNERSHIP[state];
  return hasStage ? row.withStage : row.withoutStage;
}

/** The note written before a row acts: `decision <action> blocking=<n> deferred=<n>`. */
export function decisionLine(action: string, blocking: number, deferred: number): string {
  return `decision ${action} blocking=${blocking} deferred=${deferred}`;
}

/** The headings the stage prompts read their two lists by (F2). */
export const FINDINGS_HEADING = "Findings to address, exactly these and nothing else";
export const CARRIED_HEADING = "Carried from the plan review, not owed";
export const GATE_LOG_HEADING = "Failed CI steps";

/** The state a stage works in, when the entry's own state is not one of its own. */
const STAGE_STATE: Record<Stage, IssueState> = {
  plan: "planning",
  "plan-review": "plan-reviewing",
  implement: "implementing",
  "code-review": "code-reviewing",
};

/** The stage a working state names. */
export function stageForState(state: IssueState | null): Stage | null {
  switch (state) {
    case "planning":
    case "fixing-plan":
      return "plan";
    case "plan-reviewing":
      return "plan-review";
    case "implementing":
    case "fixing-local":
    case "fixing-ci":
      return "implement";
    case "code-reviewing":
      return "code-review";
    default:
      return null;
  }
}

/** "<same state>" of the source: the entry's state when it belongs to the stage, else the stage's own. */
function sameState(entry: TableEntry, stage: Stage): IssueState {
  return stageForState(entry.state) === stage ? entry.state : STAGE_STATE[stage];
}

/**
 * The mode a stage is re-dispatched in after it was interrupted. Plan has no resume mode
 * (F2: `prompts/plan.md` defines only fresh and fix), and the reviews have no modes at all.
 */
function resumeMode(stage: Stage): Mode {
  return stage === "implement" ? "resume" : "fresh";
}

/**
 * States in which a stage has nothing left to decide: Step 3 owns the entry (a human merged or
 * closed something under it), or the issue is done. Not `fixing-ci`: its implement stage is the
 * normal case, and Step 2 reads its report.
 */
export function movedOn(state: IssueState): boolean {
  return (
    CLEANUP_STATES.has(state) || state === "pr-open" || state === "mergeable" || state === "done"
  );
}

const MOVED_ON = "stage stopped: the issue moved on";

/** "Every --reason on a blocked release ends with what it would cost to be wrong." */
const costed = (reason: string, cost: string) => `${reason} — if wrong, ${cost}`;
const WAITS = "an issue an agent could have finished waits for a human";

const blockWith = (reason: string, error = reason): Action[] => [
  { kind: "release", to: "blocked", reason },
  { kind: "set", state: "blocked", error },
];

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
}

/** The wall-clock row, the one the source kept for a stage still running past its cap. */
function wallClock(entry: TableEntry, stage: Stage, now: Date): Action[] {
  const min = minutesSince(entry.stage?.startedAt ?? now.toISOString(), now);
  return [
    { kind: "note", text: `wall clock: stopped ${stage} after ${min}m` },
    ...blockWith(
      costed(
        `wall clock: ${stage} ran ${min} minutes`,
        "a stage that needed more time waits for a human",
      ),
      `wall clock: ${stage}`,
    ),
  ];
}

/** A run that ended without a usable report: the wall clock, or a retry while the cap allows. */
function failedRun(
  entry: TableEntry,
  stage: Stage,
  outcome: StageOutcome,
  now: Date,
  cfg: ProjectConfig,
): Action[] {
  if (outcome.kind === "no-report" && outcome.result.exit === "timeout") {
    return wallClock(entry, stage, now);
  }
  if (entry.attempts.reviewRetry < cfg.caps.reviewRetries) {
    const state = sameState(entry, stage);
    return [
      { kind: "label", add: `${cfg.labels.reviewRetry}${entry.attempts.reviewRetry + 1}` },
      { kind: "set", state, stage: "none", bump: "retry" },
      { kind: "dispatch", stage, mode: resumeMode(stage), state },
    ];
  }
  return blockWith(
    costed(
      "run ended without a report, twice",
      "a stage that would have finished on another try waits for a human",
    ),
  );
}

const parsed = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/** The table proper: stage × report → actions. */
function finished(
  entry: TableEntry,
  stage: Stage,
  outcome: StageOutcome,
  decision: Decision | null,
  cfg: ProjectConfig,
  now: Date,
): Action[] {
  // The limit is the runtime's (design § 7.3), read off the outcome and never off prose, and it
  // is recorded whatever became of the issue: the account is limited either way.
  const limit: Action[] =
    outcome.kind === "limit" ? [{ kind: "limit", until: outcome.resetsAt }] : [];
  if (movedOn(entry.state)) {
    return [...limit, { kind: "set", state: entry.state, stage: "none", note: MOVED_ON }];
  }
  if (outcome.kind === "limit") {
    // No counter: quota is not the code's fault. The marker has the owning step resume this
    // stage, still without a counter, once the limit has passed (design § 9).
    return [
      ...limit,
      {
        kind: "set",
        state: sameState(entry, stage),
        stage: "none",
        note: "interrupted by the limit",
        limitedStage: stage,
      },
    ];
  }
  if (outcome.kind !== "report") return failedRun(entry, stage, outcome, now, cfg);

  switch (stage) {
    case "plan": {
      const report = parsed(() => parsePlanReport(outcome.text));
      if (report === null) return failedRun(entry, stage, outcome, now, cfg);
      if (report.status === "planned") {
        return [
          { kind: "note", text: decisionLine("review", 0, 0) },
          // First, so a crashed fix round cannot be mistaken for this report later.
          { kind: "archive", stage: "plan" },
          { kind: "dispatch", stage: "plan-review", mode: "fresh", state: "plan-reviewing" },
        ];
      }
      if (report.status === "needs-shaping") {
        return [
          { kind: "note", text: decisionLine("shape", 0, 0) },
          { kind: "release", to: "needs-shaping", reason: report.reason },
          { kind: "set", state: "needs-shaping", error: report.reason },
          {
            kind: "note",
            text: `the queue offered an issue that needs shaping: it never should have carried ${cfg.queue.ready}, a triage problem, not a planning one`,
          },
        ];
      }
      return [
        { kind: "note", text: decisionLine("block", 0, 0) },
        ...blockWith(costed(report.reason, WAITS)),
      ];
    }

    case "implement": {
      const report = parsed(() => parseImplementReport(outcome.text));
      if (report === null) return failedRun(entry, stage, outcome, now, cfg);
      if (report.status === "done") {
        // Every diff is read by a fresh context before it is pushed, a CI fix round included;
        // the implementer's reasoning leaves the worktree before the reviewer starts.
        return [
          { kind: "note", text: decisionLine("review", 0, 0) },
          { kind: "archive", stage: "implement" },
          { kind: "archive", stage: "plan-file" },
          { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
        ];
      }
      if (report.status === "needs-shaping") {
        return [
          { kind: "note", text: decisionLine("shape", 0, 0) },
          { kind: "release", to: "needs-shaping", reason: report.reason },
          { kind: "set", state: "needs-shaping", error: report.reason },
        ];
      }
      return [
        { kind: "note", text: decisionLine("block", 0, 0) },
        ...blockWith(costed(report.reason, WAITS)),
      ];
    }

    case "plan-review":
    case "code-review":
      // A review row does not read the report: the decision did, and it is obeyed. No decision
      // means the report could not be decided on (stopped, incomplete, malformed): a failed run.
      if (decision === null) return failedRun(entry, stage, outcome, now, cfg);
      return reviewRow(entry, stage, decision);
  }
}

function reviewRow(entry: TableEntry, stage: "plan-review" | "code-review", d: Decision): Action[] {
  const line: Action = {
    kind: "note",
    text: decisionLine(d.action, d.blocking.length, d.deferred.length),
  };
  const block = (): Action[] => [line, ...blockWith(d.releaseReason ?? costed(d.reason, WAITS))];

  if (stage === "plan-review") {
    switch (d.action) {
      case "fix":
        return [
          line,
          { kind: "archive", stage: "plan-review" },
          { kind: "set", state: "fixing-plan", bump: "plan" },
          {
            kind: "dispatch",
            stage: "plan",
            mode: "fix",
            state: "fixing-plan",
            extra: { findingsMarkdown: `${FINDINGS_HEADING}\n\n${d.dispatchMarkdown}` },
          },
        ];
      case "proceed":
        return [
          line,
          { kind: "archive", stage: "plan-review" },
          { kind: "set", state: "implementing", bump: "implement" },
          {
            kind: "dispatch",
            stage: "implement",
            mode: "fresh",
            state: "implementing",
            // The plan review's should and later items, which a proceed defers: about the tests
            // the implementer is about to write.
            ...(d.dispatchMarkdown.trim() !== "" && {
              extra: { carriedMarkdown: `${CARRIED_HEADING}\n\n${d.dispatchMarkdown}` },
            }),
          },
        ];
      default:
        return block();
    }
  }

  switch (d.action) {
    case "fix":
      return [
        line,
        // The label is the record of the round; `decide` numbered it from the counters.
        ...(d.label ? [{ kind: "label", add: d.label } as const] : []),
        { kind: "archive", stage: "code-review" },
        { kind: "set", state: "fixing-local", bump: "fix" },
        {
          kind: "dispatch",
          stage: "implement",
          mode: "fix",
          state: "fixing-local",
          extra: {
            findingsMarkdown: `${FINDINGS_HEADING}\n\n${d.dispatchMarkdown}`,
            // The last fix round runs on the escalated spec; the mode stays fix.
            ...(d.escalate && { escalated: true }),
          },
        },
      ];
    case "retry": {
      const state = sameState(entry, "code-review");
      return [
        line,
        ...(d.label ? [{ kind: "label", add: d.label } as const] : []),
        // Archived before the re-dispatch, so a retry that dies before writing its own report
        // does not leave this one to be read as the retry's result.
        { kind: "archive", stage: "code-review" },
        { kind: "set", state, stage: "none", bump: "retry" },
        { kind: "dispatch", stage: "code-review", mode: "fresh", state },
      ];
    }
    case "publish":
      return [line, { kind: "publish", update: entry.pr !== null }];
    default:
      return block();
  }
}

/**
 * Step 2, a stage that finished: the source table row by row, including the limit, retry and
 * wall-clock rows that still apply to a process (a runtime that timed it out). For a state Step
 * 3 owns, the stage is the only thing settled here.
 */
export function onStageFinished(
  entry: TableEntry,
  stage: Stage,
  outcome: StageOutcome,
  decision: Decision | null,
  cfg: ProjectConfig,
  now: Date,
): Action[] {
  if (!entry.stage) throw new NotOwned(`#${entry.issue} has no stage: not Step 2's`);
  return finished(entry, stage, outcome, decision, cfg, now);
}

/** Step 2, a stage still running: the wall clock, or a state that moved on under it. */
export function onStageRunning(entry: TableEntry, cfg: ProjectConfig, now: Date): Action[] {
  if (!entry.stage) throw new NotOwned(`#${entry.issue} has no stage: not Step 2's`);
  if (movedOn(entry.state)) {
    return [
      { kind: "stop-stage" },
      { kind: "set", state: entry.state, stage: "none", note: MOVED_ON },
    ];
  }
  const min = (now.getTime() - new Date(entry.stage.startedAt).getTime()) / 60_000;
  if (min <= cfg.caps.wallClockMinutesPerStage) return [];
  return [{ kind: "stop-stage" }, ...wallClock(entry, entry.stage.stage, now)];
}

/** Step 2, a stage record no task of this instance holds: the session that ran it is gone. */
export function onStageLost(entry: TableEntry): Action[] {
  if (!entry.stage) throw new NotOwned(`#${entry.issue} has no stage: not Step 2's`);
  if (movedOn(entry.state)) {
    return [{ kind: "set", state: entry.state, stage: "none", note: MOVED_ON }];
  }
  return [
    { kind: "set", state: "resume-needed", stage: "none", note: "stage lost with its session" },
  ];
}

/**
 * A report found on disk for the stage a restart interrupted (R51): the process exited, the
 * orchestrator died before consuming it, and reconcile turned the entry into `resume-needed`.
 */
export interface LateReport {
  stage: Stage;
  outcome: StageOutcome;
  decision: Decision | null;
}

/** Step 2b: an owned entry in a working state with no stage. */
export function onStalled(
  entry: TableEntry,
  worktreeExists: boolean,
  cfg: ProjectConfig,
  late?: LateReport,
): Action[] {
  if (entry.stage || !WORKING_STATES.has(entry.state))
    throw new NotOwned(`#${entry.issue} (${entry.state}) is not Step 2b's`);

  // The source's late-report rule, for the one case processes still have: the report outlived
  // the orchestrator, not the stage. It is decided, not re-run.
  if (entry.state === "resume-needed" && late) {
    return [
      {
        kind: "note",
        text: `late report from ${late.stage}: its process finished before the restart; deciding it`,
      },
      // `now` feeds only the wall-clock row, which a report never reaches.
      ...finished(entry, late.stage, late.outcome, late.decision, cfg, new Date(0)),
    ];
  }

  // Every stage starts by entering its worktree; one that is gone is recreated (from the remote
  // branch when something was pushed) and the dispatch is fresh, because nothing local survived.
  const recreate: Action[] = worktreeExists ? [] : [{ kind: "recreate-worktree" }];

  // A stage a usage limit interrupted: resumed with no counter bumped and no bound counted. The
  // tick reaches this only once the limit has passed.
  if (entry.limitedStage)
    return [...recreate, resumeLimited(entry, entry.limitedStage, worktreeExists)];

  if (entry.state === "claimed") {
    return [...recreate, { kind: "dispatch", stage: "plan", mode: "fresh", state: "planning" }];
  }
  if (entry.state === "resume-needed") {
    // Not new work: it holds a slot already. A review is the cheapest way to find out what the
    // worktree holds; with no commits ahead of the base that becomes a fix round.
    return [
      ...recreate,
      { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
    ];
  }
  const stage = stageForState(entry.state) as Stage;
  // Bound with the counter the situation carries; without it this loop had no end.
  if (entry.attempts.reviewRetry >= cfg.caps.reviewRetries) {
    return blockWith(
      costed(
        `stage re-dispatched ${cfg.caps.reviewRetries} times with no report`,
        "a stage that would have finished on another try waits for a human",
      ),
    );
  }
  return [
    ...recreate,
    { kind: "set", state: entry.state, bump: "retry" },
    {
      kind: "dispatch",
      stage,
      mode: worktreeExists ? resumeMode(stage) : "fresh",
      state: entry.state,
    },
  ];
}

/** The dispatch that resumes a stage a usage limit interrupted; the dispatch clears the marker. */
function resumeLimited(entry: TableEntry, stage: Stage, worktreeExists = true): Action {
  return {
    kind: "dispatch",
    stage,
    mode: worktreeExists ? resumeMode(stage) : "fresh",
    state: sameState(entry, stage),
  };
}

/** The run behind a red gate: where a human finds it, and its failed steps' log. */
export interface GateRun {
  url: string;
  log: string;
}

/** `canMerge`'s verdict, plus the failed run when check 2 named a failing required check. */
export interface PrVerdict {
  allowed: boolean;
  checks: Verdict[];
  gateRun?: GateRun | null;
}

const GATES_SILENT_MS = 20 * 60_000;

/** Check 2's detail read back: pass, a real failure, a silent rollup, or still pending. */
export function gateState(
  verdict: Pick<PrVerdict, "checks">,
): "pass" | "fail" | "silent" | "pending" {
  const check = verdict.checks.find((c) => c.id === 2);
  if (!check) return "pending";
  if (check.result === "pass") return "pass";
  if (check.detail.startsWith("no checks reported at all")) return "silent";
  const outcomes = check.detail.split(", ").map((p) => p.slice(p.lastIndexOf(": ") + 2));
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.every((o) => o === "not reported" || o === "skipped")) return "silent";
  return "pending";
}

/**
 * The cleanup bullets. `prOpen`: the entry's pull request is still open, so its remote branch
 * stays whatever the bullet says — deleting it would close the pull request, and closing one is
 * a human's action.
 */
function cleanup(
  entry: TableEntry,
  as: "merged" | "closed" | "blocked" | "needs-shaping",
  prOpen = false,
): Action[] {
  switch (as) {
    case "merged":
      return [
        { kind: "remove-worktree", remote: true },
        { kind: "release", to: "done", reason: `merged as #${entry.pr ?? "?"}` },
        { kind: "set", state: "done", stage: "none" },
      ];
    case "closed":
      // Without the remote branch: deleting it closes any pull request still open on it, and
      // closing a pull request is a human's action.
      return [
        { kind: "remove-worktree", remote: false },
        { kind: "release", to: "done", reason: "issue closed by a human" },
        { kind: "set", state: "done", stage: "none" },
        ...(entry.pr !== null
          ? [
              {
                kind: "note",
                text: `the remote branch was left behind for pull request #${entry.pr}`,
              } as const,
            ]
          : []),
      ];
    case "blocked":
      // The remote branch goes too: a later attempt pushes the same name, and publish refuses
      // to lease on a remote head the new worktree never had. Unless its pull request is open.
      return [
        { kind: "remove-worktree", remote: !prOpen },
        {
          kind: "release",
          to: "blocked",
          reason:
            entry.lastError ??
            (entry.pr !== null ? `pull request #${entry.pr} closed without merge` : "blocked"),
        },
        { kind: "set", state: "blocked", pr: "none", stage: "none" },
        ...(prOpen
          ? [
              {
                kind: "note",
                text: `the remote branch was kept: pull request #${entry.pr ?? "?"} is still open`,
              } as const,
            ]
          : []),
      ];
    case "needs-shaping":
      return [
        { kind: "remove-worktree", remote: false },
        { kind: "release", to: "needs-shaping", reason: entry.lastError ?? "needs shaping" },
        { kind: "set", state: "needs-shaping", stage: "none" },
      ];
  }
}

/** `ALLOWED`, or `REFUSED: <the checks that did not pass>`. */
function canMergeLine(verdict: PrVerdict): string {
  if (verdict.allowed) return "ALLOWED";
  const failing = verdict.checks.filter((c) => c.result !== "pass").map((c) => c.name);
  return `REFUSED: ${failing.join(", ")}`;
}

/**
 * Step 3: the cleanup list (an entry `reconcile` moved to merged, closed, blocked or
 * needs-shaping) and the pull requests with no running stage. Records the merge verdict and
 * never acts on it.
 */
export function onPullRequest(
  entry: TableEntry,
  pr: { state: "OPEN" | "MERGED" | "CLOSED" | null; updatedAt: string | null } | null,
  verdict: PrVerdict | null,
  cfg: ProjectConfig,
  now: Date,
): Action[] {
  if (entry.stage) throw new NotOwned(`#${entry.issue} has a stage: Step 2's first`);
  if (CLEANUP_STATES.has(entry.state)) {
    const as = entry.state as "merged" | "closed" | "blocked" | "needs-shaping";
    return cleanup(entry, as, pr?.state === "OPEN");
  }
  if (!PR_STATES.has(entry.state))
    throw new NotOwned(`#${entry.issue} (${entry.state}) is not Step 3's`);

  // A human merging or closing the pull request: as the cleanup list does for merged and
  // blocked. A closed pull request means "not like this", never "again, identically".
  if (pr?.state === "MERGED") return cleanup(entry, "merged");
  if (pr?.state === "CLOSED") return cleanup(entry, "blocked");
  // A stage a usage limit interrupted is resumed, not answered with a new fix round: the limit
  // costs no counter in this state either.
  if (entry.limitedStage) return [resumeLimited(entry, entry.limitedStage)];
  if (pr?.state !== "OPEN" || verdict === null) return [];

  const record: Action = { kind: "set", state: entry.state, canMerge: canMergeLine(verdict) };
  const silentFor = now.getTime() - new Date(pr.updatedAt ?? now.toISOString()).getTime();
  const gates = gateState(verdict);
  const detail = verdict.checks.find((c) => c.id === 2)?.detail ?? "";
  const marker = `<!-- autodev-gates issue="${entry.issue}" -->`;

  if (gates === "fail") {
    if (entry.attempts.fix < cfg.caps.fixRounds) {
      const log = verdict.gateRun
        ? verdict.gateRun.log
        : `The failed run's log could not be read. The failing checks: ${detail}`;
      return [
        record,
        // Numbered from the counter: a re-applied first label would make CI rounds endless.
        { kind: "label", add: `${cfg.labels.fixRound}${entry.attempts.fix + 1}` },
        { kind: "set", state: "fixing-ci", bump: "fix" },
        {
          kind: "dispatch",
          stage: "implement",
          mode: "fix",
          state: "fixing-ci",
          extra: { gateLog: `${GATE_LOG_HEADING}\n\n${log}` },
        },
      ];
    }
    const run = verdict.gateRun?.url ? ` The failed run: ${verdict.gateRun.url}` : "";
    return [
      record,
      // The source releases without a transition, so reconcile drops the entry; the worktree and
      // the local branch go now, or a later attempt finds them in its way. The pull request keeps
      // its remote branch.
      { kind: "remove-worktree", remote: false },
      {
        kind: "release",
        to: "blocked",
        reason: costed(
          `gates red after ${cfg.caps.fixRounds} fix rounds`,
          "a pull request whose gates would have passed waits for a human",
        ),
      },
      {
        kind: "comment",
        body: `${marker}\nThe required checks still fail after ${cfg.caps.fixRounds} fix rounds (${detail}).${run} The issue is released as blocked; a human decides how to go on.`,
      },
    ];
  }
  if (gates === "pass") {
    if (entry.state === "pr-open")
      return [record, { kind: "set", state: "mergeable", note: "gates green; awaiting a human" }];
    return [record];
  }
  // The pull request's own clock: the entry's `updatedAt` moves on every tick.
  if (gates === "silent" && silentFor > GATES_SILENT_MS) {
    const sha = entry.pushedSha ?? "the pushed head";
    return [
      record,
      { kind: "remove-worktree", remote: false },
      {
        kind: "release",
        to: "blocked",
        reason: costed(
          `no gate run for ${sha}`,
          "a pull request whose gates were only slow waits for a human",
        ),
      },
      {
        kind: "comment",
        body: `${marker}\nNo gate run reported for ${sha} in 20 minutes (${detail}). A skip marker in the commit subject or a paths filter in the workflow keeps the gates from starting; a human decides whether to amend the subject or re-run them.`,
      },
    ];
  }
  return [record];
}

/** Step 4: the issue to take, when the computed gate allows one. Resume-needed is never new work. */
export function newWork(situation: Situation, _cfg: ProjectConfig): { issue: number } | null {
  if (!situation.newWork.allowed) return null;
  const next = situation.queue[0];
  return next ? { issue: next.number } : null;
}

/**
 * The rows that answer a failed action: a label that could not be applied (the label is the
 * record of the round), a worktree that could not be recreated, a publish that refused. Null
 * for any other action: that failure is not the table's to answer.
 *
 * A failed label edit and a failed publish release blocked and nothing else, as the source
 * says: a `blocked` transition would send the entry through the cleanup, whose remote-branch
 * deletion closes an open pull request. The stage record, when there is one, is ended in place
 * (R51: the consuming path clears it), and the entry, its label gone, is dropped by the next
 * reconcile.
 */
export function onActionFailed(
  entry: TableEntry,
  action: Action,
  failure: { message: string; rebaseConflict?: boolean },
): Action[] | null {
  const why = failure.message.replace(/\s+/g, " ").trim().slice(0, 400);
  const releaseOnly = (reason: string): Action[] => [
    { kind: "release", to: "blocked", reason },
    ...(entry.stage ? [{ kind: "set", state: entry.state, stage: "none" } as const] : []),
  ];
  switch (action.kind) {
    case "label":
      return releaseOnly(
        costed(
          `the label ${action.add} could not be applied: ${why}`,
          "a round nobody recorded is spent again",
        ),
      );
    case "recreate-worktree":
      return blockWith(
        costed(
          `the worktree is gone and could not be recreated: ${why}`,
          "an issue whose branch could be restored waits for a human",
        ),
      );
    case "publish":
      return releaseOnly(
        failure.rebaseConflict
          ? costed("rebase conflict", "a change a human could rebase in a minute waits")
          : costed(`publish failed: ${why}`, "a reviewed change waits for a human"),
      );
    default:
      return null;
  }
}

/** The marker every triage comment starts with; the decision is what the rerun rule compares. */
export function triageMarker(decision: Triage["decision"]): string {
  return `<!-- autodev-triage decision="${decision}" -->`;
}

const TRIAGE_MARKER = /<!-- autodev-triage(?:\s+decision="([^"]*)")?\s*-->/;

/**
 * The decision of the last triage comment on an issue: null when there is none, `unknown` for
 * the source's bare `<!-- autodev-triage -->`, which carried no decision.
 */
export function previousTriageDecision(comments: Array<{ body: string }>): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = TRIAGE_MARKER.exec(comments[i]?.body ?? "");
    if (m) return m[1] ?? "unknown";
  }
  return null;
}

/**
 * A triage result, applied by the engine (design § 10): the label, and the comment only when the
 * decision changed since the last triage comment (the source's rerun rule).
 */
export function onTriage(triage: Triage, previous: string | null, cfg: ProjectConfig): Action[] {
  if (triage.decision === "skipped")
    return [{ kind: "note", text: `triage skipped: ${triage.reason}` }];
  const label = triage.decision === "ready" ? cfg.queue.ready : cfg.labels.needsShaping;
  const text = triage.comment.trim() !== "" ? triage.comment.trim() : `Triage: ${triage.reason}`;
  return [
    { kind: "label", add: label },
    previous === triage.decision
      ? {
          kind: "note",
          text: `triage ${triage.decision} again: the decision is unchanged, no new comment`,
        }
      : { kind: "comment", body: `${triageMarker(triage.decision)}\n${text}` },
  ];
}

/** The source's sleep table, in milliseconds. */
export const DELAYS = {
  stageRunning: 300_000,
  prsOnGates: 600_000,
  otherwise: 1_800_000,
  limitCap: 3_600_000,
} as const;

/** Step 5: the delay from the first row that applies. */
export function nextDelay(input: {
  draining: boolean;
  running: number;
  limitedUntil: string | null;
  prsOnGates: number;
  now: Date;
}): { stop: boolean; ms: number } {
  if (input.draining && input.running === 0) return { stop: true, ms: 0 };
  if (input.limitedUntil) {
    const until = new Date(input.limitedUntil).getTime() - input.now.getTime();
    if (until > 0) return { stop: false, ms: Math.min(until, DELAYS.limitCap) };
  }
  if (input.running > 0) return { stop: false, ms: DELAYS.stageRunning };
  if (input.prsOnGates > 0) return { stop: false, ms: DELAYS.prsOnGates };
  return { stop: false, ms: DELAYS.otherwise };
}
