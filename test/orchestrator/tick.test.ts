/**
 * One tick, composed: the situation from a fake forge and git, the table, and the actions
 * through the engine. Stages, reviews, publish, can-merge and worktree creation are seams;
 * claims, releases, labels and comments go through the real `Forge` and the real claim
 * functions against a fake `gh`, so every GitHub write is visible as the command it is.
 *
 * Two checks run after every test: nothing ran `gh pr merge` (Phase 1 never merges), and
 * no `gh`/`git` call happened while the ledger lock was held (lock bodies stay short).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config/load.js";
import { claimBody } from "../../src/engine/claims.js";
import { createWorktree, removeWorktree } from "../../src/engine/worktree.js";
import { control } from "../../src/engine/control.js";
import {
  loadLedger,
  machineId,
  transition,
  updateLedger,
  type IssueState,
  type LedgerEntry,
} from "../../src/engine/ledger/ledger.js";
import { evaluate } from "../../src/engine/merge/can-merge.js";
import type { Decision } from "../../src/engine/review/decision.js";
import type { Stage } from "../../src/engine/review/reports.js";
import {
  Forge,
  type Exec,
  type IssueView,
  type PrSummary,
  type RollupNode,
} from "../../src/forge/github.js";
import {
  StageRegistry,
  takeIssue,
  triageIssue,
  type EngineDeps,
  type TickCtx,
} from "../../src/orchestrator/actions.js";
import { tick } from "../../src/orchestrator/tick.js";
import { triageMarker } from "../../src/orchestrator/table.js";
import type { RuntimeAdapter, StageRequest, StageResult } from "../../src/runtimes/types.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
  input?: string;
}

const checks: Array<() => void> = [];
afterEach(() => {
  for (const check of checks.splice(0)) check();
});

/** A seam that records its calls and runs whatever the test put in `impl`. */
function seam<A extends unknown[], R>(name: string) {
  const fn = Object.assign(
    (...a: A): R => {
      fn.calls.push(a);
      return fn.impl(...a);
    },
    {
      calls: [] as A[],
      impl: ((): R => {
        throw new Error(`${name} was not expected in this test`);
      }) as (...a: A) => R,
    },
  );
  return fn;
}

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const flush = () => new Promise<void>((done) => setImmediate(done));

const okResult = (over: Partial<StageResult> = {}): StageResult => ({
  exit: "ok",
  resultText: "",
  stdoutFile: "",
  stderrFile: "",
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...over,
});

const PLANNED = [
  "AUTODEV-PLAN",
  "issue: 42",
  "status: planned",
  "reason:",
  "db-migration-required: no",
  "plan-file: .autoclaude/state/plans/42.md",
  "AUTODEV-PLAN-END",
].join("\n");

const STOPPED_REVIEW = [
  "AUTODEV-CODE-REVIEW",
  "issue: 42",
  "findings:",
  "uncertain:",
  "  - review — not finished: the scorer failed twice",
  "CODE-REVIEW-STATUS: stopped",
].join("\n");

