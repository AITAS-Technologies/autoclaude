# Spike S2: Codex isolation per run

Status: run on Windows 11 (Git Bash parent; the S3 probes also with a PowerShell parent, see `s3-codex-windows-shell.md`). WSL2/Linux run: pending — needs Linux node and a logged-in codex inside WSL.
Command to run there: `node spikes/s2-codex-isolation.mjs "$TMPDIR/s2-linux"` (plain Node ESM; on Linux the script omits the Windows sandbox key and the hook reads its parent process with `ps`).

Every statement below is marked **observed** (seen in a run on this machine) or **documented** (vendor documentation or Codex source; not verified here). Unmarked table cells are observed.

## Question

Can hooks, execpolicy rules, an MCP server and sandbox writable roots (a worktree's `.git` lives in the main checkout) be supplied to `codex exec` per run, without touching `~/.codex`? Three supply methods: `-c` overrides, a project `.codex/` directory in the worktree, a separate `CODEX_HOME` with the login linked in. For each: does the hook fire on a shell command, does exit 2 block, does a changed hook stay trusted headless, can `git commit` write the worktree's `.git`, is `~/.codex` left alone?

## Procedure

`spikes/s2-codex-isolation.mjs` builds a temp repo `main` and one `git worktree` per variant (`<root>/<label>`, whose `.git` file points to `main/.git/worktrees/<label>`), plus an untracked `s2.txt`. It spawns, with stdin empty and a 180 s timeout:

```
codex exec --json -C <worktree> -s workspace-write -m gpt-6.1-sol <per-method config> "<prompt>"
```

`codex` is the npm package's launcher (`<npm dir>/node_modules/@openai/codex/bin/codex.js`) run with this node, because the `.cmd` shim needs cmd.exe. The child environment has `CLAUDECODE` and `CLAUDE_*` removed (except `CLAUDE_CODE_GIT_BASH_PATH`).

The fence of every variant:

- three `PreToolUse` handlers on matcher `^Bash$`, all `node <hook.mjs> <mode> <log>`: mode `exit2` (stderr + exit 2 on `BLOCK_EXIT2`), mode `json` (stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}`, exit 0, on `BLOCK_JSON`), mode `psexit` (exit 2 on `BLOCK_PSEXIT`, with `commandWindows: "<same command>; exit $LASTEXITCODE"`). Each handler logs its payload.
- the trust for those handlers, computed by the script (prerequisites 4 and 5 below) and supplied by the same method;
- execpolicy rule `prefix_rule(pattern=["git", "hash-object"], decision="forbidden", justification="...")`;
- MCP server `s2` = this script with `--mcp-server` (minimal stdio JSON-RPC, one tool `ping` returning `s2-pong-<label>`), `default_tools_approval_mode = "approve"`;
- `sandbox_workspace_write = { writable_roots = [<main>\.git], exclude_tmpdir_env_var = true, exclude_slash_tmp = true }` (the temp dirs are excluded because the fixture lives under `%TEMP%`, which `workspace-write` makes writable by default), and on Windows `windows = { sandbox = "mxc" }`;
- the project trust entry for the worktree (`untrusted` for A and C, `trusted` for B).

Methods:

- **A** everything as `-c` overrides (`-c hooks.PreToolUse=[...]`, `-c hooks.state={...}`, `-c mcp_servers.s2={...}`, `-c sandbox_workspace_write={...}`, `-c windows={...}`, `-c projects={...}`).
- **B** `<worktree>/.codex/config.toml` (hooks, MCP, sandbox, windows) and `<worktree>/.codex/rules/s2.rules`; `-c projects={'<worktree>'={trust_level='trusted'}}` and `-c hooks.state=...`, because trust cannot live in the project layer and `~/.codex` is off limits. **Bm**: the same, but the hooks in `<main>/.codex/hooks.json` (see the B result).
- **C** `CODEX_HOME=<root>/codex-home-<label>` with `auth.json` hard-linked from `~/.codex/auth.json` (fallbacks symlink, copy; the hardlink worked), `config.toml` and `rules/s2.rules` there; no `-c`.

Prompts (each shell step one tool call, no retries): fence variants A, B, C run `echo s2-hello`, `echo BLOCK_EXIT2`, `echo BLOCK_JSON`, `echo BLOCK_PSEXIT`, `git hash-object s2.txt`, the MCP tool `ping`, `git add s2.txt`, `git commit -m s2-commit`, `git config s2.probe yes`; Bm the first four. `gitbase` (A without writable roots) and `gitnarrow` (A with roots `main/.git/{objects,refs,logs,worktrees/<label>}`) run the three git steps. `tA`, `tB`, `tBm`, `tC`: trust the three handlers, then change the definition of the `json` handler (timeout 30 to 31) and the content of `hook.mjs` (v1 to v2), list the hooks again, and run `echo BLOCK_JSON`.

Before each exec the script lists the hooks through `codex app-server` (JSON-RPC `hooks/list`), compares the reported `currentHash` with its own, and after each run diffs a snapshot of `~/.codex` (path, size, mtime, sha256 of every file; `auth.json` only hashed, never read out) and restores `~/.codex/config.toml` if a run changed it (it never did in the script runs).

Runs: `node spikes/s2-codex-isolation.mjs <out>` (all variants, Git Bash parent), then `... <out> s3r`, `... <out> --inherit-env s3`, and from PowerShell `... <out> s3 s3b s3m` (S3 note). Before the script existed, exploratory single runs established the prerequisites below; they are marked "exploratory".

Environment: Windows 11 Pro 10.0.26200, Node v24.14.0, git 2.29.0.windows.1, `codex --version` = `codex-cli 0.163.0`, ChatGPT login. Model: `gpt-6.1-sol`, the default of this login (observed: `turn_context.model` of a run without `-m`; it is also priority 1 in `codex debug models`; default reasoning `low`).

Documentation relied on (fetched 2026-10-16; developers.openai.com/codex/* redirects to learn.chatgpt.com/docs/*): hooks (`/docs/hooks`), configuration reference (`/docs/config-file/config-reference`), rules (`/docs/agent-configuration/rules`), sandbox and approvals (`/docs/agent-approvals-security`), Windows sandbox (`/docs/windows/windows-sandbox`), `codex --help`, `codex exec --help`. Codex source on github.com/openai/codex, main branch as of 2026-10-16 (not necessarily the 0.163.0 tag): `codex-rs/hooks/src/engine/discovery.rs` (hook hash), `codex-rs/config/src/fingerprint.rs`, `codex-rs/core/config.schema.json`.

## Observed

### Prerequisites found before the matrix (exploratory)

1. **Windows sandbox off by default.** Without a `windows.sandbox` setting the sandbox log says `Windows sandbox selection: disabled`, `-s workspace-write` silently becomes `read-only` in the rollout's `turn_context`, and every command is refused: `` exec_command failed: CreateProcess { message: "Rejected(\"`\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'echo hello'` rejected: blocked by policy\")" } ``, exit 0, the model answers "Command blocked by policy." With `-c windows.sandbox="mxc"` (log: `MXC availability: true`, `Windows sandbox selection: mxc`) the policy is `workspace-write` and commands run. Not tried: `elevated`, `unelevated`.
2. **Codex writes project trust into `$CODEX_HOME/config.toml` on its own.** The first exploratory run with an effective `workspace-write` sandbox created `~/.codex/config.toml` (which did not exist) with:
   ```
   [projects.'c:\users\user\appdata\local\temp\<fixture>\main']
   trust_level = "trusted"
   ```
   (the main checkout, lower-cased, not the worktree). The write happens at startup, before any model call: probes with `-m s2-no-such-model` (exit 1, `turn.failed`, no tokens) show it. Each time the file was deleted again (it had not existed before), so `~/.codex` was restored; see "~/.codex before and after".

   | Probe (`-C <worktree>`) | `~/.codex/config.toml` written? |
   |---|---|
   | `-s workspace-write`, `windows.sandbox="mxc"` | yes |
   | same + `--ignore-user-config` | yes |
   | same + `--ephemeral` | yes |
   | `-c sandbox_mode="workspace-write"` instead of `-s` | yes |
   | `-s workspace-write`, no `windows.sandbox` (so read-only) | no |
   | `-s read-only`, `windows.sandbox="mxc"` | no |
   | + `-c "projects={'<main, lower-case, backslashes>'={trust_level='trusted'}}"` | no |
   | + `-c "projects={'<main, original case, backslashes>'={trust_level='trusted'}}"` | no |
   | + `-c "projects={'<main with forward slashes>'={trust_level='trusted'}}"` | **yes** |
   | + `-c "projects={'<worktree, backslashes>'={trust_level='trusted'}}"` | no |
   | + `-c "projects={'<main>'={trust_level='untrusted'}}"` | no |
   | + `-c "projects={'<worktree>'={trust_level='untrusted'}}"` | no; sandbox stays `workspace-write`, `echo hello` runs |

   So the key must be the native path (backslashes; case did not matter). An `untrusted` worktree keeps `workspace-write` with an explicit `-s` and runs commands (approval `never`), and skips the project `.codex/` layer (documented).
3. **Project config is honoured** for `windows.sandbox` and `sandbox_workspace_write` when the worktree is trusted via `-c` (probe: the rollout shows the project's writable roots and `exclude_*` flags; sandbox log `mxc`).
4. **Hook trust can be supplied per run.** `codex app-server` `hooks/list` reports for a `-c` hook `"source": "sessionFlags"`, `"key": "C:\\<session-flags>\\config.toml:pre_tool_use:0:0"`, `"currentHash": "sha256:..."`, `"trustStatus": "untrusted"`. Adding `-c "hooks.state={'<key>'={trusted_hash='<currentHash>'}}"` makes it `trusted` (TOML literal strings; the same with basic `"..."` strings was rejected as "invalid type: string ..., expected a map"). `-c bypass_hook_trust=true` is not a config key ("Codex is ignoring 1 unrecognized configuration setting"); the CLI flag `--dangerously-bypass-hook-trust` exists (not run).
5. **The hash can be computed offline.** Documented in the source (`hook_hash` + `version_for_toml`): sha256 over the sorted-key JSON of `{event_name, matcher, hooks: [normalized handler]}`. Observed: `sha256(JSON.stringify(sorted({event_name:"pre_tool_use", matcher:"^Bash$", hooks:[{async:false, command, timeout:30, type:"command"}]})))` equals `currentHash` for every handler in every script run (31 of 31), for TOML (`-c`, `config.toml`) and JSON (`hooks.json`) sources alike. On Windows a handler with `commandWindows` hashes with the Windows text as `command` and no `commandWindows` field. The timeout defaults to 600 when unset (source).
6. **MCP tools need an approval mode.** The first script run of A, without `default_tools_approval_mode`, gave `{"server":"s2","tool":"ping","status":"failed","result":{"message":"MCP tool call requires approval, but approval policy is never"}}`. With `default_tools_approval_mode = "approve"` the call completes.

### Matrix (final script run, Git Bash parent)

| Question | A: `-c` overrides | B: project `.codex/` in the worktree | C: separate `CODEX_HOME` |
|---|---|---|---|
| hooks discovered (`hooks/list`) | yes, `sessionFlags`, key `C:\<session-flags>\config.toml:pre_tool_use:0:<n>` | **no**: none from `<worktree>/.codex/config.toml`; exploratory: none from `<worktree>/.codex/hooks.json` either. For a worktree Codex reads project hooks only from `<main>/.codex/` (`hooks.json` or `config.toml`). **Bm** (`<main>/.codex/hooks.json`): yes, `project`, key `<main>\.codex\hooks.json:pre_tool_use:0:<n>` | yes, `user`, key `<CODEX_HOME>\config.toml:pre_tool_use:0:<n>` |
| trusted headless | yes, via `-c hooks.state` (before: `untrusted` ×3, after: `trusted` ×3) | Bm: yes, via `-c hooks.state` | yes, `hooks.state` in the temp `config.toml` |
| hook fires on a shell command | yes: 24 log lines = 3 handlers × 8 shell commands; payload `tool_name: "Bash"`, `tool_input: {command: "<the model's text>"}` | B: no (0 lines); Bm: yes (12 lines) | yes (24 lines) |
| exit 2 blocks | **no**: `echo BLOCK_EXIT2` ran (the hook ran and exited 2) | Bm: no | no |
| JSON deny blocks | yes | Bm: yes | yes |
| exit 2 via `commandWindows: "...; exit $LASTEXITCODE"` | yes | Bm: yes | yes |
| changed definition, old trusted hash (`tA`/`tBm`/`tC`) | `hooks/list`: `trusted, modified, trusted`; the modified handler did not run, `echo BLOCK_JSON` ran; no warning on stderr or in the JSONL | tBm: same (tB: no hooks at all, as in B) | same |
| changed script content, same definition | stays `trusted`; the hook ran the new content (log lines `v2`) | tBm: same | same |
| execpolicy rule | cannot be supplied: no config key for rules (documented: `rules/` next to an active config layer; the schema has no rules key); `git hash-object` ran | yes, `<worktree>/.codex/rules/s2.rules`: blocked | yes, `<CODEX_HOME>/rules/s2.rules`: blocked |
| MCP server | yes (`tools/call` reached the server; `s2-pong-A`) | yes (`s2-pong-B`) | yes (`s2-pong-C`) |
| sandbox settings applied (rollout `turn_context`) | yes: `workspace-write`, writable `<worktree>`, `<main>\.git`; `exclude_*` true | yes | yes |
| `git add`/`commit` with `writable_roots = [<main>\.git]` | **no**: `fatal: Unable to create '<main>/.git/worktrees/A/index.lock': Permission denied` | same | same |
| `git config s2.probe yes` (writes `<main>/.git/config`) with that root | **succeeded** | succeeded | succeeded |
| `~/.codex` configuration untouched | yes (no `config.toml`, no rules, no hooks file) given the `projects` entry; Codex adds its own session and state files | yes, same | yes, and nothing at all changed in `~/.codex` (empty diff) |

Git variants (method A, no rules): `gitbase` (no extra roots): `git add`/`commit` denied (`index.lock`), `git config` denied (`could not lock config file <main>/.git/config: Permission denied`). `gitnarrow` (roots `objects`, `refs`, `logs`, `worktrees/gitnarrow` under `<main>\.git`): `git add` and `git commit` succeeded (`[gitnarrow <sha>] s2-commit`, verified on the branch afterwards), `git config` denied.

The rollout's permission profile lists read-only carve-outs only for `<root>\.git`, `.agents`, `.codex`, `.aws` of each writable root (`<worktree>\.git`, `<main>\.git\.git`, ...), not for `<main>\.git\worktrees\<wt>`; yet writes there were denied unless that directory was itself a writable root. This matches the documented rule "if `.git` is a pointer file, the resolved Git directory is also read-only", and shows an explicit writable root overrides it.

### How a block shows up

- Hook block (JSON deny or exit 2 that arrives): no JSONL item at all for the command (`--json` event types were only `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`); codex stderr gets `ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: blocked by s2 hook (json deny). Command: echo BLOCK_JSON`; the model sees the reason and reports it. Exit code 0.
- Rule block: also no JSONL item; stderr `` ERROR ... exec_command failed: CreateProcess { message: "Rejected(\"`\"C:\\...\\powershell.exe\" -Command 'git hash-object s2.txt'` rejected: s2 spike: git hash-object is forbidden in this stage\")" } ``. Exit code 0.
- Hook that fails or is skipped (untrusted, modified, exit code lost): nothing anywhere; the command runs.
- Sandbox denial: a normal `command_execution` item with `status: "failed"`, the tool's own error text, exit code 1.

