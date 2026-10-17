# S1: Claude usage without a UI

Run on 2026-10-16, Windows 11, Node 24.14.0, claude 2.1.289 (a subscription login), PowerShell/Git Bash parent. Scripts: `spikes/s1-claude-usage.mjs`, `spikes/s1-dump-statusline.mjs`.

## Question

Before dispatching a stage, autoclaude must read the account's five-hour and weekly usage percentage and reset times. For Claude Code the only known source is the status-line payload (`rate_limits.five_hour` / `rate_limits.seven_day`). Is it produced under headless `claude -p`? If not, what is the cheapest way to read it without a UI?

## Procedure

The child environment drops `CLAUDECODE` and every `CLAUDE_*` variable except `CLAUDE_CODE_GIT_BASH_PATH` (as in S4); the real `claude.exe` is spawned, not the `.cmd` shim. A settings file passed with `--settings` (the settings file touches nothing in `~/.claude`, but see "Side effects") holds `statusLine: { "type": "command", "command": "node \"<abs>/spikes/s1-dump-statusline.mjs\" \"<temp>/statusline.jsonl\"" }`. The dump script appends each stdin payload as one JSON line and prints `s1` to stdout.

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

   `resets_at` is Unix epoch seconds (1792167000 = 2026-10-16T16:10:00Z; 1792382400 = 2026-10-19T04:00:00Z). `used_percentage` is an integer. See "Paired reading" below for how the two sources compare. No per-model weekly window is in the status-line payload. The CLI also auto-updated itself during the interactive run; see "CLI version and auto-update".

## Side effects on the developer's Claude state (checked read-only on 2026-10-16, claude 2.1.301)

