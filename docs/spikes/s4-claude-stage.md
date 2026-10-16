# Spike S4: a Claude stage as a child process

Status: run on Windows 11 (PowerShell parent and Git Bash parent). WSL2/Linux run: pending, needs Linux node and a logged-in claude (and gh for S5) inside WSL.
Command to run there: `node spikes/s4-claude-stage.mjs "$TMPDIR/s4-linux"` (the script is plain Node ESM and runs unchanged on Linux; the `h` variant then tries the single spelling `//<abs path>/**`).

## Question

Can autoclaude run a pipeline stage as a headless `claude -p` child process with a fixed flag set, and how do success, structured output, turn exhaustion, a permission denial and a hook block each show up (exit code, JSON shape)? Which spelling of an absolute-path `Edit`/`Write` rule works on Windows, including under a path with a space and an umlaut?

## Procedure

`spikes/s4-claude-stage.mjs` creates a temp git repo and spawns, with `cwd` = the repo:

```
claude -p "<prompt>" --output-format json --model claude-sonnet-5-5 --settings <file> \
  --permission-mode dontAsk --mcp-config <file with {"mcpServers":{}}> --strict-mcp-config --max-turns 3
```

stdin is closed (empty), timeout 180 s, and the child environment has `CLAUDECODE` and all `CLAUDE_*` variables removed (except `CLAUDE_CODE_GIT_BASH_PATH`). The settings file allows `Read` (plus variant-specific rules). Variants:

- (a) plain answer
- (b) `--json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}'`
- (c) `--max-turns 1` with a two-read task
- (d) a Bash call not on the allow list
- (e) a `PreToolUse` hook on `Bash` that exits 2 (`node "<abs path>/block-bash-hook.mjs"`, writes a reason to stderr)
- (e2) the same hook slot with a shell-probe command
- (f) `--effort high`
- (g) prompt "Read ./PROMPT.md and follow it." with the instructions in that file
- (h) allow list with only `Edit(<abs>/**)`, `Write(<abs>/**)` and `Read`; ask for one write inside the repo and one in a sibling directory; four rule spellings, each on two bases (one under `Jürgen Müller`, one plain)

Run once with a Git Bash parent and once with a PowerShell parent (full set each). One extra pair of runs (a, d) with the controller's `CLAUDE_*` variables inherited.

Environment: Windows 11, Node v24.14.0, `claude --version` = `2.1.289 (Claude Code)` (so `TESTED_CLAUDE_MAJORS` = `[2]`), logged in with a subscription, model `claude-sonnet-5-5`.

## Observed

### Flags in `claude --help` (2.1.289)

Present: `--effort <level>` (low, medium, high, xhigh, max), `--json-schema`, `--settings <file-or-json>`, `--permission-mode` (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan), `--mcp-config`, `--strict-mcp-config`, `--model`, `--output-format` (text, json, stream-json).
Absent from `--help` but accepted and enforced: `--max-turns` (variant c shows it works). The help text alone is not a reliable flag inventory.

### Per-variant results (same outcomes for the PowerShell and Git Bash parents; only cost and timing differ)