### Exit 2 on Windows

The hook's parent process (read by the hook through `Get-CimInstance Win32_Process`) is `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "node <hook.mjs> exit2 <log>"` in every variant. Observed by hand: `powershell.exe -NoProfile -Command "node ex2.mjs"` (a script that exits 2) returns 1; with `; exit $LASTEXITCODE` appended it returns 2. So on Windows exit 2 reaches Codex as 1, which Codex treats as a hook failure and lets the command run (documented: unsupported or failed `PreToolUse` output fails open). JSON deny on stdout with exit 0 does not depend on the exit code and blocked in every method.

### Temp `CODEX_HOME` (method C)

`auth.json` hard link created without elevation. After C, tC and s3r: the temp `auth.json` was still the same file as `~/.codex/auth.json` (same inode; link count 2, or 3 while two temp homes existed; 1 after cleanup), same hash, so no token refresh happened in these runs (none was due). Codex did not modify the `config.toml` the script wrote. It filled the temp home with its own state (`sessions/`, `*.sqlite`, `cache/`, `plugins/`, `skills/`, `models_cache.json`, `.sandbox/`). C took 53 s in the first full script run and 128 s in the final one (fresh home both times; cause of the difference not determined), A and B 40 to 53 s. It printed `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "C:\Users\user\AppData\Local\Temp\" (codex_home: ...)`. The temp root (worktrees, homes, hook files) was removed at the end of every script run.

