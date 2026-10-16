# autoclaude — design

Date: 2026-10-16
Status: draft for owner review
Repository: `AITAS-Technologies/autoclaude` (public, MIT)
Origin: extracted from the `autodev` pipeline that was built and run inside the Coveniq
application repository (private). The extraction itself and that repository's cut-over
are planned there, not here.

## 1. Intent

A developer writes GitHub issues and nothing else. autoclaude, running on that
developer's own machine, triages the issues once a day, works the agent-ready ones in
priority order through plan, plan review, implementation and code review into pull
requests, merges the categories the project allows into the integration branch, and
speaks up only when a human decision is really needed.

It does this on the developer's existing subscriptions — Claude (Claude Code) and/or
ChatGPT (Codex CLI) — and uses up to a share of the rolling usage windows that each
project configures, so the subscriptions are used as fully as the developer wants and no
further.

It is public so that any developer can clone it once and point it at their own
repositories, in any language, on Windows, macOS or Linux.

### Why now

The source pipeline works: it has run attended and unattended, its code review reached
7 of 11 findings on an independent benchmark where its first version reached none, and its
fence has survived several adversarial reviews. But it is welded into one product
repository:

- The engine lives inside that repository and runs on its `node_modules` through `tsx`.
- The orchestrator is itself a Claude Code session that paces itself with `/loop` and
  dispatches stages through Claude Code's `Agent` tool, so it exists only for Claude Code.
- The launcher is a PowerShell script with Task Scheduler; there is no unattended loop on
  macOS or Linux.
- Stack facts of that one product (its test runner, formatter, database migrations, build
  tooling) are hardcoded in engine scripts.
- The agent sessions hold the developer's full GitHub login.

Finishing the framework inside that repository would deepen every one of these, so it is
extracted first and finished here.

## 2. Goals, non-goals, anti-goals

### Goals

1. **One installation per machine.** `git clone`, install, and an `autoclaude` command on
   the PATH. A project carries only its configuration directory, `.autoclaude/`.
2. **Any project language.** Every project-specific action — bootstrap, gates, test
   runner, formatter, linters — is a command from the project's configuration. Nothing
   assumes Node, npm or a particular test runner in the project.
3. **Two agent runtimes.** Claude Code (`claude -p`) and OpenAI Codex CLI (`codex exec`),
   selectable per stage, with an optional per-stage fallback to the other runtime when
   the developer has both subscriptions.
4. **Three operating systems.** The orchestrator, every stage, the autostart service and
   the test suite run on Windows, macOS and Linux.
5. **A usage budget per project.** Each project sets two thresholds per runtime — a
   percentage of the five-hour window and a percentage of the weekly window. The usage is
   the account's, shared by every project on the machine; each project's orchestrator stops
   starting work when the shared usage reaches _its own_ threshold and resumes after the
   window resets. Projects at 50 % stop before a project at 70 %.
6. **A daily rhythm.** Once a day, at a configured time, autoclaude triages the issues
   that have no agent label yet (§ 5, C15) and the `needs-shaping` issues a human has
   answered since. Then it works the queue by priority, then age, for as long as the
   budget allows.
7. **Speak only when needed.** When a human decision is required, autoclaude labels the
   issue or pull request and posts one comment that mentions the configured humans with
   `@`. That comment is the notification; autoclaude sends nothing else — no e-mail, no
   other channel (D9). `autoclaude status` lists everything that waits for a human.
8. **Auto-merge into the integration branch, by policy.** A pull request is merged by
   autoclaude when its merge verdict is green and its issue carries either the
   `automerge-dev` label, which only a human may set, or one of the configured category
   labels (default: `bug`, `documentation`). The production branch is never merged
   automatically.
9. **The developer's own GitHub login.** The engine acts on GitHub through the developer's
   existing `gh` login. No second account is required (D11).
10. **The source repository becomes the first consumer.** Its in-repository copy of the
    pipeline is removed once autoclaude reaches parity.

### Non-goals

- Forges other than GitHub. All forge access sits behind one module so a later port is
  possible, but none is built.
- A shared scheduler across projects. One orchestrator per project; projects do not
  coordinate beyond reading the same usage figures.
- A hosted service or CI runner. autoclaude runs on the developer's machine, on the
  developer's subscription logins. API-key billing is not designed for.
- Merging into the production branch, ever.
- Notification channels beyond the GitHub comment (no e-mail, chat or push).
- A machine account. Forge calls go through one module that takes its credential from the
  environment, so a token for a separate account could be supplied later without a
  redesign; nothing else is built for it.
- Several machines working one project at the same time. The existing claim protocol stays
  as a safety net, not as a feature to build on.
- Changing what a project's CI does. A project's own workflows (for example Actions-side
  reviewers) stay the project's business; autoclaude only reads their check results.

### Anti-goals — failure even if everything technically works

- **A model holding write power over the forge.** Pushing, labelling, commenting,
  opening and merging pull requests are done by deterministic engine code. A stage process
  has no credential in its environment that could do any of it (§ 7.4, with its residual
  risk).
- **A silent stop.** Exhausted budget, a dead stage, a gate run that never started, a
  refused command: each is visible in `autoclaude status` and in the events log, and where
  a human must act, as a labelled comment.
- **Noise.** At most one comment per issue per reason per state change. Progress, pauses
  for budget and successful auto-merges produce no mention.
