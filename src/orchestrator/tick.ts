/**
 * One orchestrator tick: the source skill's Steps 1 to 5 in code.
 *
 *   Step 1  the situation (reconciled with GitHub; this instance's stages are the live ones)
 *   Step 2  every entry with a stage: still running (wall clock), finished (the table), or a
 *           record no task of this instance holds (lost with its session)
 *   Step 2b every working entry whose stage is gone, re-dispatched — or, after a restart, its
 *           interrupted stage's report decided when it outlived the process (R51)
 *   Step 3  the cleanup list, then the pull requests with no running stage
 *   Step 4  one new issue, when the computed gate allows it
 *   Step 5  the delay from the source's table
 *
 * One transition per issue per tick, except where the source hands an entry on within the tick
 * (a stage stopped under an issue that moved on goes to Step 3 at once). Paused or draining runs
 * Steps 2 and 3 only; an active usage limit dispatches nothing. Every decision is noted in the
 * source's format before it is acted on.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldNote, loadLedger, type Ledger } from "../engine/ledger/ledger.js";
import {
  isReportComplete,
  parseImplementReport,
  parsePlanReport,
  reportPath,
  type Stage,
} from "../engine/review/reports.js";
import { PR_STATES, type Situation, type SituationIssue } from "../engine/situation.js";
import { engineDeps, execute, takeIssue, type EngineDeps, type TickCtx } from "./actions.js";
import type { StageOutcome } from "./stage.js";
import {
  gateState,
  movedOn,
  newWork,
  nextDelay,
  onPullRequest,
  onStageFinished,
  onStageLost,
  onStageRunning,
  onStalled,
  ownerOf,
  stageForState,
  type Action,
  type GateRun,
  type LateReport,
  type PrVerdict,
} from "./table.js";

export interface TickSummary {
  /** What changed, one line per issue acted on. */
  changed: string[];
  /** The issues whose stage is running when the tick ends. */
  running: number[];
  /** What the orchestrator waits for: gates, humans, the limit, the controls, the queue. */
  waiting: string[];
  nextWakeMs: number;
  /** Draining with nothing running: the loop ends (the source's `stop: true`). */
  stop: boolean;
}

const isReview = (stage: Stage): stage is "code-review" | "plan-review" =>
  stage === "code-review" || stage === "plan-review";

const future = (iso: string | null, now: Date) => iso !== null && new Date(iso) > now;
const hasDispatch = (actions: Action[]) => actions.some((a) => a.kind === "dispatch");

/** A gate log larger than this keeps its tail: the failure is at the end. */
const GATE_LOG_MAX = 30_000;

function reviewDecisionFor(
  ctx: TickCtx,
  d: EngineDeps,
  issue: number,
  stage: "code-review" | "plan-review",
) {
  const r = d.reviewDecision(issue, { root: ctx.root, stage, cfg: ctx.cfg });
  if (r.code !== 0 || r.decision === null) {
    ctx.notes(issue, r.message);
    return null;
  }
  return r.decision;
}

/**
 * The stage a restart interrupted: the last transition into `resume-needed` names it (the
 * reconcile's "stage <name> belonged to instance …"), or its `from` state does.
 */
function interruptedStage(ledger: Ledger, issue: number): Stage | null {
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    const ev = ledger.events[i];
    if (!ev || ev.issue !== issue || ev.to !== "resume-needed") continue;
    const named = /^stage (plan-review|code-review|plan|implement) belonged to instance /.exec(
      ev.note ?? "",
    );
    return (named?.[1] as Stage | undefined) ?? stageForState(ev.from);
  }
  return null;
}

/**
 * R51: a `resume-needed` entry whose interrupted stage left a complete report — the process
 * exited and the orchestrator died before it consumed the outcome. That report is decided.
 */