function writeReport(worktree: string, stage: Stage, text: string): string {
  const dir = join(worktree, ".autoclaude", "state", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stage}.md`);
  writeFileSync(file, text);
  return file;
}

function decision(action: Decision["action"], over: Partial<Decision> = {}): Decision {
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
    reason: "r",
    releaseReason: null,
    ...over,
  };
}

/** A runtime whose child runs until it is killed. */
function heldRuntime() {
  const state = { started: 0, killed: 0 };
  const rt: RuntimeAdapter = {
    name: "claude",
    available: async () => ({ ok: true }),
    start() {
      state.started++;
      let finish: (r: StageResult) => void = () => {};
      const done = new Promise<StageResult>((resolveDone) => {
        finish = resolveDone;
      });
      return {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        done,
        kill: async () => {
          state.killed++;
          finish(okResult({ exit: "failed", resultText: "killed" }));
        },
      };
    },
  };
  return { rt, state };
}

const request = (cwd: string, root: string): StageRequest => ({
  cwd,
  promptFile: "",
  dispatchFile: "",
  runDir: "",
  model: "m",
  effort: "low",
  timeoutMs: 1000,
  maxTurns: 1,
  projectRoot: root,
});

/** A project root with a space and an umlaut, a fake gh and git, and every heavy step a seam. */
function rig(opts: { instance?: string } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "autoclaude-tick-")));
  tmpDirs.push(base);
  const root = join(base, "Jürgen Müller", "My Projects", "app");
  mkdirSync(join(root, ".autoclaude"), { recursive: true });
  const cfg = loadProjectConfig(MINIMAL);
  const machine = machineId();
  let clock = new Date("2026-03-01T10:00:00Z");
  const t0 = new Date(clock.getTime() - 3_600_000).toISOString();
  const issues = new Map<number, IssueView>();
  const prs: PrSummary[] = [];
  const runs: unknown[] = [];
  const worktrees: string[] = [];
  const calls: Call[] = [];
  const underLock: Call[] = [];
  const prComments: Array<{ pr: number; body: string }> = [];
  const fail = { addLabel: "" };
  /** What `git rev-parse HEAD` answers in a worktree, and what `ls-remote --heads` lists. */
  const git = { head: "abc1234", remoteBranches: [] as string[] };
  const lockDir = join(root, ".autoclaude", "state", "ledger.lock");
  const flagOf = (args: string[], name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };

  const exec: Exec = (cmd, args, o) => {
    const call = { cmd, args, cwd: o?.cwd, input: o?.input };
    calls.push(call);
    if (existsSync(lockDir)) underLock.push(call);
    if (cmd === "git") {
      if (args.includes("worktree") && args.includes("list"))
        return ok(worktrees.map((w) => `worktree ${w}\nHEAD abc\n\n`).join(""));
      if (args.includes("rev-parse") && args.at(-1) === "HEAD") return ok(`${git.head}\n`);
      if (args.includes("ls-remote")) {
        const prefix = args.at(-1)!.replace(/\*$/, "");
        const heads = git.remoteBranches.filter((b) => b.startsWith(prefix));
        return ok(heads.map((b) => `0123abc\trefs/heads/${b}\n`).join(""));
      }
      // `worktree remove --force <path>` and `worktree add <path> -b <branch> <base>`, so the
      // engine's own create and remove can run against this list.
      const at = args.indexOf("worktree");
      if (at >= 0 && args[at + 1] === "remove") {
        const path = args.at(-1)!;
        worktrees.splice(worktrees.indexOf(path), 1);
        rmSync(path, { recursive: true, force: true });
      }
      if (at >= 0 && args[at + 1] === "add") {
        worktrees.push(args[at + 2]!);
        mkdirSync(args[at + 2]!, { recursive: true });
      }
      return ok();
    }
    const [, , noun, verb, ...rest] = args;
    const n = Number(rest[0]);
    if (noun === "issue" && verb === "list") {
      const label = flagOf(rest, "--label");
      const all = flagOf(rest, "--state") === "all";
      return ok(
        JSON.stringify(
          [...issues.values()].filter(
            (i) => i.labels.some((l) => l.name === label) && (all || i.state === "OPEN"),
          ),
        ),
      );
    }
    if (noun === "issue" && verb === "view") return ok(JSON.stringify(issues.get(n)));
    if (noun === "issue" && verb === "edit") {
      const add = flagOf(rest, "--add-label")?.split(",") ?? [];
      if (fail.addLabel && add.includes(fail.addLabel))
        return { status: 1, stdout: "", stderr: "HTTP 502: bad gateway" };
      const remove = flagOf(rest, "--remove-label")?.split(",") ?? [];
      const i = issues.get(n)!;
      i.labels = [
        ...i.labels.filter((l) => !remove.includes(l.name)),
        ...add.filter((a) => !i.labels.some((l) => l.name === a)).map((name) => ({ name })),
      ];
      return ok();
    }
    if (noun === "issue" && verb === "comment") {
      issues.get(n)!.comments.push({
        author: { login: "dev" },
        body: o?.input ?? "",
        createdAt: clock.toISOString(),
      });
      return ok();
    }
    if (noun === "pr" && verb === "list") return ok(JSON.stringify(prs));
    if (noun === "pr" && verb === "view") {
      const pr = prs.find((x) => x.number === n);
      return ok(JSON.stringify({ number: n, state: pr?.state, headRefOid: "abc1234", labels: [] }));
    }
    if (noun === "pr" && verb === "comment") {
      prComments.push({ pr: n, body: o?.input ?? "" });
      return ok();
    }
    if (noun === "run" && verb === "list") return ok(JSON.stringify(runs));
    if (noun === "run" && verb === "view") return ok("test › parses: expected 1, got 2\n");
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };

  const issue = (n: number, over: Partial<IssueView> = {}): IssueView => ({
    number: n,
    title: `Issue ${n}`,
    state: "OPEN",
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: t0,
    body: "## Acceptance criteria\n1. it works\n",
    ...over,
  });

  const seams = {
    runStage: seam<Parameters<EngineDeps["runStage"]>, ReturnType<EngineDeps["runStage"]>>("runStage"), // prettier-ignore
    runCodeReview: seam<Parameters<EngineDeps["runCodeReview"]>, ReturnType<EngineDeps["runCodeReview"]>>("runCodeReview"), // prettier-ignore
    runPlanReview: seam<Parameters<EngineDeps["runPlanReview"]>, ReturnType<EngineDeps["runPlanReview"]>>("runPlanReview"), // prettier-ignore
    reviewDecision: seam<Parameters<EngineDeps["reviewDecision"]>, ReturnType<EngineDeps["reviewDecision"]>>("reviewDecision"), // prettier-ignore
    publish: seam<Parameters<EngineDeps["publish"]>, ReturnType<EngineDeps["publish"]>>("publish"), // prettier-ignore
    canMerge: seam<Parameters<EngineDeps["canMerge"]>, ReturnType<EngineDeps["canMerge"]>>("canMerge"), // prettier-ignore
    createWorktree: seam<Parameters<EngineDeps["createWorktree"]>, ReturnType<EngineDeps["createWorktree"]>>("createWorktree"), // prettier-ignore
    removeWorktree: seam<Parameters<EngineDeps["removeWorktree"]>, ReturnType<EngineDeps["removeWorktree"]>>("removeWorktree"), // prettier-ignore
  };
  // A removal is nothing to fake beyond recording it.
  seams.removeWorktree.impl = () => {};

  const notes: string[] = [];
  let runtime: RuntimeAdapter = heldRuntime().rt;
  const ctx: TickCtx = {
    root,
    cfg,
    forge: new Forge("acme/widgets", exec),
    exec,
    instance: opts.instance ?? "inst-1",
    now: () => clock,
    runtimes: () => runtime,
    notes: (n, text) => {
      notes.push(`#${n} ${text}`);
    },
    stages: new StageRegistry(),
    deps: seams,
  };

  checks.push(() => {
    expect(
      calls.filter((c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("merge")),
      "Phase 1 never merges",
    ).toEqual([]);
    expect(underLock, "no gh or git call while the ledger lock is held").toEqual([]);
  });

  return {
    root,
    cfg,
    ctx,
    notes,
    calls,
    issues,
    prs,
    runs,
    prComments,
    fail,
    seams,
    machine,
    issue,
    setRuntime: (rt: RuntimeAdapter) => {
      runtime = rt;
    },
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    now: () => clock,
    entry: (n: number) => loadLedger(root).issues[String(n)],
    worktrees,
    git,
    comments: (n: number) => (issues.get(n)?.comments ?? []).map((c) => c.body),
    /** A ledger entry of this machine's, its worktree on disk and registered, its issue claimed. */
    seed(
      n: number,
      state: IssueState,
      patch: Partial<LedgerEntry> = {},
      gh: Partial<IssueView> = {},
    ): string {
      const worktree = join(root, ".autoclaude", "worktrees", `agent+${n}-issue-${n}`).replaceAll(
        "\\",
        "/",
      );
      mkdirSync(worktree, { recursive: true });
      worktrees.push(worktree);
      issues.set(
        n,
        issue(n, {
          labels: [{ name: cfg.labels.working }],
          comments: [{ author: { login: "dev" }, body: claimBody(machine, t0), createdAt: t0 }],
          ...gh,
        }),
      );
      updateLedger(
        root,
        (l) => {
          transition(
            l,
            n,
            state,
            { title: `Issue ${n}`, worktree, branch: `agent/${n}-issue-${n}`, ...patch },
            clock,
          );
        },
        clock,
      );
      return worktree;
    },
  };
}

