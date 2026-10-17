import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchVerb } from "../../src/cli/bench.js";
import { canMergeVerb } from "../../src/cli/can-merge.js";
import { drainVerb, pauseVerb, resumeVerb } from "../../src/cli/control.js";
import {
  checkRebasedVerb,
  decisionVerb,
  ledgerVerb,
  parseDecisionArgs,
  postReviewVerb,
  publishVerb,
  reportsVerb,
} from "../../src/cli/engine.js";
import { VERBS } from "../../src/cli/main.js";
import { noteVerb } from "../../src/cli/note.js";
import { redStepVerb } from "../../src/cli/red-step.js";
import { situationVerb } from "../../src/cli/situation.js";
import { pickIssues, renderWatch, watchVerb } from "../../src/cli/watch.js";
import { claimBody } from "../../src/engine/claims.js";
import {
  emptyLedger,
  loadLedger,
  machineId,
  saveLedger,
  transition,
} from "../../src/engine/ledger/ledger.js";
import { controlState } from "../../src/engine/control.js";
import type { DecisionResult } from "../../src/engine/review/decision.js";
import {
  capture,
  cleanupTemps,
  envFor,
  MINIMAL,
  REPO,
  routed,
  tempDir,
  tempRepo,
} from "../helpers/cli-env.js";

afterAll(cleanupTemps);

const NOW = new Date("2026-10-17T09:00:00Z");
const FULL = join(REPO, "test/fixtures/projects/full");
const BENCH = join(REPO, "test/fixtures/bench");
const REPORTS = join(REPO, "test/fixtures/reports");

/** A temporary project root: the minimal fixture's `.autoclaude/`, no git needed. */
function projectRoot(from = MINIMAL): string {
  const root = tempDir("autoclaude-verbs-");
  cpSync(join(from, ".autoclaude"), join(root, ".autoclaude"), { recursive: true });
  mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
  return root;
}

describe("the table of verbs", () => {
  it("registers every verb of the operating surface", () => {
    for (const verb of [
      "init",
      "doctor",
      "status",
      "watch",
      "situation",
      "pause",
      "drain",
      "resume",
      "triage",
      "issue",
      "review",
      "can-merge",
      "rollback",
      "bench",
      "note",
      "red-step",
      "decision",
      "reports",
      "publish",
      "post-review",
      "check-rebased",
      "ledger",
      // the verbs of earlier tasks stay
      "gates",
      "guard",
      "run",
      "service",
    ])
      expect(VERBS[verb], verb).toBeTypeOf("function");
  });

  // Every verb refuses a bad command line with exit 64 and a usage line, before it reads a
  // repository, a configuration or the network.
  const BAD: Array<[string, string[]]> = [
    ["init", ["--frobnicate"]],
    ["doctor", ["--frobnicate"]],
    ["status", ["--frobnicate"]],
    ["watch", ["--frobnicate"]],
    ["watch", ["--issue", "0x10"]],
    ["watch", ["--issue", "7", "--issue", "8"]],
    ["watch", ["--interval", "0"]],
    ["situation", ["--frobnicate"]],
    ["pause", ["now"]],
    ["drain", ["now"]],
    ["resume", ["now"]],
    ["triage", ["--issue", "0x10"]],
    ["triage", ["7"]],
    ["issue", []],
    ["issue", ["0x10"]],
    ["issue", ["7", "--frobnicate"]],
    ["review", []],
    ["review", ["--pr", "0x10"]],
    ["review", ["--pr", "7", "--pr", "8"]],
    ["can-merge", []],
    ["can-merge", ["0x10"]],
    ["can-merge", ["7", "--frobnicate"]],
    ["rollback", ["9", "--reason", "x"]],
    ["rollback", ["9", "--to", "blocked"]],
    ["rollback", ["9", "--to", "Blocked", "--reason", "x"]],
    ["bench", ["one-file-only"]],
    ["bench", ["a", "b", "--frobnicate"]],
    ["note", []],
    ["note", ["0x10", "text"]],
    ["note", ["9"]],
    ["red-step", ["--frobnicate"]],
    ["decision", ["0x10"]],
    ["decision", ["7", "--stage", "implement"]],
    ["reports", ["bogus", "file"]],
    ["reports", ["plan"]],
    ["publish", []],
    ["publish", ["0x10"]],
    ["post-review", ["0x10", "--report", "r", "--sha", "s"]],
    ["post-review", ["7", "--report", "r"]],
    ["check-rebased", ["--frobnicate"]],
    ["ledger", ["bogus"]],
    ["ledger", ["set", "0x10", "claimed"]],
  ];
  it.each(BAD)("%s %j exits 64 with a usage line", async (verb, args) => {
    const c = capture();
    expect(await VERBS[verb]!(args, c.io)).toBe(64);
    expect(c.errText()).toMatch(/usage: autoclaude /i);
    expect(c.text()).toBe("");
  });
});

