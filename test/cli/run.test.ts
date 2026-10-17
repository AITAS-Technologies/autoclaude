import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VERBS } from "../../src/cli/main.js";
import { runVerb, type RunDeps } from "../../src/cli/run.js";
import { loadProjectConfig } from "../../src/config/load.js";
import type { Situation } from "../../src/engine/situation.js";
import { Forge } from "../../src/forge/github.js";
import { StageRegistry, type EngineDeps, type TickCtx } from "../../src/orchestrator/actions.js";
import { acquireInstance } from "../../src/orchestrator/instance.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const draining = (ctx: TickCtx): Situation => ({
  profile: {} as Situation["profile"],
  control: { paused: false, draining: true },
  limitedUntil: null,
  issues: [],
  foreign: [],
  counts: { inFlight: 0, repoWorking: 0, openAgentPrs: 0 },
  queue: [],
  cleanup: [],
  stalled: [],
  newWork: { allowed: false, reasons: [] } as unknown as Situation["newWork"],
  caps: ctx.cfg.caps,
});

function rig(situation: EngineDeps["situation"]) {
  const root = mkdtempSync(join(tmpdir(), "autoclaude-run-"));
  tmp.push(root);
  mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
  const signals = new EventEmitter();
  const deps: RunDeps = {
    root: () => root,
    signals: signals as unknown as NodeJS.Process,
    context: (r, instance) => ({
      root: r,
      cfg: loadProjectConfig(MINIMAL),
      forge: new Forge("acme/widgets", () => ({ status: 1, stdout: "", stderr: "" })),
      exec: () => ({ status: 1, stdout: "", stderr: "" }),
      instance,
      now: () => new Date(),
      runtimes: () => {
        throw new Error("no runtime in this test");
      },
      notes: () => {},
      stages: new StageRegistry(),
      deps: { situation },
    }),
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  return { root, deps, signals, io, out, err };
}
const instanceFile = (root: string) => join(root, ".autoclaude", "state", "instance.json");

describe("autoclaude run", () => {
  it("is a registered verb", () => {
    expect(VERBS.run).toBeTypeOf("function");
  });

  it("refuses an unknown flag with exit 64", async () => {
    const r = rig(draining);
    expect(await runVerb(["--forever"], r.io, "x", r.deps)).toBe(64);
    expect(r.err.join("")).toMatch(/usage: autoclaude run/);
  });

  it("--once runs one tick, exits 0 and releases the instance", async () => {
    let ticks = 0;
    const r = rig((ctx) => {
      ticks++;
      return draining(ctx);
    });
    expect(await runVerb(["--once"], r.io, "x", r.deps)).toBe(0);
    expect(ticks).toBe(1);
    expect(existsSync(instanceFile(r.root))).toBe(false);
  });

  it("--once exits 1 when the tick fails, and says why", async () => {
    const r = rig(() => {
      throw new Error("gh is down");
    });
    expect(await runVerb(["--once"], r.io, "x", r.deps)).toBe(1);
    expect(r.err.join("")).toMatch(/gh is down/);
    expect(existsSync(instanceFile(r.root))).toBe(false);
  });

  it("refuses to start while another instance is live (exit 1)", async () => {
    const r = rig(draining);
    const held = acquireInstance(r.root);
    try {
      expect(await runVerb(["--once"], r.io, "x", r.deps)).toBe(1);
      expect(r.err.join("")).toMatch(/already running/);
    } finally {
      held.release();
    }
  });

  it("a draining project ends the loop by itself (exit 0)", async () => {
    const r = rig(draining);
    expect(await runVerb([], r.io, "x", r.deps)).toBe(0);
    expect(r.signals.listenerCount("SIGINT")).toBe(0);
    expect(existsSync(instanceFile(r.root))).toBe(false);
  });

  it("a signal ends the loop cleanly (exit 0)", async () => {
    const r = rig((ctx) => ({ ...draining(ctx), control: { paused: true, draining: false } }));
    const code = runVerb([], r.io, "x", r.deps);
    await new Promise((res) => setTimeout(res, 300));
    r.signals.emit("SIGINT");
    expect(await code).toBe(0);
    expect(r.signals.listenerCount("SIGINT")).toBe(0);
  }, 20_000);
});
