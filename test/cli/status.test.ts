import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VERBS } from "../../src/cli/main.js";
import { gatesLine, statusVerb } from "../../src/cli/status.js";
import { loadProjectConfig } from "../../src/config/load.js";
import { requiredCheckProblems } from "../../src/engine/merge/can-merge.js";
import { emptyLedger, saveLedger, transition } from "../../src/engine/ledger/ledger.js";
import { Forge } from "../../src/forge/github.js";
import { capture, cleanupTemps, envFor, MINIMAL, routed, tempDir } from "../helpers/cli-env.js";

afterAll(cleanupTemps);

const NOW = new Date("2026-10-17T09:00:00Z");
const required = ["test", "lint", "build"];

// The status line a human reads must apply the rule can-merge applies: per name, every node
// passing. Counting nodes against names called a pull request green that can-merge refused.
describe("gatesLine", () => {
  it("is green only when every required name has passing nodes and nothing else", () => {
    expect(
      gatesLine(
        [
          { name: "test", outcome: "pass" },
          { name: "lint", outcome: "pass" },
          { name: "build", outcome: "pass" },
        ],
        required,
      ),
    ).toBe("all green");
  });

  it("does not let two passing nodes of one name stand in for a missing one", () => {
    const rollup = [
      { name: "test", outcome: "pass" as const },
      { name: "test", outcome: "pass" as const },
      { name: "lint", outcome: "pass" as const },
    ];
    expect(requiredCheckProblems(rollup, required)).toEqual(["build: not reported"]);
    expect(gatesLine(rollup, required)).toBe("waiting: build: not reported");
  });

  it("names the red checks, and a pending re-run keeps a name from passing", () => {
    expect(
      gatesLine(
        [
          { name: "test", outcome: "fail" },
          { name: "lint", outcome: "pass" },
          { name: "build", outcome: "pass" },
        ],
        required,
      ),
    ).toBe("red: test");
    expect(
      gatesLine(
        [
          { name: "test", outcome: "pass" },
          { name: "test", outcome: "pending" },
          { name: "lint", outcome: "pass" },
          { name: "build", outcome: "pass" },
        ],
        required,
      ),
    ).toBe("waiting: test: pending");
  });

  it("says so when nothing reported", () => {
    expect(gatesLine([], required)).toBe("no gates reported");
  });
});

/** A project root holding the minimal fixture's config and a ledger with a few entries. */
function project(opts: { instance?: { id: string; ageSec: number }; limitedUntil?: string } = {}) {
  const root = tempDir("autoclaude-status-");
  const state = join(root, ".autoclaude", "state");
  mkdirSync(state, { recursive: true });
  cpSync(join(MINIMAL, ".autoclaude"), join(root, ".autoclaude"), { recursive: true });
  const ledger = emptyLedger("host/ada");
  const gone = join(root, "worktrees", "gone");
  transition(
    ledger,
    12,
    "pr-open",
    {
      title: "Pager",
      branch: "agent/12-pager",
      worktree: join(root, "worktrees", "pager"),
      pr: 40,
      attempts: { implement: 1, fix: 2, reviewRetry: 0, plan: 1 },
    },
    NOW,
  );
  transition(
    ledger,
    13,
    "implementing",
    {
      title: "Widget",
      branch: "agent/13-widget",
      worktree: gone,
      stage: {
        stage: "implement",
        mode: "fresh",
        pid: 4242,
        instance: "inst-a",
        startedAt: NOW.toISOString(),
        processStartedAt: null,
      },
    },
    NOW,
  );
  transition(
    ledger,
    14,
    "blocked",
    { title: "Blocked one", branch: "agent/14-b", worktree: "", lastError: "rebase conflict" },
    NOW,
  );
  transition(
    ledger,
    15,
    "planning",
    { title: "Limited", branch: "agent/15-l", worktree: "", limitedStage: "plan" },
    NOW,
  );
  ledger.foreign = [{ issue: 20, machine: "other/box", at: "2026-10-16T01:00:00Z", stale: true }];
  ledger.limitedUntil = opts.limitedUntil ?? null;
  saveLedger(root, ledger, NOW);
  if (opts.instance) {
    writeFileSync(
      join(state, "instance.json"),
      JSON.stringify({
        instance: opts.instance.id,
        pid: 1,
        heartbeatAt: new Date(NOW.getTime() - opts.instance.ageSec * 1000).toISOString(),
      }),
    );
  }
  return root;
}

async function render(root: string, args: string[] = [], rollup: unknown = []) {
  const exec = routed([
    (cmd, a) => {
      if (cmd === "gh" && a.includes("pr") && a.includes("view"))
        return { stdout: JSON.stringify({ number: 40, state: "OPEN", statusCheckRollup: rollup }) };
      return undefined;
    },
  ]);
  const c = capture();
  const env = envFor(root, { exec, forge: () => new Forge("acme/widgets", exec) });
  const code = await statusVerb(args, c.io, root, env);
  return { code, text: c.text(), err: c.errText() };
}