// --- Step 2 ------------------------------------------------------------------------------

describe("tick: Step 2 settles finished stages", () => {
  it("dispatches plan for a claimed entry with its record, then decides its report the next tick", async () => {
    const r = rig();
    r.seed(42, "claimed");
    r.seams.runStage.impl = async (_c, e) => {
      writeReport(e.worktree, "plan", PLANNED);
      return { kind: "report", text: PLANNED, result: okResult() };
    };
    r.seams.runPlanReview.impl = () => new Promise(() => {});

    await tick(r.ctx);
    expect(r.seams.runStage.calls.map((c) => [c[1].issue, c[2], c[3]])).toEqual([
      [42, "plan", "fresh"],
    ]);
    // The record names its owner the moment the stage is dispatched.
    expect(r.entry(42)).toMatchObject({
      state: "planning",
      stage: { stage: "plan", mode: "fresh", instance: "inst-1" },
    });
    expect(r.notes).toContain("#42 dispatch plan model=model-large effort=high");

    await flush();
    const summary = await tick(r.ctx);
    expect(r.notes).toContain("#42 decision review blocking=0 deferred=0");
    expect(existsSync(join(r.root, ".autoclaude", "state", "runs", "42", "plan-1.md"))).toBe(true);
    expect(r.entry(42)).toMatchObject({
      state: "plan-reviewing",
      stage: { stage: "plan-review", instance: "inst-1" },
    });
    expect(r.seams.runPlanReview.calls).toHaveLength(1);
    expect(summary.running).toEqual([42]);
    expect(summary.nextWakeMs).toBe(300_000);
  });

  it("a report's reason reaches the release comment with no skip marker and no live mention", async () => {
    const r = rig();
    r.seed(42, "claimed");
    const hostile = "Fix login & logout --replace $(rm -rf ~) `id` [skip ci] ask @someone";
    const text = PLANNED.replace("status: planned", "status: needs-human").replace(
      "reason:",
      `reason: ${hostile}`,
    );
    r.seams.runStage.impl = async () => ({ kind: "report", text, result: okResult() });
    await tick(r.ctx);
    await flush();
    await tick(r.ctx);
    const release = r.comments(42).find((b) => b.includes("autodev-release"));
    expect(release).toContain("Fix login & logout --replace $(rm -rf ~) `id`");
    expect(release).not.toContain("[skip ci]");
    expect(release).not.toContain("@someone");
    expect(r.entry(42)?.state).toBe("blocked");
  });

  it("notes the dispatch with the short model name and the effort", async () => {
    const r = rig();
    r.cfg.stages.plan.model = "claude-opus-5-5";
    r.seed(42, "claimed");
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.notes).toContain("#42 dispatch plan model=opus effort=high");
  });

  it("a crash between a stage's exit and its consumption: the late report is decided, not re-run (R51)", async () => {
    const r = rig({ instance: "inst-2" });
    const worktree = r.seed(42, "planning", {
      stage: {
        stage: "plan",
        mode: "fresh",
        pid: 999_999,
        instance: "inst-1",
        startedAt: r.now().toISOString(),
        processStartedAt: null,
      },
    });
    writeReport(worktree, "plan", PLANNED);
    r.seams.runPlanReview.impl = () => new Promise(() => {});

    await tick(r.ctx);
    expect(r.seams.runStage.calls, "the finished plan is not run again").toEqual([]);
    expect(r.notes).toContain(
      "#42 late report from plan: its process finished before the restart; deciding it",
    );
    expect(existsSync(join(r.root, ".autoclaude", "state", "runs", "42", "plan-1.md"))).toBe(true);
    expect(r.entry(42)).toMatchObject({
      state: "plan-reviewing",
      stage: { stage: "plan-review", instance: "inst-2" },
    });
  });

  it("positive control: the same crash without a report takes the source's resume-needed path", async () => {
    const r = rig({ instance: "inst-2" });
    r.seed(42, "planning", {
      stage: {
        stage: "plan",
        mode: "fresh",
        pid: 999_999,
        instance: "inst-1",
        startedAt: r.now().toISOString(),
        processStartedAt: null,
      },
    });
    r.seams.runCodeReview.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.seams.runPlanReview.calls).toEqual([]);
    expect(r.seams.runCodeReview.calls).toHaveLength(1);
    expect(r.entry(42)).toMatchObject({ state: "code-reviewing", stage: { stage: "code-review" } });
    expect(r.notes.some((n) => n.includes("late report"))).toBe(false);
  });

  it("a stage of this instance that no task holds was lost with its session: resume-needed", async () => {
    const r = rig();
    r.seed(42, "implementing", {
      stage: {
        stage: "implement",
        mode: "fresh",
        pid: 999_999,
        instance: "inst-1",
        startedAt: r.now().toISOString(),
        processStartedAt: null,
      },
    });
    await tick(r.ctx);
    expect(r.entry(42)).toMatchObject({ state: "resume-needed", stage: null });
    expect(r.seams.runCodeReview.calls, "one transition per issue per tick").toEqual([]);
  });

  it("stops a review past the wall clock: its processes are killed and it is released blocked", async () => {
    const r = rig();
    r.seed(42, "resume-needed");
    const held = heldRuntime();
    r.setRuntime(held.rt);
    const after: string[] = [];
    r.seams.runCodeReview.impl = async (c, e) => {
      await c.runtimes("claude").start(request(e.worktree, r.root), c.cfg).done;
      try {
        c.runtimes("claude").start(request(e.worktree, r.root), c.cfg);
        after.push("started");
      } catch (error) {
        after.push(String(error));
      }
      return { kind: "limit", resetsAt: r.now().toISOString() };
    };

    await tick(r.ctx);
    expect(r.entry(42)).toMatchObject({ state: "code-reviewing", stage: { stage: "code-review" } });
    r.advance(61);
    await tick(r.ctx);

    expect(held.state.killed).toBe(1);
    expect(after[0], "no new process starts once the stage is stopped").toMatch(/stopped/);
    expect(r.notes).toContain("#42 wall clock: stopped code-review after 61m");
    expect(r.entry(42)).toMatchObject({ state: "blocked", lastError: "wall clock: code-review", stage: null }); // prettier-ignore
    expect(
      r.comments(42).some((b) => b.includes("autodev-release") && b.includes("wall clock: code-review ran 61 minutes")), // prettier-ignore
    ).toBe(true);
    // The stopped review's outcome is discarded, not decided on a later tick.
    expect(loadLedger(r.root).limitedUntil).toBeNull();
  });

  // R69: whether the bootstrap may keep the engine's environment is recorded by whoever makes the
  // worktree; a worktree recreated from a pushed agent branch holds a stage's work.
  it("records whether a recreated worktree is fresh from the integration branch", async () => {
    for (const fromIntegration of [false, true]) {
      const r = rig();
      const wt = r.seed(42, "implementing", { pushedSha: "abc1234" });
      rmSync(wt, { recursive: true, force: true });
      r.worktrees.splice(r.worktrees.indexOf(wt), 1);
      r.seams.createWorktree.impl = () => {
        mkdirSync(wt, { recursive: true });
        return { branch: "agent/42-issue-42", worktree: wt, copied: [], missing: [], notes: [], fromIntegration }; // prettier-ignore
      };
      r.seams.runStage.impl = () => new Promise(() => {});
      await tick(r.ctx);
      expect(r.seams.createWorktree.calls, String(fromIntegration)).toHaveLength(1);
      expect(r.entry(42)?.freshWorktree, String(fromIntegration)).toBe(fromIntegration);
    }
  });

  it("a limit records the reset, holds every dispatch until then, and re-dispatches after it", async () => {
    const r = rig();
    r.seed(42, "claimed");
    const resetsAt = new Date(r.now().getTime() + 30 * 60_000).toISOString();
    r.seams.runStage.impl = async () => ({ kind: "limit", resetsAt, result: okResult({ exit: "limit" }) }); // prettier-ignore

    await tick(r.ctx);
    await flush();
    const limited = await tick(r.ctx);
    expect(loadLedger(r.root).limitedUntil).toBe(resetsAt);
    expect(r.entry(42)).toMatchObject({ state: "planning", stage: null, limitedStage: "plan" });
    expect(r.entry(42)?.attempts.reviewRetry, "quota is not the code's fault").toBe(0);
    expect(limited.nextWakeMs).toBe(30 * 60_000);

    r.advance(10);
    const waiting = await tick(r.ctx);
    expect(r.seams.runStage.calls, "Step 2b leaves the entry alone while limited").toHaveLength(1);
    expect(waiting.waiting.some((w) => w.includes(`limited until ${resetsAt}`))).toBe(true);

    r.advance(21);
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    // Plan has no resume mode (F2), so its resume is fresh; no counter either way (design § 9).
    expect(r.seams.runStage.calls.map((c) => c[3])).toEqual(["fresh", "fresh"]);
    expect(r.entry(42)).toMatchObject({
      state: "planning",
      stage: { stage: "plan" },
      limitedStage: null,
      attempts: { reviewRetry: 0, plan: 0 },
    });
  });

  it("a limit recorded in Step 2 holds the dispatches of the entries after it in the same tick", async () => {
    const r = rig();
    r.seed(41, "claimed");
    r.seed(42, "claimed");
    const resetsAt = new Date(r.now().getTime() + 30 * 60_000).toISOString();
    r.seams.runStage.impl = async (_c, e) => {
      if (e.issue === 41) return { kind: "limit", resetsAt, result: okResult({ exit: "limit" }) };
      writeReport(e.worktree, "plan", PLANNED);
      return { kind: "report", text: PLANNED, result: okResult() };
    };
    r.seams.runPlanReview.impl = () => new Promise(() => {});
    await tick(r.ctx);
    await flush();
    const summary = await tick(r.ctx);
    expect(loadLedger(r.root).limitedUntil).toBe(resetsAt);
    expect(r.seams.runPlanReview.calls, "#42's plan review would run into #41's limit").toEqual([]);
    expect(r.entry(42)).toMatchObject({ state: "planning", stage: { stage: "plan" } });
    expect(summary.waiting).toContain("#42: plan finished; what follows waits for the limit");
  });

  it("a finished stage whose row dispatches waits while limited, and is decided after the limit", async () => {
    const r = rig();
    r.seed(42, "claimed");
    r.seams.runStage.impl = async (_c, e) => {
      writeReport(e.worktree, "plan", PLANNED);
      return { kind: "report", text: PLANNED, result: okResult() };
    };
    r.seams.runPlanReview.impl = () => new Promise(() => {});
    await tick(r.ctx);
    await flush();
    const until = new Date(r.now().getTime() + 5 * 60_000).toISOString();
    updateLedger(r.root, (l) => {
      l.limitedUntil = until;
    });
    await tick(r.ctx);
    expect(r.seams.runPlanReview.calls, "dispatch nothing while limited").toEqual([]);
    expect(r.entry(42)?.state).toBe("planning");
    r.advance(6);
    await tick(r.ctx);
    expect(r.seams.runPlanReview.calls).toHaveLength(1);
    expect(r.entry(42)?.state).toBe("plan-reviewing");
  });

  it("a review's limit is decided by the outcome, never by a report file on disk", async () => {
    const r = rig();
    r.seed(42, "resume-needed");
    r.seams.runCodeReview.impl = async (_c, e) => {
      // Whatever sits on disk is not this run's: the limit wrote nothing.
      writeReport(e.worktree, "code-review", STOPPED_REVIEW);
      return { kind: "limit", resetsAt: new Date(r.now().getTime() + 600_000).toISOString() };
    };
    await tick(r.ctx);
    await flush();
    await tick(r.ctx);
    expect(r.seams.reviewDecision.calls).toEqual([]);
    expect(r.entry(42)).toMatchObject({ state: "code-reviewing", stage: null });
    expect(r.entry(42)?.attempts.reviewRetry).toBe(0);
    expect(r.issues.get(42)!.labels.map((l) => l.name)).not.toContain("agent-retry-1");
  });

  it("files an earlier run's report aside before it dispatches the stage again", async () => {
    const r = rig();
    const worktree = r.seed(42, "resume-needed");
    writeReport(worktree, "code-review", STOPPED_REVIEW);
    r.seams.runCodeReview.impl = () => new Promise(() => {});
    const summary = await tick(r.ctx);
    const late = join(r.root, ".autoclaude", "state", "runs", "42", "code-review-late-1.md");
    expect(existsSync(late)).toBe(true);
    expect(readFileSync(late, "utf8")).toContain('late="true"');
    expect(r.notes).toContain("#42 an earlier run's report filed aside: this run writes its own");
    expect(summary.changed.some((c) => c.includes("code-review-late-1.md"))).toBe(true);
  });

  it("a human closed the issue under a running stage: stop it, clear it, and clean up on the same tick", async () => {
    const r = rig();
    r.seed(42, "claimed");
    const held = heldRuntime();
    r.setRuntime(held.rt);
    r.seams.runStage.impl = async (c, e) => {
      await c.runtimes("claude").start(request(e.worktree, r.root), c.cfg).done;
      return { kind: "no-report", result: okResult({ exit: "failed" }) };
    };
    await tick(r.ctx);
    r.issues.get(42)!.state = "CLOSED";
    await tick(r.ctx);
    expect(held.state.killed).toBe(1);
    expect(
      loadLedger(r.root).events.some((ev) => ev.note === "stage stopped: the issue moved on"),
    ).toBe(true);
    expect(r.seams.removeWorktree.calls.map((c) => [c[1], c[3]])).toEqual([
      [42, { deleteRemote: false }],
    ]);
    expect(r.comments(42).some((b) => b.includes("issue closed by a human"))).toBe(true);
    expect(r.entry(42)).toMatchObject({ state: "done", stage: null });
  });

  it("publish exit 3 releases blocked 'rebase conflict', and only releases", async () => {
    const r = rig();
    const worktree = r.seed(42, "resume-needed");
    r.seams.runCodeReview.impl = async () => ({
      kind: "report",
      reportFile: writeReport(worktree, "code-review", "x"),
    });
    r.seams.reviewDecision.impl = () => ({ code: 0, decision: decision("publish"), message: "" });
    r.seams.publish.impl = () => ({ code: 3, issue: 42, conflict: "CONFLICT (content): src/a.ts" });
    await tick(r.ctx);
    await flush();
    await tick(r.ctx);
    expect(r.notes).toContain("#42 decision publish blocking=0 deferred=0");
    expect(r.seams.publish.calls.map((c) => [c[0], c[1]])).toEqual([[42, false]]);
    // No `blocked` transition: the cleanup it would start deletes the remote branch, which
    // closes an open pull request. The record ends in place; reconcile drops the entry.
    expect(r.entry(42)).toMatchObject({ state: "code-reviewing", stage: null });
    expect(r.comments(42).some((b) => b.includes("autodev-release") && b.includes("rebase conflict"))).toBe(true); // prettier-ignore
    await tick(r.ctx);
    expect(r.seams.removeWorktree.calls, "no cleanup follows the release").toEqual([]);
    expect(r.comments(42).filter((b) => b.includes("autodev-release"))).toHaveLength(1);
  });

  it("a failed label edit after a push removes the worktree when its HEAD is the pushed head, and keeps it otherwise", async () => {
    for (const [head, removed] of [
      ["abc1234", true],
      ["def5678", false],
    ] as const) {
      const r = rig();
      const worktree = r.seed(42, "resume-needed", { pr: 7, pushedSha: "abc1234" });
      r.git.head = head;
      r.seams.runCodeReview.impl = async () => ({ kind: "report", reportFile: writeReport(worktree, "code-review", "x") }); // prettier-ignore
      r.seams.reviewDecision.impl = () => ({ code: 0, decision: decision("retry", { label: "agent-retry-1" }), message: "" }); // prettier-ignore
      r.fail.addLabel = "agent-retry-1";
      await tick(r.ctx);
      await flush();
      await tick(r.ctx);
      // The pull request keeps its remote branch either way.
      expect(r.seams.removeWorktree.calls.map((c) => [c[1], c[3]]), head).toEqual(removed ? [[42, { deleteRemote: false }]] : []); // prettier-ignore
      if (!removed)
        expect(r.notes.some((n) => n.includes("the worktree is kept") && n.includes("autoclaude rollback 42"))).toBe(true); // prettier-ignore
    }
  });

  it("a label that cannot be applied releases blocked quoting the edit, and nothing is dispatched", async () => {
    const r = rig();
    const worktree = r.seed(42, "resume-needed");
    r.seams.runCodeReview.impl = async () => ({
      kind: "report",
      reportFile: writeReport(worktree, "code-review", "x"),
    });
    r.seams.reviewDecision.impl = () => ({
      code: 0,
      decision: decision("retry", { label: "agent-retry-1" }),
      message: "",
    });
    r.fail.addLabel = "agent-retry-1";
    await tick(r.ctx);
    await flush();
    await tick(r.ctx);
    expect(r.seams.runCodeReview.calls, "no re-dispatch after the failed edit").toHaveLength(1);
    expect(r.entry(42)).toMatchObject({ state: "code-reviewing", stage: null });
    expect(r.issues.get(42)!.labels.map((l) => l.name)).toContain("agent-blocked");
    // Nothing was pushed: the worktree holds the only copy of the work and stays.
    expect(r.seams.removeWorktree.calls).toEqual([]);
    expect(r.comments(42).some((b) => b.includes("agent-retry-1") && b.includes("HTTP 502"))).toBe(true); // prettier-ignore
    // The report the retry would have replaced is still where the decision read it.
    expect(existsSync(join(worktree, ".autoclaude", "state", "reports", "code-review.md"))).toBe(true); // prettier-ignore
  });
});