- **A weaker fence to make the second runtime work.** Where Codex cannot be fenced as
  strongly as Claude Code, the stage does not run on Codex (§ 7.5).
- **Content of any consumer project in this repository**: no code, rules, benchmark
  fixtures, run logs or history from the source repository or any other.
- **Redesigning what is proven.** The report formats, the rule catalogue grammar, the class
  policy, the review decision, the merge checks and the label-counter semantics are ported,
  not reinvented. Behaviour changes are listed in § 10 and nowhere else.

## 3. Constraints

- **Public repository**, MIT licence, English throughout. Owner: the personal account
  `AITAS-Technologies`.
- **Name.** "autoclaude" is the owner's choice. "Claude" is an Anthropic trademark; the
  owner was told and kept the name. Nothing in the repository may suggest Anthropic
  endorsement.
- **Machine prerequisites:** Node (current LTS), git, `gh`, and at least one of the two
  agent CLIs, logged in with a subscription. Nothing else.
- **No server-side protection is assumed.** Target repositories may be private
  repositories on plans without branch protection, so every guarantee is enforced on the
  client by autoclaude.
- **Subscription terms.** Both vendors support headless use of their CLIs with a
  subscription login on the developer's own machine; the Codex docs warn against using that
  login in public CI. autoclaude never runs in CI with a subscription login.
- **Stable contracts.** The four report block formats, the rule catalogue table grammar,
  the class policy and the label counters keep the meaning they have in the source
  pipeline, so its benchmark and archived runs stay comparable.

## 4. Decisions taken by the owner

| #   | Decision                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Name `autoclaude`; its own public repository, so developers can download it and use it on their own repositories                                                             |
| D2  | Target projects may be in any language                                                                                                                                       |
| D3  | Forge: GitHub only                                                                                                                                                           |
| D4  | Runtimes: Claude Code and Codex                                                                                                                                              |
| D5  | Orchestrator and stages run on Windows, macOS and Linux                                                                                                                      |
| D6  | Daily triage, then priority-ordered work; report only when human input is needed                                                                                             |
| D7  | Budget: per project, a five-hour threshold **and** a weekly threshold, against the shared account usage; one orchestrator per project                                        |
| D8  | Fallback to the other subscription is configurable per project when the developer has both                                                                                   |
| D9  | Notification is the `@` mention in a comment on the issue or pull request; no e-mail                                                                                         |
| D10 | Auto-merge into the integration branch: allowed by the `automerge-dev` issue label, which only a human may set; `bug` and `documentation` by default; all of it configurable |
| D11 | No machine account: autoclaude uses the developer's own GitHub login                                                                                                         |

## 5. Calls made by the designer (owner may overturn)