function lateReport(
  ctx: TickCtx,
  d: EngineDeps,
  e: SituationIssue,
  ledger: Ledger,
): LateReport | undefined {
  const stage = interruptedStage(ledger, e.issue);
  if (stage === null || !e.worktree) return undefined;
  const file = join(e.worktree, reportPath(stage));
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  const outcome: StageOutcome = {
    kind: "report",
    text,
    result: {
      exit: "ok",
      resultText: "",
      stdoutFile: "",
      stderrFile: "",
      pid: 0,
      startedAt: ctx.now().toISOString(),
    },
  };
  try {
    if (stage === "plan") parsePlanReport(text);
    else if (stage === "implement") parseImplementReport(text);
    else if (!isReportComplete(stage, text)) return undefined;
  } catch {
    return undefined;
  }
  if (!isReview(stage)) return { stage, outcome, decision: null };
  const decision = reviewDecisionFor(ctx, d, e.issue, stage);
  return decision === null ? undefined : { stage, outcome, decision };
}

/**
 * The run behind a red required check: the newest failed run of the pull request's current head.
 * A failed run of an earlier head is not this failure, and its log would send a fix round after
 * something already fixed.
 */
function gateRun(ctx: TickCtx, e: SituationIssue, pr: number): GateRun | null {
  try {
    const head = ctx.forge.viewPr(pr).headRefOid;
    const run = ctx.forge
      .listRuns(e.branch)
      .find((r) => r.conclusion === "failure" && r.headSha === head);
    if (!run) return null;
    const log = ctx.forge.runFailedLog(run.databaseId);
    return {
      url: run.url,
      log: log.length > GATE_LOG_MAX ? `...${log.slice(-GATE_LOG_MAX)}` : log,
    };
  } catch (error) {
    ctx.notes(e.issue, `the failed gate run could not be read: ${foldNote(String(error))}`);
    return null;
  }
}

/** What one tick accumulates while its steps run. */
interface Run {
  ctx: TickCtx;
  d: EngineDeps;
  now: Date;
  changed: string[];
  waiting: string[];
  /** One transition per issue per tick. */
  touched: Set<number>;
  /** An active usage limit: dispatch nothing. */
  limited: boolean;
  /** Shutting down: asked again before every dispatch, so an in-flight tick stops taking work. */
  hold: () => boolean;
}

export interface TickOptions {
  /** True while the loop is shutting down: settle what ran, start nothing new. */
  noNewWork?: () => boolean;
}

/** Nothing may be dispatched now: a usage limit, or a shutdown in progress. */
const held = (run: Run) => run.limited || run.hold();

const why = (error: unknown) => foldNote(error instanceof Error ? error.message : String(error));

/** A failure the tick reports and moves past: one issue's trouble never ends the tick. */
function failed(run: Run, issue: number, error: unknown): void {
  run.ctx.notes(issue, `tick: ${why(error)}`);
  run.changed.push(`#${issue}: failed: ${why(error)}`);
}

async function apply(run: Run, issue: number, actions: Action[]): Promise<void> {
  if (actions.length === 0) return;
  run.touched.add(issue);
  try {
    run.changed.push(`#${issue}: ${(await execute(run.ctx, issue, actions)).join("; ")}`);
  } catch (error) {
    failed(run, issue, error);
  }
}

/** Step 2 for one entry with a stage; null when its outcome waits (for the limit). */
async function settle(run: Run, e: SituationIssue, stage: Stage): Promise<Action[] | null> {
  const { ctx, d, now } = run;
  const task = ctx.stages.get(e.issue);
  if (task?.stage !== stage) {
    if (task) await ctx.stages.stop(e.issue);
    return onStageLost(e);
  }
  if (!task.settled || task.outcome === null) return onStageRunning(e, ctx.cfg, now);
  const outcome = task.outcome;
  // Decided by the outcome, never by a file's presence: a limit wrote nothing, whatever a
  // stopped run left on disk.
  const decision =
    !movedOn(e.state) && isReview(stage) && outcome.kind === "report"
      ? reviewDecisionFor(ctx, d, e.issue, stage)
      : null;
  const actions = onStageFinished(e, stage, outcome, decision, ctx.cfg, now);
  if (held(run) && hasDispatch(actions)) {
    run.waiting.push(`#${e.issue}: ${stage} finished; what follows waits for the limit`);
    return null;
  }
  ctx.stages.take(e.issue);
  return actions;
}

