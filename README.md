# autoclaude

autoclaude turns GitHub issues into reviewed pull requests. A deterministic engine runs a pipeline of plan, plan review, implement, quality gates and code review. Each model stage is a headless coding-agent CLI running in its own git worktree. The engine does every write to GitHub: labels, comments, pushes and pull requests. Stage processes get no forge credentials.

autoclaude is an independent project. It is not affiliated with or endorsed by Anthropic or OpenAI.

Phase 1 (this version) drives Claude Code. It opens pull requests and never merges them. Codex is not supported yet.

Read [docs/security.md](docs/security.md) before you point it at a repository you care about. It states what the protections cover and what they do not.

## Prerequisites

- Node 22 or newer.
- git. Version 2.31 or newer is recommended; older versions work (`doctor` warns, and the stage environment still blocks forge access).
- The GitHub CLI (`gh`), logged in (`gh auth login`) with access to the repository. Use a token without the `delete_repo` scope.
- git able to fetch and push the repository without a prompt. The engine turns credential prompts off and gives each of its git calls 600 seconds and each `gh` call 120 seconds, so a missing login fails the step instead of waiting for you. With Git Credential Manager, sign in once by hand.
- Claude Code (`claude`), logged in with a subscription.
- On Windows, Git for Windows. Project commands run through its `bash`.

Stages bill your Claude subscription. If `ANTHROPIC_API_KEY` is set in your environment, stages would bill the API instead. Remove it; `autoclaude doctor` warns when it is set.

The project path must not contain any of `( ) * ? [ ] { }`, and neither may `worktrees.root`. The permission rules for a stage cannot state such a path safely, so autoclaude refuses it instead of guessing, and `autoclaude doctor` fails on it.

## Install

```sh
git clone https://github.com/AITAS-Technologies/autoclaude.git
cd autoclaude
npm ci
npm run build
npm link
```

`npm link` puts the `autoclaude` command on your PATH. Check with `autoclaude --version`.

## First project

Run these in the main checkout of the project you want to enrol. It needs a git remote on GitHub and the integration branch pushed to it.

```sh
autoclaude init --create-labels
```

`init` writes `.autoclaude/config.json`, `.autoclaude/project.md` and `.autoclaude/invariants.md` from templates (it never overwrites an existing file) and adds three lines to `.gitignore`: `.autoclaude/state/`, `.autoclaude/worktrees/` and `.autoclaude/config.local.json`. With `--create-labels` it creates the labels your configuration names that the repository lacks.

The worktrees go under `.autoclaude/worktrees/` by default, inside the checkout, where your own test runner, `tsc` or ESLint may pick them up. Exclude that directory in their configuration, or set `worktrees.root` to a directory outside the checkout ([docs/config.md](docs/config.md)).

Then edit `.autoclaude/`:

- `config.json`: the branches, quality gates, test-file patterns, labels, forbidden paths, caps and the model for each stage. Every key is described in [docs/config.md](docs/config.md). Commit this file.
- `project.md`: facts the stages should know about the project (schema changes, test doubles, high-stakes areas, commit conventions).
- `invariants.md`: the project's own code-review rules, as a table.
- `config.local.json` (optional, never committed): your personal overrides of `budget`, `schedule`, `humans` and the model of each stage.

Also give the project a `CLAUDE.md`. Stages read it as the project's instructions; `doctor` warns when neither `CLAUDE.md` nor `AGENTS.md` exists. Each stage is told to read the file first, because Claude Code does not load it by itself under the stage's settings; `@` imports and nested `CLAUDE.md` files in subdirectories are not loaded automatically, so keep what the stages need in the root file.

Check the setup:

```sh
autoclaude doctor
```

`doctor` checks the configuration, the project and worktree paths, the git remote and integration branch, the `gh` login, the labels, the `claude` version, git, Git Bash on Windows and the `.gitignore` lines. It exits 1 when a check fails and prints a fix for each.

Run one issue, attended, from claim to pull request:

```sh
autoclaude issue 42
```

`--replace` replaces a leftover worktree and branch of an earlier attempt at the same issue. Add the `agent-ready` label (the name is `queue.ready`) to an issue and the orchestrator will pick it up when it runs:

```sh
autoclaude run              # the orchestrator in the foreground; --once does a single tick
autoclaude service install  # start it at logon (Windows task, macOS launchd, Linux systemd user unit)
```

On Linux, run `loginctl enable-linger $USER` once to keep the user unit running while you are logged out. `autoclaude service status` and `autoclaude service uninstall` complete the set. There is one service per project.

## Everyday commands

| Command                                                         | What it does                                        |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `autoclaude status`                                             | The ledger and the gates of every open pull request |
| `autoclaude watch`                                              | Follow a run in the terminal                        |
| `autoclaude pause`, `drain`, `resume`                           | Stop taking work, finish what runs, or continue     |
| `autoclaude triage [--issue <n>]`                               | Triage now                                          |
| `autoclaude review --pr <n>`                                    | The code review on an open pull request             |
| `autoclaude can-merge <pr>`                                     | The merge verdict for a pull request                |
| `autoclaude rollback <issue> [--to <target> --reason "<text>"]` | Release a run and clear its worktree and branches   |
| `autoclaude gates [--fix] [--only a,b]`                         | Run the project's quality gates                     |
| `autoclaude situation`                                          | What the next tick sees, as JSON                    |

`rollback` takes `--to` (one of `blocked`, `needs-shaping`, `ready`, `done`, `none`) and `--reason` together to release the claim; `--keep-branch-as <name>` keeps the branch under another name. `autoclaude --help` lists every verb. Some of them (`claim`, `publish`, `ledger`, ...) are the engine's own steps, exposed for stages and for debugging.

## Update

```sh
git pull
npm ci
npm run build
```

The service runs the built files in your checkout, so it uses the new build the next time it starts (at the next logon, or when you restart it). A running service keeps the old code until it is restarted. The node binary and the checkout path are baked into the service definition, so if either changes, run `autoclaude service install` again.

## Uninstall

In each enrolled project, run `autoclaude service uninstall`, then remove `.autoclaude/` and its three `.gitignore` lines if you no longer want them. Then, in the autoclaude checkout:

```sh
npm unlink -g autoclaude
```

and delete the checkout.

## Documentation

- [docs/config.md](docs/config.md): every configuration key.
- [docs/security.md](docs/security.md): the protections, their limits and the residual risk.
- [docs/specs/2026-10-16-autoclaude-design.md](docs/specs/2026-10-16-autoclaude-design.md): the design.
- [docs/spikes/](docs/spikes/): what was measured against the real tools before building.

## License

MIT