// --- Step 3 ------------------------------------------------------------------------------

describe("tick: Step 3 pull requests", () => {
  const prOf = (r: ReturnType<typeof rig>, rollup: RollupNode[]) => {
    r.seams.canMerge.impl = (pr) => ({
      pr,
      review: null,
      ...evaluate(
        {
          pr: {
            number: pr,
            state: "OPEN",
            mergedAt: null,
            headRefName: "agent/42-issue-42",
            headRefOid: "abc1234",
            baseRefName: "develop",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: rollup,
            labels: [],
            url: "https://github.com/acme/widgets/pull/7",
            updatedAt: r.now().toISOString(),
            isDraft: false,
          },
          files: [],
          behind: false,
          review: null,
        },
        r.cfg,
      ),
    });
  };

  function prRig(patch: Partial<LedgerEntry> = {}) {
    const r = rig();
    r.seed(42, "pr-open", { pr: 7, pushedSha: "abc1234", ...patch });
    r.prs.push({
      number: 7,
      state: "OPEN",
      headRefName: "agent/42-issue-42",
      updatedAt: r.now().toISOString(),
      url: "https://github.com/acme/widgets/pull/7",
    });
    return r;
  }

  it("gates red with fix rounds left: the failed run's log goes to an implement fix round", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]);
    r.runs.push({
      databaseId: 9,
      conclusion: "failure",
      status: "completed",
      url: "https://github.com/acme/widgets/actions/runs/9",
      headSha: "abc1234",
      workflowName: "ci",
    });
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.issues.get(42)!.labels.map((l) => l.name)).toContain("agent-fix-1");
    const [, , stage, mode, extra] = r.seams.runStage.calls[0]!;
    expect([stage, mode]).toEqual(["implement", "fix"]);
    expect(extra?.gateLog).toBe("Failed CI steps\n\ntest › parses: expected 1, got 2\n");
    expect(r.entry(42)).toMatchObject({
      state: "fixing-ci",
      attempts: { fix: 1 },
      stage: { stage: "implement", mode: "fix" },
    });
  });

  it("gates green: mergeable, awaiting a human; the verdict is recorded and nothing merges", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]);
    const summary = await tick(r.ctx);
    expect(r.entry(42)).toMatchObject({
      state: "mergeable",
      lastCanMerge: "REFUSED: no blocking findings, diff matches the review",
    });
    expect(summary.waiting.some((w) => w.includes("#42") && w.includes("human"))).toBe(true);
  });

  const redRun = (r: ReturnType<typeof rig>, headSha = "abc1234") =>
    r.runs.push({
      databaseId: 9,
      conclusion: "failure",
      status: "completed",
      url: "https://github.com/acme/widgets/actions/runs/9",
      headSha,
      workflowName: "ci",
    });

  it("reads the failed run of the pull request's current head only", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]);
    redRun(r, "0ld0ld0");
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    // An earlier head's failure is not this one: its log is not handed to the fix round.
    expect(r.seams.runStage.calls[0]?.[4]?.gateLog).toMatch(/could not be read/);
  });

  it("a fixing-ci implement run without a report is retried once in its tick, never handed to Step 3", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]);
    redRun(r);
    r.seams.runStage.impl = async () => ({ kind: "no-report", result: okResult({ exit: "failed" }) }); // prettier-ignore
    await tick(r.ctx);
    await flush();
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.seams.runStage.calls.map((c) => c[3])).toEqual(["fix", "resume"]);
    expect(r.seams.canMerge.calls, "Step 3 never saw the entry on the retry's tick").toHaveLength(1); // prettier-ignore
    expect(r.entry(42)).toMatchObject({
      state: "fixing-ci",
      attempts: { fix: 1, reviewRetry: 1 },
      stage: { stage: "implement", mode: "resume" },
    });
    expect(r.issues.get(42)!.labels.map((l) => l.name)).not.toContain("agent-fix-2");
  });

  it("an implement limit in fixing-ci is resumed after the limit: no new fix round, no counter", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]);
    redRun(r);
    const resetsAt = new Date(r.now().getTime() + 30 * 60_000).toISOString();
    r.seams.runStage.impl = async () => ({ kind: "limit", resetsAt, result: okResult({ exit: "limit" }) }); // prettier-ignore
    await tick(r.ctx);
    await flush();
    await tick(r.ctx);
    expect(r.entry(42)).toMatchObject({ state: "fixing-ci", stage: null, limitedStage: "implement" }); // prettier-ignore
    r.advance(10);
    await tick(r.ctx);
    expect(r.seams.runStage.calls, "nothing dispatched while limited").toHaveLength(1);
    r.advance(21);
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.seams.runStage.calls.map((c) => [c[2], c[3]])).toEqual([
      ["implement", "fix"],
      ["implement", "resume"],
    ]);
    expect(r.entry(42)).toMatchObject({
      state: "fixing-ci",
      attempts: { fix: 1, reviewRetry: 0 },
      limitedStage: null,
      stage: { stage: "implement", mode: "resume" },
    });
    expect(r.issues.get(42)!.labels.map((l) => l.name)).not.toContain("agent-fix-2");
    expect(r.seams.canMerge.calls, "the resume needs no verdict").toHaveLength(1);
  });

  it("a blocked entry whose pull request is open is cleaned up without deleting its remote branch", async () => {
    const r = prRig({ lastError: "wall clock: implement" });
    updateLedger(r.root, (l) => {
      transition(l, 42, "blocked", { lastError: "wall clock: implement" }, r.now());
    });
    const summary = await tick(r.ctx);
    expect(r.seams.removeWorktree.calls.map((c) => [c[1], c[3]])).toEqual([
      [42, { deleteRemote: false }],
    ]);
    expect(summary.changed.join(" ")).toContain("pull request #7 is still open");
  });

  /**
   * What this proves: gates red at the cap leave no worktree and no local branch behind (the
   * engine's own `removeWorktree` against the fake git), a re-queued issue whose branch is still
   * on the remote is refused before any claim with the rollback remedy, and once nothing is left
   * over the claim creates a fresh worktree (the engine's `createWorktree`) and dispatches plan.
   * It does not drive the new attempt to a publish: the stages and publish are seams here, and
   * publish's refusal to force over a remote head is the very state the refusal keeps it out of.
   */
  it("gates red at the cap remove the worktree; the issue is claimed again once nothing is left over", async () => {
    const r = prRig({ attempts: { implement: 1, fix: 2, reviewRetry: 0, plan: 0 } });
    r.git.remoteBranches.push("agent/42-issue-42");
    r.seams.removeWorktree.impl = removeWorktree;
    r.seams.createWorktree.impl = createWorktree;
    prOf(r, [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }]);
    redRun(r);
    await tick(r.ctx);
    expect(r.seams.removeWorktree.calls.map((c) => [c[1], c[3]])).toEqual([
      [42, { deleteRemote: false }],
    ]);
    expect(r.worktrees).toEqual([]);
    expect(r.prComments.some((c) => c.pr === 7 && c.body.includes("still fail after 2 fix rounds"))).toBe(true); // prettier-ignore
    // A human closes the pull request and puts the issue back in the queue.
    r.prs[0]!.state = "CLOSED";
    r.prs[0]!.closedAt = r.now().toISOString();
    r.issues.get(42)!.labels.push({ name: "agent-ready" });
    r.seams.runStage.impl = () => new Promise(() => {});
    r.advance(5);
    // The branch is still on the remote: claiming would end in a refused push.
    await tick(r.ctx);
    expect(r.seams.runStage.calls).toEqual([]);
    expect(r.comments(42).some((b) => b.includes("autodev-release") && b.includes("autoclaude rollback 42"))).toBe(true); // prettier-ignore
    expect(r.issues.get(42)!.labels.map((l) => l.name)).not.toContain("agent-working");
    // A human clears it (`autoclaude rollback 42`) and puts the issue back in the queue.
    r.git.remoteBranches.length = 0;
    r.issues.get(42)!.labels.push({ name: "agent-ready" });
    r.advance(5);
    const again = await tick(r.ctx);
    expect(again.changed.join(" ")).not.toMatch(/could not be created|already has a worktree/);
    expect(r.entry(42)).toMatchObject({ state: "planning", stage: { stage: "plan" } });
    expect(r.worktrees).toHaveLength(1);
  });

  it("pull requests waiting on their gates wake the loop in 600 s", async () => {
    const r = prRig();
    prOf(r, [{ name: "test", status: "IN_PROGRESS", conclusion: null }]);
    const summary = await tick(r.ctx);
    expect(r.entry(42)?.state).toBe("pr-open");
    expect(summary.nextWakeMs).toBe(600_000);
  });
});

