# Spike S5: a stage environment without forge credentials

Script: `spikes/s5-stage-env.mjs`. Run on Windows 11 from a Git Bash parent and from a PowerShell parent; the two runs gave identical exit codes. Tools: git 2.29.0.windows.1, gh 2.96.0, node v24.14.0.

## Question

Can a stage process (a headless `claude -p` child) be started in an environment where it cannot push, fetch or call the GitHub API, while the `claude` subscription login still works? Which variables make that so, and what is the minimum tool version each needs?

## Procedure

Five environments, each running the same commands (the first three were the original run; `credonly` and `closedfile` were added in fix round 1):

- `base`: this process's environment. It has a working `gh` login (token in the OS keyring) and git credentials through the system `credential.helper=manager-core` plus a global `gh auth git-credential` helper for `github.com`. It is the positive control.
- `stage`: base minus `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`, plus `GH_CONFIG_DIR=<new empty temp dir>`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and the task's `GIT_CONFIG_COUNT=2` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` pair (empty `credential.helper`, `protocol.allow=never`).
- `credonly`: `stage` plus `GIT_CONFIG_PARAMETERS='credential.helper='` only (isolates what the empty helper closes).
- `closed`: `stage` plus `GIT_CONFIG_PARAMETERS='credential.helper=' 'protocol.allow=never'`.
- `closedfile`: `closed` plus `'protocol.file.allow=always'` (restores local file transports).

The controller's `CLAUDECODE` and `CLAUDE_*` variables are stripped in all three (except `CLAUDE_CODE_GIT_BASH_PATH`).

Commands: `gh auth status`; `gh api user`; `git ls-remote <private-repo>` over https and over ssh (the private repository comes from `S5_PRIVATE_REPO` and is redacted as `<private-repo>`); `git -C <clone> push --dry-run origin HEAD:refs/heads/spike-s5`; `git -C <clone> fetch`; four local, no-network transport probes against a temp bare repo (`git clone <local path>`, `git clone file://<bare>`, `git fetch` and `git push` to a local bare remote; the push is real but only into a temp dir); `git commit` in a worktree; `claude -p "say ok" --output-format json --max-turns 1`. The clone is a fresh clone of the project's own (public) repository. Every push is `--dry-run`; no ref was created anywhere. Fixtures live in a temp dir that the script removes.

## Observed output

Exit codes (identical from both parents). "leak" marks a forge call that succeeded where it had to fail.

| Command | base | stage (task recipe) | closed |
|---|---|---|---|
| `gh auth status` | 0 (`Logged in to github.com account <user> (keyring)`) | 1 (`You are not logged into any GitHub hosts`) | 1 |
| `gh api user` | 0 | 4 (`To get started with GitHub CLI, please run: gh auth login`) | 4 |
| `git ls-remote <private-repo>` https | 0 (HEAD sha printed) | **0, leak** (HEAD sha printed) | 128 `fatal: transport 'https' not allowed` |
| `git ls-remote <private-repo>` ssh | 128 `Host key verification failed.` | 128 (same) | 128 `fatal: transport 'ssh' not allowed` |
| `git push --dry-run origin HEAD:refs/heads/spike-s5` | 0 (`* [new branch] HEAD -> spike-s5`) | **0, leak** (same line) | 128 `fatal: transport 'https' not allowed` |
| `git fetch` (public clone) | 0 | 0, **not a credential leak**: the repo is public, so it succeeds anonymously; see below | 128 `fatal: transport 'https' not allowed` |
| `git commit` in a worktree | 0 | 0 | 0 |

Fix round 1 (isolation of the closers and local transports; both full runs from a Git Bash parent, exit codes):

| Command | stage | credonly | closed | closedfile |
|---|---|---|---|---|
| `git ls-remote <private-repo>` https | 0 | 128 | 128 | 128 |
| `git push --dry-run` to the forge | 0 | 128 | 128 | 128 |
| `git fetch` (public clone) | 0 | **0** | 128 | 128 |
| `git clone <local path>` | 0 | 0 | 128 `transport 'file' not allowed` | 0 |
| `git clone file://<bare>` | 0 | 0 | 128 `transport 'file' not allowed` | 0 |
| `git fetch` (local bare remote) | 0 | 0 | 128 `transport 'file' not allowed` | 0 |
| `git push` (local bare remote) | 0 | 0 | 128 `transport 'file' not allowed` | 0 |
| `git commit` in a worktree, `claude -p`, `gh *` | 0, 0, closed | same | same | same |
| `claude -p "say ok" --output-format json` | 0, `is_error` false, result `ok` | 0, same | 0, same |

### The leak and its mechanism

With the task recipe alone, git still authenticates over https. Cause: git 2.29 does not know `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` (added in git 2.31), so the "empty `credential.helper`" and `protocol.allow=never` never took effect, and git kept using the configured helpers: the system `manager-core` and the global `credential.https://github.com.helper = !gh auth git-credential`. The `gh` helper alone is sufficient: `GIT_CONFIG_NOSYSTEM=1` by itself did not close the leak (ls-remote exit 0). The `gh` helper still finds the token although `GH_CONFIG_DIR` points to an empty dir, because the token is in the OS keyring, not in the config directory. (The `gh` CLI itself is closed by the empty `GH_CONFIG_DIR`: it reports no host.)

