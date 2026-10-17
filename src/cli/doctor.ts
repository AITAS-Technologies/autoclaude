import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectConfig, StageSpec } from "../config/types.js";
import { parseRepo } from "../forge/github.js";
import { RULE_SYNTAX } from "../runtimes/claude/fence.js";
import { TESTED_CLAUDE_MAJORS } from "../runtimes/claude/run.js";
import { labelsOf } from "./labels.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude doctor";

type Level = "ok" | "warn" | "fail";

/** Every stage spec the configuration carries, with a name for the message. */
function specsOf(cfg: ProjectConfig): Array<[string, StageSpec]> {
  const s = cfg.stages;
  const out: Array<[string, StageSpec | undefined]> = [
    ["triage", s.triage],
    ["plan", s.plan],
    ["planReview", s.planReview],
    ["planReview.scorer", s.planReview.scorer],
    ["implement", s.implement],
    ["implement.escalated", s.implement.escalated],
    ["codeReview.scorer", s.codeReview.scorer],
    ...Object.entries(s.codeReview.angles).map(([k, v]): [string, StageSpec | undefined] => [
      `codeReview.angles.${k}`,
      v,
    ]),
  ];
  const all: Array<[string, StageSpec]> = [];
  for (const [name, spec] of out) {
    if (spec === undefined) continue;
    all.push([name, spec]);
    if (spec.fallback) all.push([`${name}.fallback`, spec.fallback as StageSpec]);
  }
  return all;
}

const versionOf = (text: string): [number, number, number] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * `autoclaude doctor`: one line per check, `ok|warn|fail <check> — <detail>`; exit 1 on any
 * `fail`. Remedies name `autoclaude` commands or the vendor tools' own.
 */
