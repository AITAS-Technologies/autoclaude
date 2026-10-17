// Spike S4: a Claude stage as a child process (`claude -p`).
// Throwaway script, kept for the record. Plain Node ESM, no dependencies.
//
// Usage: node spikes/s4-claude-stage.mjs <out-dir> [--inherit-env] [variant ...]
//   variants: a b c d e e2 f g h   (default: all)
//   --inherit-env  do not strip CLAUDECODE / CLAUDE_* from the child environment
//
// Writes into <out-dir>: <variant>.stdout (verbatim stdout), <variant>.meta.json
// (exit code, duration, stderr, summary of the JSON result), and summary.json.
// Real subscription calls: tiny prompts, low turn caps, 180 s timeout each.

import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 180_000;
const SCHEMA = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';

const argv = process.argv.slice(2);
const inheritEnv = argv.includes("--inherit-env");
const rest = argv.filter((a) => a !== "--inherit-env");
const outDir = resolve(rest[0] ?? "s4-out");
const wanted = rest.slice(1).length ? rest.slice(1) : ["a", "b", "c", "d", "e", "e2", "f", "g", "h"];
mkdirSync(outDir, { recursive: true });

// ---- locating the claude binary -------------------------------------------
// On Windows the npm shim is claude.cmd; spawning a .cmd needs a shell, and cmd.exe
// mangles JSON arguments such as --json-schema. Resolve the real claude.exe instead.
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

function childEnv() {
  const env = { ...process.env };
  if (inheritEnv) return env;
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_CODE_GIT_BASH_PATH") continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
  }
  return env;
}

// ---- temp fixtures ---------------------------------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-")));
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function makeRepo(parent, name = "repo") {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "spike@example.invalid");
  git(dir, "config", "user.name", "spike");
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  writeFileSync(join(dir, "b.txt"), "bravo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
const emptyMcp = join(root, "empty-mcp.json");
writeFileSync(emptyMcp, '{"mcpServers":{}}');
const hookScript = join(root, "block-bash-hook.mjs");
writeFileSync(
  hookScript,
  'process.stderr.write("blocked by spike hook: no shell in this stage\\n");\nprocess.exit(2);\n',
);
const fwd = (p) => p.replaceAll("\\", "/");

function writeSettings(name, settings) {
  const f = join(root, name);
  writeFileSync(f, JSON.stringify(settings, null, 2));
  return f;
}

// ---- running one invocation ------------------------------------------------
function run(label, cwd, prompt, { settingsFile, extra = [], maxTurns = 3, model = MODEL } = {}) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", model,
    "--settings", settingsFile,
    "--permission-mode", "dontAsk",
    "--mcp-config", emptyMcp,
    "--strict-mcp-config",
    "--max-turns", String(maxTurns),
    ...extra,
  ];
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, {
    cwd, env: childEnv(), encoding: "utf8", timeout: TIMEOUT_MS, input: "", maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* not json */ }
  const summary = parsed && !Array.isArray(parsed)
    ? {
        keys: Object.keys(parsed),
        type: parsed.type, subtype: parsed.subtype, is_error: parsed.is_error,
        num_turns: parsed.num_turns, total_cost_usd: parsed.total_cost_usd,
        stop_reason: parsed.stop_reason, terminal_reason: parsed.terminal_reason,
        result: typeof parsed.result === "string" ? parsed.result.slice(0, 400) : parsed.result,
        structured_output: parsed.structured_output,
        permission_denials: parsed.permission_denials,
      }
    : { notAnObject: true, isArray: Array.isArray(parsed) };
  const meta = {
    label, cwd, args: args.map((a) => (a === prompt ? "<prompt>" : a)), prompt,
    exitCode: r.status, signal: r.signal, error: r.error?.message, durationMs,
    stderr: r.stderr, stdoutBytes: r.stdout?.length ?? 0, summary,
  };
  writeFileSync(join(outDir, `${label}.stdout`), r.stdout ?? "");
  writeFileSync(join(outDir, `${label}.meta.json`), JSON.stringify(meta, null, 2));
  console.log(`[${label}] exit=${r.status} ${durationMs}ms is_error=${summary.is_error} subtype=${summary.subtype} turns=${summary.num_turns} cost=${summary.total_cost_usd}`);
  return meta;
}

const results = {};
const allowRead = { permissions: { allow: ["Read"] } };

// (version / help facts)
{
  const v = spawnSync(CLAUDE, ["--version"], { encoding: "utf8", env: childEnv(), timeout: TIMEOUT_MS, input: "" });
  const h = spawnSync(CLAUDE, ["--help"], { encoding: "utf8", env: childEnv(), timeout: TIMEOUT_MS, input: "" });
  const flags = ["--effort", "--max-turns", "--json-schema", "--settings", "--permission-mode", "--strict-mcp-config", "--mcp-config"];
  results.env = {
    claudeBin: CLAUDE, version: v.error ? `error: ${v.error.message}` : (v.stdout ?? "").trim(), platform: process.platform, node: process.version,
    inheritEnv, helpMentions: Object.fromEntries(flags.map((f) => [f, !h.error && (h.stdout ?? "").includes(f)])),
  };
  console.log(JSON.stringify(results.env));
}

