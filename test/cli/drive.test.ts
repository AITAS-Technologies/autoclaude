import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { issueVerb, type IssueDeps } from "../../src/cli/issue.js";
import { VERBS } from "../../src/cli/main.js";
import { reviewVerb, type ReviewDeps } from "../../src/cli/review.js";
import { triageVerb, type TriageDeps } from "../../src/cli/triage.js";
import { loadProjectConfig } from "../../src/config/load.js";
import {
  loadLedger,
  transition,
  updateLedger,
  type IssueState,
} from "../../src/engine/ledger/ledger.js";
import type { Situation } from "../../src/engine/situation.js";
import { Forge } from "../../src/forge/github.js";
import { StageRegistry, type TickCtx } from "../../src/orchestrator/actions.js";
import {
  capture,
  cleanupTemps,
  git,
  MINIMAL,
  REPO,
  routed,
  tempDir,
  tempRepo,
  type Route,
} from "../helpers/cli-env.js";

afterAll(cleanupTemps);

const FULL = join(REPO, "test/fixtures/projects/full");
const NOW = new Date("2026-10-17T09:00:00Z");

function ctxFor(root: string, routes: Route[], over: Partial<TickCtx> = {}): TickCtx {
  const exec = routed(routes);
  return {
    root,
    cfg: loadProjectConfig(root),
    forge: new Forge("acme/widgets", exec),
    exec,
    instance: "inst-test",
    now: () => NOW,
    runtimes: () => {
      throw new Error("no runtime in this test");
    },
    notes: () => {},
    stages: new StageRegistry(),
    ...over,
  };
}

const view = (state: "OPEN" | "CLOSED", n = 7) =>
  JSON.stringify({
    number: n,
    title: "Pager",
    body: "",
    state,
    labels: [{ name: "agent-ready" }],
    assignees: [],
    comments: [],
    updatedAt: "",
  });

