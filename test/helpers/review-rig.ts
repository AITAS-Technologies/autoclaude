import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";
import { loadProjectConfig } from "../../src/config/load.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { loadLedger, transition, updateLedger } from "../../src/engine/ledger/ledger.js";
import { Forge, type Exec } from "../../src/forge/github.js";
import type { OrchestratorCtx } from "../../src/orchestrator/stage.js";
import type { RuntimeAdapter } from "../../src/runtimes/types.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

export interface ReviewRig {
  root: string;
  worktree: string;
  cfg: ProjectConfig;
  ctx: OrchestratorCtx;
  notes: string[];
  /** Every git/gh call the engine made through `ctx.exec`. */
  calls: Array<{ cmd: string; args: string[]; cwd?: string; input?: string }>;
  entry: () => ReturnType<typeof loadLedger>["issues"][string];
  /** The issue's body, with three numbered acceptance criteria. */
  setRuntime(rt: RuntimeAdapter): void;
}

export interface RigOptions {
  files?: string[];
  head?: string;
  edit?: (cfg: ProjectConfig) => void;
  pr?: number;
  posted?: string[];
}

/** A project root with a space and an umlaut, a worktree, a ledger entry for #42, fake git and gh. */
export function reviewRig(opts: RigOptions = {}): ReviewRig {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "autoclaude-review-")));
  tmpDirs.push(base);
  const root = join(base, "Jürgen Müller", "My Projects", "app");
  const worktree = join(root, ".autoclaude", "worktrees", "agent+42-fix-it").replaceAll("\\", "/");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, ".autoclaude", "project.md"), "# Project\n");
  const cfg = loadProjectConfig(MINIMAL);
  cfg.forge.remote = "origin";
  cfg.branches.integration = "develop";
  cfg.stages.codeReview.parallel = 4;
  opts.edit?.(cfg);
  updateLedger(root, (l) => {
    transition(l, 42, "code-reviewing", { title: "Fix it", worktree, branch: "agent/42-fix-it" });
    if (opts.pr !== undefined) l.issues["42"]!.pr = opts.pr;
  });
  const notes: string[] = [];
  const calls: ReviewRig["calls"] = [];
  const issue = {
    number: 42,
    title: "Fix login & logout --replace $(rm -rf ~) `id`",
    state: "OPEN",
    labels: [{ name: "ready" }],
    assignees: [],
    updatedAt: "2026-01-01T00:00:00Z",
    body: "Body\n\n## Acceptance criteria\n1. First\n2. Second\n3. Third\n",
    comments: [],
  };
  const exec: Exec = (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd, input: o?.input });
    if (cmd === "git" && args.includes("fetch")) return { status: 0, stdout: "", stderr: "" };
    // One git directory, whichever checkout asks (R73).
    if (cmd === "git" && args.includes("--git-common-dir"))
      return { status: 0, stdout: `${join(root, ".git")}\n`, stderr: "" };
    if (cmd === "git" && args.includes("rev-parse"))
      return { status: 0, stdout: `${opts.head ?? "abc1234abc1234"}\n`, stderr: "" };
    if (cmd === "git" && args.includes("diff"))
      return { status: 0, stdout: (opts.files ?? ["src/a.ts"]).join("\n") + "\n", stderr: "" };
    if (cmd === "gh" && args.includes("issue") && args.includes("view"))
      return { status: 0, stdout: JSON.stringify(issue), stderr: "" };
    if (cmd === "gh" && args.includes("list")) return { status: 0, stdout: "[]", stderr: "" };
    if (cmd === "gh" && args.includes("comments"))
      return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
    if (cmd === "gh" && args.includes("comment")) {
      opts.posted?.push(o?.input ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  let current: RuntimeAdapter | undefined;
  const ctx: OrchestratorCtx = {
    root,
    cfg,
    forge: new Forge("acme/widgets", (cmd, args, o) => ctx.exec(cmd, args, o)),
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
    notes,
    calls,
    entry: () => loadLedger(root).issues["42"]!,
    setRuntime: (rt) => {
      current = rt;
    },
  };
}
