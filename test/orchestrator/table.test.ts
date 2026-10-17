/**
 * The decision table as code (design C1, § 7.3): one test per row of the source
 * orchestrator's Step 2 table, per Step 2b bullet and per Step 3 bullet, plus the ownership
 * matrix the source's own skill test checked against `ownerStep`.
 *
 * Every test name cites the source row it covers, so a row that loses its branch fails a
 * test with its own name.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config/load.js";
import { ISSUE_STATES, type IssueState, type StageRun } from "../../src/engine/ledger/ledger.js";
import { evaluate } from "../../src/engine/merge/can-merge.js";
import type { DecidedFinding, Decision, DecisionAction } from "../../src/engine/review/decision.js";
import type { Stage } from "../../src/engine/review/reports.js";
import {
  CLEANUP_STATES,
  ownerStep,
  PR_STATES,
  WORKING_STATES,
  type Situation,
} from "../../src/engine/situation.js";
import type { PrView, RollupNode } from "../../src/forge/github.js";
import type { StageOutcome } from "../../src/orchestrator/stage.js";
import {
  CARRIED_HEADING,
  decisionLine,
  DELAYS,
  FINDINGS_HEADING,
  GATE_LOG_HEADING,
  newWork,
  nextDelay,
  NotOwned,
  onActionFailed,
  onPullRequest,
  onStageFinished,
  onStageLost,
  onStageRunning,
  onStalled,
  onTriage,
  ownerOf,
  OWNERSHIP,
  previousTriageDecision,
  triageMarker,
  type Action,
  type PrVerdict,
  type TableEntry,
} from "../../src/orchestrator/table.js";
import type { StageResult } from "../../src/runtimes/types.js";

const cfg = loadProjectConfig(resolve(import.meta.dirname, "../fixtures/projects/minimal"));
const NOW = new Date("2026-03-01T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function stageRun(stage: Stage, over: Partial<StageRun> = {}): StageRun {
  return {
    stage,
    mode: "fresh",
    pid: 4242,
    instance: "inst-1",
    startedAt: minutesAgo(5),
    processStartedAt: null,
    ...over,
  };
}

function entry(over: Partial<TableEntry> = {}): TableEntry {
  return {
    issue: 42,
    state: "implementing",
    attempts: { implement: 1, fix: 0, reviewRetry: 0, plan: 0 },
    pr: null,
    pushedSha: null,
    lastError: null,
    stage: stageRun("implement"),
    ...over,
  };
}

const result = (over: Partial<StageResult> = {}): StageResult => ({
  exit: "ok",
  resultText: "",
  stdoutFile: "",
  stderrFile: "",
  pid: 4242,
  startedAt: minutesAgo(5),
  ...over,
});
const reported = (text: string): StageOutcome => ({ kind: "report", text, result: result() });
const noReport = (over: Partial<StageResult> = {}): StageOutcome => ({
  kind: "no-report",
  result: result({ exit: "failed", ...over }),
});
const limitHit = (resetsAt: string): StageOutcome => ({
  kind: "limit",
  resetsAt,
  result: result({ exit: "limit" }),
});

const planText = (status: string, reason = "") =>
  [
    "AUTODEV-PLAN",
    "issue: 42",
    `status: ${status}`,
    `reason: ${reason}`,
    "db-migration-required: no",
    "plan-file: .autoclaude/state/plans/42.md",
    "AUTODEV-PLAN-END",
  ].join("\n");

const implementText = (status: string, reason = "") =>
  [
    "AUTODEV-REPORT",
    "issue: 42",
    `status: ${status}`,
    `reason: ${reason}`,
    "db-migration-required: no",
    "commit: 1234567",
    "criteria:",
    "  1. met — the parser trims the input",
    "tests-added: tests/parse.test.ts",
    "observed-not-done:",
    "  - nothing",
    "AUTODEV-REPORT-END",
  ].join("\n");

const finding = (rule: string) => ({ rule }) as unknown as DecidedFinding;

function decision(action: DecisionAction, over: Partial<Decision> = {}): Decision {
  return {
    action,
    round: 1,
    redStep: null,
    kept: [],
    blocking: [],
    deferred: [],
    demoted: [],
    dispatchMarkdown: "",
    label: null,
    escalate: false,
    reason: "the reason",
    releaseReason: null,
    ...over,
  };
}

const kinds = (actions: Action[]) => actions.map((a) => a.kind);
const ofKind = <K extends Action["kind"]>(actions: Action[], kind: K) =>
  actions.filter((a): a is Extract<Action, { kind: K }> => a.kind === kind);
const one = <K extends Action["kind"]>(actions: Action[], kind: K) => {
  const found = ofKind(actions, kind);
  expect(found, `exactly one ${kind} in ${JSON.stringify(actions)}`).toHaveLength(1);
  return found[0]!;
};

// --- the ownership table ------------------------------------------------------------

const stepName = (owner: ReturnType<typeof ownerStep>) =>
  owner === "none" ? "nothing" : `Step ${owner}`;
const OWNER_STEP: Record<string, string> = {
  onStageFinished: "Step 2",
  onStalled: "Step 2b",
  onPullRequest: "Step 3",
  none: "nothing",
};

/** One call into each handler for a (state, has-stage) pair; true when it accepted the entry. */
function accepts(state: IssueState, hasStage: boolean): Record<string, boolean> {
  const e = entry({
    state,
    stage: hasStage ? stageRun("implement") : null,
    pr: 7,
  });
  const tryIt = (fn: () => unknown) => {
    try {
      fn();
      return true;
    } catch (error) {
      if (error instanceof NotOwned) return false;
      throw error;
    }
  };
  return {
    onStageFinished: tryIt(() =>
      onStageFinished(e, "implement", reported(implementText("done")), null, cfg, NOW),
    ),
    onStalled: tryIt(() => onStalled(e, true, cfg)),
    onPullRequest: tryIt(() =>
      onPullRequest(e, { state: "OPEN", updatedAt: minutesAgo(1) }, null, cfg, NOW),
    ),
  };
}

/**
 * Ported from the source's skill test: the ledger's states and the steps are one state
 * machine written in two places, and what keeps falling through is a pair, not a state.
 * Here the second place is code, so the test runs the handlers instead of reading prose.
 */
