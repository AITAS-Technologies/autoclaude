// Spike S2 + S3: Codex isolation per run (hooks, execpolicy rules, MCP server, writable
// roots for a worktree's .git) without touching the developer's ~/.codex, and which shell
// runs Codex's commands on Windows.
// Throwaway script, kept for the record. Plain Node ESM, no dependencies.
//
// Usage:
//   node spikes/s2-codex-isolation.mjs <out-dir> [--inherit-env] [variant ...]
//     variants: A B Bm C gitbase gitnarrow tA tB tBm tC s3 s3b s3m s3r
//       (default: all but s3b)
//     A  fence supplied via -c overrides only
//     B  fence supplied via a project .codex/ directory in the worktree (+ -c for trust)
//     Bm as B, but the hooks in the main checkout's .codex/hooks.json (where Codex looks)
//     C  fence supplied via a separate CODEX_HOME (auth.json linked in)
//     gitbase / gitnarrow  git add/commit/config with no / narrow extra writable roots
//     tA tB tBm tC  a changed hook definition and a changed hook script, headless
//     s3 / s3b / s3m  shell probes (inherited env / SHELL forced to Git Bash / model asked for bash)
//     s3r  an execpolicy rule against PowerShell spellings of the same command
//     --inherit-env  do not strip CLAUDECODE / CLAUDE_* from the child environment
//   node spikes/s2-codex-isolation.mjs --mcp-server <log> <tag>   (internal: minimal stdio MCP server)
//
// Writes into <out-dir>: <label>.jsonl (verbatim codex stdout), <label>.json (evidence) and
// summary.json. Real subscription calls: tiny prompts, 180 s timeout each.
// Never prints or logs the contents of auth.json; only its hash is recorded. Method C links it
// into a temp CODEX_HOME (hardlink, else symlink, a copy only as last resort), removed at the end.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv[0] === "--mcp-server") mcpServer(argv[1], argv[2]);
else await main();

