import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config/load.js";
import { control } from "../../src/engine/control.js";
import type { Situation } from "../../src/engine/situation.js";
import { Forge } from "../../src/forge/github.js";
import { StageRegistry, type TickCtx } from "../../src/orchestrator/actions.js";
import { acquireInstance } from "../../src/orchestrator/instance.js";
import { runLoop } from "../../src/orchestrator/loop.js";
import { tick } from "../../src/orchestrator/tick.js";
import type { TickSummary } from "../../src/orchestrator/tick.js";
import type { RuntimeAdapter, StageRequest, StageResult } from "../../src/runtimes/types.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const result = (over: Partial<StageResult> = {}): StageResult => ({
  exit: "ok",
  resultText: "",
  stdoutFile: "",
  stderrFile: "",
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...over,
});
const request = {
  cwd: "",
  promptFile: "",
  dispatchFile: "",
  runDir: "",
  model: "m",
  effort: "low",
  timeoutMs: 1000,
  maxTurns: 1,
  projectRoot: "",
} as StageRequest;

/** A runtime whose every child runs until it is killed; counts starts and kills. */
function heldRuntime() {
  const state = { started: 0, killed: 0 };
  const rt: RuntimeAdapter = {
    name: "claude",
    available: async () => ({ ok: true }),
    start() {
      state.started++;
      let finish: (r: StageResult) => void = () => {};
      const done = new Promise<StageResult>((r) => (finish = r));
      return {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        done,
        kill: async () => {
          state.killed++;
          finish(result({ exit: "failed" }));
        },
      };
    },
  };
  return { rt, state };
}

function ctxFor(rt: RuntimeAdapter = heldRuntime().rt, deps: TickCtx["deps"] = {}): TickCtx {
  const root = mkdtempSync(join(tmpdir(), "autoclaude-loop-"));
  tmp.push(root);
  mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
  return {
    root,
    cfg: loadProjectConfig(MINIMAL),
    forge: new Forge("acme/widgets", () => ({ status: 1, stdout: "", stderr: "no gh here" })),
    exec: () => ({ status: 1, stdout: "", stderr: "" }),
    instance: "inst-1",
    now: () => new Date(),
    runtimes: () => rt,
    notes: () => {},
    stages: new StageRegistry(),
    deps,
  };
}

const summary = (over: Partial<TickSummary> = {}): TickSummary => ({
  changed: [],
  running: [],
  waiting: [],
  nextWakeMs: 60_000,
  stop: false,
  ...over,
});

const emptySituation = (ctx: TickCtx): Situation => ({
  profile: {} as Situation["profile"],
  control: { paused: false, draining: true },
  limitedUntil: null,
  issues: [],
  foreign: [],
  counts: { inFlight: 0, repoWorking: 0, openAgentPrs: 0 },
  queue: [],
  cleanup: [],
  stalled: [],
  newWork: { allowed: false, reasons: ["draining"] } as Situation["newWork"],
  caps: ctx.cfg.caps,
});

const noReport = async () => ({ kind: "no-report" as const, result: result() });

