import { afterAll, describe, expect, it } from "vitest";
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
import { loadProjectConfig } from "../../src/config/load.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { loadLedger, transition, updateLedger } from "../../src/engine/ledger/ledger.js";
import { Forge, type Exec } from "../../src/forge/github.js";
import { prefetchIssue, prefetchPriorPrs } from "../../src/orchestrator/prefetch.js";
import { runStage, type OrchestratorCtx, type StageOutcome } from "../../src/orchestrator/stage.js";
import { TriageSchema } from "../../src/orchestrator/review/schemas.js";
import type { Dispatch } from "../../src/prompts/dispatch.js";
import { fakeRuntime, type FakeRuntime } from "../helpers/fake-runtime.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");
const HOSTILE = "Fix login & logout --replace $(rm -rf ~) `id`";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  root: string;
  worktree: string;
  cfg: ProjectConfig;
  ctx: OrchestratorCtx;
  order: string[];
  notes: string[];
  fetches: Array<{ args: string[]; cwd?: string }>;
  runtime: (opts?: Parameters<typeof fakeRuntime>[0]) => FakeRuntime;
}

/** A project root with a space and an umlaut, a worktree directory, a ledger entry and fakes. */
function rig(edit?: (cfg: ProjectConfig) => void): Rig {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "autoclaude-stage-")));
  tmpDirs.push(base);
  const root = join(base, "Jürgen Müller", "My Projects", "app");
  const worktree = join(root, ".autoclaude", "worktrees", "agent+42-fix-it").replaceAll("\\", "/");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, ".autoclaude", "project.md"), "# Project\n");
  const cfg = loadProjectConfig(MINIMAL);
  cfg.forge.remote = "origin";
  cfg.branches.integration = "develop";
  cfg.bootstrap = 'echo x >> "boot.log"';
  edit?.(cfg);
  updateLedger(root, (l) => {
    transition(l, 42, "planning", { title: "Fix it", worktree, branch: "agent/42-fix-it" });
  });
  const order: string[] = [];
  const notes: string[] = [];
  const fetches: Rig["fetches"] = [];
  const issue = {
    number: 42,
    title: HOSTILE,
    state: "OPEN",
    labels: [{ name: "ready" }],
    assignees: [],
    updatedAt: "2026-01-01T00:00:00Z",
    body: "Body with ${HOME} and $(whoami)",
    comments: [{ author: { login: "octo" }, body: "A comment", createdAt: "2026-01-02T00:00:00Z" }],
  };
  const exec: Exec = (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "fetch") {
      order.push("fetch");
      fetches.push({ args, cwd: opts?.cwd });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "gh" && args.includes("view")) {
      return { status: 0, stdout: JSON.stringify(issue), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  let current: FakeRuntime | undefined;
  const ctx: OrchestratorCtx = {
    root,
    cfg,
    forge: new Forge("acme/widgets", exec),
    exec,
    instance: "inst-1",
    now: () => new Date("2026-03-01T10:00:00Z"),
    runtimes: () => {
      if (!current) throw new Error("test: no runtime set");
      return current;
    },
    notes: (n, text) => {
      notes.push(`#${n} ${text}`);
    },
  };
  return {
    root,
    worktree,
    cfg,
    ctx,
    order,
    notes,
    fetches,
    runtime: (opts) => {
      current = fakeRuntime({
        ...opts,
        onStart: (req) => {
          order.push("start");
          opts?.onStart?.(req);
        },
      });
      return current;
    },
  };
}

const entryOf = (r: Rig) => loadLedger(r.root).issues["42"]!;
const PLAN = "AUTODEV-PLAN\nplan-file: x\nAUTODEV-PLAN-END\n";
const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));

