/**
 * The table's actions, executed through the engine.
 *
 * Every GitHub write goes through the C1 `Forge` (labels, comments) or the C4/C7 functions
 * built on it (claims and releases, publish); every git command through the engine's worktree
 * and publish code, with the normal environment. The stage processes get `stageEnv` inside the
 * runtime, and so does every command the engine runs on content a stage wrote (the red step,
 * a bootstrap outside a fresh worktree: R69). Ledger writes are short `updateLedger` bodies
 * with no network call inside; the stage processes run in the background, held by a
 * `StageRegistry` the next tick reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, StageSpec } from "../config/types.js";
import { branchPrefixFor } from "../engine/branch-names.js";
import { claimIssue, releaseIssue } from "../engine/claims.js";
import {
  appendNoteBestEffort,
  archivePlanFile,
  archiveReport,
  foldNote,
  loadLedger,
  machineId,
  transition,
  transitionText,
  updateLedger,
  type LedgerEntry,
  type StageRun,
} from "../engine/ledger/ledger.js";
import { canMerge } from "../engine/merge/can-merge.js";
import { presentText, publish } from "../engine/publish.js";
import { reviewDecision } from "../engine/review/decision.js";
import { reportPath, type Stage } from "../engine/review/reports.js";
import { computeSituation, PR_STATES, type Situation } from "../engine/situation.js";
import {
  createWorktree,
  findWorktree,
  remoteIssueBranches,
  removeWorktree,
} from "../engine/worktree.js";
import type { RuntimeAdapter, StageResult } from "../runtimes/types.js";
import { runCodeReview } from "./review/code-review.js";
import { runPlanReview } from "./review/plan-review.js";
import type { ReviewOutcome } from "./review/process.js";
import { TriageSchema, validate, type Triage } from "./review/schemas.js";
import { runStage, type OrchestratorCtx, type StageOutcome } from "./stage.js";
import {
  onActionFailed,
  onTriage,
  previousTriageDecision,
  type Action,
  type DispatchExtra,
} from "./table.js";

/** The engine functions a tick composes; tests replace them, production passes nothing. */
export interface EngineDeps {
  situation: (ctx: TickCtx) => Situation;
  runStage: typeof runStage;
  runCodeReview: typeof runCodeReview;
  runPlanReview: typeof runPlanReview;
  reviewDecision: typeof reviewDecision;
  publish: typeof publish;
  canMerge: typeof canMerge;
  createWorktree: typeof createWorktree;
  removeWorktree: typeof removeWorktree;
}

export interface TickCtx extends OrchestratorCtx {
  /** The stages this instance started, across ticks. */
  stages: StageRegistry;
  deps?: Partial<EngineDeps>;
}

const DEFAULTS: EngineDeps = {
  situation: (ctx) =>
    computeSituation(ctx.root, ctx.cfg, {
      forge: ctx.forge,
      exec: ctx.exec,
      now: ctx.now(),
      liveInstance: ctx.instance,
      readOnly: false,
    }),
  runStage,
  runCodeReview,
  runPlanReview,
  reviewDecision,
  publish,
  canMerge,
  createWorktree,
  removeWorktree,
};

export function engineDeps(ctx: TickCtx): EngineDeps {
  const out = { ...DEFAULTS };
  for (const [key, fn] of Object.entries(ctx.deps ?? {})) {
    if (fn !== undefined) (out as Record<string, unknown>)[key] = fn;
  }
  return out;
}

// --- running stages ----------------------------------------------------------------------

interface Task {
  issue: number;
  stage: Stage;
  startedAt: string;
  settled: boolean;
  stopped: boolean;
  outcome: StageOutcome | null;
  done: Promise<void>;
  procs: Set<{ kill(): Promise<void> }>;
}

/** How long a stop waits for the stage to wind down after its processes were killed. */
const STOP_WAIT_MS = 60_000;

/**
 * The stages this orchestrator instance is running. A stage is a promise of its outcome; the
 * tick that dispatched it returns at once, and a later tick consumes the outcome (Step 2). Every
 * process a stage starts is tracked through its runtime, so a stop kills all of them — a code
 * review's angles and scorer as much as an implementer — and refuses to start more.
 */