describe("the table owns every (state, stage) pair", () => {
  it("has a row per ledger state and no row the ledger does not have", () => {
    expect(Object.keys(OWNERSHIP).sort()).toEqual([...ISSUE_STATES].sort());
  });

  for (const state of ISSUE_STATES) {
    it(`agrees with ownerStep for ${state}, with and without a stage`, () => {
      const row = OWNERSHIP[state];
      expect(OWNER_STEP[row.withStage], `${state} with a stage`).toBe(
        stepName(ownerStep(state, true)),
      );
      expect(OWNER_STEP[row.withoutStage], `${state} without a stage`).toBe(
        stepName(ownerStep(state, false)),
      );
      for (const hasStage of [true, false]) {
        const owner = ownerOf(state, hasStage);
        const accepted = Object.entries(accepts(state, hasStage))
          .filter(([, yes]) => yes)
          .map(([name]) => name);
        // Exactly one handler takes the pair, and it is the one the table names; `none`
        // is a pair no handler takes.
        expect(accepted, `${state}, stage ${hasStage}`).toEqual(owner === "none" ? [] : [owner]);
      }
    });
  }

  it("keeps a live stage with Step 2, which is what makes the pair rule work", () => {
    for (const state of ISSUE_STATES) expect(ownerOf(state, true)).toBe("onStageFinished");
  });

  it("sorts the stage-less states into exactly one of the three sets", () => {
    for (const state of ISSUE_STATES) {
      const sets = [WORKING_STATES.has(state), PR_STATES.has(state), CLEANUP_STATES.has(state)];
      const inOne = sets.filter(Boolean).length;
      expect(inOne, `${state} is in ${inOne} sets`).toBe(state === "done" ? 0 : 1);
    }
  });
});

describe("the steps the table points at", () => {
  it("Step 2 takes every entry with a stage, and hands the torn-down ones to Step 3", () => {
    for (const state of ISSUE_STATES) {
      const e = entry({ state, stage: stageRun("implement") });
      const finished = onStageFinished(e, "implement", reported(implementText("done")), null, cfg, NOW); // prettier-ignore
      expect(finished.length, state).toBeGreaterThan(0);
      if (CLEANUP_STATES.has(state) || ["pr-open", "mergeable", "done"].includes(state)) {
        // Source Step 2: "If the state is one Step 3 owns ... the stage is the only thing to
        // settle here": the record goes, the table is not applied.
        expect(finished).toEqual([
          { kind: "set", state, stage: "none", note: "stage stopped: the issue moved on" },
        ]);
        expect(kinds(onStageRunning(e, cfg, NOW))).toEqual(["stop-stage", "set"]);
      }
    }
  });

  it("Step 2b takes every stage-less working state, resume-needed included", () => {
    for (const state of WORKING_STATES) {
      expect(onStalled(entry({ state, stage: null }), true, cfg).length, state).toBeGreaterThan(0);
    }
  });

  it("Step 3 gives every cleanup state a bullet and clears the stage field", () => {
    let clears = 0;
    for (const state of CLEANUP_STATES) {
      const actions = onPullRequest(entry({ state, stage: null, pr: 7 }), null, null, cfg, NOW);
      expect(actions.length, state).toBeGreaterThan(0);
      clears += ofKind(actions, "set").filter((s) => s.stage === "none").length;
    }
    expect(clears, "each cleanup bullet ends the stage").toBe(CLEANUP_STATES.size);
  });

  it("Step 4 never claims resume-needed, which is in flight already", () => {
    const situation = {
      newWork: { allowed: true, reasons: [], claimedThisWindow: 0 },
      queue: [],
      issues: [{ issue: 9, state: "resume-needed" }],
    } as unknown as Situation;
    expect(newWork(situation, cfg)).toBeNull();
  });
});

// --- Step 2: the rows -----------------------------------------------------------------

describe("Step 2 rows: plan", () => {
  const planning = entry({ state: "planning", stage: stageRun("plan") });

  it("plan | status: planned — archive plan first, then dispatch plan-review", () => {
    const actions = onStageFinished(planning, "plan", reported(planText("planned")), null, cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "note", text: "decision review blocking=0 deferred=0" },
      { kind: "archive", stage: "plan" },
      { kind: "dispatch", stage: "plan-review", mode: "fresh", state: "plan-reviewing" },
    ]);
  });

  it("plan | status: planned from fixing-plan goes to plan-review again", () => {
    const fixing = entry({ state: "fixing-plan", stage: stageRun("plan", { mode: "fix" }) });
    const d = one(onStageFinished(fixing, "plan", reported(planText("planned")), null, cfg, NOW), "dispatch"); // prettier-ignore
    expect(d).toMatchObject({ stage: "plan-review", state: "plan-reviewing" });
  });

  it("plan | status: needs-shaping — release to needs-shaping and say the queue offered it", () => {
    const actions = onStageFinished(planning, "plan", reported(planText("needs-shaping", "no criteria")), null, cfg, NOW); // prettier-ignore
    expect(actions[0]).toEqual({ kind: "note", text: "decision shape blocking=0 deferred=0" });
    expect(one(actions, "release")).toEqual({
      kind: "release",
      to: "needs-shaping",
      reason: "no criteria",
    });
    expect(one(actions, "set")).toEqual({ kind: "set", state: "needs-shaping", error: "no criteria" }); // prettier-ignore
    // "The issue never should have carried labels.ready: say so in the tick summary."
    expect(ofKind(actions, "note")[1]?.text).toMatch(/agent-ready.*triage problem/);
  });

  it("plan | status: needs-human — release blocked with the reason and its cost", () => {
    const actions = onStageFinished(planning, "plan", reported(planText("needs-human", "two products")), null, cfg, NOW); // prettier-ignore
    expect(actions[0]).toEqual({ kind: "note", text: "decision block blocking=0 deferred=0" });
    const release = one(actions, "release");
    expect(release.to).toBe("blocked");
    expect(release.reason).toMatch(/^two products — if wrong, /);
    expect(one(actions, "set")).toMatchObject({ state: "blocked", error: release.reason });
  });
});