### The fetch row is not a credential leak

The fetch probe targets the project's own public repository, which git reads anonymously. With the empty helper alone (`credonly`) fetch still exits 0 while every authenticated call (private ls-remote, push --dry-run) is closed. So the empty `credential.helper` stops credentialed access only; fetch of a public repo is stopped solely by `protocol.allow=never`. The rule "a stage never fetches" therefore depends on `protocol.allow=never` (or the engine never giving the stage a remote it may fetch from); E1 must not assume the empty helper blocks fetch.

### Verified closers (manual runs on `git ls-remote <private-repo>`, then the full `closed` run above)

| Settings applied on top of `stage` | `git ls-remote` https |
|---|---|
| `GIT_CONFIG_PARAMETERS='credential.helper='` | 128 `could not read Username ... terminal prompts disabled` |
| `GIT_CONFIG_PARAMETERS='credential.helper=' 'protocol.allow=never'` | 128 `transport 'https' not allowed` |
| `GIT_CONFIG_NOSYSTEM=1` only | 0, still leaks (global `gh` helper) |
| `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_PARAMETERS='credential.helper='` | 128 |
| the task's `GIT_CONFIG_COUNT` form only (git 2.29) | 0, still leaks |

An empty `credential.helper` set at command scope resets the helper list built from all earlier scopes, including the URL-specific `github.com` entry. `GIT_CONFIG_PARAMETERS` is what `git -c` uses and has been supported since git 1.7.x; it accepts shell-quoted `'key=value'` entries separated by spaces.

### ssh

There is no positive control for ssh. In the base environment `git ls-remote` over ssh fails with `Host key verification failed`. Retrying with `StrictHostKeyChecking=accept-new` and a temp `known_hosts` fails with `Permission denied (publickey)`: this machine's key is not registered with the forge account and no ssh agent runs. So ssh access was never demonstrated to work, and "the stage env cannot use ssh" is proved only as far as `protocol.allow=never` makes git refuse the ssh transport (`transport 'ssh' not allowed`, verified). An on-disk key in `~/.ssh` is not neutralised by removing `SSH_AUTH_SOCK`; `protocol.allow=never` is what closes it for git (a raw `ssh` or `gh` would not be covered; `gh` has no credential in the stage env).

### Not tested

Whether `manager-core` alone (without the `gh` helper) would authenticate in the stage env was not isolated; the empty `credential.helper` removes it either way. The `GIT_CONFIG_COUNT` pair was not run on git >= 2.31 (no such git here); its behaviour there is documented, not observed.

## Answer

The task's recipe is sufficient for `gh` and for the `claude` login, and necessary but not sufficient for git on git < 2.31. Adding `GIT_CONFIG_PARAMETERS` closes every forge call that leaked (push, fetch, ls-remote over https and ssh); `git commit` in a worktree and `claude -p` keep working.

## Consequence for the plan (Task E1)

Final stage-environment recipe (verified on git 2.29.0, gh 2.96.0, Windows, from both Git Bash and PowerShell parents):

- Delete: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`. Also delete `CLAUDECODE` and `CLAUDE_*` (keep `CLAUDE_CODE_GIT_BASH_PATH`), per the Part A ruling.
- `GH_CONFIG_DIR=<new empty dir>`: closes `gh` even when its token is in the keyring (any gh with this config-dir variable; verified on 2.96.0).
- `GIT_TERMINAL_PROMPT=0` (any git), `GCM_INTERACTIVE=never` (Git Credential Manager).
- `GIT_CONFIG_PARAMETERS='credential.helper=' 'protocol.allow=never'` (the literal value, single quotes included): works on every git; this is the variable that actually closes git on git < 2.31 and is what E1 must set.
- `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=credential.helper`, `GIT_CONFIG_VALUE_0=` (empty), `GIT_CONFIG_KEY_1=protocol.allow`, `GIT_CONFIG_VALUE_1=never`: needs git >= 2.31; harmless and redundant next to `GIT_CONFIG_PARAMETERS`. E1 may set both.
- Side effect (observed, `closed` run): `protocol.allow=never` also forbids the `file` transport, so in the stage `git clone <local path>`, `git clone file://<bare>`, and fetch or push to a local bare remote all fail with `transport 'file' not allowed`. Local commands (add, commit, worktree, diff, log) are unaffected. Submodules were not probed.
- Recommendation for E1: use `GIT_CONFIG_PARAMETERS='credential.helper=' 'protocol.allow=never' 'protocol.file.allow=always'` (the `closedfile` environment). It keeps https and ssh to the forge closed (verified: ls-remote, push --dry-run, fetch all 128) and restores local clone, fetch and push, which project test suites commonly use. A stage can still reach any local path; that grants no forge access. Use the plain `closed` form only if local transports must also be denied.
- The engine's own fetch and push (and all gh calls) must run in a different, non-stage environment (the base environment with the credentials); the stage environment is for the `claude` child and the commands it runs only.

WSL2/Linux run: pending. It needs Linux node and a logged-in claude (and gh for S5) inside WSL. Command to run there: `S5_PRIVATE_REPO=<https-url-of-a-private-repo> node spikes/s5-stage-env.mjs ./s5-out` (optionally `S5_PRIVATE_REPO_SSH=<ssh-url>`).