// --- Step 4 and control -----------------------------------------------------------------

describe("tick: Step 4 and the control files", () => {
  const hostile = "Fix login & logout --replace $(rm -rf ~) `id`";

  function created(r: ReturnType<typeof rig>) {
    r.seams.createWorktree.impl = (issue) => {
      const worktree = join(r.root, ".autoclaude", "worktrees", `agent+${issue}-fix-login`).replaceAll("\\", "/"); // prettier-ignore
      mkdirSync(worktree, { recursive: true });
      return {
        branch: `agent/${issue}-fix-login`,
        worktree,
        copied: [],
        missing: [],
        notes: [],
        fromIntegration: true,
      };
    };
  }

  it("claims the first issue of the queue, creates its worktree with the title as one argument, dispatches plan", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { title: hostile, labels: [{ name: "agent-ready" }] }));
    created(r);
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.comments(12).some((b) => b.includes(`autodev-claim machine="${r.machine}"`))).toBe(true); // prettier-ignore
    expect(r.seams.createWorktree.calls.map((c) => [c[0], c[1]])).toEqual([[12, hostile]]);
    expect(r.entry(12)).toMatchObject({
      state: "planning",
      title: hostile,
      branch: "agent/12-fix-login",
      stage: { stage: "plan", mode: "fresh", instance: "inst-1" },
      // R69: fresh from the integration branch, so its bootstrap keeps the engine's environment.
      freshWorktree: true,
    });
  });

  // F1: a `worktrees.copy` entry the creation skipped is on the issue's events log, reason and all.
  it("notes every worktrees.copy entry the creation skipped", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    created(r);
    const make = r.seams.createWorktree.impl;
    r.seams.createWorktree.impl = (...a) => ({
      ...make(...a),
      missing: [{ entry: ".env.local", reason: "the project root has no such file" }],
    });
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.entry(12)?.state).toBe("planning");
    expect(r.notes).toContain(
      "#12 worktrees.copy: .env.local was not copied: the project root has no such file",
    );
  });

  it("a leftover worktree with no ledger entry: released blocked with the rollback remedy, nothing run", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    r.worktrees.push(join(r.root, ".autoclaude", "worktrees", "agent+12-old-try").replaceAll("\\", "/")); // prettier-ignore
    created(r);
    await tick(r.ctx);
    expect(r.seams.createWorktree.calls).toEqual([]);
    expect(r.seams.runStage.calls).toEqual([]);
    expect(r.comments(12).some((b) => b.includes("autodev-claim"))).toBe(false);
    const release = r.comments(12).find((b) => b.includes("autodev-release")) ?? "";
    expect(release).toContain("agent+12-old-try");
    expect(release).toContain("autoclaude rollback 12");
    expect(r.issues.get(12)!.labels.map((l) => l.name)).toContain("agent-blocked");
    expect(r.entry(12)).toBeUndefined();
  });

  it("the issue's branch left on the remote with no open pull request: released blocked, nothing run", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    r.git.remoteBranches.push("agent/12-old-try", "agent/120-other-issue");
    created(r);
    await tick(r.ctx);
    expect(r.seams.createWorktree.calls).toEqual([]);
    expect(r.seams.runStage.calls).toEqual([]);
    const release = r.comments(12).find((b) => b.includes("autodev-release")) ?? "";
    expect(release).toContain("agent/12-old-try");
    expect(release).not.toContain("agent/120-other-issue");
    expect(release).toContain("autoclaude rollback 12");
  });

  it("a remote branch with an open pull request is an attempt in flight: never queued, and never claimed", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    r.git.remoteBranches.push("agent/12-fix-login");
    r.prs.push({ number: 7, state: "OPEN", headRefName: "agent/12-fix-login", updatedAt: r.now().toISOString(), url: "u" }); // prettier-ignore
    created(r);
    const summary = await tick(r.ctx);
    // The queue leaves it out (its pull request is open), so nothing is claimed or released.
    expect(summary.waiting.some((w) => w.includes("queue empty"))).toBe(true);
    expect(r.comments(12)).toEqual([]);
    // And should it reach the claim anyway (a race with the listing), it is not taken.
    const taken = await takeIssue(r.ctx, { number: 12, title: "Issue 12" }, false);
    expect(taken).toEqual({ won: false, lines: ["pull request #7 is open on its branch: not new work"] }); // prettier-ignore
    expect(r.comments(12)).toEqual([]);
    expect(r.seams.createWorktree.calls).toEqual([]);
  });

  it("a lost claim moves on to the next issue in the queue", async () => {
    const r = rig();
    const other = claimBody("other/box", "2026-03-01T08:00:00.000Z");
    r.issues.set(3, r.issue(3, { labels: [{ name: "agent-ready" }], comments: [{ author: { login: "x" }, body: other, createdAt: "2026-03-01T08:00:00Z" }] })); // prettier-ignore
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    created(r);
    r.seams.runStage.impl = () => new Promise(() => {});
    await tick(r.ctx);
    expect(r.issues.get(3)!.labels.map((l) => l.name)).not.toContain("agent-working");
    expect(r.entry(12)?.state).toBe("planning");
    expect(r.entry(3)).toBeUndefined();
  });

  it("paused: Steps 2 and 3 only — nothing re-dispatched, nothing new taken", async () => {
    const r = rig();
    r.seed(42, "claimed");
    r.issues.set(12, r.issue(12, { labels: [{ name: "agent-ready" }] }));
    control(r.root, "pause");
    const summary = await tick(r.ctx);
    expect(r.seams.runStage.calls).toEqual([]);
    expect(r.seams.createWorktree.calls).toEqual([]);
    expect(summary.waiting).toContain("paused");
    expect(summary.nextWakeMs).toBe(1_800_000);
  });

  it("draining with nothing running ends the loop", async () => {
    const r = rig();
    control(r.root, "drain");
    const summary = await tick(r.ctx);
    expect(summary.stop).toBe(true);
    expect(summary.waiting.some((w) => w.includes("draining"))).toBe(true);
  });
});