describe("Step 2 rows: plan-review (the decision is obeyed, never recomputed)", () => {
  const reviewing = entry({ state: "plan-reviewing", stage: stageRun("plan-review") });
  const md = "### Must (1)\n\n1. plan/criterion-uncovered\n\n### Deferred (should)\n\n1. x";

  it("plan-review | fix — archive, bump plan, dispatch plan fix with the Must under the heading", () => {
    const d = decision("fix", {
      blocking: [finding("plan/a")],
      deferred: [finding("plan/b"), finding("plan/c")],
      dispatchMarkdown: md,
    });
    const actions = onStageFinished(reviewing, "plan-review", reported("x"), d, cfg, NOW);
    expect(actions).toEqual([
      { kind: "note", text: "decision fix blocking=1 deferred=2" },
      { kind: "archive", stage: "plan-review" },
      { kind: "set", state: "fixing-plan", bump: "plan" },
      {
        kind: "dispatch",
        stage: "plan",
        mode: "fix",
        state: "fixing-plan",
        extra: { findingsMarkdown: `${FINDINGS_HEADING}\n\n${md}` },
      },
    ]);
  });

  it("plan-review | proceed — dispatch implement fresh, carrying the deferred findings not owed", () => {
    const carried = "### Deferred (should)\n\n1. tests/no-positive-control";
    const actions = onStageFinished(reviewing, "plan-review", reported("x"), decision("proceed", { deferred: [finding("t")], dispatchMarkdown: carried }), cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "note", text: "decision proceed blocking=0 deferred=1" },
      { kind: "archive", stage: "plan-review" },
      { kind: "set", state: "implementing", bump: "implement" },
      {
        kind: "dispatch",
        stage: "implement",
        mode: "fresh",
        state: "implementing",
        extra: { carriedMarkdown: `${CARRIED_HEADING}\n\n${carried}` },
      },
    ]);
  });

  it("plan-review | proceed with nothing deferred carries nothing", () => {
    const d = one(onStageFinished(reviewing, "plan-review", reported("x"), decision("proceed"), cfg, NOW), "dispatch"); // prettier-ignore
    expect(d.extra).toBeUndefined();
  });

  it("plan-review | block — release blocked with the decision's releaseReason", () => {
    const actions = onStageFinished(reviewing, "plan-review", reported("x"), decision("block", { blocking: [finding("p")], releaseReason: "plan rounds spent — if wrong, a criterion ships untested" }), cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "note", text: "decision block blocking=1 deferred=0" },
      { kind: "release", to: "blocked", reason: "plan rounds spent — if wrong, a criterion ships untested" }, // prettier-ignore
      { kind: "set", state: "blocked", error: "plan rounds spent — if wrong, a criterion ships untested" }, // prettier-ignore
    ]);
  });
});

describe("Step 2 rows: implement", () => {
  it("implement | status: done — archive the report and the plan file before the reviewer starts", () => {
    for (const state of ["implementing", "fixing-local", "fixing-ci"] as const) {
      const actions = onStageFinished(entry({ state }), "implement", reported(implementText("done")), null, cfg, NOW); // prettier-ignore
      // Every diff is read by a fresh context before it is pushed, a CI fix round included.
      expect(actions, state).toEqual([
        { kind: "note", text: "decision review blocking=0 deferred=0" },
        { kind: "archive", stage: "implement" },
        { kind: "archive", stage: "plan-file" },
        { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
      ]);
    }
  });

  it("implement | status: needs-shaping — release to needs-shaping", () => {
    const actions = onStageFinished(entry(), "implement", reported(implementText("needs-shaping", "criteria contradict")), null, cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "note", text: "decision shape blocking=0 deferred=0" },
      { kind: "release", to: "needs-shaping", reason: "criteria contradict" },
      { kind: "set", state: "needs-shaping", error: "criteria contradict" },
    ]);
  });

  it("implement | status: needs-human or blocked — release blocked", () => {
    for (const status of ["needs-human", "blocked"]) {
      const actions = onStageFinished(entry(), "implement", reported(implementText(status, "gate cannot run")), null, cfg, NOW); // prettier-ignore
      expect(actions[0], status).toEqual({ kind: "note", text: "decision block blocking=0 deferred=0" }); // prettier-ignore
      expect(one(actions, "release")).toMatchObject({ to: "blocked" });
      expect(one(actions, "release").reason).toMatch(/^gate cannot run — if wrong, /);
      expect(one(actions, "set")).toMatchObject({ state: "blocked" });
    }
  });
});