describe("runStage", () => {
  it("fetches the integration branch in the worktree before the child is spawned", async () => {
    const r = rig();
    const rt = r.runtime({ report: { file: "plan.md", text: PLAN } });
    const out = await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("report");
    expect(r.order).toEqual(["fetch", "start"]);
    expect(r.fetches[0]!.args).toEqual(["fetch", "origin", "develop"]);
    expect(r.fetches[0]!.cwd).toBe(r.worktree);
    expect(rt.requests[0]!.cwd).toBe(r.worktree);
  });

  /** The bootstrap writes what it saw of the forge token and the stage marker. */
  const ENV_PROBE = 'echo "[${GH_TOKEN:-none}|${AUTOCLAUDE_STAGE:-none}]" >> "boot.log"';
  const withToken = async (body: () => Promise<void>) => {
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "engine-token";
    try {
      await body();
    } finally {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
    }
  };

  // R69: a worktree fresh from the integration branch is bootstrapped in the engine's
  // environment, once; the first stage recorded in it ends that.
  it("bootstraps a fresh worktree once, in the worktree and in the engine's environment", async () => {
    const r = rig((c) => {
      c.bootstrap = ENV_PROBE;
    });
    updateLedger(r.root, (l) => void (l.issues["42"]!.freshWorktree = true));
    r.runtime({ report: { file: "plan.md", text: PLAN } });
    await withToken(async () => {
      await runStage(r.ctx, entryOf(r), "plan", "fresh");
      await runStage(r.ctx, entryOf(r), "plan", "fix");
    });
    const log = readFileSync(join(r.worktree, "boot.log"), "utf8").trim().split(/\r?\n/);
    expect(log).toEqual(["[engine-token|none]"]);
    expect(existsSync(join(r.worktree, ".autoclaude", "state", "bootstrapped"))).toBe(true);
    expect(entryOf(r).freshWorktree, "a stage ran in it: no longer fresh").toBeUndefined();
  });

  // R69: anything else — recreated from a pushed agent branch, or a stage ran in it — executes
  // what a stage wrote, so it gets the stage environment: no forge token.
  it("bootstraps a worktree that is not fresh in the stage environment", async () => {
    const r = rig((c) => {
      c.bootstrap = ENV_PROBE;
    });
    r.runtime({ report: { file: "plan.md", text: PLAN } });
    await withToken(() => runStage(r.ctx, entryOf(r), "plan", "fresh").then(() => {}));
    const log = readFileSync(join(r.worktree, "boot.log"), "utf8").trim().split(/\r?\n/);
    expect(log).toEqual(["[none|1]"]);
  });

  it("records the stage with pid, instance and process start the moment the child exists", async () => {
    const r = rig();
    const rt = r.runtime({ report: { file: "plan.md", text: PLAN }, hold: true });
    const running = runStage(r.ctx, entryOf(r), "plan", "fresh");
    for (let i = 0; i < 200 && rt.requests.length === 0; i++) await sleep(25);
    // Wait for the record: it follows the spawn by one start-time read.
    for (let i = 0; i < 200 && entryOf(r).stage === null; i++) await sleep(25);
    // The child has not exited, and the ledger is free to others (the lock is held for the write only).
    const during = entryOf(r).stage;
    expect(during).toMatchObject({
      stage: "plan",
      mode: "fresh",
      pid: process.pid,
      instance: "inst-1",
    });
    expect(during!.processStartedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    updateLedger(r.root, () => {});
    rt.finish();
    expect((await running).kind).toBe("report");
    // Kept after exit: the caller that consumes the outcome clears it.
    expect(entryOf(r).stage).toMatchObject({ pid: process.pid, instance: "inst-1" });
  });

  it("returns limit with the reset time and bumps no counter", async () => {
    const r = rig();
    const before = entryOf(r).attempts;
    r.runtime({ result: { exit: "limit", limitResetsAt: "2026-03-01T15:00:00.000Z" } });
    const out = await runStage(r.ctx, entryOf(r), "implement", "fresh");
    expect(out).toMatchObject({ kind: "limit", resetsAt: "2026-03-01T15:00:00.000Z" });
    expect(entryOf(r).attempts).toEqual(before);
  });

  it("returns no-report when the child wrote none, and ignores a report left by an earlier run", async () => {
    const r = rig();
    mkdirSync(join(r.worktree, ".autoclaude", "state", "reports"), { recursive: true });
    writeFileSync(join(r.worktree, ".autoclaude", "state", "reports", "plan.md"), PLAN);
    r.runtime({ result: { exit: "failed", resultText: "crashed" } });
    const out = await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("no-report");
    expect(entryOf(r).stage).toMatchObject({ stage: "plan", pid: process.pid });
  });

  it("keeps an existing report in resume mode", async () => {
    const r = rig();
    mkdirSync(join(r.worktree, ".autoclaude", "state", "reports"), { recursive: true });
    writeFileSync(join(r.worktree, ".autoclaude", "state", "reports", "plan.md"), PLAN);
    r.runtime({ result: { exit: "failed" } });
    const out = await runStage(r.ctx, entryOf(r), "plan", "resume");
    expect(out).toMatchObject({ kind: "report", text: PLAN });
  });

  it("creates the report and plan directories before the stage starts", async () => {
    const r = rig();
    let seen: boolean[] = [];
    r.runtime({
      onStart: () => {
        seen = ["reports", "plans"].map((d) =>
          existsSync(join(r.worktree, ".autoclaude", "state", d)),
        );
      },
    });
    await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(seen).toEqual([true, true]);
  });

  it("kills the child and ends as no-report when the ledger has no entry to record in", async () => {
    const r = rig();
    const entry = { ...entryOf(r), issue: 99 };
    let killed = false;
    const rt = r.runtime({ hold: true });
    const orig = rt.start.bind(rt);
    rt.start = (req, cfg) => {
      const p = orig(req, cfg);
      return { ...p, kill: async () => void (killed = true) };
    };
    const out = await runStage(r.ctx, entry, "plan", "fresh");
    expect(out.kind).toBe("no-report");
    expect(killed).toBe(true);
    expect(r.notes.join("\n")).toMatch(/no entry/);
  });

  it("reads the report with BOM and CRLF tolerated", async () => {
    const r = rig();
    r.runtime({
      report: { file: "implement.md", text: "﻿AUTODEV-REPORT\r\nx\r\nAUTODEV-REPORT-END\r\n" },
    });
    const out = (await runStage(r.ctx, entryOf(r), "implement", "fresh")) as Extract<
      StageOutcome,
      { kind: "report" }
    >;
    expect(out.text).toBe("AUTODEV-REPORT\nx\nAUTODEV-REPORT-END\n");
  });

  it("treats an empty report file as no report", async () => {
    const r = rig();
    r.runtime({ report: { file: "plan.md", text: "  \n" } });
    expect((await runStage(r.ctx, entryOf(r), "plan", "fresh")).kind).toBe("no-report");
  });

  it("uses the escalated spec for implement when asked, the plain one otherwise", async () => {
    const r = rig((c) => {
      c.stages.implement.escalated = { runtime: "claude", model: "big-model", effort: "max" };
    });
    const rt = r.runtime({
      report: { file: "implement.md", text: "AUTODEV-REPORT\nAUTODEV-REPORT-END\n" },
    });
    await runStage(r.ctx, entryOf(r), "implement", "fresh");
    await runStage(r.ctx, entryOf(r), "implement", "fix", { escalated: true });
    expect(rt.requests[0]!.model).toBe(r.cfg.stages.implement.model);
    expect(rt.requests[1]).toMatchObject({ model: "big-model", effort: "max" });
    expect(rt.requests[1]!.timeoutMs).toBe(r.cfg.caps.wallClockMinutesPerStage * 60_000);
    expect(rt.requests[1]!.maxTurns).toBe(r.cfg.caps.maxTurnsPerStage);
  });

  it("puts the run directory in the main checkout and keeps GitHub text out of the prompt", async () => {
    const r = rig();
    const rt = r.runtime({ report: { file: "plan.md", text: PLAN } });
    await runStage(r.ctx, entryOf(r), "plan", "fresh", { findingsMarkdown: "### Must\n- x" });
    await runStage(r.ctx, entryOf(r), "plan", "fix");
    const [a, b] = rt.requests;
    const runs = join(r.root, ".autoclaude", "state", "runs", "42");
    expect(a!.runDir.replaceAll("\\", "/")).toBe(join(runs, "plan-1").replaceAll("\\", "/"));
    expect(b!.runDir.replaceAll("\\", "/")).toBe(join(runs, "plan-2").replaceAll("\\", "/"));
    expect(a!.projectRoot).toBe(r.root);
    const prompt = readFileSync(a!.promptFile, "utf8");
    expect(prompt).toContain(a!.dispatchFile);
    expect(prompt).not.toContain("rm -rf");
    const d = JSON.parse(readFileSync(a!.dispatchFile, "utf8")) as Dispatch;
    expect(d.issue.title).toBe(HOSTILE);
    expect(d.issue.comments).toEqual([
      { author: "octo", body: "A comment", createdAt: "2026-01-02T00:00:00Z" },
    ]);
    expect(d.reportFile.replaceAll("\\", "/")).toBe(
      `${r.worktree}/.autoclaude/state/reports/plan.md`,
    );
    expect(d.planFile.replaceAll("\\", "/")).toBe(`${r.worktree}/.autoclaude/state/plans/42.md`);
    expect(d).toMatchObject({
      mode: "fresh",
      integrationRef: "origin/develop",
      findingsMarkdown: "### Must\n- x",
    });
    expect(d.projectFacts.projectMd).toBe("# Project\n");
  });

  it("runs triage in the project root, read-only, with the schema, without fetch or bootstrap", async () => {
    const r = rig();
    const answer = { decision: "ready", reason: "ok", comment: "Triage: ready" };
    const rt = r.runtime({ result: { structured: answer } });
    const out = await runStage(r.ctx, entryOf(r), "triage", "fresh");
    expect(rt.requests[0]).toMatchObject({ cwd: r.root, readOnly: true, schema: TriageSchema });
    expect(r.order).toEqual(["start"]);
    expect(existsSync(join(r.worktree, "boot.log"))).toBe(false);
    expect(out.kind).toBe("report");
    expect((out as { text: string }).text).toBe(JSON.stringify(answer));
  });

  it("does not ask for a read-only fence on the other stages", async () => {
    const r = rig();
    const rt = r.runtime({ report: { file: "plan.md", text: PLAN } });
    await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(rt.requests[0]!.readOnly).toBeFalsy();
    expect(rt.requests[0]!.schema).toBeUndefined();
  });

  it("ends as no-report, with a note and no stage record, when start() throws synchronously", async () => {
    const r = rig();
    r.runtime({ throwOnStart: new Error("ENOENT: settings.json") });
    const out = await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("no-report");
    expect(r.notes.join("\n")).toMatch(/ENOENT: settings\.json/);
    expect(entryOf(r).stage).toBeNull();
  });

  it("records each permission denial as a note without failing the stage", async () => {
    const r = rig();
    r.runtime({
      report: { file: "plan.md", text: PLAN },
      result: { permissionDenials: [{ tool_name: "Bash", tool_input: { command: "curl x" } }] },
    });
    const out = await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("report");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^#42 .*denied.*Bash.*curl x/i);
  });

  it("ends as no-report without spawning when the bootstrap fails, noting its output", async () => {
    const r = rig((c) => {
      c.bootstrap = "echo install-broke >&2; exit 3";
    });
    const rt = r.runtime({ report: { file: "plan.md", text: PLAN } });
    const out = await runStage(r.ctx, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("no-report");
    expect(rt.requests).toHaveLength(0);
    expect(r.notes.join("\n")).toMatch(/bootstrap.*install-broke/is);
    expect(existsSync(join(r.worktree, ".autoclaude", "state", "bootstrapped"))).toBe(false);
  });

  it("does not spawn when the fetch fails", async () => {
    const r = rig();
    const rt = r.runtime();
    const failing: OrchestratorCtx = {
      ...r.ctx,
      exec: (cmd, args, o) =>
        cmd === "git"
          ? { status: 128, stdout: "", stderr: "no network" }
          : r.ctx.exec(cmd, args, o),
    };
    const out = await runStage(failing, entryOf(r), "plan", "fresh");
    expect(out.kind).toBe("no-report");
    expect(rt.requests).toHaveLength(0);
    expect(r.notes.join("\n")).toMatch(/fetch.*no network/is);
  });
});

describe("prefetch", () => {
  const gh =
    (routes: Record<string, unknown>): Exec =>
    (cmd, args) => {
      const key = args.slice(2, 5).join(" ");
      const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
      if (cmd !== "gh" || !hit) return { status: 1, stdout: "", stderr: `no route ${cmd} ${key}` };
      return { status: 0, stdout: JSON.stringify(hit[1]), stderr: "" };
    };

  it("returns the issue exactly as the forge does, with no author filter", () => {
    const forge = new Forge(
      "acme/widgets",
      gh({
        "issue view": {
          number: 7,
          title: "T",
          state: "OPEN",
          body: "B",
          labels: [{ name: "a" }, { name: "b" }],
          assignees: [],
          updatedAt: "x",
          comments: [
            { author: { login: "stranger" }, body: "hi", createdAt: "c1" },
            { author: { login: "owner" }, body: "yo", createdAt: "c2" },
          ],
        },
      }),
    );
    expect(prefetchIssue(forge, 7)).toEqual({
      number: 7,
      title: "T",
      body: "B",
      labels: ["a", "b"],
      comments: [
        { author: "stranger", body: "hi", createdAt: "c1" },
        { author: "owner", body: "yo", createdAt: "c2" },
      ],
    });
  });

  it("lists merged and closed pull requests touching the files, newest first, at most limit", () => {
    const prs = [1, 2, 3, 4].map((n) => ({
      number: n,
      state: n === 4 ? "OPEN" : n === 3 ? "CLOSED" : "MERGED",
      headRefName: `b${n}`,
      updatedAt: `2026-01-0${n}T00:00:00Z`,
      closedAt: n === 4 ? null : `2026-01-0${n}T00:00:00Z`,
      mergedAt: n === 3 || n === 4 ? null : `2026-01-0${n}T00:00:00Z`,
      url: `u${n}`,
    }));
    const thread = (n: number, path: string) => ({
      number: n,
      title: `PR ${n}`,
      files: [{ path }],
      comments: [{ author: { login: "a" }, body: `c${n}` }],
      reviews: [
        { author: { login: "b" }, body: `r${n}` },
        { author: { login: "b" }, body: "" },
      ],
    });
    const forge = new Forge(
      "acme/widgets",
      gh({
        "pr list": prs,
        "pr view 1": thread(1, "src/a.ts"),
        "pr view 2": thread(2, "src/b.ts"),
        "pr view 3": thread(3, "src/a.ts"),
      }),
    );
    expect(prefetchPriorPrs(forge, ["src/a.ts"])).toEqual([
      { number: 3, title: "PR 3", comments: ["a: c3", "b: r3"] },
      { number: 1, title: "PR 1", comments: ["a: c1", "b: r1"] },
    ]);
    expect(prefetchPriorPrs(forge, ["src/a.ts"], 1).map((p) => p.number)).toEqual([3]);
    expect(prefetchPriorPrs(forge, [])).toEqual([]);
  });
});