export class StageRegistry {
  private readonly tasks = new Map<number, Task>();
  private waiters: Array<() => void> = [];
  private finishedCount = 0;

  /** How many stages have finished so far: the mark `next` counts from. */
  get settledCount(): number {
    return this.finishedCount;
  }

  start(
    ctx: OrchestratorCtx,
    issue: number,
    stage: Stage,
    startedAt: string,
    run: (tracked: OrchestratorCtx) => Promise<StageOutcome>,
  ): void {
    const task: Task = {
      issue,
      stage,
      startedAt,
      settled: false,
      stopped: false,
      outcome: null,
      done: Promise.resolve(),
      procs: new Set(),
    };
    const tracked: OrchestratorCtx = {
      root: ctx.root,
      cfg: ctx.cfg,
      forge: ctx.forge,
      exec: ctx.exec,
      instance: ctx.instance,
      now: () => ctx.now(),
      notes: (n, text) => ctx.notes(n, text),
      runtimes: (name) => tracking(ctx.runtimes(name), task),
    };
    // A stage nobody consumed must not keep running beside its successor in the same worktree.
    const previous = this.tasks.get(issue);
    if (previous && !previous.settled) void this.stop(issue);
    this.tasks.set(issue, task);
    task.done = (async () => {
      try {
        return await run(tracked);
      } catch (error) {
        ctx.notes(issue, `${stage}: the stage failed: ${foldNote(String(error))}`);
        return {
          kind: "no-report",
          result: syntheticResult(ctx, "failed", String(error)),
        } as const;
      }
    })().then((outcome) => {
      task.outcome = outcome;
      task.settled = true;
      this.finishedCount++;
      this.wake();
    });
  }

  /** The task of an issue: its stage, whether it has finished, and its outcome when it has. */
  get(issue: number): { stage: Stage; settled: boolean; outcome: StageOutcome | null } | undefined {
    const t = this.tasks.get(issue);
    return t && { stage: t.stage, settled: t.settled, outcome: t.outcome };
  }

  /** Forget a task whose outcome is being consumed. */
  take(issue: number): void {
    this.tasks.delete(issue);
  }