export async function doctorVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  if (args.length > 0) return usageError(io, USAGE, `unknown argument: ${args[0]}`);
  let failed = 0;
  const line = (level: Level, check: string, detail: string) => {
    if (level === "fail") failed++;
    io.out(`${level} ${check} — ${detail.replace(/\s*\r?\n\s*/g, " ")}\n`);
  };
  const attempt = (check: string, body: () => void) => {
    try {
      body();
    } catch (e) {
      line("fail", check, messageOf(e));
    }
  };

  let root: string;
  try {
    root = env.root(cwd);
  } catch (e) {
    line("fail", "git", messageOf(e));
    return 1;
  }

  // config
  let cfg: ProjectConfig | null = null;
  try {
    cfg = env.config(root);
    line("ok", "config", `.autoclaude/config.json loads (${cfg.gates.length} gate(s))`);
  } catch (e) {
    line(
      "fail",
      "config",
      `${messageOf(e)} — fix the file, or write a fresh one with autoclaude init`,
    );
  }
  const remote = cfg?.forge.remote ?? "origin";

  // Paths a stage's permission rules cannot state: the fence refuses a worktree under one, so
  // every claimed issue would spend its retries on that refusal. A failure, not a warning.
  const worktreesAt = resolve(root, cfg?.worktrees.root ?? ".autoclaude/worktrees");
  let syntaxFree = true;
  for (const [what, path] of [
    ["the project root", root],
    ["worktrees.root", worktreesAt],
  ] as const) {
    const ch = RULE_SYNTAX.exec(path.replace(/\\/g, "/"))?.[0];
    if (ch === undefined) continue;
    syntaxFree = false;
    line(
      "fail",
      "paths",
      `${what} ${path} contains "${ch}", which Claude Code's permission rules read as syntax, so no stage can run there; move the project, or set worktrees.root to a path without ( ) * ? [ ] { }`,
    );
  }
  if (syntaxFree)
    line("ok", "paths", "the project root and worktrees.root hold no permission-rule syntax");

  // git repository with the forge remote
  let repo: string | null = null;
  attempt("git", () => {
    const r = env.exec("git", ["remote", "get-url", remote], { cwd: root });
    if (r.status !== 0)
      throw new Error(`no git remote "${remote}" (set forge.remote in the config)`);
    repo = parseRepo(r.stdout);
    line("ok", "git", `repository ${root}, remote ${remote} = ${repo}`);
  });

  // gh login and the token's scopes
  const auth = env.exec("gh", ["auth", "status"], { cwd: root });
  if (auth.status !== 0) {
    line(
      "fail",
      "gh-auth",
      `gh is not logged in (${(auth.stderr || auth.stdout).trim().split(/\r?\n/)[0] ?? ""}) — run gh auth login`,
    );
  } else {
    line("ok", "gh-auth", "gh is logged in");
    const text = `${auth.stdout}\n${auth.stderr}`;
    const scopes = /Token scopes:\s*(.*)/i.exec(text)?.[1];
    if (scopes === undefined) line("ok", "gh-scopes", "the token's scopes are not reported");
    else if (/delete_repo/.test(scopes))
      line(
        "warn",
        "gh-scopes",
        `the token carries delete_repo (${scopes.trim()}); use a token without it`,
      );
    else line("ok", "gh-scopes", scopes.trim());
  }

  // labels
  if (cfg === null) {
    line("warn", "labels", "skipped: the configuration does not load");
  } else {
    const c = cfg;
    attempt("labels", () => {
      const have = new Set(env.forge(c, root).listLabels());
      const want = labelsOf(c);
      const missing = want.filter((l) => !have.has(l));
      if (missing.length > 0)
        line(
          "fail",
          "labels",
          `missing on GitHub: ${missing.join(", ")} — create them with autoclaude init --create-labels`,
        );
      else line("ok", "labels", `all ${want.length} configured labels exist`);
    });
  }

  // the integration branch on the remote
  if (cfg === null) {
    line("warn", "integration-branch", "skipped: the configuration does not load");
  } else {
    const branch = cfg.branches.integration;
    const r = env.exec("git", ["ls-remote", "--heads", remote, branch], { cwd: root });
    if (r.status !== 0)
      line("fail", "integration-branch", `cannot ask ${remote} for ${branch}: ${r.stderr.trim()}`);
    else if (r.stdout.trim() === "")
      line(
        "fail",
        "integration-branch",
        `${remote} has no branch ${branch}; push it or change branches.integration`,
      );
    else line("ok", "integration-branch", `${remote}/${branch} exists`);
  }

  // claude
  const claude = env.exec("claude", ["--version"], { cwd: root });
  if (claude.status !== 0) {
    line("fail", "claude", "claude is not available on PATH; install Claude Code and log in");
  } else {
    const v = versionOf(claude.stdout);
    if (v === null) line("warn", "claude", `cannot read a version from "${claude.stdout.trim()}"`);
    else if (TESTED_CLAUDE_MAJORS.includes(v[0]))
      line("ok", "claude", `${v.join(".")} (major ${v[0]} is tested)`);
    else
      line(
        "warn",
        "claude",
        `${v.join(".")}: major ${v[0]} is untested (tested: ${TESTED_CLAUDE_MAJORS.join(", ")})`,
      );
  }
  if (cfg !== null) {
    const max = specsOf(cfg)
      .filter(([, s]) => s.effort === "max")
      .map(([n]) => n);
    if (max.length > 0)
      line(
        "warn",
        "effort-max",
        `${max.join(", ")} use effort max, whose value is unverified for claude --effort`,
      );
  }
  if (env.env.ANTHROPIC_API_KEY)
    line(
      "warn",
      "api-key",
      "ANTHROPIC_API_KEY is set: stages would bill the API instead of the subscription; unset it",
    );

  // git, and Git Bash on Windows
  const gv = env.exec("git", ["--version"], { cwd: root });
  const gitV = versionOf(gv.stdout);
  if (gitV === null) line("warn", "git-version", "cannot read git's version");
  else if (gitV[0] < 2 || (gitV[0] === 2 && gitV[1] < 31))
    line(
      "warn",
      "git-version",
      `${gitV.join(".")} is older than 2.31: GIT_CONFIG_COUNT is ignored; GIT_CONFIG_PARAMETERS still closes the stage environment`,
    );
  else line("ok", "git-version", gitV.join("."));
  if (env.platform === "win32") {
    try {
      line("ok", "git-bash", env.bash());
    } catch (e) {
      line("fail", "git-bash", messageOf(e));
    }
  }

  // ignored by git
  const worktreesRoot = cfg?.worktrees.root ?? ".autoclaude/worktrees";
  const probes: Array<[string, string, string]> = [
    ["ignore-state", ".autoclaude/state/ledger.json", ".autoclaude/state/"],
    ["ignore-local", ".autoclaude/config.local.json", ".autoclaude/config.local.json"],
  ];
  const wt = resolve(root, worktreesRoot);
  const wtRel = relative(root, wt).replace(/\\/g, "/");
  const outside = wtRel.startsWith("..") || isAbsolute(wtRel);
  const ignored = (path: string) =>
    env.exec("git", ["check-ignore", "-q", path], { cwd: root }).status === 0;
  for (const [check, probe, name] of probes)
    if (ignored(probe)) line("ok", check, `${name} is ignored by git`);
    else line("fail", check, `${name} is not ignored by git; run autoclaude init`);
  if (outside) line("ok", "ignore-worktrees", `${worktreesRoot} is outside the repository`);
  else if (ignored(`${wtRel}/probe`)) line("ok", "ignore-worktrees", `${wtRel}/ is ignored by git`);
  else
    line(
      "fail",
      "ignore-worktrees",
      `${wtRel}/ is not ignored by git; add it to .gitignore (autoclaude init covers the default ${".autoclaude/worktrees/"})`,
    );

  // the project's own instructions
  if (existsSync(resolve(root, "CLAUDE.md")) || existsSync(resolve(root, "AGENTS.md")))
    line("ok", "instructions", "CLAUDE.md or AGENTS.md is present");
  else
    line(
      "warn",
      "instructions",
      "neither CLAUDE.md nor AGENTS.md exists at the project root; stages get no project instructions",
    );

  if (failed > 0) io.err(`doctor: ${failed} check(s) failed\n`);
  return failed > 0 ? 1 : 0;
}
