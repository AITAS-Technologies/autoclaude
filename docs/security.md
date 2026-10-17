# Security

autoclaude runs a coding-agent CLI on your machine, on code and issue text you did not fully write. This page says what protects you, how, and what it does not protect against. Read the residual risk before you enrol a repository you care about.

## What the design holds

**The engine does every write to GitHub.** Labels, comments, pushes, pull request creation and updates are all made by the orchestrator, with your own `gh` login and your git credentials. A stage process (the headless `claude -p`) reads the issue text and the code, edits files in its worktree, runs the gates and commits locally. It never fetches, pulls, pushes or calls `gh`. Phase 1 never merges.

The protection against a stage reaching the forge anyway is three layers. Each is meant to hold when the others miss something.

### Layer 1: the stage environment

Every stage process, and everything it runs (gates and tests included), starts in an environment built by `src/runtimes/stage-env.ts`:

- `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH` and `GIT_SSH_COMMAND` are removed.
- `GH_CONFIG_DIR` points to an empty directory, so `gh` reports that it is not logged in.
- `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` stop credential prompts.
- git is configured through its environment (`GIT_CONFIG_PARAMETERS`, and `GIT_CONFIG_COUNT` with its `KEY_n`/`VALUE_n` pairs) with an empty `credential.helper`, `protocol.allow=never` and `protocol.file.allow=always`. The first removes credential helpers, the second refuses https and ssh to the forge, and the third keeps local clone, fetch and push working, which project test suites use.
- `CDPATH`, `BASH_ENV` and `ENV` are removed (they would redirect `cd` or source files the guard cannot see), and so are the variables that describe a parent Claude Code session.
- The runtime's own subscription login is left intact, so the stage can run.

This recipe comes from Phase 0 spike S5 ([docs/spikes/s5-stage-env.md](spikes/s5-stage-env.md)). The spike found that git before 2.31 ignores `GIT_CONFIG_COUNT`, and that the empty credential helper alone does not stop an anonymous fetch of a public repository; `protocol.allow=never` does. That is why `GIT_CONFIG_PARAMETERS`, which every git reads, is the closer, and the counted form is added for newer gits. With git older than 2.31 the environment still holds; `doctor` warns.

### Layer 2: the Claude Code permission layer

The engine generates a settings file per run and passes it with `--settings`. The stage is started with `--setting-sources ""`, so your own Claude Code settings, and any in the project, are not read. The file (`src/runtimes/claude/fence.ts`) sets:

- `defaultMode` `dontAsk`: whatever is not allowed is refused instead of asked about. There is no one to ask.
- Allowed: `Read`, `Grep`, `Glob`; `Edit` and `Write` only below the stage's own worktree; a short list of git commands (status, diff, log, add, commit, rebase, checkout and similar) and of shell commands (`ls`, `pwd`, `wc`, `echo`); `autoclaude note` and `autoclaude gates`; and the prefixes you list in `fence.allow`. The triage stage is read-only: it gets no `Edit` or `Write` and none of the git verbs that change the tree.
- Denied: `PowerShell`, `WebFetch`, `WebSearch`, `NotebookEdit`, sub-agents, the file readers `cat`, `head`, `tail`, `grep`, `rg`, `sed`, `awk` and similar, `curl`, `wget`, and a nested `claude`.
- Denied for reading and writing: `.env*`, `.git-credentials`, `.netrc`, `.npmrc` anywhere, and the usual secret locations in your home directory (`~/.ssh`, `~/.gitconfig`, `~/.aws`, `~/.config/gh`, `~/.docker`, `~/.kube`, `~/.azure`, `~/.gnupg`, `~/.config/gcloud`).
- Denied for writing: `.claude/**` in the worktree, so a stage cannot change the settings the next stage reads, and every path in `forbiddenPaths`. When a forbidden glob would also cover the report and plan files the stages must write (the default `.autoclaude/**` does), the rule is split so that `.autoclaude/state/reports` and `.autoclaude/state/plans` stay writable and the rest stays denied. `publish` checks the diff against `forbiddenPaths` again before it pushes.
- MCP servers: only those in the project's `.autoclaude/mcp.claude.json`; without that file, none.