  /**
   * Stop a stage: refuse new processes, kill the live ones, wait (bounded) for it to wind down,
   * and drop it, so its outcome is never decided.
   */
  async stop(issue: number): Promise<void> {
    const t = this.tasks.get(issue);
    if (!t) return;
    t.stopped = true;
    this.tasks.delete(issue);
    await Promise.all([...t.procs].map((p) => p.kill().catch(() => {})));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      t.done,
      new Promise<void>((done) => {
        timer = setTimeout(done, STOP_WAIT_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Stop every stage (the loop's second signal). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((issue) => this.stop(issue)));
  }

  /** The issues whose stage is still running, ascending. */
  running(): number[] {
    return [...this.tasks.values()]
      .filter((t) => !t.settled)
      .map((t) => t.issue)
      .sort((a, b) => a - b);
  }

  /**
   * Resolves when a stage finishes after the mark `since` (a `settledCount` read before the
   * tick), at once when one already has. Counting from a mark rather than asking "is anything
   * finished" keeps a loop from spinning on an outcome a limit holds back.
   */
  next(since: number = this.finishedCount): Promise<void> {
    if (this.finishedCount > since) return Promise.resolve();
    return new Promise((done) => this.waiters.push(done));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** A runtime whose every start is recorded on the task, and refused once the task is stopped. */
function tracking(adapter: RuntimeAdapter, task: Task): RuntimeAdapter {
  return {
    name: adapter.name,
    available: () => adapter.available(),
    start(req, cfg) {
      if (task.stopped) throw new Error(`the ${task.stage} stage of #${task.issue} was stopped`);
      const proc = adapter.start(req, cfg);
      task.procs.add(proc);
      const forget = () => task.procs.delete(proc);
      proc.done.then(forget, forget);
      return proc;
    },
  };
}

function syntheticResult(ctx: OrchestratorCtx, exit: StageResult["exit"], text = ""): StageResult {
  return {
    exit,
    resultText: text,
    stdoutFile: "",
    stderrFile: "",
    pid: 0,
    startedAt: ctx.now().toISOString(),
  };
}

/** A review's outcome in the shape the table reads: the report's text, or the limit. */
function fromReview(o: ReviewOutcome, ctx: OrchestratorCtx): StageOutcome {
  if (o.kind === "limit") {
    return {
      kind: "limit",
      resetsAt: o.resetsAt,
      result: { ...syntheticResult(ctx, "limit"), limitResetsAt: o.resetsAt },
    };
  }
  try {
    return {
      kind: "report",
      text: readFileSync(o.reportFile, "utf8"),
      result: syntheticResult(ctx, "ok"),
    };
  } catch (error) {
    return { kind: "no-report", result: syntheticResult(ctx, "failed", String(error)) };
  }
}

// --- the actions ------------------------------------------------------------------------

class RebaseConflict extends Error {}

/** The ledger entry as it is now; the actions before this one may have changed it. */
function current(ctx: TickCtx, issue: number): LedgerEntry {
  const entry = loadLedger(ctx.root).issues[String(issue)];
  if (!entry) throw new Error(`#${issue} has no ledger entry`);
  return entry;
}

const BUMP = { fix: "fix", retry: "reviewRetry", plan: "plan", implement: "implement" } as const;

/** One transition, in the ledger and the issue's events log, as `ledger set` writes it. */
function setEntry(ctx: TickCtx, issue: number, a: Extract<Action, { kind: "set" }>): void {
  const now = ctx.now();
  updateLedger(
    ctx.root,
    (l) => {
      const before = l.issues[String(issue)];
      if (!before) throw new Error(`#${issue} has no ledger entry to set ${a.state} on`);
      const patch: Parameters<typeof transition>[3] = {};
      if (a.note) patch.note = a.note;
      // `stage: none` ends a stage in the same write as the transition (R51): the record is
      // cleared by the action that consumed the outcome, never before.
      if (a.stage === "none") patch.stage = null;
      if (a.error !== undefined) patch.lastError = a.error;
      if (a.pr === "none") patch.pr = null;
      if (a.canMerge !== undefined) patch.lastCanMerge = a.canMerge;
      if (a.limitedStage !== undefined) patch.limitedStage = a.limitedStage;
      if (a.bump) {
        const attempts = { ...before.attempts };
        attempts[BUMP[a.bump]] += 1;
        patch.attempts = attempts;
      }
      const written = transition(l, issue, a.state, patch, now);
      appendNoteBestEffort(
        ctx.root,
        issue,
        transitionText({ from: before.state, to: a.state, note: a.note ?? null }),
        written.stage?.stage ?? null,
        now,
      );
    },
    now,
  );
}

function specOf(cfg: ProjectConfig, stage: Stage, extra?: DispatchExtra): StageSpec {
  switch (stage) {
    case "plan":
      return cfg.stages.plan;
    case "plan-review":
      return cfg.stages.planReview;
    case "implement":
      return extra?.escalated && cfg.stages.implement.escalated
        ? cfg.stages.implement.escalated
        : cfg.stages.implement;
    case "code-review":
      return cfg.stages.codeReview.angles.default;
  }
}

/** `claude-opus-5-5` is `opus`; a model of another naming is named as it is. */
function shortModel(model: string): string {
  return /^claude-([a-z]+)/i.exec(model)?.[1] ?? model;
}

/**
 * Dispatch a stage: file a report left from a decided round aside, write the stage record in
 * the same ledger update as the state, note the dispatch, start the stage in the background.
 */
function dispatch(
  ctx: TickCtx,
  d: EngineDeps,
  issue: number,
  a: Extract<Action, { kind: "dispatch" }>,
): string[] {
  const lines: string[] = [];
  const before = current(ctx, issue);
  // The source's "late report ... is filed aside, not decided again": a report still in the
  // worktree when a fresh or fix run starts is an earlier run's — decided, or given up on (a
  // stopped review that was retried, a stage a limit interrupted). Left there it would be read
  // as this run's; numbered into the series it would be read as a round. A resumed stage keeps
  // its report (it may have finished it).
  if (
    a.mode !== "resume" &&
    before.worktree &&
    existsSync(join(before.worktree, reportPath(a.stage)))
  ) {
    const late = archiveReport(ctx.root, before, a.stage, {}, undefined, { late: true });
    if (late) {
      ctx.notes(issue, "an earlier run's report filed aside: this run writes its own");
      lines.push(`late report filed aside at ${late}`);
    }
  }
  const now = ctx.now();
  const record: StageRun = {
    stage: a.stage,
    mode: a.mode,
    pid: null,
    instance: ctx.instance,
    startedAt: now.toISOString(),
    processStartedAt: null,
  };
  updateLedger(
    ctx.root,
    (l) => {
      const was = l.issues[String(issue)];
      if (!was) throw new Error(`#${issue} has no ledger entry to dispatch ${a.stage} for`);
      // Any dispatch ends a limit's interruption: the stage it marked runs again, or another
      // one replaced it.
      transition(l, issue, a.state, { stage: record, limitedStage: null }, now);
      appendNoteBestEffort(
        ctx.root,
        issue,
        transitionText({ from: was.state, to: a.state, note: null }),
        a.stage,
        now,
      );
    },
    now,
  );
  const entry = current(ctx, issue);
  const spec = specOf(ctx.cfg, a.stage, a.extra);
  ctx.notes(issue, `dispatch ${a.stage} model=${shortModel(spec.model)} effort=${spec.effort}`);
  ctx.stages.start(ctx, issue, a.stage, record.startedAt, async (tracked) => {
    switch (a.stage) {
      case "plan":
      case "implement":
        return d.runStage(tracked, entry, a.stage, a.mode, a.extra);
      case "code-review":
        return fromReview(await d.runCodeReview(tracked, entry, { kind: "worktree" }), tracked);
      case "plan-review":
        return fromReview(await d.runPlanReview(tracked, entry), tracked);
    }
  });
  return lines;
}

/** The comment's target: the pull request for an entry in a pull request state, else the issue. */
function commentOn(ctx: TickCtx, issue: number, body: string): void {
  const entry = loadLedger(ctx.root).issues[String(issue)];
  const text = presentText(
    `${body}\n\n${ctx.cfg.messages.footer}`,
    ctx.cfg.messages,
    ctx.cfg.humans,
  );
  if (entry && entry.pr !== null && PR_STATES.has(entry.state)) ctx.forge.commentPr(entry.pr, text);
  else ctx.forge.commentIssue(issue, text);
}

async function run(ctx: TickCtx, d: EngineDeps, issue: number, a: Action): Promise<string[]> {
  const { root, cfg, exec } = ctx;
  switch (a.kind) {
    case "note":
      ctx.notes(issue, a.text);
      return [];
    case "set":
      setEntry(ctx, issue, a);
      return [];
    case "dispatch":
      return dispatch(ctx, d, issue, a);
    case "release":
      // A reason can quote a report, which is model-written: no CI skip marker reaches GitHub
      // (the release comment defuses the mentions itself).
      releaseIssue(issue, a.to, presentText(a.reason, { ...cfg.messages, defuseMentions: false }), {
        forge: ctx.forge,
        cfg,
        machine: machineId(),
        now: ctx.now(),
      });
      return [];
    case "label":
      ctx.forge.editLabels(issue, { add: [a.add] });
      return [];
    case "archive": {
      const entry = current(ctx, issue);
      const path =
        a.stage === "plan-file"
          ? archivePlanFile(root, entry)
          : archiveReport(root, entry, a.stage, {}, undefined, { late: a.late ?? false });
      return path ? [`archived ${path}`] : [];
    }
    case "publish": {
      const res = d.publish(issue, a.update, { exec, root, cfg, now: ctx.now(), forge: ctx.forge });
      if (res.code === 3) throw new RebaseConflict(res.conflict);
      return [`pull request #${res.pr}${res.url ? ` ${res.url}` : ""}`];
    }
    case "limit":
      updateLedger(
        root,
        (l) => {
          // The later of two limits wins: two stages limited one after the other must not
          // shorten the pause.
          if (!l.limitedUntil || new Date(l.limitedUntil) < new Date(a.until))
            l.limitedUntil = a.until;
        },
        ctx.now(),
      );
      return [];
    case "stop-stage":
      await ctx.stages.stop(issue);
      return [];
    case "remove-worktree": {
      const kept = a.keepUnpushed ? unpushedWork(ctx, issue) : null;
      if (kept !== null) {
        ctx.notes(issue, kept);
        return [kept];
      }
      d.removeWorktree(root, issue, cfg, { deleteRemote: a.remote }, exec);
      return [];
    }
    case "comment":
      commentOn(ctx, issue, a.body);
      return [];
    case "recreate-worktree": {
      const entry = current(ctx, issue);
      const made = d.createWorktree(
        issue,
        entry.title,
        { replace: true, ...(entry.pushedSha ? { pushedSha: entry.pushedSha } : {}), root },
        cfg,
        exec,
      );
      noteCreated(ctx, issue, made);
      updateLedger(
        root,
        (l) => {
          const e = l.issues[String(issue)];
          if (e)
            Object.assign(e, {
              worktree: made.worktree,
              branch: made.branch,
              // From a pushed agent branch it holds a stage's work: its bootstrap gets the
              // stage environment (R69).
              freshWorktree: made.fromIntegration,
            });
        },
        ctx.now(),
      );
      return [`worktree ${made.worktree}`];
    }
  }
}

/**
 * What a new worktree's creation reported, on the issue's events log: a fallback it took, a
 * remote tip that moved, and every `worktrees.copy` entry it skipped. A stage that runs
 * without a configured file fails in ways that do not name it, so the skip is said here.
 */
function noteCreated(ctx: TickCtx, issue: number, made: ReturnType<typeof createWorktree>): void {
  for (const note of made.notes) ctx.notes(issue, note);
  for (const m of made.missing)
    ctx.notes(issue, `worktrees.copy: ${m.entry} was not copied: ${m.reason}`);
}

/**
 * Why an entry's worktree must stay although its work was pushed once: its HEAD is not the
 * head the ledger recorded as pushed (a fix round's reviewed commits, say), or no pushed head
 * is known to compare with. Null when the worktree may go.
 */
function unpushedWork(ctx: TickCtx, issue: number): string | null {
  const entry = loadLedger(ctx.root).issues[String(issue)];
  if (!entry?.worktree || !existsSync(entry.worktree)) return null;
  const r = ctx.exec("git", ["rev-parse", "HEAD"], { cwd: entry.worktree });
  const head = r.status === 0 ? r.stdout.trim() : "";
  if (entry.pushedSha !== null && head === entry.pushedSha) return null;
  return `the worktree is kept: its HEAD ${head || "(unreadable)"} is not the pushed head ${entry.pushedSha ?? "(none recorded)"}; \`autoclaude rollback ${issue}\` clears it when the work is not wanted`;
}

/** One line per action for the tick summary. */
export function describe(a: Action): string {
  switch (a.kind) {
    case "dispatch":
      return `dispatched ${a.stage} (${a.mode})`;
    case "release":
      return `released to ${a.to}`;
    case "label":
      return `labelled ${a.add}`;
    case "archive":
      return `archived ${a.stage}${a.late ? " (late)" : ""}`;
    case "publish":
      return a.update ? "published the fix round" : "published";
    case "set":
      return `-> ${a.state}`;
    case "limit":
      return `limited until ${a.until}`;
    case "note":
      return a.text;
    case "stop-stage":
      return "stopped the stage";
    case "remove-worktree":
      return a.remote ? "removed the worktree and its remote branch" : "removed the worktree";
    case "comment":
      return "commented";
    case "recreate-worktree":
      return "recreated the worktree";
  }
}

/**
 * Execute a row's actions in order. A failure the table answers (a label that could not be
 * applied, a worktree that could not be recreated, a publish that refused) runs its answer
 * instead of the rest; any other failure is thrown to the tick, which notes it.
 *
 * `answerFailures: false` throws every failure: the table's answers release a claimed issue,
 * and a caller with no claim (triage) must not have one released.
 */
export async function execute(
  ctx: TickCtx,
  issue: number,
  actions: Action[],
  opts: { answerFailures?: boolean } = {},
): Promise<string[]> {
  const d = engineDeps(ctx);
  const done: string[] = [];
  for (const action of actions) {
    try {
      const extra = await run(ctx, d, issue, action);
      done.push(describe(action), ...extra);
    } catch (error) {
      if (opts.answerFailures === false) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const entry = loadLedger(ctx.root).issues[String(issue)];
      const follow = onActionFailed(
        entry ?? {
          issue,
          state: "claimed",
          attempts: { implement: 0, fix: 0, reviewRetry: 0, plan: 0 },
          pr: null,
          pushedSha: null,
          lastError: null,
          stage: null,
        },
        action,
        { message, rebaseConflict: error instanceof RebaseConflict },
      );
      if (follow === null) throw error;
      ctx.notes(issue, `${action.kind} failed: ${foldNote(message)}`);
      done.push(`${describe(action)} failed`, ...(await execute(ctx, issue, follow)));
      return done;
    }
  }
  return done;
}

// --- Step 4: claiming new work -----------------------------------------------------------

/**
 * Why claiming this issue would walk into a failure it cannot get out of, or null: a worktree
 * of the issue with no ledger entry (`createWorktree` refuses it), or the issue's branch still
 * on the remote with no open pull request (the new attempt's first push is refused, because the
 * remote head is one its worktree never had). Neither is cleared automatically, because either
 * may hold the only copy of someone's work; `autoclaude rollback <issue>` clears both.
 *
 * Throws when the remote cannot be asked: a claim made blind is the failure this prevents.
 */
function leftoverOf(ctx: TickCtx, n: number): { reason: string } | { openPr: number } | null {
  const { root, cfg, exec } = ctx;
  const found: string[] = [];
  const known = loadLedger(root).issues[String(n)] !== undefined;
  const worktree = known ? null : findWorktree(root, n, cfg, exec);
  if (worktree) found.push(`a worktree at ${worktree.path} that no ledger entry names`);
  const remote = remoteIssueBranches(root, n, cfg, exec);
  if (remote.length > 0) {
    // An open pull request on the branch is an attempt in flight, tracked by its entry (the
    // queue leaves such an issue out already); it is not a leftover, and not new work either.
    const prefix = branchPrefixFor(n, cfg);
    const open = ctx.forge
      .listPrs("open")
      .find((p) => p.state === "OPEN" && p.headRefName.startsWith(prefix));
    if (open) return { openPr: open.number };
    found.push(`the branch ${remote.join(", ")} on ${cfg.forge.remote} with no open pull request`);
  }
  if (found.length === 0) return null;
  return {
    reason:
      `a new attempt would fail on what an earlier one left: ${found.join(", and ")}. ` +
      `Run \`autoclaude rollback ${n}\` to clear it (\`--keep-branch-as <name>\` keeps the work), ` +
      `then re-apply ${cfg.queue.ready} — if wrong, a claimable issue waits for a human`,
  };
}

/**
 * Claim one issue, create its worktree and dispatch its plan. The title is GitHub-controlled
 * text and reaches `createWorktree` as one argument, never a command line.
 */
export async function takeIssue(
  ctx: TickCtx,
  item: { number: number; title: string },
  replace: boolean,
): Promise<{ won: boolean; lines: string[] }> {
  const d = engineDeps(ctx);
  const { root, cfg } = ctx;
  const n = item.number;
  const deps = { forge: ctx.forge, cfg, machine: machineId(), now: ctx.now() };
  // Before the claim: a claim that can only end in a refused push or a refused worktree is
  // not taken. The issue is released blocked at once, with the remedy.
  const leftover = leftoverOf(ctx, n);
  if (leftover && "openPr" in leftover) {
    return {
      won: false,
      lines: [`pull request #${leftover.openPr} is open on its branch: not new work`],
    };
  }
  if (leftover) {
    releaseIssue(n, "blocked", leftover.reason, deps);
    ctx.notes(n, `not claimed: ${foldNote(leftover.reason)}`);
    return {
      won: false,
      lines: ["not claimed: an earlier attempt's leftovers", "released to blocked"],
    };
  }
  const claim = claimIssue(n, { takeover: false }, deps);
  if (!claim.won) {
    return {
      won: false,
      lines: [`claim lost or not claimable${claim.reason ? `: ${claim.reason}` : ""}`],
    };
  }
  let made: ReturnType<typeof createWorktree>;
  try {
    made = d.createWorktree(n, item.title, { replace, root }, cfg, ctx.exec);
  } catch (error) {
    const why = foldNote(error instanceof Error ? error.message : String(error));
    releaseIssue(
      n,
      "blocked",
      `the worktree could not be created: ${why} — if wrong, a claimable issue waits for a human`,
      deps,
    );
    return {
      won: true,
      lines: ["claimed", "the worktree could not be created", "released to blocked"],
    };
  }
  noteCreated(ctx, n, made);
  const now = ctx.now();
  updateLedger(
    root,
    (l) => {
      const was = l.issues[String(n)];
      transition(
        l,
        n,
        "claimed",
        {
          title: item.title,
          branch: made.branch,
          worktree: made.worktree,
          freshWorktree: made.fromIntegration,
        },
        now,
      );
      appendNoteBestEffort(
        root,
        n,
        transitionText({ from: was?.state ?? null, to: "claimed", note: null }),
        null,
        now,
      );
    },
    now,
  );
  const lines = await execute(ctx, n, [
    { kind: "dispatch", stage: "plan", mode: "fresh", state: "planning" },
  ]);
  return { won: true, lines: ["claimed", ...lines] };
}

// --- triage --------------------------------------------------------------------------------

export interface TriageOutcome {
  decision: Triage["decision"] | "not-triaged" | "failed" | "limit";
  reason: string;
  actions: Action[];
}

/**
 * Triage one issue (design § 10, C13): the stage answers with a `TriageSchema` object, and the
 * engine applies the label and posts the comment from it. Closed issues are never triaged and
 * an issue assigned to a human is skipped with a note (F2: the prompt no longer reads either).
 * Phase 1 runs this only when asked (`autoclaude triage`); no tick schedules it.
 */
export async function triageIssue(ctx: TickCtx, n: number): Promise<TriageOutcome> {
  const d = engineDeps(ctx);
  const view = ctx.forge.viewIssue(n);
  if (view.state !== "OPEN")
    return { decision: "not-triaged", reason: "the issue is closed", actions: [] };
  if (view.assignees.length > 0) {
    const who = view.assignees.map((a) => a.login).join(", ");
    const reason = `assigned to ${who}: a human has claimed it`;
    ctx.notes(n, `triage skipped: ${reason}`);
    return { decision: "not-triaged", reason, actions: [] };
  }
  const now = ctx.now().toISOString();
  const entry: LedgerEntry = {
    issue: n,
    title: view.title,
    state: "claimed",
    branch: "",
    worktree: "",
    pr: null,
    attempts: { implement: 0, fix: 0, reviewRetry: 0, plan: 0 },
    stage: null,
    claimedAt: now,
    pushedSha: null,
    lastError: null,
    lastCanMerge: null,
    updatedAt: now,
  };
  const outcome = await d.runStage(ctx, entry, "triage", "fresh");
  if (outcome.kind === "limit") {
    const actions: Action[] = [{ kind: "limit", until: outcome.resetsAt }];
    await execute(ctx, n, actions);
    return { decision: "limit", reason: `usage limit until ${outcome.resetsAt}`, actions };
  }
  if (outcome.kind === "no-report") {
    ctx.notes(n, "triage: the stage ended without an answer");
    return { decision: "failed", reason: "the stage ended without an answer", actions: [] };
  }
  let triage: Triage;
  try {
    const value = JSON.parse(outcome.text) as unknown;
    const invalid = validate(TriageSchema, value);
    if (invalid) throw new Error(invalid);
    triage = value as Triage;
  } catch (error) {
    const reason = `the answer is not a triage result: ${foldNote(String(error))}`;
    ctx.notes(n, `triage: ${reason}`);
    return { decision: "failed", reason, actions: [] };
  }
  const actions = onTriage(triage, previousTriageDecision(view.comments), ctx.cfg);
  try {
    await execute(ctx, n, actions, { answerFailures: false });
  } catch (error) {
    // Nobody claimed this issue: a failed label or comment is noted and reported, never
    // answered with a release or a ledger entry.
    const reason = `applying the ${triage.decision} result failed: ${foldNote(error instanceof Error ? error.message : String(error))}`;
    ctx.notes(n, `triage: ${reason}`);
    return { decision: "failed", reason, actions };
  }
  return { decision: triage.decision, reason: triage.reason, actions };
}