| #   | Call                                                                                                                                                                                                                                                                                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The orchestrator becomes a **deterministic Node process**; every stage is a **separate headless CLI process** (`claude -p` / `codex exec`) with the worktree as its working directory                                                                                                                                            | runtime- and OS-neutral; restores per-stage cost, turn caps and exit codes, which the source pipeline gave up by dispatching through the `Agent` tool; removes a failure class seen in practice (a subagent that stopped to wait for a background command was taken for finished, and its late report was lost); the source orchestrator's long prose state machine only relays decisions its scripts already compute |
| C2  | The **code review's fan-out** (nine angles, a scorer) is driven by the orchestrator as separate processes; the red step, path gates and report assembly are engine code                                                                                                                                                          | same as C1; how the review ran becomes a recorded fact instead of model prose                                                                                                                                                                                                                                                                                                                                         |
| C3  | **Stage prompts are templates rendered by the engine**, not skills a runtime has to discover. Optional export as skills for interactive use                                                                                                                                                                                      | skill discovery differs per runtime (`.claude/skills` vs `.agents/skills`); the orchestrator dispatches the payload anyway                                                                                                                                                                                                                                                                                            |
| C4  | The four superpowers procedures the stages use (test-driven-development, systematic-debugging, receiving-code-review, verification-before-completion) are **vendored** into the prompts, with the MIT notice                                                                                                                     | Codex has no plugin mechanism for them; a missing skill fails a stage silently                                                                                                                                                                                                                                                                                                                                        |
| C5  | **Models read, the engine writes.** Stage processes run without forge credentials in their environment; issue and PR data they need is prefetched. This is environment sanitising plus the fence, **not** OS-level isolation (residual risk in § 7.4)                                                                            | strictly stronger than the source pipeline, whose sessions hold the developer's full `gh` login; real isolation is out of reach on native Windows while the CLIs need the developer's own subscription login                                                                                                                                                                                                          |
| C6  | Engine shipped as **compiled JavaScript**; no `tsx` at run time                                                                                                                                                                                                                                                                  | hook latency (resolving `npx tsx` measured 1.8 s per call, paid 30–40 times per issue) and no dependency on a project's `node_modules`                                                                                                                                                                                                                                                                                |
| C7  | Project configuration in `.autoclaude/`, **committed** to the project, with a gitignored `config.local.json` for the developer's own values (C20); runtime state in `.autoclaude/state/`, gitignored, in the project's main checkout                                                                                             | reviewable config, per-project state, per-developer budget                                                                                                                                                                                                                                                                                                                                                            |
| C8  | "Only a human may set `automerge-dev`" rests on three layers rather than on the label's actor: stage processes hold no forge credential (C5), the guard refuses label commands on these labels, the engine never sets them. Same for the category labels. Residual risk as in § 7.4                                              | with one shared account GitHub cannot tell the developer's label from the engine's, so an actor check would prove nothing                                                                                                                                                                                                                                                                                             |
| C9  | Stages already running when a threshold is reached **finish**; only new stages are held                                                                                                                                                                                                                                          | killing a stage wastes what it consumed; the overshoot is bounded by concurrency × one stage                                                                                                                                                                                                                                                                                                                          |
| C10 | Fresh repository without the source history                                                                                                                                                                                                                                                                                      | the history carries private details of the source project                                                                                                                                                                                                                                                                                                                                                             |
| C11 | `autoclaude review --pr <n>` replaces the hand-run review skill on an open pull request                                                                                                                                                                                                                                          | works for both runtimes, same pipeline as unattended                                                                                                                                                                                                                                                                                                                                                                  |
| C12 | **Author trust.** Only issues opened by a user with write access to the repository are triaged, claimed or merged; comments by users without write access are left out of every payload and never count as a human answer. A template that applies `bug` to an outside author's issue therefore qualifies nothing                | target repositories may be public; without this, anyone could open an issue that ends in an auto-merge                                                                                                                                                                                                                                                                                                                |
| C13 | **Triage applies `agent-ready` itself**, and work starts without a human veto window                                                                                                                                                                                                                                             | D6; this drops the source pipeline's rule that only a human curates the queue, listed in § 10                                                                                                                                                                                                                                                                                                                         |
| C14 | **Re-triage may promote** an answered `needs-shaping` issue to `agent-ready` when the acceptance criteria now stand in a trusted human's own words (body or comment), or a trusted human's comment explicitly approves the criteria triage proposed. Never on criteria only triage wrote                                         | keeps the rule "an agent is never graded against criteria it wrote itself" while letting a reply, not a label click, be the human's input                                                                                                                                                                                                                                                                             |
| C15 | **First sweep is opt-in.** `triage.since` defaults to the day a project enrols; older issues are triaged only when a human adds the opt-in label (default `agent-triage`). `triage.maxPerDay` caps a sweep                                                                                                                       | an existing backlog of dozens of issues would otherwise get a comment each on day one, and a budget spike                                                                                                                                                                                                                                                                                                             |
| C16 | **Falling behind is not a refusal.** Auto-merge runs a merge queue (§ 12): only the front pull request is rebased; a conflict-free rebase with an unchanged patch id keeps its review; CI must be green again; the merge re-reads the integration tip under a lock and uses `--match-head-commit`                                | with concurrency 2 and several open PRs nearly every second merge leaves another PR behind; a full re-review per rebase costs nine angles and a scorer each time; this is the source pipeline's own design answer, never built until now                                                                                                                                                                              |
| C17 | **If Claude usage cannot be read headless (spike S1 fails),** the Claude budget degrades to the source pipeline's bounds — the caps and the hard-limit pause, now detected by code — and `status` says "budget not enforced: usage unreadable" in every frame. Whether that is acceptable is put to the owner with the S1 result | "unknown means hold" would stop a Claude-only machine for good; a silent fallback would break the anti-goal against silent stops                                                                                                                                                                                                                                                                                      |
| C18 | **Codex on Windows is in scope.** Spike S3 decides the route: Codex commands run through a POSIX shell the guard can read, if Codex can be configured that way; otherwise a PowerShell grammar in the guard becomes Phase 3 work. Until one exists, `doctor` refuses Codex on Windows                                            | Windows developers are a primary audience; D4 and D8 would otherwise never work for them                                                                                                                                                                                                                                                                                                                              |
| C20 | **Personal overrides.** `.autoclaude/config.local.json`, gitignored, may override only the keys that belong to a developer rather than a project: `budget`, `schedule`, the `runtime`/`model`/`effort`/`fallback` of each stage, and `humans`. Any other key in it is a load error                                               | thresholds, triage time, concurrency and runtime choice depend on the developer's subscriptions; committed in the project they would be shared by everyone on a team                                                                                                                                                                                                                                                  |
| C21 | **One instruction file for both runtimes.** Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`. The runtime adapter makes each stage read whichever the project has (for Codex `project_doc_fallback_filenames`; for Claude Code an import or an appended system prompt); `doctor` warns when a project has neither          | a project written for one runtime must not lose its instructions on the other                                                                                                                                                                                                                                                                                                                                         |
| C19 | `autoclaude status` has a **"Waiting for you"** section: every issue or pull request whose next step is a human's, with the reason and a link                                                                                                                                                                                    | with one shared login GitHub sends the developer no notification for autoclaude's own comments; the developer needs one place to look                                                                                                                                                                                                                                                                                 |

## 6. What carries over, what is rebuilt

**Carries over essentially unchanged** (once paths and the state directory are
parameters): the ledger with its lock, atomic writes, transitions, reconcile and events
log; the claim protocol; the queue and capacity logic; the day/night profile; pause, drain
and resume; the `gh` wrapper with its injectable exec; worktree naming and removal; the
rollback order; the config validator; the rule catalogue (engine half), its table grammar
and the class policy; the report parser and renderers; the review decision; the merge
verdict; the publish gates; the rebase check; the guard's decision library; the review
benchmark; the red step's verdict. These already take an injectable exec and carry no
project facts.

**Is rebuilt or generalised:**

| In the source pipeline                                                            | Problem                                                         | In autoclaude                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| orchestrator = a prose skill run by a model on every tick                         | Claude-only; relays computed decisions                          | orchestrator module; decision table in code with a unit test over every (state, stage) pair |
| review fan-out through the `Agent` tool                                           | Claude-only; completion notifications can reach the wrong level | engine-driven parallel processes                                                            |
| PowerShell launcher with Task Scheduler                                           | Windows only                                                    | `autoclaude service install` for Task Scheduler, launchd, systemd user units                |
| engine invoked as `node node_modules/tsx/… scripts/…` from prompts and allowlists | host-repository path and host `node_modules`                    | `autoclaude <verb>`                                                                         |
| red step with one test runner's globs, aliases and JSON                           | one stack                                                       | test-runner contract from config (§ 8.3)                                                    |
| formatter check with one formatter, resolved from the engine's own location       | one stack, wrong resolution once standalone                     | a gate command with a `{files}` placeholder; file selection stays engine code               |
| migration lint importing the host's CI script                                     | host code                                                       | a gate command with a `when` path filter                                                    |
| hand-written runtime permission file and hooks                                    | Claude Code format, host paths                                  | generated per run by the runtime adapter from the project config                            |
| usage "not readable"; learned ceiling; a free-text limit note from the model      | no real budget                                                  | read from the runtimes (§ 9)                                                                |
| sessions hold the developer's `gh` and git credentials                            | the fence is the only thing between a model and a push or merge | stage processes without forge credentials; the engine writes (§ 7.4)                        |

## 7. Architecture

### 7.1 Parts

```
              ┌────────────────────────── developer machine ──────────────────────────┐
              │                                                                        │
  GitHub ◀────┤  autoclaude orchestrator (one per project, Node, deterministic)        │
 (developer's │    ├─ forge/github   all reads and writes, developer's gh login        │
  gh login)   │    ├─ engine         ledger · claims · worktrees · situation · review   │
              │    │                 decision · publish · can-merge · automerge · guard │
              │    ├─ usage          budget gate per runtime, shared usage cache        │
              │    └─ runtimes       claude | codex adapters                            │
              │           │ spawn, cwd = worktree, sanitised environment                │
              │           ▼                                                             │
              │      stage process  (claude -p … | codex exec …) — reads, edits,        │
              │                      runs gates, commits; no forge credential           │
              └────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Repository layout (proposal; the builder may refine module boundaries)