/** Step 2: every entry with a stage, whatever its state. Returns the entries handed to Step 3. */
async function step2(run: Run, issues: SituationIssue[]): Promise<SituationIssue[]> {
  const handOver: SituationIssue[] = [];
  for (const e of issues) {
    if (!e.stage) continue;
    let actions: Action[] | null;
    try {
      actions = await settle(run, e, e.stage.stage);
    } catch (error) {
      failed(run, e.issue, error);
      continue;
    }
    if (actions === null) continue;
    await apply(run, e.issue, actions);
    // A limit recorded here holds every later dispatch of this tick, this step's included.
    const limit = actions.find((a) => a.kind === "limit");
    if (limit?.kind === "limit" && future(limit.until, run.now)) run.limited = true;
    // "Leave the entry to Step 3 on this same tick, which now sees it with no stage" — only for
    // an issue that moved on. Any other row that ends the stage (a retry, a limit) has given
    // the entry its one transition of the tick.
    if (movedOn(e.state) && ownerOf(e.state, false) === "onPullRequest")
      handOver.push({ ...e, stage: null });
  }
  return handOver;
}

/** Step 2b: working entries whose stage is gone. */
async function step2b(run: Run, situation: Situation): Promise<void> {
  const ledger = loadLedger(run.ctx.root);
  for (const s of situation.stalled) {
    if (run.touched.has(s.issue)) continue;
    if (held(run)) return;
    const e = situation.issues.find((i) => i.issue === s.issue);
    if (!e) continue;
    let actions: Action[];
    try {
      const late = e.state === "resume-needed" ? lateReport(run.ctx, run.d, e, ledger) : undefined;
      actions = onStalled(e, e.worktreeExists, run.ctx.cfg, late);
    } catch (error) {
      failed(run, e.issue, error);
      continue;
    }
    await apply(run, e.issue, actions);
  }
}

/** The merge verdict of an open pull request, with the failed run when a required check failed. */
function verdictFor(run: Run, e: SituationIssue, pr: number): PrVerdict {
  const { ctx } = run;
  const v = run.d.canMerge(pr, { forge: ctx.forge, exec: ctx.exec, root: ctx.root, cfg: ctx.cfg });
  const verdict: PrVerdict = { allowed: v.allowed, checks: v.checks };
  if (gateState(verdict) === "fail") verdict.gateRun = gateRun(ctx, e, pr);
  return verdict;
}

/** Step 3: first the cleanup list, then the pull requests with no running stage. */
async function step3(run: Run, situation: Situation, handOver: SituationIssue[]): Promise<void> {
  const cleanupIssues = new Set(situation.cleanup.map((c) => c.issue));
  const entries: SituationIssue[] = [
    ...situation.issues.filter((e) => cleanupIssues.has(e.issue)),
    ...handOver,
    ...situation.issues.filter(
      (e) => !e.stage && PR_STATES.has(e.state) && !cleanupIssues.has(e.issue),
    ),
  ];
  for (const e of entries) {
    if (run.touched.has(e.issue) && !handOver.includes(e)) continue;
    let verdict: PrVerdict | null = null;
    // A stage a limit interrupted is resumed whatever the gates say: no verdict needed.
    if (PR_STATES.has(e.state) && e.prState === "OPEN" && e.pr !== null && !e.limitedStage) {
      try {
        verdict = verdictFor(run, e, e.pr);
      } catch (error) {
        run.ctx.notes(e.issue, `can-merge #${e.pr}: ${why(error)}`);
        run.waiting.push(`#${e.issue}: the merge verdict of pull request #${e.pr} is unreadable`);
        continue;
      }
    }
    const pr = { state: e.prState, updatedAt: e.prUpdatedAt };
    const actions = onPullRequest(e, pr, verdict, run.ctx.cfg, run.now);
    if (held(run) && hasDispatch(actions)) {
      run.waiting.push(`#${e.issue}: a CI fix round waits for the limit`);
      continue;
    }
    await apply(run, e.issue, actions);
  }
}