| Variant | Exit | `is_error` | `subtype` | `num_turns` | Cost USD (bash run) | Notes |
|---|---|---|---|---|---|---|
| a plain | 0 | false | success | 1 | 0.055 | answer in `result` (`"pong"`) |
| b `--json-schema` | 0 | false | success | 2 | 0.117 (0.055 in the PowerShell run; cache effect) | `structured_output: {"ok":true}`; `result` is the same JSON as a string |
| c `--max-turns 1` | **1** | **true** | **error_max_turns** | 2 | 0.049 | no `result` key; `errors: ["Reached maximum number of turns (1)"]`; `terminal_reason: "max_turns"`; `stop_reason: "tool_use"` |
| d Bash not allowed | 0 | false | success | 2 | 0.065 | `permission_denials: [{tool_name, tool_use_id, tool_input}]`; the model's `result` text says it was refused |
| e hook exit 2 | 0 | false | success | 2 | 0.057 | the hook block is also reported in `permission_denials` (same shape as d); the hook's stderr text appears only in the model's `result` |
| f `--effort high` | 0 | false | success | 1 | 0.046 | accepted; answer `pong` |
| g `Read ./PROMPT.md and follow it` | 0 | false | success | 2 | 0.062 | `result` = `banana` (the file's instruction was followed) |

Top-level JSON keys on a success (stripped environment): `duration_api_ms, stop_reason, session_id, total_cost_usd, usage, modelUsage, permission_denials, terminal_reason, fast_mode_state, fast_mode_disabled_reason, subagent_stats, is_error, num_turns, subtype, api_error_status, result, ttft_ms, type, duration_ms, uuid, ttft_stream_ms, time_to_request_ms, first_content_frame_ms, queued_turn_count, result_index`. `type` is `"result"`. The output is a single JSON object, not an array. (b adds `structured_output`; c has `errors` and no `result`.)

Wall time per call: 4 to 15 s for these tiny prompts. Cost per call: about 0.045 to 0.12 USD, dominated by cache creation for the 11k to 29k-token system prompt.

Variant d note: a first attempt used `git status --short`; it ran without any allow rule and without a denial (read-only git commands are evidently allowed in `dontAsk`). The recorded d uses `touch ./created.txt`, which was denied. A fence cannot assume that "not on the allow list" blocks read-only Bash commands.

Variant d denial, verbatim from `refused.json`:
`"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_...","tool_input":{"command":"touch ./created.txt && ls -l ./created.txt","description":"Create created.txt and verify it exists"}}]` with `"subtype":"success"`, `"is_error":false`, exit code 0. A denial is not an error at the process level.

Variant e hook block, from `hook-blocked.json`: `permission_denials` holds the Bash call (`echo hello`); `result` begins: "I couldn't run `echo hello`. A pre-tool hook (`block-bash-hook.mjs`) blocked the Bash call with the message "blocked by spike hook: no shell in this stage" ...". The claude process's own stderr was empty.

Variant e2 (shell probe), the hook diagnostic line as relayed by the model:
`PreToolUse:Bash hook error: [echo probe[bash=$BASH_VERSION][cmd=%COMSPEC%][ps=$PSVersionTable] 1>&2; exit 2]: probe[bash=4.4.23(1)-release][cmd=%COMSPEC%][ps=]`
So on Windows Claude Code ran the hook command through Git Bash (bash 4.4.23), not cmd.exe or PowerShell (same line from both the Git Bash and the PowerShell parent). Hook commands therefore need POSIX-shell quoting and forward-slash paths.

### Variant h: absolute-path rules (`Edit(<spec>/**)` + `Write(<spec>/**)` + `Read`, `dontAsk`)

The same result for the umlaut base (`Jürgen Müller`) and the plain base, and for both parents:

| Rule spelling (`<spec>`) | Inside write | Outside write |
|---|---|---|
| `//C:/Users/.../repo` (`//` + drive + colon) | denied | denied |
| `//c/Users/.../repo` (`//` + lowercase drive, MSYS style) | allowed | denied |
| `/C:/Users/.../repo` (single slash + drive + colon) | denied | denied |
| `C:/Users/.../repo` (plain drive path, forward slashes) | allowed | denied |

The umlaut and the space caused no failure: the two failing spellings fail on the plain path as well. The inside file was checked on disk after each run; the outside file never existed. A denied write is reported like d: exit 0, `subtype: success`, `permission_denials: [{tool_name: "Write", tool_use_id, tool_input: {file_path: "<native Windows path with backslashes>", content}}]`. The model's `tool_input.file_path` uses backslashes, so matching normalises separators.
Not tested: case sensitivity of the drive letter or path, and nested directories under the allowed root (only files directly in the root were written).

### Inherited `CLAUDE_*` environment (extra run: a and d with `CLAUDECODE=1`, `CLAUDE_EFFORT=xhigh` etc. kept)

Outcome identical (a: `pong`, success; d: denied, success). The only difference seen: the result JSON carries extra diagnostic keys (`time_to_request_phases_ms`, `turn_start_resume_kind`, `process_turn_index`, `time_to_request_loop_lag_ms`, `time_to_request_cpu_ms`, `time_to_request_major_faults`, `input_attachments_detail`) and lacks `fast_mode_disabled_reason`. No behavioural change was observed (one pair of runs; no evidence that `CLAUDE_EFFORT=xhigh` changed effort or cost).

### Spawning on Windows

`claude` on PATH is an npm `.cmd` shim. Spawning a `.cmd` needs a shell, and cmd.exe mangles JSON arguments such as `--json-schema`. The spike resolves the real `claude.exe` (`<npm dir>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`) and spawns it directly with an argument array; that worked for every variant, including the schema argument and a prompt containing backticks. (Spawning via the shim was not tried, so "mangles" is the expected cmd.exe behaviour, not an observation.)

### Usage-limit messages (from the vendor documentation, not observed)

A limit cannot be provoked on demand. The messages, as given for this task from the vendor docs:
- `You've hit your session limit · resets 3:45pm`
- `You've hit your weekly limit · resets Mon 12:00am`

Not re-verified here against the live docs. How these surface in `claude -p --output-format json` (exit code, `is_error`, `subtype`, `result` text) is unobserved. E3 must treat that shape as unknown and detect the text in `result` and in stderr.

## Answer

Yes. The fixed flag set works as given (`--max-turns` works although absent from `--help`; `--effort` exists and `--effort high` is accepted). A stage's outcome is read from the single JSON object on stdout plus the exit code:

- success: exit 0, `subtype: "success"`, `is_error: false`, text in `result`.
- structured output: in `structured_output` (and as a JSON string in `result`).
- turn limit: exit 1, `is_error: true`, `subtype: "error_max_turns"`, no `result`.
- permission denial and hook block: exit 0, `subtype: "success"`, the call listed in `permission_denials`. The two are indistinguishable by structure.
- Git Bash and PowerShell parents behave the same.

## Consequence for the plan

- E3 (stage runner): spawn `claude.exe` directly with an argument array (resolve it past the `.cmd` shim on Windows), close stdin, enforce its own timeout, parse stdout as one JSON object. Do not treat a non-empty `permission_denials` as a failed process: the runner must inspect it and decide (a denial in a fenced stage is a policy event; the model usually reports it in `result`). Do not rely on the exit code alone: only turn exhaustion changed it here. Fixtures: `test/fixtures/runtime/claude/{ok,structured,max-turns,refused,hook-blocked}.json`. `TESTED_CLAUDE_MAJORS` = `[2]`. Probe flags by running them, not from `--help`. A handler for the limit messages must be written from the docs text and verified later.
- E2 (fence generator): on Windows write absolute-path rules as `Edit(//c/<rest>/**)` / `Write(//c/<rest>/**)` (MSYS-style, lowercase drive) or `C:/<rest>/**` (plain forward-slash drive path); do not emit `//C:/...` or `/C:/...`. Both working forms were tested with a space and an umlaut in the path. Prefer the `//c/...` form since it follows the `//` absolute-path convention; the plain form working is an undocumented observation. Read-only Bash commands such as `git status` ran without an allow rule, so Bash fences need explicit deny rules where that matters. Hook commands run in Git Bash on Windows, so write them as `node "<forward-slash abs path>"`.
- Environment: stripping `CLAUDE_*` is safe and keeping them changed nothing observable here, so stripping stays the conservative choice (keep `CLAUDE_CODE_GIT_BASH_PATH`).