try {
  const repo = makeRepo(root);
  if (wanted.includes("a")) {
    results.a = run("a-ok", repo, "Reply with exactly the single word: pong",
      { settingsFile: writeSettings("s-a.json", allowRead) });
  }
  if (wanted.includes("b")) {
    results.b = run("b-structured", repo, "Set ok to true.",
      { settingsFile: writeSettings("s-b.json", allowRead), extra: ["--json-schema", SCHEMA] });
  }
  if (wanted.includes("c")) {
    results.c = run("c-max-turns", repo,
      "Use the Read tool to read ./a.txt, then in a separate step use the Read tool to read ./b.txt, then reply with both contents.",
      { settingsFile: writeSettings("s-c.json", allowRead), maxTurns: 1 });
  }
  if (wanted.includes("d")) {
    results.d = run("d-refused", repo,
      "Run the shell command `touch ./created.txt` with the Bash tool, then tell me whether it worked.",
      { settingsFile: writeSettings("s-d.json", allowRead) });
  }
  if (wanted.includes("e")) {
    const s = writeSettings("s-e.json", {
      permissions: { allow: ["Read", "Bash(echo *)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${fwd(hookScript)}"` }] }],
      },
    });
    results.e = run("e-hook-blocked", repo,
      "Run the shell command `echo hello` with the Bash tool and tell me its output.", { settingsFile: s });
  }
  if (wanted.includes("e2")) {
    // Which shell runs hook commands? The command uses syntax that prints differently per shell.
    const s = writeSettings("s-e2.json", {
      permissions: { allow: ["Read", "Bash(echo *)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo probe[bash=$BASH_VERSION][cmd=%COMSPEC%][ps=$PSVersionTable] 1>&2; exit 2" }] }],
      },
    });
    results.e2 = run("e2-hook-shell-probe", repo,
      "Run the shell command `echo hello` with the Bash tool. If it is blocked, quote the block message verbatim and nothing else.", { settingsFile: s });
  }
  if (wanted.includes("f")) {
    results.f = run("f-effort", repo, "Reply with exactly the single word: pong",
      { settingsFile: writeSettings("s-f.json", allowRead), extra: ["--effort", "high"] });
  }
  if (wanted.includes("g")) {
    const dir = makeRepo(root, "repo-g");
    writeFileSync(join(dir, "PROMPT.md"), "Reply with exactly the single word: banana\n");
    results.g = run("g-prompt-file", dir, "Read ./PROMPT.md and follow it.",
      { settingsFile: writeSettings("s-g.json", allowRead) });
  }
  if (wanted.includes("h")) {
    // Two bases: one with a space and an umlaut (as for worktrees under "Jürgen Müller"),
    // one plain, so a failure can be attributed to the spelling or to the path characters.
    results.h = {};
    for (const [baseName, baseDir] of [["umlaut", join(root, "Jürgen Müller")], ["plain", join(root, "plain")]]) {
      mkdirSync(baseDir, { recursive: true });
      const hrepo = makeRepo(baseDir, "repo");
      const outside = join(baseDir, "sibling");
      mkdirSync(outside, { recursive: true });
      const abs = fwd(hrepo);
      const drive = /^([A-Za-z]):\/(.*)$/.exec(abs);
      // Spellings of the absolute-path rule to try (// prefix = filesystem-absolute per the permission docs).
      const spellings = process.platform === "win32" && drive
        ? { "drive-colon": `//${drive[1]}:/${drive[2]}`, "drive-msys": `//${drive[1].toLowerCase()}/${drive[2]}`, "single-slash-drive": `/${drive[1]}:/${drive[2]}`, "plain-drive": abs }
        : { "double-slash": `/${abs}` };
      for (const [name, spec] of Object.entries(spellings)) {
        const tag = `${baseName}-${name}`;
        const inside = join(hrepo, `in-${tag}.txt`);
        const outsideFile = join(outside, `out-${tag}.txt`);
        const s = writeSettings(`s-h-${tag}.json`, {
          permissions: { allow: ["Read", `Edit(${spec}/**)`, `Write(${spec}/**)`] },
        });
        const meta = run(`h-${tag}`, hrepo,
          `Use the Write tool to create the file ${inside} with the content "hi". Then use the Write tool to create the file ${outsideFile} with the content "hi". Report the outcome of each write.`,
          { settingsFile: s, maxTurns: 4 });
        meta.insideCreated = existsSync(inside);
        meta.outsideCreated = existsSync(outsideFile);
        meta.rule = `Edit(${spec}/**)`;
        writeFileSync(join(outDir, `h-${tag}.meta.json`), JSON.stringify(meta, null, 2));
        console.log(`   rule=${meta.rule} inside=${meta.insideCreated} outside=${meta.outsideCreated}`);
        results.h[tag] = meta;
      }
    }
  }
} finally {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 2));
  rmSync(root, { recursive: true, force: true });
}
