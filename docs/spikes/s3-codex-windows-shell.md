# Spike S3: which shell runs Codex's commands on Windows

Status: run on Windows 11 with a Git Bash parent and a PowerShell parent. WSL2/Linux run: pending — needs Linux node and a logged-in codex inside WSL. Command to run there: `node spikes/s2-codex-isolation.mjs "${TMPDIR:-/tmp}/s3-linux" s3 s3m` (the same script as S2). What to look for in `s3m.json` there: whether the model reports a `shell` parameter, which binary `run.commands[].command` shows, and whether the hook payload (`hookLog[].tool_input_keys`) still has only `command`. Bash is usually the default shell on Linux, so `s3m` as written (it asks for bash) only shows whether the parameter exists. To probe the gap itself, change the shell named in `S3M_PROMPT` to an installed non-default one (`pwsh` if present, else `zsh` or `sh`). A run of that shell behind an unchanged payload confirms the gap on Linux.

Statements are marked **observed** (seen here) or **documented** (vendor docs, issue tracker, Codex source; not verified here).

## Question

Which shell executes the commands Codex runs on Windows (and its hook commands), what text does the pre-command hook receive, and can a setting make the shell Git Bash, so that the guard's POSIX tokenizer can read it (C18)?

## Procedure

`spikes/s2-codex-isolation.mjs` (see `s2-codex-isolation.md` for the fixture and the fence; method A, `-c` overrides, `windows.sandbox = "mxc"`), with a single trusted `PreToolUse` hook (`^Bash$`) that logs the payload and its own parent process (`Get-CimInstance Win32_Process` of `process.ppid`). Variants:

- `s3`: prompt runs `echo "probe0=[$0]"` and `$PSVersionTable.PSVersion.ToString()` as two tool calls, environment inherited from the parent.
- `s3b`: the same with `SHELL=C:/Program Files/Git/bin/bash.exe` forced into codex's environment.
- `s3m`: the model is asked to list its shell tool's parameters and to run `echo "probe0=[$0] bash=[$BASH_VERSION]"` in bash by setting a parameter of the tool (no `bash -c` wrapper).
- `s3r`: a `forbidden` execpolicy rule on `git hash-object` (separate `CODEX_HOME`), tried against five PowerShell spellings.