- **Trust entry.** Accepting the folder-trust prompt in the interactive run wrote an entry for the temp directory into `~/.claude.json` (`projects.<temp dir>.hasTrustDialogAccepted = true`; only that field was read). It is still there after the temp directory was deleted. The `-p` runs wrote **no** trust entry (the only entry matching the spike's temp names is the interactive one). So the claim that nothing in `~/.claude` changed was wrong for the interactive route: it leaves one trusted-folder entry per throwaway directory.
- **Transcripts.** Each `claude -p` run, including `-p "/usage"` (0 turns), wrote a session transcript `.jsonl` and an empty `memory` directory under `~/.claude/projects/<cwd-derived name>/`. Observed: the three first spike runs left three transcripts (about 14 KB, 17 KB and 194 KB) in one project directory; the interactive run left one 278 KB transcript. The test runs for this section left further directories named `...Temp-s1fix*`; they were not removed because the spike must not modify anything under `~/.claude`.
- **`--no-session-persistence`** exists (`claude --help`: "Disable session persistence"). Observed with a fresh working directory each: `-p "/usage"` without it left `<id>.jsonl` + `memory`; with it only an empty `memory` directory and no transcript. A `-p "say ok"` run with the flag also left only `memory`.
- **Consequence for Phase 2.** Polling `/usage` every few minutes would add one transcript per call (and one project directory per distinct cwd). Spawn the reading with `--no-session-persistence` and one fixed neutral working directory (for example a directory under autoclaude's own state directory), so at most one empty `memory` directory exists and no trust entry is needed (`-p` did not prompt for trust and wrote none). The pseudo-terminal route is the only one that touches `~/.claude.json`, a further reason not to use it.

## CLI version and auto-update

- Versions per observation: the three `-p` runs and the first interactive run (payload `version`) were on **2.1.289**; the CLI then updated itself (the interactive screen showed "Auto-updating..." and "Update installed - Restart to apply"), and every later check, including all runs in the sections below, is on **2.1.301**. The `/usage` text quoted above was captured on 2.1.289.
- `claude -p "/usage" --output-format json` was re-run on 2.1.301 (several times, 0 turns, cost 0, exit 0): the text format is **unchanged** (same header line, same `Current session` / `Current week (all models)` / `Current week (Fable)` lines). The status-line payload on 2.1.301 has the same `rate_limits` shape and `version: 2.1.301`.
- The self-update was triggered in the **interactive** session (a spawned process changed the developer's installation); it was not seen in the `-p` runs. Documented, not observed: the auto-updater can be disabled for a spawned process with the environment variable `DISABLE_AUTOUPDATER=1`. Recommendation: the stage environment sets `DISABLE_AUTOUPDATER=1` for every spawned claude, and the parser fixture records the CLI version it was captured on (here 2.1.289, re-verified on 2.1.301) so a format change is attributable.

## Paired reading (percentages and reset times)

One short sequence on 2.1.301 with no other claude activity: `-p /usage` at 13:46:19Z, an interactive status-line reading, `-p /usage` again at 13:48:11Z.

| Source | five-hour used | five-hour reset | week used | week reset |
|---|---|---|---|---|
| `/usage` before | 16 % | 6:09pm | 7 % | 5:59am |
| status line (two entries) | 15 | 1792167000 = 18:10:00 local | 7 | 1792382400 = 06:00:00 local |
| `/usage` after | 16 % | 6:10pm | 7 % | 6am |

Observed: `/usage` is one point above the status line on both sides of the status-line reading, so the earlier "15 vs 14" difference is a systematic offset between the sources, not run order or caching (no falling percentage within a window was seen). The cause is not determined; the likely hypothesis is that `/usage` rounds up (or the status line floors) a fractional value, and nothing observed distinguishes the two. The reset time in `/usage` varies by one minute between consecutive runs for the same window (6:09pm then 6:10pm; 5:59am then 6am), while the status-line `resets_at` was identical in every entry (exactly 18:10:00 and 06:00:00). The earlier "rounded to the minute" explanation was a guess; what is observed is that `/usage` can show a time one minute earlier than the instant, consistent with truncating a slightly jittered value. Consequence: treat `/usage` percentages as accurate to about +1 point and reset times to +/- 1 minute. Phase 2 must not rely on single-point or minute precision: use a margin of at least 2 points on any pause threshold and round a reset up to the next minute before scheduling a resume.

## Answer

- The status-line payload is **not** produced under `claude -p`. It is produced by an interactive session, but only after the first response, so the pseudo-terminal route needs a model call (a real, if tiny, subscription turn) and a trust-prompt dialogue and `node-pty` (a native dependency).
- The usage windows **are** readable headless, at no model cost, with `claude -p "/usage" --output-format json`: the `result` text carries percentage and reset time for the session (five-hour) window and the weekly window.

## Recommendation for Phase 2

Read usage with **`claude -p "/usage" --output-format json --no-session-persistence`**, spawned without a shell (Windows: the real `claude.exe`) from a fixed neutral working directory, with the stage-style environment plus `DISABLE_AUTOUPDATER=1`, and parse `result` with a tolerant matcher. Parser rules (observed unless labelled):

- Lines are `Current session: <n>% used · resets <date time> (<IANA zone>)` and `Current week (all models): <n>% used · resets ...`; other `Current week (<model>)` lines are optional and ignored. Observed.
- The time part is `<Mon> <d>, <h>[:<mm>]<am|pm>`; minutes are **optional** (`6am` and `5:59am` both occur). Observed.
- There is no year. Resolve in the stated IANA zone and choose the nearest occurrence at or after now. DST edges were **not observed**; for a nonexistent or ambiguous local time take the later instant. A reset that is off by an hour is harmless because it is only a resume hint and the usage is re-read before resuming.
- **Window not started** (not observed): after an idle period the session window may show `0% used` with no reset time, or have no `Current session` line. That is a normal state, not a failure: treat a missing or reset-less session line as 0 % used and "no active window", and never block a dispatch on it. Treat the whole reading as unreadable (C17) only when the command fails, times out, or no `Current ...` line parses at all.
- Locale and language (not observed; this machine runs English): the text is human-oriented and may be localized. A reading whose lines do not match the English patterns is "unreadable" (C17 for that reading), never a guessed value. A missing weekly line alone (for example a plan without a weekly limit) means "no weekly cap known", not a pause.
- Margins: percentages run about +1 point high against the status line and reset times can be one minute early (see Paired reading): apply a 2-point margin and round resets up.
- Keep the text format behind one parser module with a fixture that records the CLI version (captured on 2.1.289, unchanged on 2.1.301). Do not use a pseudo-terminal: it costs a model turn per reading, needs a native dependency, can trigger an auto-update and writes a trust entry to `~/.claude.json`.

Not verified: the output on an API-key (non-subscription) login or a plan without weekly limits (the line may be absent, which the tolerant parser maps to "unreadable"), and whether `/usage` counts as a request against any rate limit (it made no model call).

## Consequence for the plan

C17 does not apply on this machine for Claude: usage is readable. S1's status-line route is dropped for the `-p` path; the `/usage` route is the reading method and needs a fixture-based parser test. The same probe should be repeated on Linux.

WSL2/Linux run: pending — needs Linux node and a logged-in claude (and gh for S5) inside WSL. Command to run there: `node spikes/s1-claude-usage.mjs /tmp/s1-out p usage status` (add `pty` with `S1_NODE_PTY=<dir of node-pty>` for the interactive probe).