/** Step 4: one new issue per tick, the next in the queue when a claim is lost. */
async function step4(run: Run, situation: Situation): Promise<void> {
  let queue = situation.queue;
  for (;;) {
    if (held(run)) return;
    const next = newWork({ ...situation, queue }, run.ctx.cfg);
    const item = next && queue.find((q) => q.number === next.issue);
    if (!item) return;
    queue = queue.filter((q) => q.number !== item.number);
    // `--replace` is for a stale worktree of the same issue that the situation showed.
    const replace = situation.issues.some((i) => i.issue === item.number && i.worktreeExists);
    try {
      const taken = await takeIssue(run.ctx, item, replace);
      run.changed.push(`#${item.number}: ${taken.lines.join("; ")}`);
      if (taken.won) return;
    } catch (error) {
      run.changed.push(`#${item.number}: the claim failed: ${why(error)}`);
      return;
    }
  }
}

/** Step 5: who waits on whom, and the delay from the first row of the source's table. */
function step5(run: Run, draining: boolean): Omit<TickSummary, "changed" | "waiting"> {
  const final = loadLedger(run.ctx.root);
  let prsOnGates = 0;
  for (const e of Object.values(final.issues)) {
    if (e.stage) continue;
    if (e.state === "pr-open" || e.state === "fixing-ci") {
      prsOnGates++;
      run.waiting.push(`#${e.issue}: pull request #${e.pr ?? "?"} waits on its gates`);
    } else if (e.state === "mergeable") {
      run.waiting.push(
        `#${e.issue}: pull request #${e.pr ?? "?"} is mergeable; a human reviews and merges it`,
      );
    }
  }
  const running = run.ctx.stages.running();
  const delay = nextDelay({
    draining,
    running: running.length,
    limitedUntil: final.limitedUntil,
    prsOnGates,
    now: run.now,
  });
  if (delay.stop) run.waiting.push("draining and nothing is running: the loop ends");
  return { running, nextWakeMs: delay.ms, stop: delay.stop };
}

export async function tick(ctx: TickCtx, opts: TickOptions = {}): Promise<TickSummary> {
  const d = engineDeps(ctx);
  const now = ctx.now();
  // Step 1.
  const situation = d.situation(ctx);
  const { paused, draining } = situation.control;
  const run: Run = {
    ctx,
    d,
    now,
    changed: [],
    waiting: [],
    touched: new Set(),
    limited: future(situation.limitedUntil, now),
    hold: opts.noNewWork ?? (() => false),
  };

  const handOver = await step2(run, situation.issues);

  // A limit recorded in Step 2 holds this tick's dispatches too.
  const limitedUntil = loadLedger(ctx.root).limitedUntil;
  run.limited = run.limited || future(limitedUntil, now);
  if (run.limited) run.waiting.push(`limited until ${limitedUntil ?? situation.limitedUntil}`);
  if (paused) run.waiting.push("paused");
  if (draining) run.waiting.push("draining: finishing what runs, taking nothing new");

  // Paused or draining: Steps 2 and 3 only. Limited: dispatch nothing.
  if (run.hold()) run.waiting.push("shutting down: settling what ran, taking nothing new");
  if (!held(run) && !paused && !draining) await step2b(run, situation);
  await step3(run, situation, handOver);
  if (situation.newWork.allowed && !held(run)) await step4(run, situation);
  else if (!situation.newWork.allowed)
    run.waiting.push(`no new work: ${situation.newWork.reasons.join("; ")}`);
  // Not taken over automatically in this phase.
  for (const f of situation.foreign.filter((x) => x.stale))
    run.waiting.push(`#${f.issue}: claimed by ${f.machine}, stale; a human decides on a takeover`);

  return { changed: run.changed, waiting: run.waiting, ...step5(run, draining) };
}