describe("autoclaude status", () => {
  it("is a registered verb", () => {
    expect(VERBS.status).toBeTypeOf("function");
  });

  it("renders a fixture ledger: a row per issue, with state, pr, gates, attempts and stage", async () => {
    const root = project();
    const green = ["test", "lint", "build"].map((name) => ({
      name,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    }));
    const r = await render(root, [], green);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/^autoclaude status/m);
    const row = (n: number) => r.text.split("\n").find((l) => l.startsWith(`#${n} `)) ?? "";
    expect(row(12)).toMatch(/pr-open\s+40\s+all green\s+1\/2\/0/);
    expect(row(13)).toMatch(/implementing .*implement\/fresh/);
    expect(row(14)).toMatch(/blocked/);
    // The bad news only: a missing worktree and the reason an entry is blocked.
    expect(r.text).toContain(`worktree gone: ${join(root, "worktrees", "gone")}`);
    expect(r.text).toContain("reason: rebase conflict");
    expect(r.text).toMatch(/FOREIGN #20 claimed by other\/box .*\(stale, may be taken over\)/);
  });

  it("does not name the source product, and asks nothing of the agent tool", async () => {
    const r = await render(project());
    expect(r.text).not.toMatch(/Agent tool|agents --all/i);
  });

  it("shows a stage a usage limit interrupted, and when it resumes", async () => {
    const root = project({ limitedUntil: "2026-10-17T12:00:00.000Z" });
    const r = await render(root);
    expect(r.text).toMatch(/LIMITS\s+limited until 2026-10-17T12:00:00.000Z/);
    const row = r.text.split("\n").find((l) => l.startsWith("#15 ")) ?? "";
    expect(row).toMatch(/limited: plan/);
    expect(r.text).toMatch(/#15 .*resumes after 2026-10-17T12:00:00.000Z/s);
  });

  it("says which orchestrator instance is live, from its heartbeat", async () => {
    const live = await render(project({ instance: { id: "inst-live", ageSec: 30 } }));
    expect(live.text).toMatch(/instance inst-live \(live, heartbeat 30 s ago\)/);
    const stale = await render(project({ instance: { id: "inst-old", ageSec: 400 } }));
    expect(stale.text).toMatch(/instance inst-old \(not live: heartbeat 400 s old\)/);
    const none = await render(project());
    expect(none.text).toMatch(/instance none recorded/);
  });

  it("reads a stage of the live instance as running and a foreign one as not", async () => {
    const root = project({ instance: { id: "inst-a", ageSec: 10 } });
    const live = await render(root);
    const row = live.text.split("\n").find((l) => l.startsWith("#13 ")) ?? "";
    expect(row).toMatch(/implement\/fresh/);
    expect(row).not.toMatch(/dead/);
    const stale = await render(project({ instance: { id: "inst-b", ageSec: 10 } }));
    expect(stale.text.split("\n").find((l) => l.startsWith("#13 "))).toMatch(
      /implement\/fresh \(instance gone\)/,
    );
  });

  it("prints the control state with remedies that name autoclaude verbs only", async () => {
    const root = project();
    writeFileSync(join(root, ".autoclaude", "state", "PAUSED"), "x\n");
    writeFileSync(join(root, ".autoclaude", "state", "DRAINING"), "x\n");
    const r = await render(root);
    expect(r.text).toMatch(/CONTROL\s+PAUSED \(both files present; run autoclaude resume\)/);
    expect(r.text).not.toMatch(/npm run|tsx|scripts\/|agent:/);
  });

  it("survives a gh failure on the gates cell", async () => {
    const root = project();
    const exec = routed([
      (cmd) => (cmd === "gh" ? { status: 1, stderr: "rate limited" } : undefined),
    ]);
    const c = capture();
    const code = await statusVerb(
      [],
      c.io,
      root,
      envFor(root, { exec, forge: () => new Forge("acme/widgets", exec) }),
    );
    expect(code).toBe(0);
    expect(c.text()).toMatch(/gh failed/);
  });

  it("exits 64 on an argument, and 1 when the configuration cannot be read", async () => {
    const c = capture();
    expect(await statusVerb(["--now"], c.io, "x", envFor(project()))).toBe(64);
    expect(c.errText()).toMatch(/usage: autoclaude status/);
    const empty = tempDir("autoclaude-status-empty-");
    const e = capture();
    expect(await statusVerb([], e.io, empty, envFor(empty, { config: loadProjectConfig }))).toBe(1);
  });
});