// --- the registry the loop waits on ---------------------------------------------------------

describe("StageRegistry", () => {
  it("next(since) wakes on a stage that finishes after the mark, never on one already counted", async () => {
    const r = rig();
    const stages = new StageRegistry();
    let finish: () => void = () => {};
    const held = new Promise<void>((done) => {
      finish = done;
    });
    stages.start(r.ctx, 42, "plan", r.now().toISOString(), async () => {
      await held;
      return { kind: "no-report", result: okResult({ exit: "failed" }) };
    });
    const mark = stages.settledCount;
    let woke = false;
    void stages.next(mark).then(() => {
      woke = true;
    });
    await flush();
    expect(woke).toBe(false);
    expect(stages.running()).toEqual([42]);
    finish();
    await flush();
    expect(woke).toBe(true);
    expect(stages.running()).toEqual([]);
    // A finished outcome held back (a limit) does not wake a loop that already counted it.
    let again = false;
    void stages.next(stages.settledCount).then(() => {
      again = true;
    });
    await flush();
    expect(again).toBe(false);
  });

  it("a stage started over an unconsumed running one stops the old one first", async () => {
    const r = rig();
    const held = heldRuntime();
    r.setRuntime(held.rt);
    const stages = new StageRegistry();
    const run = async (c: Parameters<Parameters<StageRegistry["start"]>[4]>[0]) => {
      await c.runtimes("claude").start(request(r.root, r.root), c.cfg).done;
      return { kind: "no-report" as const, result: okResult({ exit: "failed" }) };
    };
    stages.start(r.ctx, 42, "implement", r.now().toISOString(), run);
    stages.start(r.ctx, 42, "implement", r.now().toISOString(), run);
    await flush();
    expect(held.state.started).toBe(2);
    expect(held.state.killed).toBe(1);
    expect(stages.running()).toEqual([42]);
  });
});