describe("Step 2 rows: code-review (the decision is obeyed, never recomputed)", () => {
  const reviewing = entry({ state: "code-reviewing", stage: stageRun("code-review") });
  const md = "### Must (1)\n\n1. bug/x\n\n### Deferred (later)\n\n1. later/y";

  it("code-review | fix — label from the decision, archive, bump fix, dispatch implement fix", () => {
    const d = decision("fix", {
      blocking: [finding("bug/x")],
      deferred: [finding("later/y")],
      dispatchMarkdown: md,
      label: "agent-fix-1",
    });
    const actions = onStageFinished(reviewing, "code-review", reported("x"), d, cfg, NOW);
    expect(actions).toEqual([
      { kind: "note", text: "decision fix blocking=1 deferred=1" },
      { kind: "label", add: "agent-fix-1" },
      { kind: "archive", stage: "code-review" },
      { kind: "set", state: "fixing-local", bump: "fix" },
      {
        kind: "dispatch",
        stage: "implement",
        mode: "fix",
        state: "fixing-local",
        extra: { findingsMarkdown: `${FINDINGS_HEADING}\n\n${md}` },
      },
    ]);
  });

  it("code-review | fix with escalate — the last round runs on the escalated spec, still in fix mode", () => {
    const d = decision("fix", { label: "agent-fix-2", escalate: true, dispatchMarkdown: md });
    const dispatch = one(onStageFinished(reviewing, "code-review", reported("x"), d, cfg, NOW), "dispatch"); // prettier-ignore
    expect(dispatch).toMatchObject({ stage: "implement", mode: "fix", extra: { escalated: true } });
  });

  it("code-review | block — release blocked with the decision's releaseReason", () => {
    const d = decision("block", { blocking: [finding("a"), finding("b")], releaseReason: "2 fix rounds are spent — if wrong, a regression ships" }); // prettier-ignore
    expect(onStageFinished(reviewing, "code-review", reported("x"), d, cfg, NOW)).toEqual([
      { kind: "note", text: "decision block blocking=2 deferred=0" },
      { kind: "release", to: "blocked", reason: "2 fix rounds are spent — if wrong, a regression ships" }, // prettier-ignore
      { kind: "set", state: "blocked", error: "2 fix rounds are spent — if wrong, a regression ships" }, // prettier-ignore
    ]);
  });

  it("code-review | retry — label, archive before the re-dispatch, bump retry (not fix), review fresh", () => {
    const d = decision("retry", { label: "agent-retry-1" });
    const actions = onStageFinished(reviewing, "code-review", reported("x"), d, cfg, NOW);
    expect(actions).toEqual([
      { kind: "note", text: "decision retry blocking=0 deferred=0" },
      { kind: "label", add: "agent-retry-1" },
      { kind: "archive", stage: "code-review" },
      { kind: "set", state: "code-reviewing", stage: "none", bump: "retry" },
      { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
    ]);
  });

  it("code-review | retry carries no bound of its own: a second retry the decision asks for is obeyed", () => {
    const second = entry({ ...reviewing, attempts: { implement: 1, fix: 0, reviewRetry: 1, plan: 0 } }); // prettier-ignore
    const actions = onStageFinished(second, "code-review", reported("x"), decision("retry", { label: "agent-retry-2" }), cfg, NOW); // prettier-ignore
    expect(one(actions, "label").add).toBe("agent-retry-2");
    expect(one(actions, "dispatch").stage).toBe("code-review");
  });

  it("code-review | publish — publish, with --update when the entry has a pull request", () => {
    expect(
      onStageFinished(
        reviewing,
        "code-review",
        reported("x"),
        decision("publish", { deferred: [finding("l")] }),
        cfg,
        NOW,
      ),
    ).toEqual([
      // prettier-ignore
      { kind: "note", text: "decision publish blocking=0 deferred=1" },
      { kind: "publish", update: false },
    ]);
    const withPr = entry({ ...reviewing, pr: 7 });
    expect(one(onStageFinished(withPr, "code-review", reported("x"), decision("publish"), cfg, NOW), "publish").update).toBe(true); // prettier-ignore
  });

  it("the fix dispatch's findings are the decision's own field, read before the archive moves the report", () => {
    const actions = onStageFinished(reviewing, "code-review", reported("x"), decision("fix", { dispatchMarkdown: md, label: "agent-fix-1" }), cfg, NOW); // prettier-ignore
    const archive = actions.findIndex((a) => a.kind === "archive");
    const dispatch = actions.findIndex((a) => a.kind === "dispatch");
    expect(archive).toBeGreaterThan(-1);
    expect(archive).toBeLessThan(dispatch);
    expect(one(actions, "dispatch").extra?.findingsMarkdown).toContain(md);
  });
});

describe("Step 2: a run that ended without a usable report", () => {
  it("limit — record the reset, drop the stage, mark it for a resume, bump nothing (quota is not the code's fault)", () => {
    const pairs = [
      ["plan", "fixing-plan"],
      ["implement", "fixing-ci"],
      ["plan-review", "plan-reviewing"],
      ["code-review", "code-reviewing"],
    ] as const;
    for (const [stage, state] of pairs) {
      const e = entry({ state, stage: stageRun(stage) });
      const actions = onStageFinished(e, stage, limitHit("2026-03-01T12:00:00.000Z"), null, cfg, NOW); // prettier-ignore
      expect(actions, stage).toEqual([
        { kind: "limit", until: "2026-03-01T12:00:00.000Z" },
        {
          kind: "set",
          state,
          stage: "none",
          note: "interrupted by the limit",
          limitedStage: stage,
        },
      ]);
      expect(ofKind(actions, "set")[0]?.bump, stage).toBeUndefined();
    }
  });

  it("limit — recorded even when the issue moved on under the stage, which is then only cleared", () => {
    const e = entry({ state: "closed", stage: stageRun("implement") });
    expect(
      onStageFinished(e, "implement", limitHit("2026-03-01T12:00:00.000Z"), null, cfg, NOW),
    ).toEqual([
      // prettier-ignore
      { kind: "limit", until: "2026-03-01T12:00:00.000Z" },
      { kind: "set", state: "closed", stage: "none", note: "stage stopped: the issue moved on" },
    ]);
  });

  it("limit — a review's limit wins over any report on disk (decided by the outcome, not the file)", () => {
    const e = entry({ state: "code-reviewing", stage: stageRun("code-review") });
    const stale = decision("publish");
    expect(kinds(onStageFinished(e, "code-review", limitHit("2026-03-01T12:00:00.000Z"), stale, cfg, NOW))).toEqual(["limit", "set"]); // prettier-ignore
  });

  it("no report, retries left — label the retry from its counter, bump retry, re-dispatch the same stage", () => {
    const e = entry({ state: "fixing-local", attempts: { implement: 1, fix: 1, reviewRetry: 1, plan: 0 } }); // prettier-ignore
    expect(onStageFinished(e, "implement", noReport(), null, cfg, NOW)).toEqual([
      { kind: "label", add: "agent-retry-2" },
      { kind: "set", state: "fixing-local", stage: "none", bump: "retry" },
      { kind: "dispatch", stage: "implement", mode: "resume", state: "fixing-local" },
    ]);
  });

  it("no report on plan — re-dispatched fresh, because the plan prompt has no resume mode (F2 ruling)", () => {
    const e = entry({ state: "planning", stage: stageRun("plan") });
    expect(one(onStageFinished(e, "plan", noReport(), null, cfg, NOW), "dispatch")).toEqual({
      kind: "dispatch",
      stage: "plan",
      mode: "fresh",
      state: "planning",
    });
  });

  it("no report on a review — the reviews have no modes, so the re-dispatch is fresh", () => {
    for (const [stage, state] of [
      ["code-review", "code-reviewing"],
      ["plan-review", "plan-reviewing"],
    ] as const) {
      // prettier-ignore
      const e = entry({ state, stage: stageRun(stage) });
      expect(one(onStageFinished(e, stage, noReport(), null, cfg, NOW), "dispatch")).toMatchObject({ stage, mode: "fresh", state }); // prettier-ignore
    }
  });

  it("a report that does not parse is a run that failed", () => {
    const actions = onStageFinished(entry(), "implement", reported("no block at all"), null, cfg, NOW); // prettier-ignore
    expect(kinds(actions)).toEqual(["label", "set", "dispatch"]);
  });

  it("a review report the decision could not read (stopped, incomplete) is a run that failed", () => {
    const e = entry({ state: "code-reviewing", stage: stageRun("code-review") });
    expect(kinds(onStageFinished(e, "code-review", reported("x"), null, cfg, NOW))).toEqual(["label", "set", "dispatch"]); // prettier-ignore
  });

  it("no report and the retry cap spent — release blocked 'run ended without a report, twice'", () => {
    const e = entry({ attempts: { implement: 1, fix: 0, reviewRetry: 2, plan: 0 } });
    const actions = onStageFinished(e, "implement", noReport(), null, cfg, NOW);
    expect(kinds(actions)).toEqual(["release", "set"]);
    expect(one(actions, "release")).toMatchObject({ to: "blocked" });
    expect(one(actions, "release").reason).toMatch(/^run ended without a report, twice — if wrong, /); // prettier-ignore
    expect(one(actions, "set")).toMatchObject({ state: "blocked" });
  });

  it("still running past the wall clock — stop it, note it, release blocked (the rule a process keeps)", () => {
    const e = entry({ stage: stageRun("code-review", { startedAt: minutesAgo(61) }), state: "code-reviewing" }); // prettier-ignore
    const actions = onStageRunning(e, cfg, NOW);
    expect(actions).toEqual([
      { kind: "stop-stage" },
      { kind: "note", text: "wall clock: stopped code-review after 61m" },
      { kind: "release", to: "blocked", reason: expect.stringMatching(/^wall clock: code-review ran 61 minutes — if wrong, /) }, // prettier-ignore
      { kind: "set", state: "blocked", error: "wall clock: code-review" },
    ]);
    expect(onStageRunning(entry({ stage: stageRun("implement", { startedAt: minutesAgo(59) }) }), cfg, NOW)).toEqual([]); // prettier-ignore
  });

  it("a stage the runtime timed out without a report is the wall-clock row, not a retry", () => {
    const e = entry({ stage: stageRun("implement", { startedAt: minutesAgo(60) }) });
    const actions = onStageFinished(e, "implement", noReport({ exit: "timeout" }), null, cfg, NOW);
    expect(actions).toEqual([
      { kind: "note", text: "wall clock: stopped implement after 60m" },
      { kind: "release", to: "blocked", reason: expect.stringMatching(/^wall clock: implement ran 60 minutes/) }, // prettier-ignore
      { kind: "set", state: "blocked", error: "wall clock: implement" },
    ]);
  });

  it("a stage this instance does not know — 'stage lost with its session', resume-needed", () => {
    expect(onStageLost(entry())).toEqual([
      { kind: "set", state: "resume-needed", stage: "none", note: "stage lost with its session" },
    ]);
    expect(onStageLost(entry({ state: "closed" }))).toEqual([
      { kind: "set", state: "closed", stage: "none", note: "stage stopped: the issue moved on" },
    ]);
  });
});

describe("Step 2: late reports (R51: a stage whose report outlived its process)", () => {
  it("a complete report of the stage a restart interrupted is decided, not re-run", () => {
    const e = entry({ state: "resume-needed", stage: null });
    const actions = onStalled(e, true, cfg, {
      stage: "implement",
      outcome: reported(implementText("done")),
      decision: null,
    });
    expect(actions[0]).toEqual({
      kind: "note",
      text: "late report from implement: its process finished before the restart; deciding it",
    });
    expect(actions.slice(1)).toEqual([
      { kind: "note", text: "decision review blocking=0 deferred=0" },
      { kind: "archive", stage: "implement" },
      { kind: "archive", stage: "plan-file" },
      { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
    ]);
  });

  it("a late review report is decided on the state its stage works in", () => {
    const e = entry({ state: "resume-needed", stage: null });
    const actions = onStalled(e, true, cfg, { stage: "code-review", outcome: reported("x"), decision: decision("retry", { label: "agent-retry-1" }) }); // prettier-ignore
    expect(one(actions, "set")).toEqual({ kind: "set", state: "code-reviewing", stage: "none", bump: "retry" }); // prettier-ignore
  });
});

// --- Step 2b ---------------------------------------------------------------------------

describe("Step 2b: entries whose stage is gone", () => {
  it("claimed — nothing has run yet: dispatch plan fresh, no counter", () => {
    expect(onStalled(entry({ state: "claimed", stage: null }), true, cfg)).toEqual([
      { kind: "dispatch", stage: "plan", mode: "fresh", state: "planning" },
    ]);
  });

  it("a working state — re-dispatch the stage it names, resume where the stage has modes, bump retry", () => {
    const cases = [
      ["planning", "plan", "fresh"],
      ["fixing-plan", "plan", "fresh"],
      ["plan-reviewing", "plan-review", "fresh"],
      ["implementing", "implement", "resume"],
      ["fixing-local", "implement", "resume"],
      ["code-reviewing", "code-review", "fresh"],
    ] as const;
    for (const [state, stage, mode] of cases) {
      expect(onStalled(entry({ state, stage: null }), true, cfg), state).toEqual([
        { kind: "set", state, bump: "retry" },
        { kind: "dispatch", stage, mode, state },
      ]);
    }
  });

  it("the re-dispatch is bounded by the retry counter: 'stage re-dispatched <cap> times with no report'", () => {
    const e = entry({ state: "implementing", stage: null, attempts: { implement: 1, fix: 0, reviewRetry: 2, plan: 0 } }); // prettier-ignore
    const actions = onStalled(e, true, cfg);
    expect(kinds(actions)).toEqual(["release", "set"]);
    expect(one(actions, "release").reason).toMatch(/^stage re-dispatched 2 times with no report — if wrong, /); // prettier-ignore
  });

  it("a stage a limit interrupted — resumed once the limit has passed, no counter and no bound (design § 9)", () => {
    const spent = { implement: 1, fix: 1, reviewRetry: 2, plan: 0 };
    const cases = [
      ["implementing", "implement", "resume"],
      ["fixing-local", "implement", "resume"],
      ["planning", "plan", "fresh"],
      ["code-reviewing", "code-review", "fresh"],
    ] as const;
    for (const [state, stage, mode] of cases) {
      const e = entry({ state, stage: null, limitedStage: stage, attempts: spent });
      // The retry cap is spent, and the resume still goes: a limit is not a failed run.
      expect(onStalled(e, true, cfg), state).toEqual([{ kind: "dispatch", stage, mode, state }]);
    }
    expect(
      onStalled(
        entry({ state: "implementing", stage: null, limitedStage: "implement" }),
        false,
        cfg,
      ),
    ).toEqual([
      // prettier-ignore
      { kind: "recreate-worktree" },
      { kind: "dispatch", stage: "implement", mode: "fresh", state: "implementing" },
    ]);
  });

  it("resume-needed — a review is the cheapest way to find out what the worktree holds", () => {
    expect(onStalled(entry({ state: "resume-needed", stage: null }), true, cfg)).toEqual([
      { kind: "dispatch", stage: "code-review", mode: "fresh", state: "code-reviewing" },
    ]);
  });

  it("worktreeExists false — recreate it first and dispatch fresh, because nothing local survived", () => {
    expect(onStalled(entry({ state: "implementing", stage: null }), false, cfg)).toEqual([
      { kind: "recreate-worktree" },
      { kind: "set", state: "implementing", bump: "retry" },
      { kind: "dispatch", stage: "implement", mode: "fresh", state: "implementing" },
    ]);
    expect(kinds(onStalled(entry({ state: "resume-needed", stage: null }), false, cfg))).toEqual([
      "recreate-worktree",
      "dispatch",
    ]);
  });

  it("the worktree could not be recreated — 'the worktree is gone and could not be recreated'", () => {
    const actions = onActionFailed(entry({ stage: null }), { kind: "recreate-worktree" }, { message: "fetch failed" }); // prettier-ignore
    expect(kinds(actions ?? [])).toEqual(["release", "set"]);
    expect(one(actions ?? [], "release").reason).toMatch(/^the worktree is gone and could not be recreated: fetch failed — if wrong, /); // prettier-ignore
  });
});

// --- Step 3 ----------------------------------------------------------------------------

const prView = (rollup: RollupNode[]): PrView => ({
  number: 7,
  state: "OPEN",
  mergedAt: null,
  headRefName: "agent/42-fix-it",
  headRefOid: "abc",
  baseRefName: "develop",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: rollup,
  labels: [],
  url: "https://github.com/acme/widgets/pull/7",
  updatedAt: minutesAgo(30),
  isDraft: false,
});
const verdictOf = (rollup: RollupNode[], gateRun?: PrVerdict["gateRun"]): PrVerdict => ({
  ...evaluate({ pr: prView(rollup), files: [], behind: false, review: null }, cfg),
  ...(gateRun !== undefined && { gateRun }),
});
const node = (name: string, conclusion: string | null, status = "COMPLETED"): RollupNode => ({
  name,
  status,
  conclusion,
});
const open = (updated = 30) => ({ state: "OPEN" as const, updatedAt: minutesAgo(updated) });
const prEntry = (over: Partial<TableEntry> = {}) =>
  entry({ state: "pr-open", stage: null, pr: 7, pushedSha: "abc1234", ...over });

describe("Step 3: the cleanup list", () => {
  it("merged — remove the worktree with its remote branch, release done 'merged as #<pr>'", () => {
    expect(
      onPullRequest(entry({ state: "merged", stage: null, pr: 7 }), null, null, cfg, NOW),
    ).toEqual([
      { kind: "remove-worktree", remote: true },
      { kind: "release", to: "done", reason: "merged as #7" },
      { kind: "set", state: "done", stage: "none" },
    ]);
  });

  it("closed — remove the worktree without --remote (deleting the branch would close a pull request)", () => {
    const actions = onPullRequest(entry({ state: "closed", stage: null, pr: 7 }), null, null, cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "remove-worktree", remote: false },
      { kind: "release", to: "done", reason: "issue closed by a human" },
      { kind: "set", state: "done", stage: "none" },
      { kind: "note", text: "the remote branch was left behind for pull request #7" },
    ]);
  });

  it("blocked — remove with the remote branch, release blocked quoting lastError, clear the pull request", () => {
    const e = entry({ state: "blocked", stage: null, pr: 7, lastError: "pull request #7 closed without merge" }); // prettier-ignore
    expect(onPullRequest(e, null, null, cfg, NOW)).toEqual([
      { kind: "remove-worktree", remote: true },
      { kind: "release", to: "blocked", reason: "pull request #7 closed without merge" },
      { kind: "set", state: "blocked", pr: "none", stage: "none" },
    ]);
  });

  it("blocked with its pull request still open — the remote branch stays, so no cleanup closes a PR", () => {
    // Wall clock, a review block or needs-human during a CI fix round: the entry is blocked
    // while its pull request is open, and deleting the branch would close it.
    const e = entry({ state: "blocked", stage: null, pr: 7, lastError: "wall clock: implement" });
    expect(onPullRequest(e, open(), null, cfg, NOW)).toEqual([
      { kind: "remove-worktree", remote: false },
      { kind: "release", to: "blocked", reason: "wall clock: implement" },
      { kind: "set", state: "blocked", pr: "none", stage: "none" },
      { kind: "note", text: "the remote branch was kept: pull request #7 is still open" },
    ]);
  });

  it("needs-shaping — remove the worktree, release needs-shaping quoting lastError", () => {
    const e = entry({ state: "needs-shaping", stage: null, lastError: "criteria contradict" });
    expect(onPullRequest(e, null, null, cfg, NOW)).toEqual([
      { kind: "remove-worktree", remote: false },
      { kind: "release", to: "needs-shaping", reason: "criteria contradict" },
      { kind: "set", state: "needs-shaping", stage: "none" },
    ]);
  });
});