### `~/.codex` before and after

At task start (given): `auth.json`, `log/`, `tmp/`; no `config.toml`. First listing taken here, after `codex --version`/`--help` and `codex debug models` but before any `exec`:

```
F auth.json 4254 2026-10-16T12:59:34.594Z sha256=0bea36c36b4cbb38
D log/
F log/codex-login.log 544 2026-10-16T12:59:34.233Z
F models_cache.json 399163 2026-10-16T13:56:08.799Z      (written by `codex debug models`)
D tmp/  D tmp/arg0-windows/                               (written by the first codex invocations)
```

After all runs (top level): `.sandbox/` (`sandbox.<date>.log`), `.sandbox_migration`, `auth.json` (4254 bytes, mtime 2026-10-16T12:59:34Z, sha256 prefix `0bea36c36b4cbb38`, unchanged, link count 1), `cache/`, `goals_1.sqlite*`, `installation_id`, `log/`, `logs_2.sqlite*`, `memories_1.sqlite`, `models_cache.json`, `plugins/` (~29 MB of downloaded curated plugins), `queue_1.sqlite*`, `sessions/` (one rollout per A/B-style run), `skills/`, `state_5.sqlite*`, `thread-writer-locks/`, `thread_history_1.sqlite*`, `tmp/`. No `config.toml`, no `*.toml`, no `hooks.json`, no `rules/` anywhere under `~/.codex`. The only configuration write was Codex's own trust entry from the exploratory runs (prerequisite 2), deleted each time; the script's runs (which always pass the `projects` entry) never wrote it.