describe("pause, drain and resume", () => {
  it("write and clear the control files, keep one of the two, and print the state", async () => {
    const root = projectRoot();
    const env = envFor(root);
    const run = async (verb: typeof pauseVerb) => {
      const c = capture();
      const code = await verb([], c.io, root, env);
      return { code, state: JSON.parse(c.text()) as { paused: boolean; draining: boolean } };
    };
    expect(await run(drainVerb)).toEqual({ code: 0, state: { paused: false, draining: true } });
    expect(await run(pauseVerb)).toEqual({ code: 0, state: { paused: true, draining: false } });
    expect(controlState(root)).toEqual({ paused: true, draining: false });
    expect(await run(resumeVerb)).toEqual({ code: 0, state: { paused: false, draining: false } });
  });
});

describe("autoclaude note", () => {
  it("appends a ledger note under the lock and never touches the network", async () => {
    const root = projectRoot();
    const calls: string[] = [];
    const env = envFor(root, {
      exec: (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 1, stdout: "", stderr: "no network in this test" };
      },
    });
    const c = capture();
    expect(await noteVerb(["9", "plan", "drafted;", "now", "reviewing"], c.io, root, env)).toBe(0);
    const log = readFileSync(join(root, ".autoclaude", "state", "runs", "9", "events.log"), "utf8");
    expect(log).toContain("#9");
    expect(log).toContain("plan drafted; now reviewing");
    expect(JSON.parse(c.text())).toHaveProperty("noted");
    expect(calls).toEqual([]);
    // No ledger lock is left behind.
    expect(existsSync(join(root, ".autoclaude", "state", "ledger.lock"))).toBe(false);
  });

  it("records a shell-looking text as text", async () => {
    const root = projectRoot();
    const env = envFor(root);
    const text = "Fix login & logout --replace $(rm -rf ~) `id`";
    expect(await noteVerb(["4", text], capture().io, root, env)).toBe(0);
    expect(
      readFileSync(join(root, ".autoclaude", "state", "runs", "4", "events.log"), "utf8"),
    ).toContain(text);
  });
});

describe("autoclaude ledger", () => {
  it("shows, sets and limits through the ledger's own commands, and reports a failure as exit 1", async () => {
    const root = projectRoot();
    const env = envFor(root);
    const set = capture();
    expect(
      await ledgerVerb(
        ["set", "9", "claimed", "--title", "Pager", "--branch", "agent/9-pager"],
        set.io,
        root,
        env,
      ),
    ).toBe(0);
    const show = capture();
    expect(await ledgerVerb(["show"], show.io, root, env)).toBe(0);
    expect(JSON.parse(show.text()).issues["9"].state).toBe("claimed");
    const lim = capture();
    expect(await ledgerVerb(["limit", "+30"], lim.io, root, env)).toBe(0);
    expect(loadLedger(root).limitedUntil).not.toBeNull();
    // A branch outside the issue's namespace is refused by the ledger, not by the usage rule.
    const bad = capture();
    expect(
      await ledgerVerb(["set", "9", "claimed", "--branch", "develop"], bad.io, root, env),
    ).toBe(1);
    expect(bad.errText()).toMatch(/integration branch/);
  });
});