describe("Step 3: pull requests with no running stage", () => {
  it("prState MERGED — as the cleanup list's merged bullet", () => {
    expect(kinds(onPullRequest(prEntry(), { state: "MERGED", updatedAt: minutesAgo(1) }, null, cfg, NOW))).toEqual(["remove-worktree", "release", "set"]); // prettier-ignore
  });

  it("prState CLOSED — as the cleanup list's blocked bullet: 'not like this', never 'again'", () => {
    const actions = onPullRequest(prEntry(), { state: "CLOSED", updatedAt: minutesAgo(1) }, null, cfg, NOW); // prettier-ignore
    expect(actions[0]).toEqual({ kind: "remove-worktree", remote: true });
    expect(one(actions, "release")).toMatchObject({ to: "blocked" });
    expect(one(actions, "set")).toEqual({ kind: "set", state: "blocked", pr: "none", stage: "none" }); // prettier-ignore
  });

  it("prState OPEN — the can-merge verdict is recorded on every pass, one line", () => {
    const pending = onPullRequest(prEntry(), open(), verdictOf([node("test", null, "IN_PROGRESS")]), cfg, NOW); // prettier-ignore
    // "anything pending: leave it" — the verdict line is all that happens.
    expect(pending).toEqual([
      { kind: "set", state: "pr-open", canMerge: "REFUSED: required checks, no blocking findings, diff matches the review" }, // prettier-ignore
    ]);
  });

  it("check 2 fail on a required check, fix rounds left — label the round, dispatch implement fix with the log", () => {
    const run = { url: "https://github.com/acme/widgets/actions/runs/9", log: "test failed: x" };
    const actions = onPullRequest(prEntry(), open(), verdictOf([node("test", "FAILURE")], run), cfg, NOW); // prettier-ignore
    expect(actions.slice(1)).toEqual([
      { kind: "label", add: "agent-fix-1" },
      { kind: "set", state: "fixing-ci", bump: "fix" },
      {
        kind: "dispatch",
        stage: "implement",
        mode: "fix",
        state: "fixing-ci",
        extra: { gateLog: `${GATE_LOG_HEADING}\n\ntest failed: x` },
      },
    ]);
  });

  it("the fix label is numbered from the counter, so CI fix rounds cannot repeat endlessly", () => {
    const e = prEntry({ state: "fixing-ci", attempts: { implement: 1, fix: 1, reviewRetry: 0, plan: 0 } }); // prettier-ignore
    expect(one(onPullRequest(e, open(), verdictOf([node("test", "FAILURE")], null), cfg, NOW), "label").add).toBe("agent-fix-2"); // prettier-ignore
  });

  it("check 2 fail with the cap reached — release blocked 'gates red after <cap> fix rounds' and comment with the run", () => {
    const e = prEntry({ attempts: { implement: 1, fix: 2, reviewRetry: 0, plan: 0 } });
    const run = { url: "https://github.com/acme/widgets/actions/runs/9", log: "" };
    const actions = onPullRequest(e, open(), verdictOf([node("test", "FAILURE")], run), cfg, NOW); // prettier-ignore
    expect(kinds(actions)).toEqual(["set", "remove-worktree", "release", "comment"]);
    // The worktree and the local branch go; the pull request keeps its remote branch.
    expect(one(actions, "remove-worktree").remote).toBe(false);
    expect(one(actions, "release").reason).toMatch(/^gates red after 2 fix rounds — if wrong, /);
    expect(one(actions, "comment").body).toContain(run.url);
  });

  it("check 2 pass in pr-open — mergeable, 'gates green; awaiting a human'; nothing merges", () => {
    const actions = onPullRequest(prEntry(), open(), verdictOf([node("test", "SUCCESS")]), cfg, NOW); // prettier-ignore
    expect(actions).toEqual([
      { kind: "set", state: "pr-open", canMerge: "REFUSED: no blocking findings, diff matches the review" }, // prettier-ignore
      { kind: "set", state: "mergeable", note: "gates green; awaiting a human" },
    ]);
    // Phase 1 never merges: an entry already mergeable gets its verdict line and nothing else.
    expect(kinds(onPullRequest(prEntry({ state: "mergeable" }), open(), verdictOf([node("test", "SUCCESS")]), cfg, NOW))).toEqual(["set"]); // prettier-ignore
  });

  it("check 2 fail naming only 'not reported' or 'skipped' checks, 20 minutes on the PR's own clock — no gate run", () => {
    for (const rollup of [[node("lint", "SUCCESS")], [node("test", "SKIPPED")]]) {
      const actions = onPullRequest(prEntry(), open(21), verdictOf(rollup), cfg, NOW);
      expect(kinds(actions), JSON.stringify(rollup)).toEqual(["set", "remove-worktree", "release", "comment"]); // prettier-ignore
      expect(one(actions, "remove-worktree").remote).toBe(false);
      expect(one(actions, "release").reason).toMatch(/^no gate run for abc1234 — if wrong, /);
    }
  });

  it("check 2 fail with an empty rollup, 20 minutes on the PR's own clock — no gate run; before that, wait", () => {
    expect(kinds(onPullRequest(prEntry(), open(21), verdictOf([]), cfg, NOW))).toEqual(["set", "remove-worktree", "release", "comment"]); // prettier-ignore
    // The pull request's own clock decides, not the entry's: 19 minutes is still waiting.
    expect(kinds(onPullRequest(prEntry(), open(19), verdictOf([]), cfg, NOW))).toEqual(["set"]);
  });

  it("an implement a limit interrupted in fixing-ci — resumed, not answered with a new fix round", () => {
    const e = prEntry({ state: "fixing-ci", limitedStage: "implement", attempts: { implement: 1, fix: 2, reviewRetry: 0, plan: 0 } }); // prettier-ignore
    // Red gates and the fix cap spent: still a resume, no label, no counter, no release.
    expect(onPullRequest(e, open(), verdictOf([node("test", "FAILURE")], null), cfg, NOW)).toEqual([
      // prettier-ignore
      { kind: "dispatch", stage: "implement", mode: "resume", state: "fixing-ci" },
    ]);
    expect(onPullRequest(e, open(), null, cfg, NOW)).toEqual([
      { kind: "dispatch", stage: "implement", mode: "resume", state: "fixing-ci" },
    ]);
  });

  it("never produces a merge: every action of every verdict is one the union names", () => {
    const allowed = new Set(["set", "label", "dispatch", "release", "comment", "remove-worktree", "note"]); // prettier-ignore
    for (const rollup of [[], [node("test", "SUCCESS")], [node("test", "FAILURE")]]) {
      for (const a of onPullRequest(prEntry(), open(30), verdictOf(rollup, null), cfg, NOW))
        expect(allowed.has(a.kind), a.kind).toBe(true);
    }
  });
});

