import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Env } from "../../src/cli/common.js";
import { loadProjectConfig } from "../../src/config/load.js";
import { Forge, realExec, type Exec, type ExecResult } from "../../src/forge/github.js";
import { childEnv } from "./child-env.js";

export const REPO = resolve(import.meta.dirname, "../..");
export const MINIMAL = join(REPO, "test/fixtures/projects/minimal");

/** The output of a verb, collected. */
export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) },
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

const temps: string[] = [];
export function cleanupTemps(): void {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
}
export function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: childEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A real repository in a temporary directory (local identity, no autocrlf, an `origin` that
 * names a GitHub repository), optionally with a project copied in from a fixture.
 */
export function tempRepo(opts: { project?: string; remote?: string } = {}): string {
  const root = tempDir("autoclaude-cli-");
  git(root, "init", "-q", "-b", "develop");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "core.autocrlf", "false");
  git(root, "remote", "add", "origin", opts.remote ?? "https://github.com/acme/widgets.git");
  if (opts.project)
    cpSync(join(opts.project, ".autoclaude"), join(root, ".autoclaude"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

export type Route = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => Partial<ExecResult> | undefined;

/**
 * An `Exec` that answers the commands a route claims and runs every other one for real, so a
 * test fakes `gh` and `claude` and keeps real `git` against its temporary repository.
 */
export function routed(routes: Route[], calls: string[] = []): Exec {
  return (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    for (const route of routes) {
      const hit = route(cmd, args, opts);
      if (hit !== undefined) return { status: 0, stdout: "", stderr: "", ...hit };
    }
    return realExec(cmd, args, { ...opts });
  };
}

/** An environment over a root, with `gh`/`claude` and anything else injected. */
export function envFor(root: string, over: Partial<Env> = {}): Env {
  const exec = over.exec ?? realExec;
  return {
    root: () => root,
    config: loadProjectConfig,
    exec,
    forge: (_cfg, _root) => new Forge("acme/widgets", exec),
    now: () => new Date("2026-10-17T09:00:00Z"),
    env: {},
    platform: process.platform,
    bash: () => "bash",
    ...over,
  };
}

export function writeProject(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}