### Inherited `CLAUDE_*` environment

`--inherit-env s3` (keeps `CLAUDECODE`, `CLAUDE_EFFORT`, `CLAUDE_CODE_*`): same commands, same outputs, same shell as the stripped run. No behaviour change seen (one run).

### Other observations

- The rollout's `token_count` events carry `rate_limits: {limit_id: "codex", primary: {used_percent, window_minutes: 300, resets_at}, secondary: {window_minutes: 10080, ...}}` (relevant to § 9; not pursued).
- Hook payload keys: `session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, tool_name, tool_input, tool_use_id`; `permission_mode` was `bypassPermissions` (approval `never`).
- The model calls shell commands through a code-mode `exec` tool that calls `exec_command`; the hook still sees `tool_name: "Bash"`.
- `codex execpolicy check --rules <file> -- git hash-object s2.txt` gives `forbidden`; the same command wrapped as `powershell.exe -Command "..."` or `bash -lc "..."` gives no match, although at runtime the PowerShell-wrapped command was blocked. The CLI checker does not model the runtime unwrapping.
- With a trusted project, `.codex/` in the worktree is untracked content (`git status`: `?? .codex/`); a stage's `git add -A` would commit it.
- Cost per fence run: about 160k to 172k input tokens (148k to 164k cached), about 500 output tokens.