// --- action failures, triage, Step 4, the delay table, the decision line ---------------

describe("a failed action releases blocked quoting it", () => {
  it("the retry label could not be applied — release blocked quoting the edit's error, and no blocked transition", () => {
    const actions = onActionFailed(entry({ state: "code-reviewing" }), { kind: "label", add: "agent-retry-1" }, { message: "gh: HTTP 502" }); // prettier-ignore
    // The release only, as the source says; the stage record ends in place (R51). A `blocked`
    // transition would send the entry to the cleanup, whose branch deletion closes a PR.
    expect(actions).toEqual([
      { kind: "release", to: "blocked", reason: expect.stringMatching(/agent-retry-1.*gh: HTTP 502/) }, // prettier-ignore
      { kind: "set", state: "code-reviewing", stage: "none" },
    ]);
    // A CI fix round's label has no stage to end: the release is all.
    const ci = onActionFailed(entry({ state: "pr-open", stage: null }), { kind: "label", add: "agent-fix-1" }, { message: "x" }); // prettier-ignore
    expect(kinds(ci ?? [])).toEqual(["release"]);
  });

  it("publish exit 3 — release blocked 'rebase conflict'; any other failure quotes the output; no blocked transition", () => {
    const conflict = onActionFailed(entry({ state: "code-reviewing" }), { kind: "publish", update: false }, { message: "CONFLICT", rebaseConflict: true }); // prettier-ignore
    expect(one(conflict ?? [], "release").reason).toMatch(/^rebase conflict — if wrong, /);
    expect(ofKind(conflict ?? [], "set")).toEqual([{ kind: "set", state: "code-reviewing", stage: "none" }]); // prettier-ignore
    const other = onActionFailed(entry(), { kind: "publish", update: false }, { message: "the diff touches forbidden paths" }); // prettier-ignore
    expect(one(other ?? [], "release").reason).toMatch(/^publish failed: the diff touches forbidden paths — if wrong, /); // prettier-ignore
    expect(ofKind(other ?? [], "set").some((a) => a.state === "blocked")).toBe(false);
  });

  it("any other action's failure is not the table's to handle", () => {
    expect(
      onActionFailed(entry(), { kind: "note", text: "x" }, { message: "disk full" }),
    ).toBeNull();
  });
});