describe("autoclaude situation", () => {
  const issueJson = (n: number) => ({
    number: n,
    title: "Pager",
    state: "OPEN",
    labels: [{ name: "agent-working" }],
    assignees: [],
    comments: [
      {
        author: { login: "bot" },
        body: claimBody(machineId(), NOW.toISOString()),
        createdAt: NOW.toISOString(),
      },
    ],
    updatedAt: "2026-10-17T08:00:00Z",
  });
  function rig(opts: { instance?: { id: string; ageSec: number } } = {}) {
    const root = tempRepo({ project: MINIMAL });
    const state = join(root, ".autoclaude", "state");
    mkdirSync(state, { recursive: true });
    const ledger = emptyLedger(machineId());
    const wt = join(root, "wt");
    mkdirSync(wt);
    transition(
      ledger,
      5,
      "implementing",
      {
        title: "Pager",
        branch: "agent/5-pager",
        worktree: wt,
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
    saveLedger(root, ledger, NOW);
    if (opts.instance)
      writeFileSync(
        join(state, "instance.json"),
        JSON.stringify({
          instance: opts.instance.id,
          pid: 1,
          heartbeatAt: new Date(NOW.getTime() - opts.instance.ageSec * 1000).toISOString(),
        }),
      );
    const exec = routed([
      (cmd, args) => {
        if (cmd !== "gh") return undefined;
        if (args.includes("pr") && args.includes("list")) return { stdout: "[]" };
        if (args.includes("issue") && args.includes("list"))
          return { stdout: args.includes("agent-working") ? JSON.stringify([issueJson(5)]) : "[]" };
        return { status: 1, stderr: `unexpected gh call: ${args.join(" ")}` };
      },
    ]);
    return { root, env: envFor(root, { exec }) };
  }
  const stageOf = (root: string) => loadLedger(root).issues["5"]!;

  it("prints one JSON line with now, machine, the orchestrator and the situation's keys", async () => {
    const { root, env } = rig();
    const c = capture();
    expect(await situationVerb(["--read-only"], c.io, root, env)).toBe(0);
    expect(c.text().trim().split("\n")).toHaveLength(1);
    const out = JSON.parse(c.text());
    expect(Object.keys(out)).toEqual([
      "now",
      "machine",
      "orchestrator",
      "profile",
      "control",
      "limitedUntil",
      "issues",
      "foreign",
      "counts",
      "queue",
      "cleanup",
      "stalled",
      "newWork",
      "caps",
    ]);
    expect(out.now).toBe(NOW.toISOString());
    expect(out.orchestrator).toEqual({ recorded: null, live: null });
    // --pretty is indented, and the same data.
    const p = capture();
    await situationVerb(["--read-only", "--pretty"], p.io, root, env);
    expect(p.text().split("\n").length).toBeGreaterThan(10);
    expect(JSON.parse(p.text()).counts).toEqual(out.counts);
  });

  it("--read-only writes nothing; without it the reconcile is saved", async () => {
    const { root, env } = rig();
    const before = readFileSync(join(root, ".autoclaude", "state", "ledger.json"), "utf8");
    await situationVerb(["--read-only"], capture().io, root, env);
    expect(readFileSync(join(root, ".autoclaude", "state", "ledger.json"), "utf8")).toBe(before);
    await situationVerb([], capture().io, root, env);
    expect(readFileSync(join(root, ".autoclaude", "state", "ledger.json"), "utf8")).not.toBe(
      before,
    );
  });

  it("passes the recorded instance as live when its heartbeat is fresh, else none", async () => {
    const fresh = rig({ instance: { id: "inst-a", ageSec: 20 } });
    const c = capture();
    await situationVerb(["--read-only"], c.io, fresh.root, fresh.env);
    expect(JSON.parse(c.text()).orchestrator).toEqual({ recorded: "inst-a", live: "inst-a" });
    expect(JSON.parse(c.text()).issues[0].stage).not.toBeNull();

    const stale = rig({ instance: { id: "inst-a", ageSec: 300 } });
    const s = capture();
    await situationVerb([], s.io, stale.root, stale.env);
    expect(JSON.parse(s.text()).orchestrator).toEqual({ recorded: "inst-a", live: null });
    // A recorded stage of an instance that is not live reads as dead: the entry is resumable.
    expect(stageOf(stale.root).state).toBe("resume-needed");
    expect(stageOf(fresh.root).state).toBe("implementing");
  });

  it("--full adds the whole ledger entry to each issue", async () => {
    const { root, env } = rig();
    const c = capture();
    await situationVerb(["--read-only", "--full"], c.io, root, env);
    expect(JSON.parse(c.text()).issues[0]).toHaveProperty("lastCanMerge");
    const compact = capture();
    await situationVerb(["--read-only"], compact.io, root, env);
    expect(JSON.parse(compact.text()).issues[0]).not.toHaveProperty("lastCanMerge");
  });

  it("exits 1 with the message when the forge cannot be read", async () => {
    const { root } = rig();
    const exec = routed([
      (cmd) => (cmd === "gh" ? { status: 1, stderr: "rate limited" } : undefined),
    ]);
    const c = capture();
    expect(await situationVerb(["--read-only"], c.io, root, envFor(root, { exec }))).toBe(1);
    expect(c.errText()).toMatch(/rate limited/);
  });
});

describe("pickIssues and renderWatch", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const stage = (startedAt: string) => ({
    stage: "implement" as const,
    mode: "fresh" as const,
    pid: 1,
    instance: "i",
    startedAt,
    processStartedAt: null,
  });

  it("renders the status and the tail of each running issue's log", () => {
    const out = renderWatch({
      statusMd: "# autoclaude status\n\nsome table row",
      tails: [
        {
          issue: 10,
          lines: [
            "2026-09-14T10:00:00.000Z #10 implement state claimed -> implementing",
            "2026-09-14T10:01:00.000Z #10 implement gate lint pass",
          ],
        },
        { issue: 20, lines: ["2026-09-14T10:05:00.000Z #20 code-review angle bugs dispatched"] },
      ],
      now,
    });
    expect(out).toContain("# autoclaude status");
    expect(out).toContain("some table row");
    expect(out).toContain("2026-09-14T10:01:00.000Z #10 implement gate lint pass");
    expect(out).toContain("2026-09-14T10:05:00.000Z #20 code-review angle bugs dispatched");
    expect(out.indexOf("#10")).toBeLessThan(out.indexOf("#20"));
  });

  it("says so when there is no status or no log yet", () => {
    const out = renderWatch({ statusMd: null, tails: [{ issue: 30, lines: [] }], now });
    expect(out).toContain("no status.md yet");
    expect(out).toContain("no events yet");
  });

  it("picks the entries with a live stage, newest first, and honours --issue over the ledger", () => {
    const ledger = emptyLedger("m");
    transition(ledger, 10, "implementing", {
      title: "t10",
      branch: "agent/10-x",
      worktree: "w",
      stage: stage("2026-09-14T10:00:00.000Z"),
    });
    transition(ledger, 20, "code-reviewing", {
      title: "t20",
      branch: "agent/20-x",
      worktree: "w",
      stage: stage("2026-09-14T11:00:00.000Z"),
    });
    // pr-open carries no live stage; it must not appear even though the ledger knows it.
    transition(ledger, 30, "pr-open", { title: "t30", branch: "agent/30-x", worktree: "w" });
    expect(pickIssues(ledger)).toEqual([20, 10]);
    expect(pickIssues(ledger, 99)).toEqual([99]);
  });
});

describe("autoclaude watch", () => {
  function watched() {
    const root = projectRoot();
    const state = join(root, ".autoclaude", "state");
    writeFileSync(join(state, "status.md"), "# autoclaude status\n\nstatus-marker\n");
    mkdirSync(join(state, "runs", "77"), { recursive: true });
    writeFileSync(
      join(state, "runs", "77", "events.log"),
      "2026-09-14T10:00:00.000Z #77 implement log-marker\n",
    );
    return root;
  }

  it("--once prints status.md and the requested issue's log tail, reading files only", async () => {
    const root = watched();
    const calls: string[] = [];
    const env = envFor(root, {
      exec: (cmd, args) => (
        calls.push(`${cmd} ${args.join(" ")}`),
        { status: 1, stdout: "", stderr: "" }
      ),
    });
    const c = capture();
    expect(await watchVerb(["--issue", "77", "--once"], c.io, root, env)).toBe(0);
    expect(c.text()).toContain("status-marker");
    expect(c.text()).toContain("log-marker");
    expect(calls).toEqual([]);
  });

  it("refreshes until it is signalled, clearing the screen each time, and survives a bad frame", async () => {
    const root = watched();
    let frames = 0;
    const c = capture();
    const ac = new AbortController();
    const code = await watchVerb(["--interval", "1"], c.io, root, envFor(root), {
      sleep: async () => {
        frames++;
        if (frames === 1)
          writeFileSync(join(root, ".autoclaude", "state", "ledger.json"), "{ torn");
        if (frames === 2) rmSync(join(root, ".autoclaude", "state", "ledger.json"));
        if (frames === 3) ac.abort();
      },
      stop: ac.signal,
    });
    expect(code).toBe(0);
    expect(c.text().split("\x1b[2J\x1b[H").length - 1).toBeGreaterThanOrEqual(2);
    expect(c.errText()).toMatch(/watch: /);
  });

  it("fails the first frame when the ledger cannot be read", async () => {
    const root = watched();
    writeFileSync(join(root, ".autoclaude", "state", "ledger.json"), "{ torn");
    const c = capture();
    expect(await watchVerb(["--once"], c.io, root, envFor(root))).toBe(1);
  });
});

describe("autoclaude can-merge", () => {
  const verdict = (allowed: boolean) => ({
    pr: 7,
    review: { issue: 9, archive: "a" },
    allowed,
    checks: [
      { id: 1, name: "pull request is open", result: "pass" as const, detail: "open" },
      {
        id: 2,
        name: "required checks green",
        result: (allowed ? "pass" : "fail") as "pass" | "fail",
        detail: allowed ? "all green" : "test: fail",
      },
    ],
  });

  it("exits 0 when allowed and 1 when refused, printing the table or the JSON", async () => {
    const root = projectRoot();
    const env = envFor(root);
    const ok = capture();
    expect(await canMergeVerb(["7"], ok.io, root, env, { canMerge: () => verdict(true) })).toBe(0);
    expect(ok.text()).toMatch(/can-merge #7: ALLOWED/);
    const no = capture();
    expect(await canMergeVerb(["7"], no.io, root, env, { canMerge: () => verdict(false) })).toBe(1);
    expect(no.text()).toMatch(/can-merge #7: REFUSED/);
    const json = capture();
    expect(
      await canMergeVerb(["7", "--json"], json.io, root, env, { canMerge: () => verdict(false) }),
    ).toBe(1);
    expect(JSON.parse(json.text())).toMatchObject({ pr: 7, allowed: false, review: { issue: 9 } });
  });

  it("exits 1 with the message when the verdict could not be computed", async () => {
    const root = projectRoot();
    const c = capture();
    const boom = () => {
      throw new Error("gh pr view 7 failed (exit 1): not found");
    };
    expect(await canMergeVerb(["7"], c.io, root, envFor(root), { canMerge: boom })).toBe(1);
    expect(c.errText()).toMatch(/not found/);
  });

  it("asks the forge about the number that was typed, and nothing before the token is checked", async () => {
    const root = projectRoot();
    let asked: number | null = null;
    await canMergeVerb(["12"], capture().io, root, envFor(root), {
      canMerge: (n) => ((asked = n), verdict(true)),
    });
    expect(asked).toBe(12);
  });
});

describe("autoclaude bench", () => {
  const pair = [join(BENCH, "sample-report.md"), join(BENCH, "sample-expected.json")];
  const run = async (args: string[]) => {
    const c = capture();
    const code = await benchVerb(args, c.io, FULL, envFor(FULL));
    return { code, out: c.text(), err: c.errText() };
  };

  it("prints the table and exits 0", async () => {
    const r = await run(pair);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/boundary\s+hit\s+must\s+src\/lib\/pager\.ts:40-50/);
    expect(r.out).toMatch(/router\s+miss/);
    expect(r.out).toMatch(/recall 0\.56 \(5\/9\)/);
    expect(r.out).toMatch(/seenRate 0\.78 \(7\/9\)/);
    expect(r.out).toContain("docs/completeness");
  });

  it("prints the same measurement as JSON, with the two path keys named for what they are", async () => {
    const r = await run([...pair, "--json"]);
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(r.out) as {
      recall: number;
      reportFile: string;
      expectedFile: string;
    };
    expect(parsed.recall).toBeCloseTo(5 / 9, 10);
    expect(parsed.reportFile).toBe(pair[0]);
    expect(parsed.expectedFile).toBe(pair[1]);
  });

  it("exits 1 on a report the parser cannot read", async () => {
    const dir = tempDir("autoclaude-bench-");
    const legacy = join(dir, "legacy.md");
    writeFileSync(
      legacy,
      "REVIEW\nissue: 103\nlevel: none\nfindings: []\nREVIEW-STATUS: complete\n",
    );
    const r = await run([legacy, pair[1]!]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("AUTODEV-CODE-REVIEW");
  });

  // A review that stopped early found less than one that ran to the end, and the status
  // line is the only proof it ran at all: measuring one is measuring nothing.
  it("exits 1 on a report that never reached its verdict, printing nothing", async () => {
    const dir = tempDir("autoclaude-bench-");
    const stopped = join(dir, "stopped.md");
    writeFileSync(
      stopped,
      readFileSync(pair[0]!, "utf8").replace(
        "CODE-REVIEW-STATUS: complete",
        "CODE-REVIEW-STATUS: stopped",
      ),
    );
    const r = await run([stopped, pair[1]!]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the run did not finish");
    expect(r.out).toBe("");
  });

  it("exits 1 on a report file that is not there, and 64 without both arguments", async () => {
    const missing = await run([join(BENCH, "no-such-report.md"), pair[1]!]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("ENOENT");
    expect((await run([pair[0]!])).code).toBe(64);
  });
});

describe("autoclaude red-step", () => {
  const proven = {
    verdict: { kind: "proven" as const, reason: "base fails" },
    reason: "base fails",
    files: ["a.test.ts"],
  };
  const run = async (args: string[], result: unknown) => {
    const root = projectRoot();
    const c = capture();
    const code = await redStepVerb(
      args,
      c.io,
      root,
      envFor(root, { exec: () => ({ status: 0, stdout: "", stderr: "" }) }),
      {
        runRedStep: async () => result as never,
      },
    );
    return { code, out: c.text(), err: c.errText() };
  };

  it("maps the verdict onto the exit codes of design § 14: 0 proven, 2 not proven, 3 no test files, 1 could not run", async () => {
    expect((await run([], proven)).code).toBe(0);
    expect(
      (await run([], { verdict: { kind: "not-proven", reason: "r" }, reason: "r" })).code,
    ).toBe(2);
    expect(
      (
        await run([], {
          verdict: { kind: "no-test-files" },
          reason: "no test files among 2 path(s)",
        })
      ).code,
    ).toBe(3);
    expect(
      (
        await run([], {
          verdict: { kind: "could-not-run", reason: "base broken" },
          reason: "base broken",
        })
      ).code,
    ).toBe(1);
  });

  it("--json prints the result, and the plain form prints a label and the reason", async () => {
    const json = await run(["--json"], proven);
    expect(JSON.parse(json.out)).toMatchObject({
      verdict: { kind: "proven" },
      files: ["a.test.ts"],
    });
    const plain = await run([], proven);
    expect(plain.out).toMatch(/red step: PROVEN \(base fails\)/);
  });

  it("exits 1 when git or the runner cannot answer", async () => {
    const root = projectRoot();
    const c = capture();
    const code = await redStepVerb(
      [],
      c.io,
      root,
      envFor(root, { exec: () => ({ status: 0, stdout: "", stderr: "" }) }),
      {
        runRedStep: async () => {
          throw new Error("git diff failed: bad revision");
        },
      },
    );
    expect(code).toBe(1);
    expect(c.errText()).toMatch(/bad revision/);
  });
});

describe("autoclaude decision", () => {
  const decided = (action: string): DecisionResult => ({
    code: 0,
    decision: {
      action,
      reason: "r",
      dispatchMarkdown: "Fix the pager.",
      kept: [],
      demoted: [],
    } as never,
    message: `issue 7: ${action} — r`,
  });
  const run = async (args: string[], result: DecisionResult | Error) => {
    const root = projectRoot();
    const c = capture();
    const code = await decisionVerb(args, c.io, root, envFor(root), {
      reviewDecision: () => {
        if (result instanceof Error) throw result;
        return result;
      },
    });
    return { code, out: c.text(), err: c.errText() };
  };

  it("prints the decision as JSON on stdout and one line on stderr, exit 0", async () => {
    const r = await run(["7"], decided("fix"));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).action).toBe("fix");
    expect(r.err.trim()).toBe("issue 7: fix — r");
  });

  it("--markdown prints the dispatch, falling back to the reason when there is none", async () => {
    expect((await run(["7", "--markdown"], decided("fix"))).out.trim()).toBe("Fix the pager.");
    const empty = decided("publish");
    (empty.decision as { dispatchMarkdown: string }).dispatchMarkdown = "";
    expect((await run(["7", "--markdown"], empty)).out.trim()).toBe("r");
  });

  it("answers 2 for an unfinished report and 1 for a run it cannot decide, in the one-line shape", async () => {
    const incomplete = await run(["7"], {
      code: 2,
      decision: null,
      message: "issue 7: incomplete — not marked complete",
    });
    expect(incomplete.code).toBe(2);
    expect(incomplete.out).toBe("");
    const thrown = await run(["7"], new Error("not inside a git repository"));
    expect(thrown.code).toBe(1);
    expect(thrown.err).toMatch(/^issue 7: cannot-decide — .*not inside a git repository/);
  });

  it("parses --stage, --report and the output flags like the source, and refuses the rest", () => {
    expect(parseDecisionArgs(["7"])).toEqual({
      issue: 7,
      stage: "code-review",
      report: undefined,
      markdown: false,
    });
    expect(
      parseDecisionArgs(["7", "--stage", "plan-review", "--report", "r.md", "--markdown"]),
    ).toEqual({
      issue: 7,
      stage: "plan-review",
      report: "r.md",
      markdown: true,
    });
    expect(() => parseDecisionArgs(["7", "--pr", "12"])).toThrow(/unknown option/);
    expect(() => parseDecisionArgs(["7", "--json", "--markdown"])).toThrow(/two different outputs/);
    expect(() => parseDecisionArgs(["7", "--stage", "a", "--stage", "b"])).toThrow(
      /more than once/,
    );
    expect(() => parseDecisionArgs(["7", "--report", "--json"])).toThrow(/needs a value/);
  });

  // The command line against a real ledger and a real report, as the dropped source tests ran it.
  it("decides a real report from a temporary project, and exits 1 for a plan-review report that is not there", async () => {
    const root = projectRoot();
    const wt = join(root, "wt");
    mkdirSync(join(wt, ".autoclaude", "state", "reports"), { recursive: true });
    writeFileSync(
      join(wt, ".autoclaude", "state", "reports", "code-review.md"),
      [
        "AUTODEV-CODE-REVIEW",
        "issue: 5",
        "red-step: proven",
        "fan-out: bugs, tests",
        "scored-by: model-small",
        "criteria:",
        "  1. met — src/x.ts:3",
        "findings:",
        "uncertain:",
        "CODE-REVIEW-STATUS: complete",
        "",
      ].join("\n"),
    );
    const ledger = emptyLedger("host/ada");
    transition(ledger, 5, "code-reviewing", { title: "t", branch: "agent/5-x", worktree: wt }, NOW);
    saveLedger(root, ledger, NOW);
    const env = envFor(root);
    const code = capture();
    expect(await decisionVerb(["5"], code.io, root, env)).toBe(0);
    expect(JSON.parse(code.text()).action).toBe("publish");
    expect(code.errText()).toMatch(/^issue 5: publish — /);
    const plan = capture();
    expect(await decisionVerb(["5", "--stage", "plan-review"], plan.io, root, env)).toBe(1);
    expect(plan.errText()).toMatch(/^issue 5: cannot-decide — /);
  });
});

describe("autoclaude reports", () => {
  const run = async (args: string[], root = FULL) => {
    const c = capture();
    const code = await reportsVerb(args, c.io, root, envFor(root));
    return { code, out: c.text(), err: c.errText() };
  };

  it("prints the parsed plan, implement, plan-review and code-review reports as JSON", async () => {
    for (const stage of ["plan", "implement", "plan-review", "code-review"] as const) {
      const r = await run([stage, join(REPORTS, `${stage}.md`)]);
      expect(r.code, `${stage}: ${r.err}`).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
    }
  });

  it("exits 2 for a review that did not finish — asked before the catalogue is even loaded — and 1 for a malformed one", async () => {
    const stopped = join(REPORTS, "code-review-stopped.md");
    expect((await run(["code-review", stopped])).code).toBe(2);
    // A catalogue that does not load must not turn a stopped run into "cannot decide".
    const broken = projectRoot();
    writeFileSync(join(broken, ".autoclaude", "invariants.md"), "| `Bad Row` | error | a | b |\n");
    const r = await run(["code-review", stopped], broken);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not marked complete/);
    const garbled = join(tempDir("autoclaude-reports-"), "r.md");
    writeFileSync(garbled, "no block here\n");
    expect((await run(["plan", garbled])).code).toBe(1);
    expect((await run(["plan", join(REPORTS, "missing.md")])).code).toBe(1);
  });
});

describe("autoclaude publish", () => {
  it("prints the result on 0, names the conflict on 3, and 1 for any other failure", async () => {
    const root = projectRoot();
    const ok = capture();
    expect(
      await publishVerb(["9"], ok.io, root, envFor(root), {
        publish: () => ({ code: 0, issue: 9, pr: 40, rebased: false, pushed: "abc" }),
      }),
    ).toBe(0);
    expect(JSON.parse(ok.text())).toMatchObject({ issue: 9, pr: 40 });
    const conflict = capture();
    expect(
      await publishVerb(["9", "--update"], conflict.io, root, envFor(root), {
        publish: (issue, update) => {
          expect(update).toBe(true);
          return { code: 3, issue, conflict: "CONFLICT (content): src/a.ts" };
        },
      }),
    ).toBe(3);
    expect(conflict.errText()).toMatch(/rebase onto origin\/develop conflicted:\nCONFLICT/);
    const failed = capture();
    expect(
      await publishVerb(["9"], failed.io, root, envFor(root), {
        publish: () => {
          throw new Error("no ledger entry for issue 9");
        },
      }),
    ).toBe(1);
    expect(failed.errText()).toMatch(/no ledger entry/);
  });
});

describe("autoclaude post-review and check-rebased", () => {
  it("post-review passes the poster's exit code through, 64 for usage and 1 for a missing report", async () => {
    const root = projectRoot();
    const report = join(tempDir("autoclaude-post-"), "r.md");
    writeFileSync(report, "text");
    const ok = capture();
    expect(
      await postReviewVerb(["7", "--report", report, "--sha", "abc"], ok.io, root, envFor(root), {
        postReview: (pr, text, sha) => ({
          code: 0,
          message: `posted 0 findings for ${sha} on #${pr} (${text.length})`,
        }),
      }),
    ).toBe(0);
    expect(ok.errText()).toMatch(/posted 0 findings for abc on #7/);
    const parse = capture();
    expect(
      await postReviewVerb(
        ["7", "--report", report, "--sha", "abc"],
        parse.io,
        root,
        envFor(root),
        {
          postReview: () => ({ code: 2, message: "report did not parse: x" }),
        },
      ),
    ).toBe(2);
    const missing = capture();
    expect(
      await postReviewVerb(
        ["7", "--report", join(root, "none.md"), "--sha", "abc"],
        missing.io,
        root,
        envFor(root),
      ),
    ).toBe(1);
  });

  it("check-rebased exits 0 when rebased and 1 when stale or when the fetch failed, naming the remedy as git steps", async () => {
    const root = projectRoot();
    const yes = capture();
    expect(
      await checkRebasedVerb([], yes.io, root, envFor(root), {
        checkRebased: () => ({ rebased: true, base: "origin/develop" }),
      }),
    ).toBe(0);
    expect(yes.text()).toMatch(/Rebased onto origin\/develop/);
    const no = capture();
    expect(
      await checkRebasedVerb([], no.io, root, envFor(root), {
        checkRebased: () => ({ rebased: false, base: "origin/develop" }),
      }),
    ).toBe(1);
    expect(no.errText()).toMatch(
      /Not rebased onto origin\/develop\. Run: git fetch origin && git rebase origin\/develop/,
    );
    const boom = capture();
    expect(
      await checkRebasedVerb([], boom.io, root, envFor(root), {
        checkRebased: () => {
          throw new Error("git fetch origin develop failed (exit 128)");
        },
      }),
    ).toBe(1);
  });
});

describe("autoclaude post-review with a configuration that cannot be read", () => {
  it("still posts the review, degraded, with the repository taken from origin", async () => {
    const root = projectRoot();
    writeFileSync(join(root, ".autoclaude", "config.json"), "{ broken");
    const report = join(tempDir("autoclaude-post-"), "r.md");
    writeFileSync(report, readFileSync(join(REPORTS, "code-review.md"), "utf8"));
    const posted: string[] = [];
    const exec = routed([
      (cmd, a) => {
        if (cmd === "git" && a.includes("get-url"))
          return { stdout: "https://github.com/acme/widgets.git\n" };
        if (cmd === "gh" && a.includes("view")) return { stdout: '{"comments":[]}' };
        if (cmd === "gh" && a.includes("comment")) {
          posted.push(a.join(" "));
          return {};
        }
        return undefined;
      },
    ]);
    const c = capture();
    const code = await postReviewVerb(
      ["7", "--report", report, "--sha", "abc123"],
      c.io,
      root,
      envFor(root, {
        exec,
        config: () => {
          throw new Error("config.json: invalid JSON");
        },
      }),
    );
    expect(code, c.errText()).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("-R acme/widgets pr comment 7");
    expect(c.errText()).toMatch(/configuration cannot be read/);
  });
});