## Answer

- **Per run without touching `~/.codex`: yes, best with a separate `CODEX_HOME` (method C).** C supplies hooks, their trust, rules, the MCP server and the sandbox settings, and left `~/.codex` byte-for-byte unchanged. A (`-c`) supplies everything except execpolicy rules; B (project `.codex/`) supplies config and rules but not hooks for a worktree: Codex takes a worktree's project hooks from the main checkout's `.codex/`, which is the developer's working copy and shared by all worktrees. A and B use the real `~/.codex`, where Codex keeps writing its own sessions and state, and would write a project trust entry into `~/.codex/config.toml` unless every run passes `-c projects={'<native worktree path>'={trust_level=...}}`.
- **Hook fires on a shell command:** yes in A, C, Bm; no in B.
- **Exit 2 blocks:** no on Windows (fails open; the exit code is lost in `powershell -Command`). JSON deny blocks in every method; exit 2 blocks with `commandWindows: "<cmd>; exit $LASTEXITCODE"`.
- **A changed hook stays trusted headless:** a changed definition does not: it becomes `modified` and is skipped silently, so the command runs (fail open). A changed hook *script* (same command line) stays trusted and its new content runs: trust covers the definition, not the file it calls. Trust is supplied per run (`hooks.state`) and the hash is computable offline.
- **`git commit` in the worktree:** not with `writable_roots = [<main>/.git]` (the worktree's own gitdir stays read-only, while the rest of the common `.git` becomes writable: `config` was written; `hooks/` lies under the same root, not tried). It works with `<main>/.git/{objects,refs,logs,worktrees/<wt>}` as roots, and `.git/config` stays read-only.
- **`~/.codex` untouched:** configuration yes in all script runs (no `config.toml`, `auth.json` hash unchanged); with C nothing at all is written there.

## Consequence for the plan

Phase 3 (Codex adapter, § 7.5 to 7.6):

- **Supply method:** a per-run `CODEX_HOME` owned by autoclaude, outside the OS temp dir (Codex refuses to create its helper binaries under temp), holding `config.toml` (hooks + `hooks.state`, MCP servers from the project's Codex config, sandbox settings, `projects.'<worktree>'.trust_level = "untrusted"` so the repository's own `.codex/` never loads), `rules/*.rules`, and `auth.json` linked to the developer's. Keep `CODEX_HOME` per run or per worktree; expect Codex to fill it with state and a plugin cache (29 MB in `~/.codex` here) on first use, so reuse one per machine if that state is not a concern. Open: what happens to the link when Codex refreshes tokens (in-place write vs. replace). The adapter must check after each run that the temp `auth.json` is still the developer's file, and fail loudly if not, because a rotated refresh token left only in a temp copy would log the developer out.
- **If `-c` is used at all** (e.g. per-stage overrides on top of C): always pass the `projects` entry with the native path; forward-slash paths do not match and Codex then writes trust into the user config.
- **Hook (guard) on Codex:** answer by JSON on stdout (`permissionDecision: "deny"`), never by exit code; the guard wrapper must turn its own errors into a JSON deny. Supply trust as `hooks.state` with the hash computed as above, and before every stage verify through `codex app-server` `hooks/list` (same config) that every fence hook is `trusted`. Untrusted and modified hooks and a lost exit code fail open without any trace (observed); a hook that fails or returns unsupported output lets the call continue (documented); crash and timeout were not tried. Keep the hook script outside every writable root (in C's home, not in `%TEMP%` unless the temp dirs are excluded): its content is not covered by the trust hash.
- **Second layer:** set `windows.sandbox` explicitly (`mxc` worked here; `doctor` must check it, since without it every command is refused), `exclude_tmpdir_env_var`/`exclude_slash_tmp` unless a stage needs temp, `default_tools_approval_mode` per MCP server. Execpolicy rules work at runtime but on Windows are bypassed by PowerShell spellings (S3), so they are not a fence there.
- **Commits:** either the engine commits after the stage, or the writable roots are exactly `<common .git>/{objects,refs,logs,worktrees/<wt>}`. Never `<common .git>` whole: that lets a stage write `.git/config` (observed) and presumably `.git/hooks`, which the engine's own later git calls (push) would execute outside any sandbox. Even the narrow set lets a stage move any local ref, so the engine checks refs before pushing. Do not let fence files land in the worktree (B's `.codex/` shows up as untracked).
- **Runner:** blocks leave no JSONL item; read codex stderr (`ERROR codex_core::tools::router: ...`) to record policy events. Exit code was 0 in every run that completed a turn; a failed model call gave exit 1 with `turn.failed`.
- § 7.6 table, Codex column: `codex exec --json`, `-m`, `-C`, `[mcp_servers.*]` via `-c`, trust hashing, exec's approval `never` confirmed; "exit 2 blocks" holds only where the hook shell keeps the exit code (not Windows PowerShell); add `windows.sandbox` and `default_tools_approval_mode` as required settings. `--output-schema`, `-o`, `model_reasoning_effort` and the limit message were not exercised here.