describe("triage results are applied by the engine (design § 10)", () => {
  const triage = (decision: "ready" | "needs-shaping" | "skipped", comment = "Triage: meets the standard") => ({ decision, reason: "the reason", comment }); // prettier-ignore

  it("ready — apply the ready label and post the comment under the triage marker", () => {
    expect(onTriage(triage("ready"), null, cfg)).toEqual([
      { kind: "label", add: "agent-ready" },
      { kind: "comment", body: `${triageMarker("ready")}\nTriage: meets the standard` },
    ]);
  });

  it("needs-shaping — apply the needs-shaping label and post the comment", () => {
    expect(onTriage(triage("needs-shaping", "Proposed acceptance criteria"), "ready", cfg)).toEqual(
      [
        { kind: "label", add: "needs-shaping" },
        { kind: "comment", body: `${triageMarker("needs-shaping")}\nProposed acceptance criteria` },
      ],
    );
  });

  it("skipped — no label and no comment", () => {
    expect(onTriage(triage("skipped", ""), null, cfg)).toEqual([
      { kind: "note", text: "triage skipped: the reason" },
    ]);
  });

  it("an unchanged decision posts no new comment (source triage Step 4)", () => {
    const actions = onTriage(triage("ready"), "ready", cfg);
    expect(kinds(actions)).toEqual(["label", "note"]);
  });

  it("finds the last triage decision by its marker, including the source's bare marker", () => {
    const at = (body: string) => ({ body });
    expect(previousTriageDecision([at("hello")])).toBeNull();
    expect(previousTriageDecision([at(`${triageMarker("ready")}\nx`), at(`${triageMarker("needs-shaping")}\ny`)])).toBe("needs-shaping"); // prettier-ignore
    // A comment the source wrote carries `<!-- autodev-triage -->` and no decision: unknown,
    // which differs from every decision, so the engine says where it stands now.
    expect(previousTriageDecision([at("<!-- autodev-triage -->\nTriage: ...")])).toBe("unknown");
    expect(triageMarker("ready").startsWith("<!-- autodev-triage")).toBe(true);
  });
});

