import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guardVerb, type GuardDeps } from "../../src/cli/guard.js";
import { VERBS } from "../../src/cli/main.js";
import { loadProjectConfig } from "../../src/config/load.js";
import { hookCommand } from "../../src/runtimes/claude/fence.js";
import { runSync } from "../../src/platform/spawn.js";
import { childEnv } from "../helpers/child-env.js";

const REPO = resolve(import.meta.dirname, "../..");
const MINIMAL = join(REPO, "test/fixtures/projects/minimal");
const BASH = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const payload = (command: string, tool = "Bash"): string =>
  JSON.stringify({ tool_name: tool, tool_input: { command } });

function io() {
  const err: string[] = [];
  return { err, io: { out: () => {}, err: (s: string) => void err.push(s) } };
}

const deps = (stdin: string, extra: Partial<GuardDeps> = {}): GuardDeps => ({
  stdin: async () => stdin,
  root: () => MINIMAL,
  load: loadProjectConfig,
  ...extra,
});

const ARGS = ["--runtime", "claude", "--worktree", "/work/tree"];

describe("the guard verb, in process", () => {
  it("is registered", () => {
    expect(Object.keys(VERBS)).toContain("guard");
  });

  it("exits 2 on a refused command and says why on stderr", async () => {
    const { io: i, err } = io();
    expect(await guardVerb(ARGS, i, deps(payload("git push")))).toBe(2);
    expect(err.join("")).toMatch(/^autoclaude guard: /);
  });

  it("exits 0 on an allowed command (positive control)", async () => {
    const { io: i, err } = io();
    expect(await guardVerb(ARGS, i, deps(payload("git status")))).toBe(0);
    expect(err.join("")).toBe("");
  });

  it("loads the configuration from the main checkout of the worktree it was given", async () => {
    const seen: string[] = [];
    const loaded: string[] = [];
    const d = deps(payload("git status"), {
      root: (cwd) => (seen.push(cwd), "/main/checkout"),
      load: (root) => (loaded.push(root), loadProjectConfig(MINIMAL)),
    });
    const { io: i } = io();
    expect(await guardVerb(ARGS, i, d)).toBe(0);
    expect(seen).toEqual([resolve("/work/tree")]);
    expect(loaded).toEqual(["/main/checkout"]);
  });

  it("applies the project's forbidden paths to a redirection", async () => {
    const wt = resolve("/work/tree");
    const { io: i } = io();
    const refused = await guardVerb(
      ["--runtime", "claude", "--worktree", wt],
      i,
      deps(payload("echo x > .github/workflows/ci.yml")),
    );
    expect(refused).toBe(2);
  });

  it("refuses a payload for another tool, whatever the command", async () => {
    const { io: i } = io();
    expect(await guardVerb(ARGS, i, deps(payload("git status", "PowerShell")))).toBe(2);
  });

  it.each([
    ["no --worktree", ["--runtime", "claude"]],
    ["no --runtime", ["--worktree", "/w"]],
    ["an unknown runtime", ["--runtime", "other", "--worktree", "/w"]],
    ["an unknown argument", [...ARGS, "--extra"]],
    ["a repeated flag", [...ARGS, "--worktree", "/x"]],
    ["no arguments", []],
  ])("exits 2 on %s", async (_n, args) => {
    const { io: i, err } = io();
    expect(await guardVerb(args, i, deps(payload("git status")))).toBe(2);
    expect(err.join("")).not.toBe("");
  });

  it("refuses --runtime codex as not available before phase 3", async () => {
    const { io: i, err } = io();
    expect(
      await guardVerb(["--runtime", "codex", "--worktree", "/w"], i, deps(payload("ls"))),
    ).toBe(2);
    expect(err.join("")).toMatch(/not available before phase 3/);
  });

  it("exits 2 when the configuration cannot be loaded, the root found or stdin read", async () => {
    for (const extra of [
      {
        load: () => {
          throw new Error("bad config");
        },
      },
      {
        root: () => {
          throw new Error("not a repo");
        },
      },
      {
        stdin: async () => {
          throw new Error("stdin closed");
        },
      },
    ]) {
      const { io: i, err } = io();
      expect(await guardVerb(ARGS, i, deps(payload("git status"), extra))).toBe(2);
      expect(err.join("")).toMatch(/guard/);
    }
  });

  it("exits 2 on an empty or unparsable payload", async () => {
    for (const stdin of ["", "not json", "[]"]) {
      const { io: i } = io();
      expect(await guardVerb(ARGS, i, deps(stdin))).toBe(2);
    }
  });
});