```
autoclaude/
  package.json                 bin: autoclaude
  src/
    cli/                       one file per verb
    orchestrator/              loop, tick, decision table, stage supervision
    engine/
      ledger/  claims/  worktree/  situation/
      review/                  reports, rules, policy, decision, red-step core, assembly
      publish/  merge/         publish, can-merge, merge queue, automerge policy
      guard/                   decision library + one hook entry point per runtime
    runtimes/
      claude/                  spawn, flags, settings+hooks generation, usage, limit parsing
      codex/                   spawn, config/hooks/rules generation, app-server usage
    forge/github/              every gh call; pagination; remote name from config
    adapters/                  gate runner, test-runner contract, result parsers (JUnit XML …)
    usage/                     thresholds, reset handling, machine-wide cache
    notify/                    labelled comments, de-duplication, "Waiting for you"
    platform/                  spawn incl. Windows .cmd shims, process-tree kill, paths,
                               state/config dirs, autostart backends
  prompts/
    triage.md  plan.md  plan-review.md  implement.md
    code-review/  angles/*.md  scorer.md  (lead.md if a lead pass remains)
    procedures/                vendored superpowers procedures + NOTICE
  catalogue/rules.md           the engine half of the rule catalogue
  templates/project/           what `autoclaude init` writes into a project
  test/                        engine tests and generic fixtures only
  docs/                        README, setup, config reference, specs
  .github/workflows/ci.yml     matrix: ubuntu, macos, windows
  LICENSE  NOTICE
```

### 7.3 The orchestrator

- `autoclaude run` is the loop in the foreground; `autoclaude service install` registers
  it with the OS for autostart and restarts. One instance per project, enforced by a lock
  with pid and heartbeat in `.autoclaude/state/`.
- A tick reads the situation (reconciled with GitHub), settles finished stages, handles
  pull requests, the merge queue and cleanup, then takes new work if the gates allow. It
  sleeps until the next timer or until a child process exits.
- A stage is a child process. Its ledger record is the pid, its start time and the
  orchestrator instance id. A stage whose pid is gone after a restart becomes
  `resume-needed`.
- The source orchestrator's decision table (stage × report → action) becomes code, covered
  by a unit test over every (state, has-stage) pair.
