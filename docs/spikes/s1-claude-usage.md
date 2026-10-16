# S1: Claude usage without a UI

Run on 2026-10-16, Windows 11, Node 24.14.0, claude 2.1.289 (a subscription login), PowerShell/Git Bash parent. Scripts: `spikes/s1-claude-usage.mjs`, `spikes/s1-dump-statusline.mjs`.

## Question

Before dispatching a stage, autoclaude must read the account's five-hour and weekly usage percentage and reset times. For Claude Code the only known source is the status-line payload (`rate_limits.five_hour` / `rate_limits.seven_day`). Is it produced under headless `claude -p`? If not, what is the cheapest way to read it without a UI?

## Procedure

The child environment drops `CLAUDECODE` and every `CLAUDE_*` variable except `CLAUDE_CODE_GIT_BASH_PATH` (as in S4); the real `claude.exe` is spawned, not the `.cmd` shim. A settings file passed with `--settings` (nothing in `~/.claude` is touched) holds `statusLine: { "type": "command", "command": "node \"<abs>/spikes/s1-dump-statusline.mjs\" \"<temp>/statusline.jsonl\"" }`. The dump script appends each stdin payload as one JSON line and prints `s1` to stdout.

1. `claude -p "say ok" --output-format json --settings <file> --max-turns 1`
2. `claude -p "/usage" ...` (same flags)
3. `claude -p "/status" ...`
4. Interactive `claude --settings <file>` under a pseudo-terminal (ConPTY via `node-pty`, installed in a scratch directory outside the repository and loaded by absolute path via `S1_NODE_PTY`): answer the folder-trust prompt, send `say ok`, then `/exit`, 100 s hard timeout.

## Observed

1. `-p "say ok"`: exit 0, 12.3 s, a normal JSON result. `statusline.jsonl` was **not created**: the status-line command is never invoked in headless `-p`.
2. `-p "/usage"`: exit 0, 7.2 s, `num_turns: 0`, `total_cost_usd: 0`, `duration_api_ms: 0` (no model call). The `result` field holds the same text the interactive `/usage` shows. Verbatim (usage figures only):

   ```
   You are currently using your subscription to power your Claude Code usage

   Current session: 15% used · resets Oct 16, 6:09pm (Europe/Berlin)
   Current week (all models): 7% used · resets Oct 19, 5:59am (Europe/Berlin)
   Current week (Fable): 0% used · resets Oct 19, 6am (Europe/Berlin)

   What's contributing to your limits usage?
   Approximate, based on local sessions on this machine — does not include other devices or claude.ai. ...
   Last 24h · 422 requests · 57 sessions
   ...
   ```

   Plain `--output-format text` prints the same text. Gotchas: Git Bash rewrites an argument starting with `/` into a Windows path (`/usage` became `C:/Program Files/Git/usage` and the model answered about it); spawning from Node (no shell) is unaffected, and `MSYS_NO_PATHCONV=1` or `//usage` fixes it in Git Bash. The text has no year, a local time zone name instead of an offset, and a model-specific weekly line that appears only for some plans.
3. `-p "/status"`: exit 0, 0 turns, `result: "/status isn't available in this environment."`
4. Interactive under ConPTY: the first attempts showed a folder-trust prompt whose default is "No, exit" (Enter alone exits with code 1); sending Down then Enter trusts the folder. After that the status line fired 3 times in 49 s (one `say ok` prompt and `/exit`). `statusline.jsonl` was written. Payload top-level keys: `session_id, transcript_path, cwd, scratchpad_dir, effort, model, workspace, version, output_style, cost, context_window, exceeds_200k_tokens, fast_mode, thinking, prompt_id, prompt_cache, rate_limits`. The first entry (before the first response) had **no** `rate_limits`; the second and third had:

   ```json
   "rate_limits": {
     "five_hour": { "used_percentage": 14, "resets_at": 1792167000 },
     "seven_day": { "used_percentage": 7,  "resets_at": 1792382400 }
   }
   ```

   `resets_at` is Unix epoch seconds (1792167000 = 2026-10-16T16:10:00Z; 1792382400 = 2026-10-19T04:00:00Z). `used_percentage` is an integer. The two readings agree (14 % vs 15 % a few minutes apart, `/usage` reset times are the same instants rounded to the minute: 6:09pm vs 6:10pm, 5:59am vs 6:00am). No per-model weekly window is in the status-line payload. Note: during the interactive run the CLI auto-updated itself (2.1.289 to 2.1.301 afterwards); this is outside the spike's control and is an argument for pinning nothing about the output text format.

## Answer

- The status-line payload is **not** produced under `claude -p`. It is produced by an interactive session, but only after the first response, so the pseudo-terminal route needs a model call (a real, if tiny, subscription turn) and a trust-prompt dialogue and `node-pty` (a native dependency).
- The usage windows **are** readable headless, at no model cost, with `claude -p "/usage" --output-format json`: the `result` text carries percentage and reset time for the session (five-hour) window and the weekly window.

## Recommendation for Phase 2

Read usage with **`claude -p "/usage" --output-format json`**, spawned without a shell (Windows: the real `claude.exe`), with the stage-style environment, from any directory, and parse `result` with a tolerant matcher: lines `Current session: <n>% used · resets <date time> (<IANA zone>)` and `Current week (all models): <n>% used · resets ...`. Use only the session and "all models" week lines; treat other `Current week (...)` lines as optional. Resolve the reset date in the stated zone and, since there is no year, pick the next occurrence at or after now. Treat any parse failure, a non-zero exit, a timeout or a missing line as "unreadable" and apply design C17 for that reading (budget degrades to caps plus a hard-limit pause, `status` says "budget not enforced: usage unreadable"). Keep the text format behind a single parser module with a fixture, because it is human-oriented output and may change between CLI versions. Do not use a pseudo-terminal: it costs a model turn per reading and adds a native dependency. Resolution is one minute and the percentage is an integer; that is enough for budgeting.

Not verified: the output on an API-key (non-subscription) login or a plan without weekly limits (the line may be absent, which the tolerant parser maps to "unreadable"), and whether `/usage` counts as a request against any rate limit (it made no model call).

## Consequence for the plan

C17 does not apply on this machine for Claude: usage is readable. S1's status-line route is dropped for the `-p` path; the `/usage` route is the reading method and needs a fixture-based parser test. The same probe should be repeated on Linux.

WSL2/Linux run: pending — needs Linux node and a logged-in claude (and gh for S5) inside WSL. Command to run there: `node spikes/s1-claude-usage.mjs /tmp/s1-out p usage status` (add `pty` with `S1_NODE_PTY=<dir of node-pty>` for the interactive probe).