// ---- minimal stdio MCP server (newline-delimited JSON-RPC) -----------------
function mcpServer(log, tag) {
  const note = (x) => { try { appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), tag, ...x }) + "\n"); } catch { /* ignore */ } };
  const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  note({ event: "start" });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      note({ method: m.method });
      if (m.id === undefined || m.id === null) continue;
      const reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") {
        reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s2-spike", version: "0.0.0" } });
      } else if (m.method === "tools/list") {
        reply({ tools: [{ name: "ping", description: "Returns a fixed marker string.", inputSchema: { type: "object", properties: {} } }] });
      } else if (m.method === "tools/call") {
        reply({ content: [{ type: "text", text: `s2-pong-${tag}` }] });
      } else if (m.method === "ping") {
        reply({});
      } else {
        out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

async function main() {
  const IS_WIN = process.platform === "win32";
  const MODEL = "gpt-6.1-sol"; // default of this ChatGPT login (turn_context.model without -m)
  const TIMEOUT_MS = 180_000;
  const SCRIPT = fileURLToPath(import.meta.url);
  const inheritEnv = argv.includes("--inherit-env");
  const rest = argv.filter((a) => a !== "--inherit-env");
  const outDir = resolve(rest[0] ?? "s2-out");
  const wanted = rest.slice(1).length ? rest.slice(1) : ["A", "B", "Bm", "C", "gitbase", "gitnarrow", "tA", "tB", "tBm", "tC", "s3", "s3m", "s3r"];
  mkdirSync(outDir, { recursive: true });

  // ---- locating codex --------------------------------------------------------
  // On Windows `codex` is an npm .cmd shim; spawning it needs cmd.exe, which mangles
  // arguments. Run the package's own launcher (bin/codex.js) with this node instead.
  function resolveCodex() {
    if (process.env.AUTOCLAUDE_CODEX_BIN) return { cmd: process.env.AUTOCLAUDE_CODEX_BIN, pre: [] };
    if (!IS_WIN) return { cmd: "codex", pre: [] };
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(join(dir, "codex.cmd")) && existsSync(js)) return { cmd: process.execPath, pre: [js] };
      if (existsSync(join(dir, "codex.exe"))) return { cmd: join(dir, "codex.exe"), pre: [] };
    }
    return { cmd: "codex", pre: [] };
  }
  const CODEX = resolveCodex();

  function childEnv(extra = {}) {
    const env = { ...process.env };
    if (!inheritEnv) {
      for (const k of Object.keys(env)) {
        if (k === "CLAUDE_CODE_GIT_BASH_PATH") continue;
        if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
      }
    }
    return { ...env, ...extra };
  }

  // ---- small helpers ---------------------------------------------------------
  const fwd = (p) => p.replaceAll("\\", "/");
  const q = (p) => (/^[\w:/.\-]+$/.test(p) ? p : `"${p}"`); // hook commands: quote only if needed
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const fileHash = (p) => (existsSync(p) ? sha(readFileSync(p)) : null);
  const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);
  const tomlStr = (s) => (!s.includes("'") && !/[\r\n]/.test(s) ? `'${s}'` : JSON.stringify(s));
  const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));
  function toToml(v) {
    if (typeof v === "string") return tomlStr(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return `[${v.map(toToml).join(", ")}]`;
    return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${toToml(x)}`).join(", ")} }`;
  }
  const cArgs = (cfg) => Object.entries(cfg).flatMap(([k, v]) => ["-c", `${tomlKey(k)}=${toToml(v)}`]);
  const tomlFile = (cfg) => Object.entries(cfg).map(([k, v]) => `${tomlKey(k)} = ${toToml(v)}`).join("\n") + "\n";
  const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : []);

  function git(cwd, ...args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  const gitTry = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };

  // ---- the developer's codex home: snapshot, diff, guard -----------------------
  const DEV_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
  const DEV_CONFIG = join(DEV_HOME, "config.toml");
  const DEV_AUTH = join(DEV_HOME, "auth.json");
  const devConfigOriginal = existsSync(DEV_CONFIG) ? readFileSync(DEV_CONFIG) : null;
  const CONFIG_LIKE = /(^|\/)(config\.toml|[^/]*\.config\.toml|hooks\.json|requirements\.toml)$|^rules\//;

  function snapshot(dir) {
    const m = {};
    const walk = (d) => {
      let entries = [];
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(d, e.name);
        const rel = fwd(relative(dir, p));
        let s;
        try { s = statSync(p); } catch { continue; }
        if (e.isDirectory()) { m[rel + "/"] = { dir: true }; walk(p); continue; }
        let h = null;
        try { h = sha(readFileSync(p)).slice(0, 16); } catch { h = "unreadable"; }
        m[rel] = { size: s.size, mtime: s.mtime.toISOString(), sha256_16: h };
      }
    };
    if (existsSync(dir)) walk(dir);
    return m;
  }
  function diff(a, b) {
    const added = [], removed = [], changed = [];
    for (const k of Object.keys(b)) {
      if (!(k in a)) added.push(k);
      else if (!b[k].dir && (a[k].sha256_16 !== b[k].sha256_16 || a[k].size !== b[k].size)) changed.push(k);
    }
    for (const k of Object.keys(a)) if (!(k in b)) removed.push(k);
    const group = (list) => {
      const g = {};
      for (const k of list) { const top = k.split("/")[0] + (k.includes("/") ? "/" : ""); g[top] = (g[top] ?? 0) + 1; }
      return g;
    };
    const all = [...added, ...removed, ...changed];
    return { added: group(added), removed: group(removed), changed: group(changed), configLike: all.filter((k) => CONFIG_LIKE.test(k)) };
  }
  function listing(snap) {
    // Top level only (files with size, mtime, hash prefix; directories with their entry count).
    const top = Object.keys(snap).filter((k) => !k.includes("/") || k.indexOf("/") === k.length - 1);
    return top.sort().map((k) => (snap[k].dir
      ? `${k} (${Object.keys(snap).filter((x) => x !== k && x.startsWith(k)).length} entries)`
      : `${k} ${snap[k].size} ${snap[k].mtime} sha256:${snap[k].sha256_16}`));
  }
  // The developer's config.toml must stay as it was. If a run changes it, record the
  // change and put the original back (delete it if it did not exist before).
  function guardDevConfig() {
    const now = existsSync(DEV_CONFIG) ? readFileSync(DEV_CONFIG) : null;
    const same = (now === null && devConfigOriginal === null) || (now && devConfigOriginal && now.equals(devConfigOriginal));
    if (same) return { changed: false };
    const written = now ? now.toString("utf8") : null;
    if (devConfigOriginal === null) unlinkSync(DEV_CONFIG); else writeFileSync(DEV_CONFIG, devConfigOriginal);
    return { changed: true, writtenContent: written, restored: true };
  }

  // ---- fixtures ------------------------------------------------------------------
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "s2-")));
  const logs = join(root, "logs");
  mkdirSync(logs);
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "config", "user.email", "spike@example.invalid");
  git(main, "config", "user.name", "spike");
  git(main, "config", "core.autocrlf", "false");
  writeFileSync(join(main, "a.txt"), "alpha\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const MAIN_GIT = join(main, ".git");
  function makeWorktree(name) {
    git(main, "worktree", "add", "-q", join("..", name), "-b", name);
    const wt = realpathSync.native(join(root, name));
    writeFileSync(join(wt, "s2.txt"), "s2\n");
    return wt;
  }

  const HOOK_SRC = (version) => `// s2 spike hook, version ${version}
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [mode, log] = process.argv.slice(2);
let raw = ""; try { raw = readFileSync(0, "utf8"); } catch { raw = ""; }
let p = {}; try { p = JSON.parse(raw); } catch {}
const command = typeof p.tool_input?.command === "string" ? p.tool_input.command : JSON.stringify(p.tool_input ?? null);
let parent = null;
if (mode === "exit2" || mode === "probe") {
  try {
    parent = process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=" + process.ppid + "'; $p.Name + ' | ' + $p.CommandLine"], { encoding: "utf8", timeout: 20000 }).trim()
      : execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();
  } catch (e) { parent = "unknown: " + e.message; }
}
appendFileSync(log, JSON.stringify({ version: ${JSON.stringify(version)}, mode, at: new Date().toISOString(), event: p.hook_event_name, tool_name: p.tool_name, tool_input: p.tool_input, cwd: p.cwd, permission_mode: p.permission_mode, payload_keys: Object.keys(p), parent: parent && parent.slice(0, 400) }) + "\\n");
const marker = { exit2: "BLOCK_EXIT2", json: "BLOCK_JSON", psexit: "BLOCK_PSEXIT" }[mode];
if (marker && command.includes(marker)) {
  if (mode === "json") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked by s2 hook (json deny)" } }));
    process.exit(0);
  }
  process.stderr.write("blocked by s2 hook (exit 2, mode " + mode + ")\\n");
  process.exit(2);
}
process.exit(0);
`;

  // Three PreToolUse handlers in one matcher group: exit 2, JSON deny, and exit 2 with a
  // Windows override that re-raises the exit code through PowerShell.
  function hookGroup(hookFile, log, { probeOnly = false, jsonTimeout = 30 } = {}) {
    const base = (mode) => `node ${q(fwd(hookFile))} ${mode} ${q(fwd(log))}`;
    const hooks = probeOnly
      ? [{ type: "command", command: base("probe"), timeout: 30 }]
      : [
          { type: "command", command: base("exit2"), timeout: 30 },
          { type: "command", command: base("json"), timeout: jsonTimeout },
          { type: "command", command: base("psexit"), commandWindows: `${base("psexit")}; exit $LASTEXITCODE`, timeout: 30 },
        ];
    return { matcher: "^Bash$", hooks };
  }
  // Trust hash as Codex computes it (codex-rs hooks discovery: sha256 over the sorted-key
  // JSON of {event_name, matcher, hooks: [normalized handler]}); checked against app-server.
  // Observed on Windows: the normalized handler carries the commandWindows text as `command`
  // and no commandWindows field. (Elsewhere assumed: `command`, override dropped.)
  function hookHash(group, handler) {
    const command = IS_WIN && handler.commandWindows ? handler.commandWindows : handler.command;
    const h = { type: handler.type, command, timeout: handler.timeout ?? 600, async: handler.async ?? false };
    if (handler.statusMessage) h.statusMessage = handler.statusMessage;
    return "sha256:" + sha(JSON.stringify(sortDeep({ event_name: "pre_tool_use", matcher: group.matcher, hooks: [h] })));
  }

  const RULES = 'prefix_rule(pattern=["git", "hash-object"], decision="forbidden", justification="s2 spike: git hash-object is forbidden in this stage")\n';

  function sandboxCfg(roots) {
    return { writable_roots: roots, exclude_tmpdir_env_var: true, exclude_slash_tmp: true };
  }
  const NARROW_ROOTS = (wtName) => ["objects", "refs", "logs", join("worktrees", wtName)].map((p) => join(MAIN_GIT, p));
  const winCfg = IS_WIN ? { windows: { sandbox: "mxc" } } : {};
  // default_tools_approval_mode: without it the first variant-A run got "MCP tool call
  // requires approval, but approval policy is never" (exec forces approval never).
  const mcpCfg = (label) => ({ s2: { command: process.execPath, args: [fwd(SCRIPT), "--mcp-server", fwd(join(logs, `mcp-${label}.log`)), label], startup_timeout_sec: 30, default_tools_approval_mode: "approve" } });

  // ---- codex app-server: hooks/list ----------------------------------------------
  function appServer(calls, { args = [], env }) {
    return new Promise((resolveP) => {
      const p = spawn(CODEX.cmd, [...CODEX.pre, ...args, "app-server"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "", stderr = "";
      const pending = new Map();
      const results = [];
      let id = 0;
      let finished = false;
      const done = (extra) => {
        if (finished) return;
        finished = true;
        clearTimeout(t);
        p.stdin.end(); // app-server exits on stdin EOF; kill only if it lingers
        const k = setTimeout(() => p.kill(), 3000);
        const fin = () => { clearTimeout(k); resolveP({ results, stderr: stderr.slice(-2000), ...extra }); };
        if (p.exitCode !== null || p.signalCode !== null) fin(); else p.once("exit", fin);
      };
      const t = setTimeout(() => done({ error: "timeout" }), 60_000);
      p.stderr.on("data", (d) => { stderr += d; });
      p.on("error", (e) => done({ error: e.message }));
      p.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        }
      });
      const send = (method, params) => new Promise((res) => {
        const myId = id++;
        pending.set(myId, res);
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
      (async () => {
        const init = await send("initialize", { clientInfo: { name: "s2-spike", version: "0.0.0" } });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
        for (const [method, params] of calls) results.push(await send(method, params));
        done({ codexHome: init.result?.codexHome });
      })();
    });
  }
  async function listHooks(wt, opts) {
    const r = await appServer([["hooks/list", { cwds: [wt] }]], opts);
    const entry = r.results[0]?.result?.data?.[0] ?? {};
    return {
      codexHome: r.codexHome, error: r.error ?? r.results[0]?.error,
      warnings: entry.warnings, errors: entry.errors,
      hooks: (entry.hooks ?? []).map((h) => ({ key: h.key, source: h.source, command: h.command, currentHash: h.currentHash, trustStatus: h.trustStatus, enabled: h.enabled })),
    };
  }
  function trustState(listed, groups) {
    // A hook key ends in ":<event>:<group index>:<handler index>"; map it back to our handler,
    // compute the hash ourselves and compare it with the one app-server reports.
    const state = {}, check = [];
    for (const lh of listed.hooks) {
      const m = /:pre_tool_use:(\d+):(\d+)$/.exec(lh.key ?? "");
      const g = m && groups[Number(m[1])];
      const h = g && g.hooks[Number(m[2])];
      const mine = h ? hookHash(g, h) : null;
      const match = mine === lh.currentHash;
      check.push({ key: lh.key, listed: lh.currentHash, computed: mine, match });
      state[lh.key] = { trusted_hash: match ? mine : lh.currentHash };
    }
    return { state, check };
  }

  // ---- codex exec ------------------------------------------------------------------
  function findRollout(home, threadId) {
    const base = join(home, "sessions");
    const stack = [base];
    while (stack.length) {
      const d = stack.pop();
      let es = [];
      try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of es) {
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.includes(threadId)) return p;
      }
    }
    return null;
  }
  function readRollout(home, threadId) {
    const f = threadId && findRollout(home, threadId);
    if (!f) return { found: false };
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tc = lines.find((l) => l.type === "turn_context")?.payload ?? {};
    const entries = tc.permission_profile?.file_system?.entries ?? [];
    const pathOf = (e) => (e.path?.type === "path" ? e.path.path : `:${e.path?.value?.kind}`);
    const hookLines = lines.filter((l) => l.type !== "session_meta" && !(l.type === "response_item" && l.payload?.type === "message") && /hook/i.test(JSON.stringify(l)));
    return {
      found: true,
      model: tc.model, approval_policy: tc.approval_policy, sandbox_policy: tc.sandbox_policy,
      write: entries.filter((e) => e.access === "write").map(pathOf),
      readOnlyCarveOuts: entries.filter((e) => e.access === "read" && e.path?.type === "path").map(pathOf),
      eventTypes: [...new Set(lines.filter((l) => l.type === "event_msg").map((l) => l.payload?.type))],
      hookMentions: hookLines.length, hookSnippets: hookLines.slice(0, 3).map((l) => JSON.stringify(l).slice(0, 300)),
    };
  }
  function codexExec(label, wt, prompt, { args = [], env, home = DEV_HOME, model = MODEL }) {
    const full = [...CODEX.pre, "exec", "--json", "-C", wt, "-s", "workspace-write", "-m", model, ...args, prompt];
    const t0 = Date.now();
    const r = spawnSync(CODEX.cmd, full, { cwd: root, env, encoding: "utf8", input: "", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const durationMs = Date.now() - t0;
    writeFileSync(join(outDir, `${label}.jsonl`), r.stdout ?? "");
    const events = (r.stdout ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
    const done = events.filter((e) => e.type === "item.completed").map((e) => e.item);
    const threadId = events.find((e) => e.type === "thread.started")?.thread_id;
    return {
      exitCode: r.status, signal: r.signal, error: r.error?.message, durationMs,
      stderrTail: (r.stderr ?? "").slice(-1500),
      args: full.slice(CODEX.pre.length).map((a) => (a === prompt ? "<prompt>" : a)),
      eventTypes: [...new Set(events.map((e) => e.type))],
      commands: done.filter((i) => i.type === "command_execution").map((i) => ({ command: i.command, status: i.status, exit_code: i.exit_code, output: (i.aggregated_output ?? "").slice(0, 200) })),
      mcpCalls: done.filter((i) => i.type === "mcp_tool_call").map((i) => ({ server: i.server, tool: i.tool, status: i.status, result: JSON.stringify(i.result ?? i.error ?? null).slice(0, 200) })),
      otherItems: done.filter((i) => !["command_execution", "mcp_tool_call", "agent_message", "reasoning"].includes(i.type)).map((i) => JSON.stringify(i).slice(0, 300)),
      messages: done.filter((i) => i.type === "agent_message").map((i) => i.text),
      errors: events.filter((e) => e.type === "error" || e.type === "turn.failed").map((e) => JSON.stringify(e).slice(0, 400)),
      usage: events.find((e) => e.type === "turn.completed")?.usage,
      rollout: readRollout(home, threadId),
    };
  }

  // ---- prompts -----------------------------------------------------------------------
  const NO_WORKAROUND = "Each numbered shell step is exactly one separate shell command (one tool call each), run unchanged. Do not combine, modify, retry or work around any step, even if it fails or is blocked; just go on with the next step.";
  const FENCE_PROMPT = `This is an automated test of a sandbox. Do these steps in order. ${NO_WORKAROUND}
1. Shell: echo s2-hello
2. Shell: echo BLOCK_EXIT2
3. Shell: echo BLOCK_JSON
4. Shell: echo BLOCK_PSEXIT
5. Shell: git hash-object s2.txt
6. Call the MCP tool "ping" of the MCP server "s2" once, without arguments. If no such tool is available to you, say so.
7. Shell: git add s2.txt
8. Shell: git commit -m s2-commit
9. Shell: git config s2.probe yes
Finally reply with one line per step: the step number, ran / blocked / failed, and the first line of its output or error.`;
  const GIT_PROMPT = `This is an automated test of a sandbox. Do these steps in order. ${NO_WORKAROUND}
1. Shell: git add s2.txt
2. Shell: git commit -m s2-commit
3. Shell: git config s2.probe yes
Finally reply with one line per step: the step number, ran / blocked / failed, and the first line of its output or error.`;
  const HOOK_PROMPT = `This is an automated test of a sandbox. Do these steps in order. ${NO_WORKAROUND}
1. Shell: echo s2-hello
2. Shell: echo BLOCK_EXIT2
3. Shell: echo BLOCK_JSON
4. Shell: echo BLOCK_PSEXIT
Finally reply with one line per step: the step number, ran / blocked / failed, and the first line of its output or error.`;
  const TRUST_PROMPT = `This is an automated test of a sandbox. ${NO_WORKAROUND}
1. Shell: echo BLOCK_JSON
Finally reply with: ran or blocked, and the output or error.`;
  const S3_PROMPT = `This is an automated test. ${NO_WORKAROUND}
1. Shell: echo "probe0=[$0]"
2. Shell: $PSVersionTable.PSVersion.ToString()
Finally reply with the exact output (or error) of each step.`;
  const S3R_PROMPT = `This is an automated test of a sandbox. Do these steps in order. ${NO_WORKAROUND}
1. Shell: git hash-object s2.txt
2. Shell: echo s2-first; git hash-object s2.txt
3. Shell: & git hash-object s2.txt
4. Shell: Invoke-Expression 'git hash-object s2.txt'
5. Shell: cmd /c git hash-object s2.txt
Finally reply with one line per step: the step number, ran / blocked / failed, and the first line of its output or error.`;
  const S3M_PROMPT = `This is an automated test. First list the parameter names that your shell command tool accepts. Then run the command  echo "probe0=[$0] bash=[$BASH_VERSION]"  in bash instead of your default shell, but only by setting a parameter of the shell tool that selects the shell; do not wrap the command in another shell (no "bash -c"). If the tool has no such parameter, say so and run nothing. Reply with the parameter names, the parameter you used, and the exact output.`;

  // ---- one variant -------------------------------------------------------------------
  const results = {};
  let devSnap = snapshot(DEV_HOME);
  const startSnap = devSnap;
  const devAuthHashStart = fileHash(DEV_AUTH);

  function evidence(label, wt, branch, extra) {
    const hookLog = readLines(join(logs, `hook-${label}.log`)).map((l) => ({ version: l.version, mode: l.mode, tool_name: l.tool_name, command: l.tool_input?.command, tool_input_keys: l.tool_input ? Object.keys(l.tool_input) : null, permission_mode: l.permission_mode, payload_keys: l.payload_keys, parent: l.parent }));
    const mcpLog = readLines(join(logs, `mcp-${label}.log`)).map((l) => l.event ?? l.method);
    const lastSubject = gitTry(main, "log", "-1", "--format=%s", `refs/heads/${branch}`);
    const probe = gitTry(main, "config", "--get", "s2.probe");
    if (probe !== null) gitTry(main, "config", "--unset", "s2.probe");
    const after = snapshot(DEV_HOME);
    const devHomeDiff = diff(devSnap, after);
    devSnap = after;
    const devConfig = guardDevConfig();
    if (devConfig.changed) devSnap = snapshot(DEV_HOME);
    return {
      hookLog, mcpLog,
      git: { committed: lastSubject === "s2-commit", lastSubject, configProbeWritten: probe === "yes", status: gitTry(wt, "status", "--porcelain") },
      devHomeDiff, devConfig, devAuthUnchanged: fileHash(DEV_AUTH) === devAuthHashStart,
      ...extra,
    };
  }
  function record(label, data) {
    results[label] = data;
    writeFileSync(join(outDir, `${label}.json`), JSON.stringify(data, null, 2));
    const r = data.run ?? {};
    console.log(`[${label}] exit=${r.exitCode} ${r.durationMs}ms sandbox=${r.rollout?.sandbox_policy?.type} cmds=${(r.commands ?? []).length} hookLines=${data.hookLog?.length} mcp=${(data.mcpLog ?? []).join(",")} committed=${data.git?.committed} cfgProbe=${data.git?.configProbeWritten} devConfigChanged=${data.devConfig?.changed} devCfgLike=${JSON.stringify(data.devHomeDiff?.configLike)}`);
    for (const c of r.commands ?? []) console.log(`   cmd ${c.status} exit=${c.exit_code} ${c.command} -> ${JSON.stringify(c.output.slice(0, 80))}`);
    for (const m of r.messages ?? []) console.log(`   msg ${JSON.stringify(m.slice(0, 600))}`);
  }

  // Fence config per method. Returns { args, env, home, groups, wt, branch, label }.
  async function setupMethod(method, label, { roots = "wide", hookOpts = {}, probeOnly = false, rules = true, envExtra = {}, hooksIn = "worktree" } = {}) {
    const wt = makeWorktree(label);
    const roots_ = roots === "wide" ? [MAIN_GIT] : roots === "narrow" ? NARROW_ROOTS(label) : [];
    const hookLog = join(logs, `hook-${label}.log`);
    const env = childEnv(envExtra);
    let groups, args = [], home = DEV_HOME, hookFile, listOpts;
    if (method === "A") {
      const dir = join(root, `fence-${label}`);
      mkdirSync(dir);
      hookFile = join(dir, "hook.mjs");
      writeFileSync(hookFile, HOOK_SRC("v1"));
      groups = [hookGroup(hookFile, hookLog, { probeOnly, ...hookOpts })];
      const cfg = {
        ...winCfg,
        projects: { [wt]: { trust_level: "untrusted" } },
        sandbox_workspace_write: sandboxCfg(roots_),
      };
      // Dotted paths, so that hooks.state (added later) and other MCP servers merge in.
      args = [...cArgs(cfg), "-c", `mcp_servers.s2=${toToml(mcpCfg(label).s2)}`, "-c", `hooks.PreToolUse=${toToml(groups)}`];
      listOpts = { args, env };
    } else if (method === "B") {
      // hooksIn "worktree": hooks inline in <worktree>/.codex/config.toml (like the rest).
      // hooksIn "main": hooks in <main checkout>/.codex/hooks.json, because Codex was seen to
      // discover project hooks of a worktree only there (removed again after the variant).
      const dir = join(wt, ".codex");
      const hooksDir = hooksIn === "main" ? join(main, ".codex") : dir;
      mkdirSync(join(dir, "hooks"), { recursive: true });
      mkdirSync(join(hooksDir, "hooks"), { recursive: true });
      hookFile = join(hooksDir, "hooks", `hook-${label}.mjs`);
      writeFileSync(hookFile, HOOK_SRC("v1"));
      groups = [hookGroup(hookFile, hookLog, { probeOnly, ...hookOpts })];
      const projectCfg = { ...winCfg, sandbox_workspace_write: sandboxCfg(roots_), mcp_servers: mcpCfg(label) };
      if (hooksIn === "main") writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: groups } }, null, 2));
      else projectCfg.hooks = { PreToolUse: groups };
      writeFileSync(join(dir, "config.toml"), tomlFile(projectCfg));
      if (rules) { mkdirSync(join(dir, "rules")); writeFileSync(join(dir, "rules", "s2.rules"), RULES); }
      args = cArgs({ projects: { [wt]: { trust_level: "trusted" } } });
      listOpts = { args, env };
      const s = { method, label, wt, branch: label, env, home, groups, hookFile, args, listOpts, hooksIn };
      s.cleanup = () => { if (hooksIn === "main") rmSync(hooksDir, { recursive: true, force: true }); };
      s.writeHooks = (useGroups) => {
        if (hooksIn === "main") { writeFileSync(join(hooksDir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: useGroups } }, null, 2)); return; }
        const cfgPath = join(dir, "config.toml");
        writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").split("\n").map((l) => (l.startsWith("hooks = ") ? `hooks = ${toToml({ PreToolUse: useGroups })}` : l)).join("\n"));
      };
      return s;
    } else if (method === "C") {
      home = join(root, `codex-home-${label}`);
      mkdirSync(home);
      // Link the login into the temp home: hardlink, else symlink, else copy.
      let linkKind = "hardlink";
      try { linkSync(DEV_AUTH, join(home, "auth.json")); } catch {
        try { symlinkSync(DEV_AUTH, join(home, "auth.json"), "file"); linkKind = "symlink"; } catch {
          copyFileSync(DEV_AUTH, join(home, "auth.json")); linkKind = "copy";
        }
      }
      const dir = join(root, `fence-${label}`);
      mkdirSync(dir);
      hookFile = join(dir, "hook.mjs");
      writeFileSync(hookFile, HOOK_SRC("v1"));
      groups = [hookGroup(hookFile, hookLog, { probeOnly, ...hookOpts })];
      if (rules) { mkdirSync(join(home, "rules")); writeFileSync(join(home, "rules", "s2.rules"), RULES); }
      env.CODEX_HOME = home;
      listOpts = { args: [], env };
      const s = { method, label, wt, branch: label, env, home, groups, hookFile, args: [], listOpts, linkKind };
      s.writeConfig = (state, useGroups = groups) => {
        s.lastConfigWritten = tomlFile({
          ...winCfg,
          projects: { [wt]: { trust_level: "untrusted" } },
          sandbox_workspace_write: sandboxCfg(roots_),
          mcp_servers: mcpCfg(label),
          hooks: state ? { PreToolUse: useGroups, state } : { PreToolUse: useGroups },
        });
        writeFileSync(join(home, "config.toml"), s.lastConfigWritten);
      };
      s.writeConfig(null);
      return s;
    }
    return { method, label, wt, branch: label, env, home, groups, hookFile, args, listOpts };
  }
  // Supply trust: compute hashes, add them per method, and list again.
  async function trust(s) {
    const before = await listHooks(s.wt, s.listOpts);
    const { state, check } = trustState(before, s.groups);
    if (s.method === "C") s.writeConfig(state);
    else { s.args = [...s.args, "-c", `hooks.state=${toToml(state)}`]; s.listOpts = { ...s.listOpts, args: s.args }; }
    const after = await listHooks(s.wt, s.listOpts);
    return { before, hashCheck: check, after, state };
  }
  function homeAudit(s) {
    if (s.method !== "C") return undefined;
    const tmpAuth = join(s.home, "auth.json");
    const ts = statSync(tmpAuth), ds = statSync(DEV_AUTH);
    const cfgNow = readFileSync(join(s.home, "config.toml"), "utf8");
    return {
      linkKind: s.linkKind,
      tempAuthSameFile: ts.ino === ds.ino && ts.dev === ds.dev, nlinkDev: ds.nlink,
      tempAuthHashEqualsDev: fileHash(tmpAuth) === fileHash(DEV_AUTH),
      tempConfigChangedByCodex: cfgNow !== s.lastConfigWritten,
      tempConfigNow: cfgNow !== s.lastConfigWritten ? cfgNow : undefined,
      tempHomeTop: readdirSync(s.home).sort(),
    };
  }

  // ---- version / help facts ----------------------------------------------------------
  {
    const v = spawnSync(CODEX.cmd, [...CODEX.pre, "--version"], { encoding: "utf8", env: childEnv(), timeout: TIMEOUT_MS, input: "" });
    const h = spawnSync(CODEX.cmd, [...CODEX.pre, "exec", "--help"], { encoding: "utf8", env: childEnv(), timeout: TIMEOUT_MS, input: "" });
    const flags = ["--json", "-C", "--add-dir", "--dangerously-bypass-hook-trust", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema", "--skip-git-repo-check"];
    const rulesFile = join(root, "check.rules");
    writeFileSync(rulesFile, RULES);
    const ep = (...cmd) => spawnSync(CODEX.cmd, [...CODEX.pre, "execpolicy", "check", "--rules", rulesFile, "--", ...cmd], { encoding: "utf8", env: childEnv(), timeout: TIMEOUT_MS, input: "" }).stdout?.trim();
    results.env = {
      codex: CODEX.pre[0] ?? CODEX.cmd, version: (v.stdout ?? "").trim() || v.error?.message, platform: process.platform, node: process.version,
      inheritEnv, shellEnv: process.env.SHELL ?? null, model: MODEL, devHome: DEV_HOME,
      devConfigExistsAtStart: devConfigOriginal !== null, devAuthSha256_16AtStart: devAuthHashStart?.slice(0, 16),
      devHomeListingAtStart: listing(startSnap),
      execHelpMentions: Object.fromEntries(flags.map((f) => [f, (h.stdout ?? "").includes(f)])),
      execpolicyCheck: {
        plain: ep("git", "hash-object", "s2.txt"),
        powershellWrapped: ep("powershell.exe", "-Command", "git hash-object s2.txt"),
        bashWrapped: ep("bash", "-lc", "git hash-object s2.txt"),
      },
    };
    console.log(JSON.stringify(results.env, null, 1));
  }

  try {
    for (const [label, method, opts, prompt] of [
      ["A", "A", {}, FENCE_PROMPT], ["B", "B", {}, FENCE_PROMPT], ["Bm", "B", { hooksIn: "main" }, HOOK_PROMPT], ["C", "C", {}, FENCE_PROMPT],
    ]) {
      if (!wanted.includes(label)) continue;
      const s = await setupMethod(method, label, opts);
      try {
        const tr = await trust(s);
        const run = codexExec(label, s.wt, prompt, { args: s.args, env: s.env, home: s.home });
        record(label, { method, hooksIn: s.hooksIn, trust: tr, run, ...evidence(label, s.wt, s.branch, { tempHome: homeAudit(s) }) });
      } finally { s.cleanup?.(); }
    }
    for (const [label, roots] of [["gitbase", "none"], ["gitnarrow", "narrow"]]) {
      if (!wanted.includes(label)) continue;
      const s = await setupMethod("A", label, { roots });
      const tr = await trust(s);
      const run = codexExec(label, s.wt, GIT_PROMPT, { args: s.args, env: s.env });
      record(label, { method: "A", roots, trust: tr, run, ...evidence(label, s.wt, s.branch) });
    }
    for (const [label, method, opts] of [["tA", "A", {}], ["tB", "B", {}], ["tBm", "B", { hooksIn: "main" }], ["tC", "C", {}]]) {
      if (!wanted.includes(label)) continue;
      // Trust the original definitions, then change one handler's definition (timeout of the
      // JSON-deny handler 30 -> 31) and the content of the hook script (v1 -> v2).
      const s = await setupMethod(method, label, opts);
      try {
        const tr = await trust(s);
        const changed = [hookGroup(s.hookFile, join(logs, `hook-${label}.log`), { jsonTimeout: 31 })];
        // Change the definition where this method keeps it; the trusted hashes stay as they were.
        if (method === "A") {
          const idx = s.args.findIndex((a) => a.startsWith("hooks.PreToolUse="));
          s.args[idx] = `hooks.PreToolUse=${toToml(changed)}`;
          s.listOpts = { ...s.listOpts, args: s.args };
        } else if (method === "B") {
          s.writeHooks(changed);
        } else {
          s.writeConfig(tr.state, changed);
        }
        writeFileSync(s.hookFile, HOOK_SRC("v2"));
        const listedChanged = await listHooks(s.wt, s.listOpts);
        const run = codexExec(label, s.wt, TRUST_PROMPT, { args: s.args, env: s.env, home: s.home });
        record(label, { method, hooksIn: s.hooksIn, trust: tr, listedAfterChange: listedChanged, run, ...evidence(label, s.wt, s.branch, { tempHome: homeAudit(s) }) });
      } finally { s.cleanup?.(); }
    }
    for (const label of ["s3", "s3b", "s3m", "s3r"]) {
      if (!wanted.includes(label)) continue;
      const gitBash = ["C:/Program Files/Git/bin/bash.exe", "/bin/bash"].find((p) => existsSync(p));
      const envExtra = label === "s3b" && gitBash ? { SHELL: gitBash } : {};
      // s3r: rules in a separate CODEX_HOME, checked against PowerShell spellings of one command.
      const method = label === "s3r" ? "C" : "A";
      const s = await setupMethod(method, label, { probeOnly: true, envExtra });
      const tr = await trust(s);
      const prompt = { s3: S3_PROMPT, s3b: S3_PROMPT, s3m: S3M_PROMPT, s3r: S3R_PROMPT }[label];
      const run = codexExec(label, s.wt, prompt, { args: s.args, env: s.env, home: s.home });
      record(label, { method, shellEnvForChild: s.env.SHELL ?? null, trust: tr, run, ...evidence(label, s.wt, s.branch, { tempHome: homeAudit(s) }) });
    }
  } finally {
    const end = snapshot(DEV_HOME);
    results.devHome = {
      listingAtEnd: listing(end),
      diffStartToEnd: diff(startSnap, end),
      configExistsAtEnd: existsSync(DEV_CONFIG),
      authSha256_16AtEnd: fileHash(DEV_AUTH)?.slice(0, 16),
      authUnchanged: fileHash(DEV_AUTH) === devAuthHashStart,
    };
    console.log(JSON.stringify(results.devHome, null, 1));
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 2));
    rmSync(root, { recursive: true, force: true });
    console.log(`temp root removed: ${!existsSync(root)}`);
  }
}