// --- triage -----------------------------------------------------------------------------

describe("triage applied by the engine", () => {
  const answer = (decision: string, comment: string) =>
    JSON.stringify({ decision, reason: "1 checkable criterion, scope one function", comment });

  it("applies the label and posts the comment with the marker, through the text pipeline", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12));
    r.seams.runStage.impl = async () => ({
      kind: "report",
      text: answer("ready", "Triage: meets the standard. Ask @someone [skip ci]"),
      result: okResult(),
    });
    const out = await triageIssue(r.ctx, 12);
    expect(out.decision).toBe("ready");
    expect(r.seams.runStage.calls[0]?.[2]).toBe("triage");
    expect(r.issues.get(12)!.labels.map((l) => l.name)).toContain("agent-ready");
    const posted = r.comments(12);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.startsWith(triageMarker("ready"))).toBe(true);
    expect(posted[0]).toContain("Generated by autoclaude");
    expect(posted[0]).not.toContain("@someone");
    expect(posted[0]).not.toContain("[skip ci]");
  });

  it("an unchanged decision posts no second comment", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12));
    r.seams.runStage.impl = async () => ({ kind: "report", text: answer("needs-shaping", "Proposed acceptance criteria"), result: okResult() }); // prettier-ignore
    await triageIssue(r.ctx, 12);
    await triageIssue(r.ctx, 12);
    expect(r.comments(12)).toHaveLength(1);
    expect(r.issues.get(12)!.labels.map((l) => l.name)).toContain("needs-shaping");
  });

  it("a label that cannot be applied fails the triage: no release and no ledger entry for an unclaimed issue", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12));
    r.seams.runStage.impl = async () => ({ kind: "report", text: answer("ready", "Triage: ok"), result: okResult() }); // prettier-ignore
    r.fail.addLabel = "agent-ready";
    const out = await triageIssue(r.ctx, 12);
    expect(out.decision).toBe("failed");
    expect(r.issues.get(12)!.labels.map((l) => l.name)).not.toContain("agent-blocked");
    expect(r.comments(12).some((b) => b.includes("autodev-release"))).toBe(false);
    expect(r.entry(12)).toBeUndefined();
    expect(r.notes.some((n) => n.startsWith("#12 triage: applying the ready result failed"))).toBe(true); // prettier-ignore
  });

  it("never triages a closed issue, and skips an assigned one with a note", async () => {
    const r = rig();
    r.issues.set(12, r.issue(12, { state: "CLOSED" }));
    r.issues.set(13, r.issue(13, { assignees: [{ login: "ada" }] }));
    expect((await triageIssue(r.ctx, 12)).decision).toBe("not-triaged");
    expect((await triageIssue(r.ctx, 13)).decision).toBe("not-triaged");
    expect(r.seams.runStage.calls).toEqual([]);
    expect(r.notes.some((n) => n.startsWith("#13 triage skipped: assigned to ada"))).toBe(true);
    expect(r.comments(12)).toEqual([]);
  });
});