/**
 * The hook as Claude Code runs it: a command line through bash, node on a compiled entry.
 * The tree is compiled once into a temp directory (a copy of dist, as far as the entry's
 * path is concerned) with node_modules linked in.
 */
describe("the hook process", () => {
  let build: string;
  let project: string;

  const link = (dir: string): void => {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "junction");
  };

  beforeAll(() => {
    build = tmp("ac-guard-build-");
    const tsc = join(REPO, "node_modules/typescript/bin/tsc");
    const r = runSync(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--outDir", join(build, "dist"), "--incremental", "false"],
      { cwd: REPO, env: childEnv() },
    );
    if (r.status !== 0) throw new Error(`tsc failed: ${r.stdout}${r.stderr}`);
    link(build);

    project = tmp("ac-guard-proj-");
    mkdirSync(join(project, ".autoclaude"));
    cpSync(join(MINIMAL, ".autoclaude/config.json"), join(project, ".autoclaude/config.json"));
    const g = runSync("git", ["init", "-q", project], { env: childEnv() });
    if (g.status !== 0) throw new Error(g.stderr);
  }, 180_000);

  const entryOf = (dir: string): string =>
    join(dir, "dist/cli/hook-entry.js").replaceAll("\\", "/");
  const bin = (entry: string): string => `"${process.execPath.replaceAll("\\", "/")}" "${entry}"`;

  /** Runs the hook line exactly as generated, through bash, with a payload on stdin. */
  function run(entry: string, command: string, tool = "Bash") {
    const line = hookCommand(bin(entry), project);
    return runSync(BASH, ["-c", line], {
      cwd: project,
      env: childEnv(),
      input: payload(command, tool),
    });
  }

  it("refuses a command (exit 2) and passes an allowed one (exit 0)", () => {
    const refused = run(entryOf(build), "git push");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/autoclaude guard: /);
    const ok = run(entryOf(build), "git status");
    expect({ status: ok.status, stderr: ok.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("refuses a payload without a Bash tool name", () => {
    expect(run(entryOf(build), "git status", "PowerShell").status).toBe(2);
  });

  it("still refuses through a copied entry", () => {
    const copy = tmp("ac-guard-copy-");
    cpSync(join(build, "dist"), join(copy, "dist"), { recursive: true });
    link(copy);
    expect(run(entryOf(copy), "git push").status).toBe(2);
    expect(run(entryOf(copy), "git status").status).toBe(0);
  });

  it("still refuses through a differently-cased entry path", (ctx) => {
    const entry = entryOf(build);
    // Directories only: node itself refuses a file whose extension is spelled `.JS`.
    const slash = entry.lastIndexOf("/");
    const cased = `${entry.slice(0, slash).toUpperCase()}${entry.slice(slash)}`;
    // A case-sensitive file system has no such file; there the case cannot matter.
    if (cased === entry || !existsSync(cased)) return ctx.skip();
    expect(run(cased, "git push").status).toBe(2);
    const ok = run(cased, "git status");
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
  });

  it("blocks (exit 2) when a module the entry imports is missing", () => {
    const broken = tmp("ac-guard-broken-");
    cpSync(join(build, "dist"), join(broken, "dist"), { recursive: true });
    link(broken);
    rmSync(join(broken, "dist/engine/guard/core.js"));
    // node itself exits 1 here; the `|| exit 2` on the hook line turns it into a block.
    expect(run(entryOf(broken), "git status").status).toBe(2);
  });

  it("blocks when the entry file does not exist at all", () => {
    expect(run(entryOf(join(build, "nowhere")), "git status").status).toBe(2);
  });
});
