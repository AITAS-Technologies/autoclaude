// Spike S5: a stage environment without forge credentials.
// Throwaway script, kept for the record. Plain Node ESM, no dependencies.
//
// Usage: S5_PRIVATE_REPO=<https url of a private repo> node spikes/s5-stage-env.mjs <out-dir> [env ...]
//   env names: base stage closed   (default: all three)
//     base   = this process's environment (the positive control: a working gh login and git credentials)
//     stage  = base minus the forge variables, plus the recipe variables from the task
//     closed = stage plus the extra closers found by this spike (see CLOSERS below)
//   S5_PRIVATE_REPO_SSH (optional) overrides the ssh form derived from S5_PRIVATE_REPO.
//
// The private repository is read from the environment and redacted from every recorded output
// as <private-repo>; neither this script nor the note names it. Every push is --dry-run.

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 90_000;
const PUBLIC_REPO = "https://github.com/AITAS-Technologies/autoclaude.git";

const argv = process.argv.slice(2);
const outDir = resolve(argv[0] ?? "s5-out");
const wanted = argv.slice(1).length ? argv.slice(1) : ["base", "stage", "closed"];
mkdirSync(outDir, { recursive: true });

const PRIVATE = process.env.S5_PRIVATE_REPO;
if (!PRIVATE) {
  console.error("S5_PRIVATE_REPO is not set (https url of a private repository)");
  process.exit(2);
}
const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(PRIVATE);
const PRIVATE_SSH = process.env.S5_PRIVATE_REPO_SSH ?? (m ? `git@github.com:${m[1]}.git` : "");
const secrets = [PRIVATE, PRIVATE_SSH, m?.[1], m?.[1]?.split("/")[1]].filter(Boolean)
  .sort((a, b) => b.length - a.length);
const redact = (s) => {
  let out = String(s ?? "");
  for (const x of secrets) out = out.split(x).join("<private-repo>");
  return out;
};

// ---- environments ------------------------------------------------------------
const FORGE_VARS = [
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS",
];
const root = realpathSync(mkdtempSync(join(tmpdir(), "s5-")));
const ghEmpty = join(root, "gh-empty");
mkdirSync(ghEmpty);

// Not a forge credential, but the controller's CLAUDE_* variables are stripped from every child (task ruling).
function stripClaude(env) {
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_CODE_GIT_BASH_PATH") continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
  }
  return env;
}
const baseEnv = () => stripClaude({ ...process.env });

function stageEnv() {
  const env = baseEnv();
  for (const k of FORGE_VARS) delete env[k];
  Object.assign(env, {
    GH_CONFIG_DIR: ghEmpty,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "protocol.allow",
    GIT_CONFIG_VALUE_1: "never",
  });
  return env;
}

// Extra closers, filled in from the leaks this spike observed (each verified by a run).
// git < 2.31 ignores GIT_CONFIG_COUNT/KEY/VALUE; GIT_CONFIG_PARAMETERS is what `git -c` uses
// (git 1.7.x and later), so the same two settings are also passed that way.
const CLOSERS = {
  GIT_CONFIG_PARAMETERS: "'credential.helper=' 'protocol.allow=never'",
};
function closedEnv() {
  return { ...stageEnv(), ...CLOSERS };
}
const ENVS = { base: baseEnv, stage: stageEnv, closed: closedEnv };

// ---- locating binaries -------------------------------------------------------
function resolveClaude() {
  if (process.env.AUTOCLAUDE_CLAUDE_BIN) return process.env.AUTOCLAUDE_CLAUDE_BIN;
  if (process.platform !== "win32") return "claude";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, "claude.exe"))) return join(dir, "claude.exe");
    if (existsSync(join(dir, "claude.cmd"))) {
      const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return "claude";
}
const CLAUDE = resolveClaude();