- Wall clock per stage is enforced by the parent: timeout → kill the process tree → the
  `blocked` path. A turn cap (`--max-turns` or the runtime's equivalent) is a second bound.
- Rate-limit hits inside a stage are detected by the runtime adapter from structured output
  or the documented message text, not reported by the model.

### 7.4 Stage processes: least power

A stage process gets:

- the worktree as working directory, the rendered prompt, a dispatch file with the payload
  (issue text and trusted comments, findings, mode, prior-review data it needs), and an
  output path for its report;
- the runtime's own login (the subscription), the project's MCP servers for that runtime,
  and the fence (§ 7.5);
- **no forge credential in its environment**: `gh` is pointed at an empty config
  directory, git credential helpers are overridden to none, SSH agents are not inherited.
  The engine verifies this at stage start on every OS; a test proves that a push and a
  `gh` write from a stage environment fail.

**Residual risk, accepted and documented.** A stage runs as the developer's OS user, and the
gates it runs execute code the model wrote — tests above all. That code can reach the OS
credential store (Windows Credential Manager, macOS Keychain, libsecret) or the developer's
normal `gh`/git configuration directly; neither the guard nor the sanitising sees what runs
inside a test. Closing that would need a separate OS user, a container or a network block
towards github.com, none of which is reachable on native Windows while the runtime CLIs
must use the developer's own subscription login. The defences that remain are the review
(every diff is read by a fresh context before anything is pushed), author trust (C12) and
the guard. The README states the risk plainly.

What a stage needs from GitHub that cannot be prefetched (a review angle's search through
earlier pull requests) is either prefetched by the engine or the angle is dropped for that
runtime; the builder decides per angle.

The engine — never a model — runs the bootstrap command before the first stage in a
worktree, applies labels, posts comments, pushes, opens, updates and merges pull requests.

### 7.5 The fence

Two layers, generated per run rather than hand-written:

1. **The guard**: a runtime-neutral function from command text and project config to
   "allowed" or a refusal. Each runtime adapter installs a pre-command hook that calls
   `autoclaude guard --runtime <r>` and translates payload and verdict. The hook **fails
   closed**: any error, timeout or unparsable input is a refusal. This matters for Codex,
   whose hooks fail open on hook errors and are skipped when their trust hash changes.
2. **The runtime's own permission layer:** for Claude Code a `--settings` file
   (`dontAsk`, allow and deny lists, edits limited to the worktree, reads of secrets
   denied); for Codex the sandbox mode, writable roots, execpolicy rules and approval
   policy.

Neither may alter the developer's own runtime configuration (`~/.claude`, `~/.codex`).

Known gap to close: the guard tokenizes POSIX shell only. Claude Code on Windows runs its
Bash tool through Git Bash, and its PowerShell tool is denied. Codex on Windows may run
commands in PowerShell (spike S3); until the guard parses what that runtime actually
executes, `autoclaude doctor` refuses the pair (C18).

### 7.6 Runtime adapter contract

```ts
interface Runtime {
  name: "claude" | "codex";
  available(): Promise<Availability>;              // installed, logged in, version
  runStage(req: StageRequest): Promise<StageResult>;
  readUsage(): Promise<UsageSnapshot | Unknown>;   // § 9
  fence(project: ProjectConfig, worktree: string): FenceFiles; // generated per run
}

interface StageRequest {
  cwd: string; prompt: string; dispatchFile: string; outputFile: string;
  model: string; effort: "low" | "medium" | "high" | "max";
  schema?: JsonSchema; timeoutMs: number; maxTurns?: number;
}

interface StageResult {
  exit: "ok" | "failed" | "timeout" | "limit" | "refused";
  limitResetsAt?: Date; tokens?: TokenUsage; costUsd?: number;
  transcriptPath: string; errorClass?: "auth" | "quota" | "config" | "network" | "unknown";
}
```

Known mappings (vendor documentation as of 2026-10-16):

|                   | Claude Code                                                                                                  | Codex CLI                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| headless run      | `claude -p --output-format json`                                                                             | `codex exec --json`                                                                               |
| model / effort    | `--model`, `--effort`                                                                                        | `-m`, `-c model_reasoning_effort=…`                                                               |
| structured output | `--json-schema`                                                                                              | `--output-schema`, `-o`                                                                           |
| working dir       | process cwd                                                                                                  | `-C`                                                                                              |
| pre-command hook  | `PreToolUse` via `--settings`, exit 2 blocks                                                                 | `PreToolUse`-style hooks, exit 2 or JSON deny; trust-hashed; fail open on hook error              |
| permissions       | `--permission-mode dontAsk` + allow/deny                                                                     | sandbox `workspace-write` + execpolicy `.rules`; `exec` forces approval `never`                   |
| MCP               | `--mcp-config` + `--strict-mcp-config`                                                                       | `[mcp_servers.*]`, `-c` overrides                                                                 |
| usage             | status line `rate_limits.five_hour` / `seven_day` with `used_percentage`, `resets_at` (headless: unverified) | `codex app-server` → `account/rateLimits/read` (`primary`/`secondary`, `usedPercent`, `resetsAt`) |
| limit hit         | "You've hit your session/weekly limit · resets …" (exit code unverified)                                     | `turn.failed`/`error`, exit 1, localised "Try again at …" text                                    |

## 8. The project contract

### 8.1 `.autoclaude/` in a project

| File                 | Content                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`        | everything below; validated strictly, unknown keys refused; committed                                                                                                                                                         |
| `config.local.json`  | gitignored; the developer's own `budget`, `schedule`, stage runtime/model choice and `humans`, nothing else (C20)                                                                                                             |
| `project.md`         | six optional headings (schema changes, test doubles, high-stakes areas, localisation, commit conventions, bootstrap traps); an absent heading means the clause that reads it does not apply — never that the agent improvises |
| `invariants.md`      | the project half of the rule catalogue, same grammar; an id also present in the engine half is a load error                                                                                                                   |
| `mcp.<runtime>.json` | optional MCP servers per runtime                                                                                                                                                                                              |
| `state/`             | gitignored: ledger, events, reports archive, control files, lock                                                                                                                                                              |

The project's own agent instructions stay where the project keeps them, `CLAUDE.md` or
`AGENTS.md` at its root; autoclaude makes both runtimes read the one that exists (C21).

`autoclaude init` writes the templates and the `.gitignore` entry; `autoclaude doctor`
checks config, labels, commands, runtimes, the `gh` login (and warns when its token carries
`delete_repo`), and version compatibility.

### 8.2 `config.json` — shape (illustrative; key names are the builder's to finalise)

```jsonc
{
  "autoclaude": ">=0.1.0",                       // refuse to run on an older engine
  "forge": { "remote": "origin" },
  "branches": { "integration": "develop", "production": "main" },
  "humans": ["your-github-handle"],              // mentioned when input is needed
  "bootstrap": "npm ci",                          // run by the engine, not the model
  "gates": [                                      // run in order by implementer and publish
    { "name": "format", "check": "npx prettier --check {files}", "fix": "npx prettier --write {files}" },
    { "name": "lint", "check": "npm run lint" },
    { "name": "typecheck", "check": "npm run typecheck" },
    { "name": "test", "check": "npm test" },
    { "name": "build", "check": "npm run build" },
    { "name": "migration-lint", "check": "./scripts/lint-migrations.sh {files}",
      "when": ["db/migrations/**"] }
  ],
  "redStep": {
    "testFiles": ["tests/**/*.test.ts", "src/**/*.test.ts"],
    "supportFiles": ["tests/helpers/**"],
    "exclude": ["tests/e2e/**"],
    "run": "npx vitest run --reporter=junit --outputFile={report} {files}",
    "result": "junit",                            // junit | exit-code
    "install": { "when": "package-lock.json", "run": "npm ci" }
  },
  "worktrees": { "root": ".autoclaude/worktrees", "copy": [".env.local"] },
  "stages": {
    "triage":     { "runtime": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    "plan":       { "runtime": "claude", "model": "claude-opus-5-5",   "effort": "high",
                    "fallback": { "runtime": "codex", "model": "<codex model>", "effort": "high" } },
    "planReview": { "runtime": "claude", "model": "claude-opus-5-5",   "effort": "medium" },
    "implement":  { "runtime": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    "codeReview": { "angles": { "default":  { "runtime": "claude", "model": "claude-sonnet-5-5" },
                                "security": { "runtime": "claude", "model": "claude-opus-5-5" } },
                    "scorer": { "runtime": "claude", "model": "claude-sonnet-5-5" } }
  },
  "budget": {
    "claude": { "fiveHourPct": 80, "weeklyPct": 90 },
    "codex":  { "fiveHourPct": 70, "weeklyPct": 85 }
  },
  "schedule": { "timezone": "Europe/Berlin", "triageAt": "06:00", "concurrency": 2 },
  "triage": { "since": "2026-11-01", "optInLabel": "agent-triage", "maxPerDay": 10 },
  "queue": {
    "ready": "agent-ready",
    "priority": ["priority: critical", "priority: high"]   // first match wins; unlabeled last; ties: oldest
  },
  "automerge": {
    "enabled": true,
    "label": "automerge-dev",
    "categories": ["bug", "documentation"],
    "method": "squash"
  },
  "humanApproval": [                               // paths that need a human's label to merge
    { "paths": ["db/migrations/**"], "label": "agent-migration-ok" }
  ],
  "labelRules": [                                  // labels the engine adds from the diff
    { "when": ["src/ui/**"], "unless": ["src/ui/**/*.test.ts"], "label": "review:ui" }
  ],
  "requiredChecks": ["test", "build"],
  "forbiddenPaths": [".github/workflows/**", ".autoclaude/**", "CLAUDE.md", "AGENTS.md"],
  "policyAdjacentPaths": ["src/auth/**"],
  "codeReview": { "angles": ["criteria", "bugs", "invariants", "history", "prior-prs",
                             "comments", "performance", "tests", "security"],
                  "scoreThreshold": 7 },
  "planReview": { "scoreThreshold": 7 },
  "caps": { "fixRounds": 2, "reviewRetries": 2, "planRounds": 2,
            "wallClockMinutesPerStage": 60, "openPullRequests": 4, "staleClaimHours": 2 },
  "labels": { "working": "agent-working", "blocked": "agent-blocked",
              "needsShaping": "needs-shaping", "fixRound": "agent-fix-", "reviewRetry": "agent-retry-" }
}
```

Every label named must exist (`doctor` checks, `init` offers to create them); tuning knobs
are free to edit; safety values are validated. `budget`, `schedule`, the stages' runtime
and model choice and `humans` are the project's defaults; a developer's
`config.local.json` overrides them (C20).

### 8.3 Red step without a fixed runner

The contract stays: new or changed test files must fail on the integration base and pass
on the head. The engine selects test files from the diff by `testFiles`/`exclude`, builds a
detached base worktree, copies the tests and `supportFiles` in, runs `install` if its
`when` file differs, and runs `run` on base and head. With `result: "junit"` the verdict
uses per-test outcomes from JUnit XML, which most runners emit (vitest, jest, pytest, Go via
`gotestsum`, Rust via `cargo2junit`, JUnit itself); with `exit-code` it degrades to
`could-not-run` whenever the base fails for a reason it cannot attribute. The source
heuristic — a base load failure counts as proven only if the output names a file the change
adds — is kept for both.

## 9. Usage budget

- **Reading.** Each runtime adapter reads the account's usage: five-hour and weekly
  percentage used and their reset times. Readings are cached machine-wide (one cache per
  runtime, shared by all projects, file-locked, refreshed at most every few minutes and
  always before a dispatch decision when older than that).
- **Gate.** Before dispatching any stage, the orchestrator checks the stage's runtime
  against the project's two thresholds. Above either: if the stage has a configured
  fallback and the fallback runtime is under its thresholds, dispatch there; otherwise hold
  all new dispatches until the earliest reset that brings the runtime back under, then
  continue. Running stages finish (C9).
- **Hard limit inside a stage.** The adapter reports `limit` with the reset time; the stage
  is marked interrupted without bumping any counter and resumed after the reset.
- **Unknown usage.** A reading that fails _transiently_ holds new work until the next
  successful reading. A runtime whose usage cannot be read _at all_ falls back to the caps
  and the hard-limit pause, and says "budget not enforced: usage unreadable" in every
  `status` frame (C17).
- **Visible.** `autoclaude usage` prints both windows per runtime against this project's
  thresholds; the events log records every hold and resume.

The source pipeline's learned ceiling and day-profile reserve are retired: the thresholds
replace them because the usage is now readable. Day/night concurrency profiles remain
available as an option.

## 10. Behaviour that changes on purpose

| Area              | Source pipeline                                    | autoclaude                                                                                                                |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Queue order       | lowest issue number first                          | configured priority labels, then oldest                                                                                   |
| Issue/PR listing  | first 100 issues, newest 200 PRs                   | paginated, complete                                                                                                       |
| Triage            | by hand                                            | daily at `triageAt` for issues since enrolment or opted in (C15), plus re-triage of answered `needs-shaping` issues (C14) |
| Queue curation    | only what a human labelled `agent-ready`           | triage applies `agent-ready` itself, no veto window (C13)                                                                 |
| Eligible authors  | anyone                                             | users with write access only (C12)                                                                                        |
| Triage output     | labels and comment written by the model            | structured report; labels and comment written by the engine                                                               |
| Merge             | never                                              | by policy into the integration branch, through a merge queue (§ 12)                                                       |
| can-merge check 6 | reviewed head sha equals PR head                   | reviewed patch id equals the PR diff's patch id, after a conflict-free queue rebase (C16)                                 |
| Notification      | none                                               | one labelled comment with `@` mention; "Waiting for you" in `status` (C19)                                                |
| Budget            | issue caps, learned ceiling, free-text limit notes | thresholds on read usage                                                                                                  |
| Effort            | a prompt phrase ("Ultrathink …")                   | the runtime's effort flag                                                                                                 |
| Stage record      | Agent task id + session id                         | pid + start time + orchestrator instance                                                                                  |

Defects found in the source pipeline, fixed during the port with a test each:

1. Recreating an issue's worktree does not pick up its already pushed branch, so publish's
   lease check fails afterwards.
2. Paths are lowercased on every OS, which is wrong on case-sensitive file systems.
3. Issue and PR listings are capped; older agent pull requests become invisible to
   reconcile.
4. Priority labels are ignored.
5. The guard has no PowerShell grammar while its hook matcher includes PowerShell.
6. The configured migrations path is read by nothing; the merge check hardcodes one.
7. Node refuses to spawn `.cmd`/`.bat` shims without a shell on Windows; `npx` and
   npm-installed CLIs need the spawn helper.
8. Remedy messages mix bash quoting with PowerShell commands.

## 11. Notifications

- **The comment is the notification (D9).** autoclaude posts one comment on the issue or
  pull request, mentions the configured `humans` with `@`, and sets the matching label.
  It sends no e-mail and uses no other channel. Whether GitHub delivers the mention to the
  developer is the developer's GitHub setting; with one shared login it usually does not,
  which is why `status` carries "Waiting for you" (C19).
- Every comment autoclaude posts carries a fixed marker line naming autoclaude, so a reader
  can tell it from the developer's own words, and triage can tell a human answer from an
  autoclaude comment.
- **When:**
  - an issue moves to `needs-shaping`, with the concrete questions;
  - an issue moves to `blocked`, with the reason and what it would cost to be wrong;
  - a pull request is ready but not eligible for auto-merge, asking for review and merge;
  - a gate run never started for a pushed head;
  - a stale foreign claim needs a human's takeover decision.
- **De-duplication:** one comment per issue per reason per state change, recorded in the
  ledger and reconstructible from GitHub through the markers.
- A trusted human's reply on a `needs-shaping` issue is picked up by the next daily triage
  (C14).

## 12. Auto-merge

A pull request opened by autoclaude is merged by the engine when **all** of these hold:

1. `automerge.enabled` and no pause or drain control file.
2. The target is `branches.integration`. The production branch is refused in code, not
   only by configuration.
3. The issue carries `automerge.label` or one of `automerge.categories`, which only a human
   can have put there (C8).
4. The merge verdict is `ALLOWED`: base is the integration branch; required checks green;
   review stamped `publish` with no open must and a proven red step; mergeable state; not
   behind; reviewed diff equals the PR diff; `humanApproval` labels present for matching
   paths.
5. No forbidden or policy-adjacent path in the diff.
6. The issue's author has write access (C12).

**Merge queue (C16).** Eligible pull requests merge one at a time, oldest eligible first.
A pull request that fell behind is not refused: at the front of the queue, the engine
rebases it. If the rebase is conflict-free and `git patch-id --stable` of the rebased diff
equals that of the reviewed diff, the review stands, and the review archive records both
heads. CI must report green again on the new head. A conflict, or a changed patch id, sends
the issue to a fix round and so through a fresh code review. The merge happens under the
ledger lock: re-read the integration tip, re-check, then merge with
`gh pr merge --match-head-commit <sha>`, so a push in between makes the merge fail rather
than land something unreviewed.

Then: merge with `automerge.method`, record it, clean up worktree and branch, release the
claim as done. A refusal other than "behind" on an otherwise eligible pull request becomes
a notification (§ 11). Every merge is one line in the events log and in `status`.

## 13. Cross-platform

- Spawning: one helper that resolves Windows shims, passes command text through a shell
  only for configured project commands, and kills the whole process tree on timeout
  (`taskkill /T` on Windows, process groups elsewhere).
- Paths: real paths and the file system's own case rules; no blanket lowercasing.
- Time: the schedule's timezone is explicit in the config, not the machine's local zone.
- Autostart: `service install|uninstall|status` for Task Scheduler (Windows), a launchd
  user agent (macOS) and a systemd user unit (Linux). The service runs in the logged-in
  user's context so the CLIs find their logins; machines that reboot unattended are
  documented, not scripted.
- CI: the whole suite on ubuntu, macos and windows on every pull request (free for a public
  repository). A test that skips on a platform says which and why.

## 14. CLI surface

| Verb                                              | Purpose                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `init`, `doctor`                                  | set up a project; check everything                                        |
| `run`, `service install\|uninstall\|status`       | the orchestrator in the foreground; autostart                             |
| `status`, `watch`, `situation`, `usage`           | what is happening and what waits for you; what the next tick sees; budget |
| `pause`, `drain`, `resume`                        | control files, from any terminal                                          |
| `triage [--issue <n>]`, `issue <n>`               | triage now; one issue attended, start to pull request                     |
| `review --pr <n>`                                 | the code review on an open pull request, posted as a comment              |
| `can-merge <pr>`, `rollback <issue> …`, `bench …` | merge verdict; ordered rollback; review benchmark                         |
| `guard --runtime <r>`                             | internal: the hook entry point                                            |

## 15. Rollout

**Phase 0 — spikes, before any port.**

- **S1** Does the Claude Code status line (and so `rate_limits`) run in `claude -p` with a
  subscription login? If not, which fallback: a short interactive probe session, the
  warning text ("You've used 85 % of your session limit"), or none (C17)?
- **S2** Codex isolation: can hooks, execpolicy rules, sandbox writable roots (a worktree's
  `.git` lives in the main checkout) and MCP servers be supplied per run without touching
  `~/.codex`, and does hook trust survive headless runs?
- **S3** Codex on Windows: which shell executes commands, and can it be a POSIX shell the
  guard reads?
- **S4** A full Claude stage as a child process on each OS: `--settings` with hooks,
  `--effort`, `--json-schema`, exit code and limit message shape.
- **S5** A stage environment without forge credentials on each OS (§ 7.4).

**Phase 1 — extraction at parity, Claude only.** Repository, CLI, engine port with its
tests, compiled build, project contract, gate and test-runner adapters, deterministic
orchestrator with the source pipeline's behaviour (no merge), engine-driven review fan-out,
stage processes without forge credentials, autostart on all three OSes, CI matrix, the
defects in § 10. _Exit:_ the first consumer runs issues to pull requests through
autoclaude, unattended overnight; the suite is green on all three OSes.

**Cut-over of the first consumer**, right after Phase 1, planned in that repository.

**Phase 2 — budget, schedule, priority, notifications** (§ 9, § 11, queue rules, C12–C15,
C19).

**Phase 3 — Codex runtime and fallback** (§ 7.5–7.6, gated by S2 and S3), including Windows
(C18).

**Phase 4 — auto-merge and the merge queue** (§ 12).

## 16. Risks

| Risk                                                                            | Mitigation                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude usage not readable headless (S1)                                         | C17: visible degradation; owner decides with the S1 result                                                                               |
| Codex fence weaker than Claude's                                                | refuse the runtime/OS pair in `doctor`; C5 removes forge credentials regardless                                                          |
| Code a model writes reaches the OS credential store through the gates           | documented residual risk (§ 7.4); review, author trust and guard remain                                                                  |
| Nine angle processes per review each pay start-up and the ~6.5k-token catalogue | same token cost as the source pipeline's subagents; now measured per stage, so cutting the catalogue per angle can be decided on numbers |
| Auto-merge of `bug` by default merges a wrong fix                               | requires a proven red step and no open must; the integration branch is not production; a project can drop `bug` from the defaults        |
| Two orchestrators on one machine overshoot a threshold together                 | bounded by the sum of their concurrency × one stage; acceptable by D7                                                                    |
| Vendor CLIs change flags (Codex changed its profile format in 0.134)            | adapters pin a tested version range; `doctor` refuses an untested major                                                                  |

## 17. Left to the builder

Module boundaries and file names; the exact config key names and schema; the prompt
templating mechanism; whether a lead pass remains in the code review; how the usage cache
is stored; the stage-environment sanitising mechanism per OS (proven by test); whether
prompts are also exported as skills; the logging format beyond the events-log line; test
reorganisation; how a project supplies benchmark fixtures.