The permission rules cannot state a path containing `( ) * ? [ ] { }` safely. autoclaude refuses to run a stage in such a path. This is deliberate: it fails closed.

### Layer 3: the command guard

Phase 0 found that in `dontAsk` mode read-only shell commands run with no allow rule. For shell commands the guard, not the allow list, is the fence. Every Bash command a stage proposes goes to `autoclaude guard` through a `PreToolUse` hook before it runs.

The guard reads the command as POSIX shell text, splits it into simple commands and judges each one, through wrappers such as `sudo`, `env`, `timeout` and `xargs`. It refuses:

- `gh` entirely, and `git fetch`, `pull`, `push` and `remote`;
- an environment assignment in front of a command, a nested shell (`bash -c`, `eval`), and `find -exec`, `-delete` and `-fprint`;
- `node` and `npx tsx`, unless the command starts with a prefix in `fence.allow`, and every `autoclaude` verb except `note` and `gates`;
- for git: global options, subcommands and `-c` keys outside an allowlist, config writes, `rebase --exec`, `reset --hard`, forced branch resets, pathspecs outside the worktree or inside a forbidden path, and reads that would print a secret;
- a program name that the shell would decide (an expansion, substitution or glob in the command word);
- a redirection that writes outside the worktree or into a forbidden path, and a `cd` that leaves the worktree.

The hook fails closed. The hook line ends in `|| exit 2`, because a hook blocks only on exit code 2 and a Node process that cannot start exits 1 or 127. The guard has a 20 second watchdog that turns "no answer" into a refusal, and the hook has a 30 second timeout above it. An exception, unparsable input or a broken configuration is a refusal. The entry point calls the guard unconditionally, so no spelling of a path can skip it.

## The residual risk

The three layers do not isolate the stage from your machine.

A stage runs as your operating system user. The gates it runs, and the tests above all, execute code that a model wrote. That code is an ordinary program with your privileges. It can read the operating system's credential store (Windows Credential Manager, macOS Keychain, libsecret), and it can read your normal `gh` and git configuration. Neither the stage environment nor the guard sees what happens inside a test process, and the permission layer governs only the tools Claude Code itself uses.

Closing that gap would need a separate operating system user, a container, or a network block towards github.com. None of these is practical on native Windows while the runtime CLI has to use your own subscription login. autoclaude does not claim to be a sandbox.

What remains between a mistake and your repository:

- **Review.** Every diff is read by a fresh context, from several angles, before anything is pushed, and the pull request is for you to read before it is merged. Phase 1 never merges.
- **The guard and the permission layer**, which raise the cost of an honest mistake and of a model that follows instructions planted in an issue.
- **Author trust.** Phase 1 does not yet check who opened an issue or wrote a comment; issue text and comments reach the stage as they are. Point autoclaude only at repositories where everyone who can open issues is someone you trust. The design for author trust (only issues from users with write access are worked on) is planned for Phase 2.

Practical advice: log `gh` in with a token that cannot delete repositories (`doctor` warns when it can), do not run autoclaude on a machine with credentials you cannot afford to lose, and read each pull request, including its test files, before you merge.

## Known limitations of the guard

The guard reads text; it does not run or sandbox anything. These are the places where it deliberately does not look, and each is covered by the other two layers:

- It does not reach interpreters. A command such as `python -c "..."` or `perl -e "..."`, and some package-runner forms, run code the guard cannot read. The stage environment still has no forge credential for that code to use, and the permission layer still limits the Claude Code tools, but code that runs as your user is within the residual risk above.
- It does not model environment changes that alter how later commands resolve, such as `PATH=...;` or `export GIT_DIR=...` as a separate command. The stage environment starts without the variables the guard cannot model, and layers 1 and 2 are unchanged by such a command.
- It does not inspect the bodies of here-documents.
- It leaves `tee`, `cp` and `rm` to the permission layer. What those commands can write is therefore bounded by Claude Code's permission rules and by your operating system's file permissions, not by the guard.

None of these is a way around layer 1: a stage process has no forge credential in its environment however it is started. They matter for what the model can do on your machine, which is the residual risk described above.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or contact the maintainers by the address on their GitHub profile. Do not post exploit details in a public issue.