describe("Step 4: new work", () => {
  const sit = (allowed: boolean, queue: number[]) =>
    ({
      newWork: { allowed, reasons: allowed ? [] : ["paused"], claimedThisWindow: 0 },
      queue: queue.map((number) => ({ number, title: `Issue ${number}` })),
      issues: [],
    }) as unknown as Situation;

  it("takes the first issue of the queue when the gate allows, and nothing against it", () => {
    expect(newWork(sit(true, [12, 3]), cfg)).toEqual({ issue: 12 });
    expect(newWork(sit(false, [12, 3]), cfg)).toBeNull();
    expect(newWork(sit(true, []), cfg)).toBeNull();
  });
});

describe("Step 5: the delay table, first row that applies", () => {
  const base = { draining: false, running: 0, limitedUntil: null, prsOnGates: 0, now: NOW };

  it("draining and nothing running — stop", () => {
    expect(nextDelay({ ...base, draining: true })).toEqual({ stop: true, ms: 0 });
    expect(nextDelay({ ...base, draining: true, running: 1 })).toEqual({ stop: false, ms: 300_000 }); // prettier-ignore
  });

  it("limitedUntil in the future — until then, capped at 3600 s", () => {
    expect(nextDelay({ ...base, running: 1, limitedUntil: minutesAgo(-10) })).toEqual({ stop: false, ms: 600_000 }); // prettier-ignore
    expect(nextDelay({ ...base, limitedUntil: minutesAgo(-120) })).toEqual({ stop: false, ms: 3_600_000 }); // prettier-ignore
    expect(nextDelay({ ...base, limitedUntil: minutesAgo(10) }).ms, "a passed limit is no row").toBe(1_800_000); // prettier-ignore
  });

  it("a stage running 300 s, pull requests on their gates 600 s, otherwise 1800 s", () => {
    expect(nextDelay({ ...base, running: 2, prsOnGates: 1 }).ms).toBe(300_000);
    expect(nextDelay({ ...base, prsOnGates: 1 }).ms).toBe(600_000);
    expect(nextDelay(base).ms).toBe(1_800_000);
    expect(DELAYS).toEqual({
      stageRunning: 300_000,
      prsOnGates: 600_000,
      otherwise: 1_800_000,
      limitCap: 3_600_000,
    });
  });
});

describe("the decision line", () => {
  it("is the source's format byte for byte", () => {
    expect(decisionLine("fix", 2, 1)).toBe("decision fix blocking=2 deferred=1");
  });
});