// ---- fixtures (built with the base environment) -------------------------------
function sh(cwd, cmd, args, env = baseEnv(), timeout = GIT_TIMEOUT_MS) {
  return spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout, input: "" });
}
const clone = join(root, "autoclaude-clone");
{
  const r = sh(root, "git", ["clone", "-q", PUBLIC_REPO, clone]);
  if (r.status !== 0) throw new Error(`clone failed: ${redact(r.stderr)}`);
  sh(clone, "git", ["config", "user.email", "spike@example.invalid"]);
  sh(clone, "git", ["config", "user.name", "spike"]);
}
const wtBase = join(root, "worktrees");
mkdirSync(wtBase);
const emptyMcp = join(root, "empty-mcp.json");
writeFileSync(emptyMcp, '{"mcpServers":{}}');

// ---- the probes --------------------------------------------------------------
let wtCount = 0;
function probes() {
  const list = [
    ["gh auth status", "gh", ["auth", "status"], root],
    ["gh api user", "gh", ["api", "user", "--jq", ".type"], root],
    ["git ls-remote <private-repo> (https)", "git", ["ls-remote", PRIVATE, "HEAD"], root],
  ];
  if (PRIVATE_SSH) list.push(["git ls-remote <private-repo> (ssh)", "git", ["ls-remote", PRIVATE_SSH, "HEAD"], root]);
  list.push(
    ["git push --dry-run origin HEAD:refs/heads/spike-s5", "git", ["-C", clone, "push", "--dry-run", "origin", "HEAD:refs/heads/spike-s5"], root],
    ["git fetch (public clone)", "git", ["-C", clone, "fetch"], root],
  );
  return list;
}

function record(envName, label, r, extra = {}) {
  const row = {
    env: envName, label, exit: r.status, signal: r.signal, error: r.error?.message,
    stdout: redact(r.stdout).slice(0, 1500), stderr: redact(r.stderr).slice(0, 1500), ...extra,
  };
  console.log(`[${envName}] ${label}: exit=${row.exit}${row.signal ? ` signal=${row.signal}` : ""}${row.error ? ` error=${row.error}` : ""}`);
  return row;
}

const results = [];
try {
  for (const envName of wanted) {
    const env = ENVS[envName]();
    if (envName !== "base") {
      const leftover = FORGE_VARS.filter((k) => k in env);
      if (leftover.length) throw new Error(`forge variables still present: ${leftover}`);
    }
    for (const [label, cmd, args, cwd] of probes()) {
      results.push(record(envName, label, sh(cwd, cmd, args, env)));
    }
    // git commit in a worktree: must succeed everywhere.
    {
      const wt = join(wtBase, `wt-${envName}-${wtCount++}`);
      const a = sh(clone, "git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], env);
      let r = a;
      if (a.status === 0) {
        writeFileSync(join(wt, "s5.txt"), `${envName}\n`);
        sh(wt, "git", ["add", "s5.txt"], env);
        r = sh(wt, "git", ["commit", "-q", "-m", "s5 probe"], env);
      }
      results.push(record(envName, "git commit in a worktree", r, { worktreeAdd: a.status }));
    }
    // claude -p: the subscription login must keep working.
    {
      const t0 = Date.now();
      const r = spawnSync(CLAUDE, [
        "-p", "say ok", "--output-format", "json", "--max-turns", "1",
        "--mcp-config", emptyMcp, "--strict-mcp-config", "--permission-mode", "dontAsk",
      ], { cwd: root, env, encoding: "utf8", timeout: TIMEOUT_MS, input: "" });
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch { /* not json */ }
      results.push(record(envName, "claude -p \"say ok\" --output-format json", r, {
        durationMs: Date.now() - t0,
        isError: parsed?.is_error, result: typeof parsed?.result === "string" ? parsed.result.slice(0, 80) : undefined,
        stdout: undefined,
      }));
    }
  }
} finally {
  writeFileSync(join(outDir, "s5-results.json"), JSON.stringify({
    platform: process.platform, node: process.version,
    git: (sh(root, "git", ["--version"]).stdout ?? "").trim(),
    gh: (sh(root, "gh", ["--version"]).stdout ?? "").split("\n")[0],
    results,
  }, null, 2));
  rmSync(root, { recursive: true, force: true });
}