describe("runLoop", () => {
  it("wakes on a child's exit before the timer", async () => {
    const ctx = ctxFor();
    const calls: number[] = [];
    const t0 = Date.now();
    await runLoop(ctx, new AbortController().signal, {
      tick: async () => {
        calls.push(Date.now() - t0);
        if (calls.length === 1) {
          ctx.stages.start(ctx, 7, "implement", new Date().toISOString(), async () => {
            await new Promise((r) => setTimeout(r, 200));
            return noReport();
          });
          return summary({ running: [7] });
        }
        return summary({ stop: true });
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(150);
    expect(calls[1]!, "the second tick ran on the exit, not the 60 s timer").toBeLessThan(2000);
  });

  it("returns when draining and nothing runs", async () => {
    const ctx = ctxFor(undefined, { situation: emptySituation });
    control(ctx.root, "drain");
    await runLoop(ctx, new AbortController().signal);
  });

  it("honours TickSummary.stop", async () => {
    let n = 0;
    await runLoop(ctxFor(), new AbortController().signal, {
      tick: async () => {
        n++;
        return summary({ stop: true });
      },
    });
    expect(n).toBe(1);
  });

  it("logs a failed tick and tries again on the next timer", async () => {
    let n = 0;
    const logs: string[] = [];
    await runLoop(ctxFor(), new AbortController().signal, {
      errorRetryMs: 20,
      log: (m) => logs.push(m),
      tick: async () => {
        if (++n === 1) throw new Error("gh is down");
        return summary({ stop: true });
      },
    });
    expect(n).toBe(2);
    expect(logs.join("\n")).toMatch(/gh is down/);
  });

  it("drains on the first signal: no new dispatch, the finished stage is consumed, then it returns", async () => {
    const ctx = ctxFor();
    const first = new AbortController();
    let dispatched = 0;
    let consumed = 0;
    let ticksAfterSignal = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const loop = runLoop(ctx, first.signal, {
      tick: async (_c, o) => {
        if (o.noNewWork?.()) ticksAfterSignal++;
        const task = ctx.stages.get(7);
        if (task?.settled) {
          ctx.stages.take(7);
          consumed++;
        }
        if (!o.noNewWork?.() && dispatched === 0) {
          dispatched++;
          ctx.stages.start(ctx, 7, "implement", new Date().toISOString(), async () => {
            await gate;
            return noReport();
          });
        }
        return summary({ running: ctx.stages.running() });
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    first.abort();
    let returned = false;
    void loop.then(() => (returned = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(returned, "still waiting for the running stage").toBe(false);
    expect(ticksAfterSignal, "the loop keeps ticking in no-new-work mode").toBeGreaterThan(0);
    release();
    await loop;
    expect(consumed, "a stage that finished after the signal was consumed").toBe(1);
    expect(dispatched, "nothing was dispatched after the signal").toBe(1);
  });

  // R68: losing the instance is not a drain. The ledger is the other instance's now, and each
  // further tick would turn its live stages into resume-needed.
  it("a foreign id in instance.json stops the loop at once: its stages killed, no further tick", async () => {
    const { rt, state } = heldRuntime();
    const ctx = ctxFor(rt);
    const lost = new AbortController();
    const h = acquireInstance(ctx.root, { heartbeatMs: 20, onLost: () => lost.abort() });
    let ticks = 0;
    let ticksAfterLoss = 0;
    try {
      const loop = runLoop(ctx, new AbortController().signal, {
        lost: lost.signal,
        tick: async (c, o) => {
          ticks++;
          if (lost.signal.aborted) ticksAfterLoss++;
          if (ticks === 1)
            c.stages.start(c, 7, "implement", new Date().toISOString(), async (tracked) => {
              const proc = tracked.runtimes("claude").start(request, tracked.cfg);
              return { kind: "no-report", result: await proc.done };
            });
          expect(o.halt?.(), "no tick is told to act after the loss").toBe(false);
          return summary({ nextWakeMs: 60_000, running: c.stages.running() });
        },
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(state.started).toBe(1);
      writeFileSync(
        join(ctx.root, ".autoclaude", "state", "instance.json"),
        JSON.stringify({ instance: "someone-else", pid: 1, heartbeatAt: new Date().toISOString() }),
      );
      await loop; // a stage was running: a drain would have waited for it
      expect(lost.signal.aborted).toBe(true);
      expect(state.killed, "the stage this process started was killed").toBe(1);
      expect(ctx.stages.running()).toEqual([]);
      expect(ticks).toBe(1);
      expect(ticksAfterLoss).toBe(0);
    } finally {
      h.release();
    }
  });

  it("a tick in flight when the instance is lost acts on nothing more", async () => {
    const ctx = ctxFor(heldRuntime().rt, {
      situation: (c) => ({
        ...emptySituation(c),
        control: { paused: false, draining: false },
        newWork: { allowed: true, reasons: [] } as unknown as Situation["newWork"],
        queue: [{ number: 5, title: "Fix it" }],
      }),
    });
    const calls: string[] = [];
    ctx.exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { status: 1, stdout: "", stderr: "stub" };
    };
    ctx.forge = new Forge("acme/widgets", ctx.exec);
    await tick(ctx, { halt: () => true });
    expect(calls, "no claim, no label, no comment").toEqual([]);
  });

  describe("a real tick in no-new-work mode", () => {
    const queued = (ctx: TickCtx): Situation => ({
      ...emptySituation(ctx),
      control: { paused: false, draining: false },
      newWork: { allowed: true, reasons: [] } as unknown as Situation["newWork"],
      queue: [{ number: 5, title: "Fix it" }],
    });
    const withCalls = (ctx: TickCtx) => {
      const calls: string[] = [];
      ctx.exec = (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 1, stdout: "", stderr: "stub" };
      };
      ctx.forge = new Forge("acme/widgets", ctx.exec);
      return calls;
    };

    it("claims nothing when the flag is set, and does when it is not (positive control)", async () => {
      const ctx = ctxFor(undefined, { situation: queued });
      const calls = withCalls(ctx);
      await tick(ctx, { noNewWork: () => true });
      expect(calls).toEqual([]);
      await tick(ctx, { noNewWork: () => false });
      expect(calls.length, "without the flag the tick does try to claim").toBeGreaterThan(0);
    });

    it("re-asks the flag before the claim, inside the tick", async () => {
      const ctx = ctxFor(undefined, { situation: queued });
      const calls = withCalls(ctx);
      let asked = 0;
      // false for the earlier gates of the tick, true by the time Step 4 is about to claim
      await tick(ctx, { noNewWork: () => ++asked >= 4 });
      expect(asked).toBeGreaterThanOrEqual(4);
      expect(calls).toEqual([]);
    });
  });

  it("kills every child, review children included, on the second signal", async () => {
    const { rt, state } = heldRuntime();
    const ctx = ctxFor(rt);
    const first = new AbortController();
    const second = new AbortController();
    const loop = runLoop(ctx, first.signal, {
      force: second.signal,
      tick: async (_c, o) => {
        if (o.noNewWork?.()) return summary({ running: ctx.stages.running() });
        // A review: two processes (angle, scorer) behind one stage record.
        ctx.stages.start(ctx, 7, "code-review", new Date().toISOString(), async (tracked) => {
          const adapter = tracked.runtimes("claude");
          const a = adapter.start(request, ctx.cfg);
          const b = adapter.start(request, ctx.cfg);
          await Promise.all([a.done, b.done]);
          return noReport();
        });
        return summary({ running: [7] });
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(state.started).toBe(2);
    first.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(state.killed, "the first signal kills nothing").toBe(0);
    second.abort();
    await loop;
    expect(state.killed).toBe(2);
    expect(ctx.stages.running()).toEqual([]);
  });

  it("kills the children when the loop ends for any other reason too", async () => {
    const { rt, state } = heldRuntime();
    const ctx = ctxFor(rt);
    let n = 0;
    await runLoop(ctx, new AbortController().signal, {
      tick: async () => {
        if (++n === 1) {
          ctx.stages.start(ctx, 7, "implement", new Date().toISOString(), async (tracked) => {
            await tracked.runtimes("claude").start(request, ctx.cfg).done;
            return noReport();
          });
          return summary({ nextWakeMs: 10 });
        }
        return summary({ stop: true });
      },
    });
    expect(state.killed).toBe(1);
  });
});