describe("autoclaude issue", () => {
  function rig(
    opts: {
      entry?: IssueState;
      states?: IssueState[];
      viewState?: "OPEN" | "CLOSED";
      won?: boolean;
    } = {},
  ) {
    const root = tempRepo({ project: MINIMAL });
    mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
    const taken: Array<{ n: number; replace: boolean }> = [];
    const written: TickCtx[] = [];
    const states = [...(opts.states ?? ["pr-open"])];
    const setState = (state: IssueState) =>
      updateLedger(
        root,
        (l) =>
          void transition(
            l,
            7,
            state,
            { title: "Pager", branch: "agent/7-pager", worktree: join(root, "wt") },
            NOW,
          ),
        NOW,
      );
    if (opts.entry) setState(opts.entry);
    const signals = new EventEmitter();
    const deps: IssueDeps = {
      root: () => root,
      signals: signals as unknown as NodeJS.Process,
      context: (r, instance) =>
        ctxFor(
          r,
          [
            (cmd, a) =>
              cmd === "gh" && a.includes("view")
                ? { stdout: view(opts.viewState ?? "OPEN") }
                : undefined,
          ],
          { instance },
        ),
      take: async (_ctx, item, replace) => {
        taken.push({ n: item.number, replace });
        if (opts.won === false)
          return { won: false, lines: ["claim lost or not claimable: assigned"] };
        setState("planning");
        return { won: true, lines: ["claimed"] };
      },
      tick: async (ctx) => {
        written.push(ctx);
        const next = states.shift();
        if (next) setState(next);
        return {
          changed: next ? [`#7: ${next}`] : [],
          running: [],
          waiting: [],
          nextWakeMs: 10,
          stop: false,
        };
      },
    };
    return { root, deps, taken, written, signals };
  }

  it("is a registered verb", () => {
    expect(VERBS.issue).toBeTypeOf("function");
  });

  it("claims the issue, ticks until its pull request is open and exits 0", async () => {
    const r = rig({ states: ["implementing", "code-reviewing", "pr-open"] });
    const c = capture();
    expect(await issueVerb(["7"], c.io, "x", r.deps)).toBe(0);
    expect(r.taken).toEqual([{ n: 7, replace: false }]);
    expect(r.written.length).toBeGreaterThanOrEqual(3);
    expect(loadLedger(r.root).issues["7"]!.state).toBe("pr-open");
    expect(c.text()).toMatch(/#7: pr-open/);
    // The instance is released again.
    expect(existsSync(join(r.root, ".autoclaude", "state", "instance.json"))).toBe(false);
  });

  it("passes --replace to the claim", async () => {
    const r = rig({ states: ["pr-open"] });
    expect(await issueVerb(["7", "--replace"], capture().io, "x", r.deps)).toBe(0);
    expect(r.taken).toEqual([{ n: 7, replace: true }]);
  });

  it("holds Step 4 off through the situation it hands the tick, whatever the queue holds", async () => {
    const r = rig({ states: ["pr-open"] });
    const stub = (): Situation =>
      ({
        newWork: { allowed: true, reasons: [], claimedThisWindow: 0 },
        queue: [{ number: 8, title: "other" }],
        issues: [{ issue: 7 }, { issue: 8 }],
        cleanup: [{ issue: 7 }, { issue: 8 }],
        stalled: [{ issue: 8 }],
      }) as unknown as Situation;
    // Another in-flight entry (#8) is invisible to the tick: it is neither published, fixed,
    // cleaned up nor waited for by this attended run.
    expect(await rigWrapped(r.deps, stub, r.root)).toEqual({
      allowed: false,
      queue: [],
      issues: [7],
      cleanup: [7],
      stalled: [],
    });
  });

  it("exits 1 for a state a human must look at, and says why", async () => {
    const r = rig({ states: ["blocked"] });
    updateLedger(r.root, () => {}, NOW);
    const c = capture();
    expect(await issueVerb(["7"], c.io, "x", r.deps)).toBe(1);
    expect(c.text()).toMatch(/#7: blocked/);
  });

  it("continues an issue the ledger already holds instead of claiming it again", async () => {
    const r = rig({ entry: "implementing", states: ["pr-open"] });
    expect(await issueVerb(["7"], capture().io, "x", r.deps)).toBe(0);
    expect(r.taken).toEqual([]);
  });

  it("exits 1 when the claim is lost, when the issue is closed and when another instance runs", async () => {
    const lost = rig({ won: false });
    const c = capture();
    expect(await issueVerb(["7"], c.io, "x", lost.deps)).toBe(1);
    expect(c.text() + c.errText()).toMatch(/claim lost or not claimable: assigned/);

    const closed = rig({ viewState: "CLOSED" });
    expect(await issueVerb(["7"], capture().io, "x", closed.deps)).toBe(1);
    expect(closed.taken).toEqual([]);

    const busy = rig();
    writeFileSync(
      join(busy.root, ".autoclaude", "state", "instance.json"),
      JSON.stringify({
        instance: "other",
        pid: process.pid,
        heartbeatAt: new Date().toISOString(),
      }),
    );
    const b = capture();
    expect(await issueVerb(["7"], b.io, "x", busy.deps)).toBe(1);
    expect(b.errText()).toMatch(/already running/);
    expect(b.errText()).toMatch(/autoclaude (drain|status)/);
    expect(b.errText()).not.toMatch(/npm run|tsx|scripts\//);
    expect(busy.taken).toEqual([]);
  });
});

/** Runs the situation wrapper a verb installs on a context, over a stand-in base. */
async function rigWrapped(
  deps: IssueDeps,
  base: () => Situation,
  root: string,
): Promise<{
  allowed: boolean;
  queue: unknown[];
  issues: number[];
  cleanup: number[];
  stalled: number[];
}> {
  let seen: TickCtx | undefined;
  const probe: IssueDeps = {
    ...deps,
    context: (r, i) =>
      ctxFor(
        r,
        [(cmd, a) => (cmd === "gh" && a.includes("view") ? { stdout: view("OPEN") } : undefined)],
        { instance: i, deps: { situation: base } },
      ),
    tick: async (ctx) => {
      seen = ctx;
      updateLedger(root, (l) => void transition(l, 7, "pr-open", {}, NOW), NOW);
      return { changed: [], running: [], waiting: [], nextWakeMs: 10, stop: true };
    },
  };
  await issueVerb(["7"], capture().io, "x", probe);
  const s = seen!.deps!.situation!(seen!);
  return {
    allowed: s.newWork.allowed,
    queue: s.queue,
    issues: s.issues.map((i) => i.issue),
    cleanup: s.cleanup.map((i) => i.issue),
    stalled: s.stalled.map((i) => i.issue),
  };
}

describe("autoclaude triage", () => {
  function rig(
    root: string,
    triaged: number[],
    decide: (n: number) => { decision: string; reason: string },
    routes: Route[] = [],
  ) {
    const deps: TriageDeps = {
      root: () => root,
      context: (r, instance) => ctxFor(r, routes, { instance }),
      triage: async (_ctx, n) => {
        triaged.push(n);
        return { ...decide(n), actions: [] } as never;
      },
    };
    return deps;
  }
  const root = () => {
    const r = tempDir("autoclaude-triage-");
    cpSync(join(FULL, ".autoclaude"), join(r, ".autoclaude"), { recursive: true });
    return r;
  };

  it("triages the one issue it is given and exits 0 for a decision", async () => {
    const triaged: number[] = [];
    const c = capture();
    const code = await triageVerb(
      ["--issue", "7"],
      c.io,
      "x",
      rig(root(), triaged, () => ({ decision: "ready", reason: "clear" })),
    );
    expect(code).toBe(0);
    expect(triaged).toEqual([7]);
    expect(c.text()).toMatch(/#7: ready — clear/);
  });

  it("exits 1 when a triage failed or hit a usage limit, 0 for a skipped or closed issue", async () => {
    for (const [decision, code] of [
      ["failed", 1],
      ["limit", 1],
      ["not-triaged", 0],
      ["skipped", 0],
      ["needs-shaping", 0],
    ] as const) {
      const c = capture();
      expect(
        await triageVerb(
          ["--issue", "7"],
          c.io,
          "x",
          rig(root(), [], () => ({ decision, reason: "r" })),
        ),
      ).toBe(code);
    }
  });

  it("without --issue triages the open issues that carry the opt-in label", async () => {
    const triaged: number[] = [];
    const routes: Route[] = [
      (cmd, a) =>
        cmd === "gh" && a.includes("list") && a.includes("agent-triage")
          ? {
              stdout: JSON.stringify([
                {
                  number: 3,
                  title: "a",
                  state: "OPEN",
                  labels: [{ name: "agent-triage" }],
                  assignees: [],
                  comments: [],
                  updatedAt: "",
                },
                {
                  number: 4,
                  title: "b",
                  state: "OPEN",
                  labels: [{ name: "agent-triage" }, { name: "agent-ready" }],
                  assignees: [],
                  comments: [],
                  updatedAt: "",
                },
                {
                  number: 5,
                  title: "c",
                  state: "OPEN",
                  labels: [{ name: "agent-triage" }, { name: "agent-working" }],
                  assignees: [],
                  comments: [],
                  updatedAt: "",
                },
              ]),
            }
          : undefined,
    ];
    const c = capture();
    expect(
      await triageVerb(
        [],
        c.io,
        "x",
        rig(root(), triaged, () => ({ decision: "ready", reason: "ok" }), routes),
      ),
    ).toBe(0);
    // Already decided (ready) or being worked on: not triaged again.
    expect(triaged).toEqual([3]);
  });

  it("without --issue and without an opt-in label asks for --issue: exit 64", async () => {
    const minimal = tempDir("autoclaude-triage-");
    cpSync(join(MINIMAL, ".autoclaude"), join(minimal, ".autoclaude"), { recursive: true });
    const c = capture();
    expect(
      await triageVerb(
        [],
        c.io,
        "x",
        rig(minimal, [], () => ({ decision: "ready", reason: "r" })),
      ),
    ).toBe(64);
    expect(c.errText()).toMatch(/--issue <n>/);
  });
});

describe("autoclaude review --pr", () => {
  const COMPLETE = readFileSync(join(REPO, "test/fixtures/reports/code-review.md"), "utf8");
  const STOPPED = readFileSync(join(REPO, "test/fixtures/reports/code-review-stopped.md"), "utf8");

  interface Seen {
    worktree: string;
    existed: boolean;
    target: unknown;
    issue: number;
    secret: boolean;
    bootstraps: number;
    bootLog: string;
  }

  function rig(
    opts: {
      prState?: "OPEN" | "CLOSED";
      branch?: string;
      outcome?: "report" | "stopped" | "limit" | "hang";
      entryWorktree?: boolean;
      /** bootstrap + worktrees.copy in the project's config */
      prepared?: boolean;
    } = {},
  ) {
    const root = tempRepo({ project: MINIMAL });
    if (opts.prepared) {
      const path = join(root, ".autoclaude", "config.json");
      const doc = JSON.parse(readFileSync(path, "utf8"));
      // What the bootstrap saw of the stage marker: a pull request's head is a stage's work (R69).
      doc.bootstrap = 'echo "ran ${AUTOCLAUDE_STAGE:-none}" >> bootstrap.log';
      doc.worktrees = { root: ".autoclaude/worktrees", copy: ["secret.env", "absent.env"] };
      writeFileSync(path, JSON.stringify(doc));
      writeFileSync(join(root, "secret.env"), "TOKEN=x\n");
    }
    const oid = git(root, "rev-parse", "HEAD");
    const calls: Seen[] = [];
    const killed: number[] = [];
    let started: () => void = () => {};
    const hasStarted = new Promise<void>((r) => (started = r));
    const dir = tempDir("autoclaude-review-report-");
    const reportFile = join(dir, "code-review.md");
    writeFileSync(reportFile, opts.outcome === "stopped" ? STOPPED : COMPLETE);
    const pr = {
      number: 40,
      state: opts.prState ?? "OPEN",
      mergedAt: null,
      headRefName: opts.branch ?? "agent/9-pager",
      headRefOid: oid,
      baseRefName: "develop",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
      labels: [],
      url: "u",
      updatedAt: "",
      isDraft: false,
    };
    const signals = new EventEmitter();
    const deps: ReviewDeps = {
      root: () => root,
      signals: signals as unknown as NodeJS.Process,
      context: (r, instance) =>
        ctxFor(
          r,
          [
            (cmd, a) =>
              cmd === "gh" && a.includes("pr") && a.includes("view")
                ? { stdout: JSON.stringify(pr) }
                : undefined,
            (cmd, a) => (cmd === "git" && a.includes("fetch") ? {} : undefined),
          ],
          {
            instance,
            runtimes: () => ({
              name: "claude",
              available: async () => ({ ok: true }),
              start: () => {
                let finish: () => void = () => {};
                const done = new Promise<never>(
                  (_res, rej) => (finish = () => rej(new Error("killed"))),
                );
                started();
                return {
                  pid: 1,
                  startedAt: "",
                  done,
                  kill: async () => {
                    killed.push(1);
                    finish();
                  },
                };
              },
            }),
          },
        ),
      review: async (c, entry, target) => {
        const log = join(entry.worktree, "bootstrap.log");
        calls.push({
          worktree: entry.worktree,
          existed: existsSync(entry.worktree),
          target,
          issue: entry.issue,
          secret: existsSync(join(entry.worktree, "secret.env")),
          bootstraps: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0,
          bootLog: existsSync(log) ? readFileSync(log, "utf8").trim() : "",
        });
        if (opts.outcome === "hang") await c.runtimes("claude").start({} as never, c.cfg).done;
        return opts.outcome === "limit"
          ? { kind: "limit", resetsAt: "2026-10-17T12:00:00.000Z" }
          : { kind: "report", reportFile };
      },
    };
    if (opts.entryWorktree) {
      updateLedger(
        root,
        (l) =>
          void transition(
            l,
            9,
            "pr-open",
            { title: "Pager", branch: "agent/9-pager", worktree: root, pr: 40 },
            NOW,
          ),
        NOW,
      );
    }
    return { root, oid, calls, deps, signals, killed, hasStarted };
  }

  it("reviews the head of an open pull request in a detached worktree and removes it afterwards", async () => {
    const r = rig();
    const c = capture();
    expect(await reviewVerb(["--pr", "40"], c.io, "x", r.deps)).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      existed: true,
      target: { kind: "pr", pr: 40, headSha: r.oid },
      issue: 9,
    });
    expect(existsSync(r.calls[0]!.worktree)).toBe(false);
    expect(git(r.root, "worktree", "list", "--porcelain")).not.toContain("review-pr-40");
    expect(c.text()).toMatch(/review of #40 .* is posted/);
  });

  it("is the unattended pipeline: bootstrap runs once and worktrees.copy is copied", async () => {
    const r = rig({ prepared: true });
    const c = capture();
    expect(await reviewVerb(["--pr", "40"], c.io, "x", r.deps)).toBe(0);
    expect(r.calls[0]).toMatchObject({ secret: true, bootstraps: 1 });
    // R69: the head is a stage's work, so its bootstrap ran in the stage environment.
    expect(r.calls[0]!.bootLog).toBe("ran 1");
    // An entry the copy skipped is said on stderr, not dropped.
    expect(c.errText()).toContain(
      "worktrees.copy: absent.env was not copied: the project root has no such file",
    );
  });

  it("runs the bootstrap of a ledger worktree once, not again when its marker is there", async () => {
    const r = rig({ prepared: true, entryWorktree: true });
    expect(await reviewVerb(["--pr", "40"], capture().io, "x", r.deps)).toBe(0);
    expect(await reviewVerb(["--pr", "40"], capture().io, "x", r.deps)).toBe(0);
    expect(r.calls.map((c) => c.bootstraps)).toEqual([1, 1]);
  });

  it("reuses the ledger entry's worktree when it stands at the pull request's head", async () => {
    const r = rig({ entryWorktree: true });
    expect(await reviewVerb(["--pr", "40"], capture().io, "x", r.deps)).toBe(0);
    expect(r.calls[0]!.worktree).toBe(r.root);
    expect(r.calls[0]!.issue).toBe(9);
  });

  it("exits 2 and says nothing was posted when the review stopped before its verdict", async () => {
    const r = rig({ outcome: "stopped" });
    const c = capture();
    expect(await reviewVerb(["--pr", "40"], c.io, "x", r.deps)).toBe(2);
    expect(c.errText()).toMatch(/stopped before its verdict; nothing was posted/);
    expect(c.text()).toBe("");
  });

  it("exits 1 for a closed pull request, for a branch that names no issue and for a usage limit", async () => {
    const closed = rig({ prState: "CLOSED" });
    expect(await reviewVerb(["--pr", "40"], capture().io, "x", closed.deps)).toBe(1);
    expect(closed.calls).toEqual([]);
    const human = rig({ branch: "feature/pager" });
    const c = capture();
    expect(await reviewVerb(["--pr", "40"], c.io, "x", human.deps)).toBe(1);
    expect(c.errText()).toMatch(/which issue/);
    const limited = rig({ outcome: "limit" });
    const l = capture();
    expect(await reviewVerb(["--pr", "40"], l.io, "x", limited.deps)).toBe(1);
    expect(l.errText()).toMatch(/usage limit until 2026-10-17T12:00:00.000Z; nothing was posted/);
    expect(existsSync(limited.calls[0]!.worktree)).toBe(false);
  });

  it("Ctrl-C kills the review's processes, removes its worktree and lets go of the signals", async () => {
    const r = rig({ outcome: "hang" });
    const c = capture();
    const run = reviewVerb(["--pr", "40"], c.io, "x", r.deps);
    await r.hasStarted;
    r.signals.emit("SIGINT");
    expect(await run).toBe(1);
    expect(r.killed.length).toBeGreaterThanOrEqual(1);
    expect(c.errText()).toMatch(/interrupted/);
    expect(existsSync(r.calls[0]!.worktree)).toBe(false);
    expect(r.signals.listenerCount("SIGINT")).toBe(0);
    expect(git(r.root, "worktree", "list", "--porcelain")).not.toContain("review-pr-40");
  });

  it("removes a review worktree an earlier interrupted run left behind", async () => {
    const r = rig();
    const stale = join(r.root, ".autoclaude", "worktrees", "review-pr-40");
    mkdirSync(join(r.root, ".autoclaude", "worktrees"), { recursive: true });
    git(r.root, "worktree", "add", "--detach", "--quiet", stale, r.oid);
    expect(await reviewVerb(["--pr", "40"], capture().io, "x", r.deps)).toBe(0);
    expect(existsSync(stale)).toBe(false);
  });
});

describe("autoclaude triage and Ctrl-C", () => {
  it("kills the triage stage's process on SIGINT, exits 1 and lets go of the signals", async () => {
    const root = tempDir("autoclaude-triage-int-");
    cpSync(join(FULL, ".autoclaude"), join(root, ".autoclaude"), { recursive: true });
    const signals = new EventEmitter();
    const killed: number[] = [];
    let started: () => void = () => {};
    const hasStarted = new Promise<void>((r) => (started = r));
    const deps: TriageDeps = {
      root: () => root,
      signals: signals as unknown as NodeJS.Process,
      context: (r, instance) =>
        ctxFor(r, [], {
          instance,
          runtimes: () => ({
            name: "claude",
            available: async () => ({ ok: true }),
            start: () => {
              let finish: () => void = () => {};
              const done = new Promise<never>(
                (_res, rej) => (finish = () => rej(new Error("killed"))),
              );
              started();
              return {
                pid: 1,
                startedAt: "",
                done,
                kill: async () => {
                  killed.push(1);
                  finish();
                },
              };
            },
          }),
        }),
      triage: async (c) => {
        await c.runtimes("claude").start({} as never, c.cfg).done;
        return { decision: "ready", reason: "r", actions: [] } as never;
      },
    };
    const c = capture();
    const run = triageVerb(["--issue", "7"], c.io, "x", deps);
    await hasStarted;
    signals.emit("SIGINT");
    expect(await run).toBe(1);
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(c.errText()).toMatch(/interrupted/);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