Runs: `s3`, `s3m`, `s3r` and `--inherit-env s3` from Git Bash (where `SHELL` is set to Git Bash's `bash.exe`), `s3 s3b s3m` from PowerShell (no `SHELL`). Environment as in S2: `codex-cli 0.163.0`, model `gpt-6.1-sol`, Windows PowerShell 5.1.26100.9711, no PowerShell 7 (`pwsh`) installed.

## Observed

### Commands

Every command the model ran with its default shell, from both parents and with `SHELL` forced to Git Bash, was executed as (JSONL `command_execution.command`):

```
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'echo "probe0=[$0]"'      -> probe0=[]
"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$PSVersionTable.PSVersion.ToString()'  -> 5.1.26100.9711
```

`$0` is empty (not a PowerShell variable), `$PSVersionTable` exists: Windows PowerShell 5.1. The rollout's environment context tells the model `<shell>powershell</shell>`. Every default-shell command of every S2 and S3 run had this form.

### Hook commands

The hook's parent process, in every run: `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "node <hook.mjs> probe <log>"`. Hook commands are PowerShell text too, and `powershell -Command` turns a hook's exit 2 into exit 1 (S2: exit 2 does not block on Windows; `; exit $LASTEXITCODE` or JSON output does).

### What the guard receives

The hook payload carries `tool_name: "Bash"` and `tool_input: {"command": "<text>"}`, where `<text>` is the model's text without the wrapper: `echo "probe0=[$0]"`, `$PSVersionTable.PSVersion.ToString()`, `& git hash-object s2.txt`, `Invoke-Expression 'git hash-object s2.txt'`. So on Windows the guard is handed PowerShell source under the name "Bash".

### Can a setting make it Git Bash?

- `SHELL` pointing to Git Bash (inherited from the Git Bash parent, or forced in `s3b`): no effect, still `powershell.exe`.
- No config key: the configuration reference and the config schema have only `windows.sandbox` and `windows.allow_mxc` under `windows`, and no shell key anywhere (documented). Codex source (`shell_detect.rs`, main branch, documented): on Windows the default user shell is always PowerShell: `pwsh` from `PATH` or `C:\Program Files\PowerShell\7\pwsh.exe`, else `powershell.exe`; `SHELL` is read on Unix only. Issue openai/codex#16717 asked for a `[windows].agent_shell = "git-bash"` key; it was closed in May 2026 without the feature (documented).
- **The model can choose a shell per call.** `s3m`: the model listed the tool parameters `cmd, justification, login, max_output_tokens, prefix_rule, sandbox_permissions, shell, tty, workdir, yield_time_ms` and set `shell: "bash"`. Codex then resolved `bash` from `PATH` and ran `"<bash>" -lc 'echo "probe0=[$0] bash=[$BASH_VERSION]"'`:
  - Git Bash parent: `C:\Program Files\Git\usr\bin\bash.exe`, exit `-1073741502` (0xC0000142, DLL initialisation failed), no output.
  - PowerShell parent: `C:\WINDOWS\system32\bash.exe` (the WSL launcher), exit 1, output "Zugriff verweigert ... Bash/E_ACCESSDENIED" (access denied).
  Both failed inside the MXC sandbox, so no working bash was reached. The hook payload was the same shape as for PowerShell (`tool_input` has only `command`): the guard cannot tell which shell will run the text. A bash started outside this sandbox mode (`elevated`, `unelevated`) was not tried.
  This is not a Windows property. `exec_command` is the same tool on every OS. In the source (documented, not verified on Linux here), `get_shell_by_model_provided_path` maps the requested shell to bash, zsh, sh, PowerShell (`pwsh`) or cmd and looks it up on the machine. So on Linux and macOS a POSIX-only guard can also be handed text that another shell (e.g. `pwsh`, where installed) will run.

### Execpolicy rules against PowerShell spellings (`s3r`)

Rule `prefix_rule(pattern=["git", "hash-object"], decision="forbidden")`:

| Command text | Result |
|---|---|
| `git hash-object s2.txt` | blocked (`rejected: <justification>`) |
| `echo s2-first; git hash-object s2.txt` | blocked |
| `& git hash-object s2.txt` | **ran** |
| `Invoke-Expression 'git hash-object s2.txt'` | **ran** |
| `cmd /c git hash-object s2.txt` | **ran** |

Codex splits simple PowerShell command lists for rule matching, but the call operator, `Invoke-Expression` and `cmd /c` pass. (Documented for bash: scripts with substitutions, variables or control flow are matched as one opaque `bash -lc` call; the PowerShell behaviour is not documented.)

### Environment variables

The `--inherit-env` run (controller `CLAUDE_*` variables kept) gave the same shell and output as the stripped run.

## Answer

Codex 0.163.0 on Windows runs its commands and its hook commands through Windows PowerShell 5.1 (`powershell.exe -Command`), regardless of the parent shell and of `SHELL`. No setting makes it Git Bash: there is no config key, `SHELL` is ignored on Windows, and the only way to another shell is the model's per-call `shell` parameter, which the hook payload does not reveal and which did not yield a working bash inside the sandbox here. The guard therefore receives PowerShell text by default, and it cannot know for certain which shell a given text is for, on Windows or elsewhere.

**C18 route: a PowerShell grammar in the guard becomes Phase 3 work; until it exists, `doctor` refuses Codex on Windows.**

## Consequence for the plan

- Phase 3 (Codex on Windows): the guard needs a PowerShell tokenizer/grammar for `autoclaude guard --runtime codex` on Windows, covering at least `;`, pipelines, the call operator `&`, `Invoke-Expression`/`iex`, script blocks, `cmd /c` and `Start-Process`, and refusing what it cannot parse (fail closed).
- The per-call `shell` parameter is a separate gap, on every OS. The payload (`tool_name: "Bash"`, `tool_input: {command}`) does not say which shell will run the text. Text can also be valid in two shells with different meanings: a backtick is an escape character in PowerShell but command substitution in bash. So checking the text against one grammar ("refuse what parses only as POSIX") does not close the gap, and neither does a check against both. Until Codex's `shell` parameter can be pinned or ruled out (nothing in the config schema does it), or the guard learns the target shell (Codex would have to put it in the payload), the guard cannot be sure which grammar applies. The design's anti-goal says "Where Codex cannot be fenced as strongly as Claude Code, the stage does not run on Codex". By that rule, this blocks Codex stages that rely on the guard on any OS, Linux and macOS included, not only the Windows pair. Phase 3 must close or re-check this before any Codex stage ships (analysis; the gap is observed on Windows, expected from the source elsewhere, and pending the Linux `s3m` run).
- Until then `doctor` refuses the pair Codex + Windows (C18), and the README says so. Because of the `shell` gap, `doctor` must also refuse guard-dependent Codex stages on the other OSes until it is closed. WSL2 (Codex inside Linux, bash and the Linux sandbox; documented) is a separate Linux run, pending here.
- Execpolicy rules are not a fence on Windows: three plain PowerShell spellings passed a `forbidden` rule. The fence on Windows is the guard plus the sandbox (writable roots, network off).
- Hook commands generated for Windows must be valid PowerShell (`node <path> <args>` with forward slashes worked; the paths had no spaces, so quoting was not tested, and PowerShell quoting differs from Git Bash, which Claude Code uses for its hooks) and must answer by JSON on stdout, or append `; exit $LASTEXITCODE` through `commandWindows`.
