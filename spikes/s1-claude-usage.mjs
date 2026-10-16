// Spike S1: can the Claude usage windows be read without a UI?
// Throwaway script, kept for the record. Plain Node ESM, no dependencies.
//
// Usage: node spikes/s1-claude-usage.mjs <out-dir> [variant ...]
//   variants: p (claude -p with a statusLine), usage (claude -p "/usage"), status (claude -p "/status"),
//             pty (interactive claude under a pseudo-terminal; needs node-pty, see S1_NODE_PTY)
//   default: p usage status
// S1_NODE_PTY=<abs path to node_modules/node-pty> (installed OUTSIDE the repository) enables "pty".
// Real subscription calls: tiny prompts, 180 s timeout each.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 180_000;
const here = dirname(fileURLToPath(import.meta.url));
const dump = join(here, "s1-dump-statusline.mjs");
const argv = process.argv.slice(2);
const outDir = resolve(argv[0] ?? "s1-out");
const wanted = argv.slice(1).length ? argv.slice(1) : ["p", "usage", "status"];
mkdirSync(outDir, { recursive: true });

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
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (k === "CLAUDE_CODE_GIT_BASH_PATH") continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
  }
  return env;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "s1-")));
const fwd = (p) => p.replaceAll("\\", "/");
const work = join(root, "work");
mkdirSync(work);
const sl = join(root, "statusline.jsonl");
const settings = join(root, "settings.json");
writeFileSync(settings, JSON.stringify({
  statusLine: { type: "command", command: `node "${fwd(dump)}" "${fwd(sl)}"` },
}, null, 2));

function summarize(file) {
  if (!existsSync(file)) return { written: false };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    written: true, entries: lines.length,
    topKeys: [...new Set(lines.flatMap((l) => Object.keys(l)))],
    rate_limits: lines.map((l) => l.rate_limits ?? null),
    last: lines.at(-1),
  };
}

const results = {};
function runP(label, prompt) {
  const args = ["-p", prompt, "--output-format", "json", "--settings", settings, "--max-turns", "1"];
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { cwd: work, env: childEnv(), encoding: "utf8", timeout: TIMEOUT_MS, input: "" });
  const meta = { label, prompt, exitCode: r.status, signal: r.signal, error: r.error?.message, durationMs: Date.now() - t0,
    stdout: (r.stdout ?? "").slice(0, 3000), stderr: (r.stderr ?? "").slice(0, 2000), statusline: summarize(sl) };
  writeFileSync(join(outDir, `${label}.json`), JSON.stringify(meta, null, 2));
  console.log(`[${label}] exit=${r.status} ${meta.durationMs}ms statusline.written=${meta.statusline.written}`);
  results[label] = meta;
  rmSync(sl, { force: true });
}

try {
  if (wanted.includes("p")) runP("p-say-ok", "say ok");
  if (wanted.includes("usage")) runP("p-usage", "/usage");
  if (wanted.includes("status")) runP("p-status", "/status");
  if (wanted.includes("pty")) {
    const ptyPath = process.env.S1_NODE_PTY;
    if (!ptyPath) throw new Error("set S1_NODE_PTY to the node-pty directory");
    const pty = createRequire(import.meta.url)(ptyPath);
    const exe = CLAUDE;
    const proc = pty.spawn(exe, ["--settings", settings], { name: "xterm-256color", cols: 120, rows: 40, cwd: work, env: childEnv() });
    let all = "", buf = "", sentPrompt = false, sentExit = false, trustHandled = false;
    const t0 = Date.now();
    const done = new Promise((res) => {
      proc.onExit((e) => res(e));
      proc.onData((d) => { buf += d; all += d; });
      const tick = setInterval(() => {
        const plain = buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
        const age = Date.now() - t0;
        if (!trustHandled && /trust/i.test(plain) && age < 60000) { proc.write("\x1b[B"); setTimeout(() => proc.write("\r"), 500); trustHandled = true; buf = ""; return; }
        if (!sentPrompt && age > 15000) { proc.write("say ok\r"); sentPrompt = true; return; }
        if (sentPrompt && !sentExit && age > 45000) { proc.write("/exit\r"); sentExit = true; return; }
        if (age > 100000) { proc.kill(); clearInterval(tick); }
      }, 1000);
    });
    const e = await done;
    const meta = { label: "pty", exit: e, durationMs: Date.now() - t0, trustHandled, statusline: summarize(sl),
      tail: all.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(0,4000) };
    writeFileSync(join(outDir, "pty.json"), JSON.stringify(meta, null, 2));
    console.log(`[pty] written=${meta.statusline.written} exit=${JSON.stringify(e)}`);
    results.pty = meta;
  }
} finally {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 2));
  rmSync(root, { recursive: true, force: true });
}
