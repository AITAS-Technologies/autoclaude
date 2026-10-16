# autoclaude

autoclaude is a command-line tool that turns GitHub issues into reviewed pull requests. It runs a deterministic pipeline of plan, implement, gate and review stages, each executed by a coding-agent CLI inside an isolated git worktree, while the engine itself does every write to the forge. autoclaude is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.

## Install

Requires Node 22 or newer, git and the GitHub CLI (`gh`).

```sh
git clone https://github.com/AITAS-Technologies/autoclaude.git
cd autoclaude
npm ci
npm run build
npm link
```

## First project

These verbs arrive with Phase 1; until then the CLI only answers `--version` and `--help`.

```sh
autoclaude init     # set up the project: writes .autoclaude/ configuration
autoclaude doctor   # check the tools, logins, gates and configuration
autoclaude run      # run the orchestrator in the foreground
```

## License

MIT
