# Single-issue runs, the source's stage skills with subagents, run logging, local concurrency

Date: 2026-10-23
Status: design amendment; the decisions marked "owner" were taken by the owner, the rest are the
designer's calls and may be overturned
Supersedes: the 2026-10-21 draft of this amendment (never merged)
Amends: `docs/specs/2026-10-16-autoclaude-design.md` as listed in § 6

## 1. Why

Two things happened after Phase 1.

**The review got much worse.** The Phase 1 acceptance run measured the code review against the
source pipeline's benchmark: a 787-line React concurrency change with eleven findings that were
adjudicated independently. The source pipeline's best run reached 7 of 11 (must 2/2, should 3/4).
autoclaude reached **1 of 11 (must 0/2, should 1/4)**.

**The owner set a direction:**

- the stages are structured exactly as in the source pipeline, which the skills were written and
  tuned for;
- first one issue runs completely and unattended, at any time of day; an orchestrator for many
  issues comes later and builds on that;
- every run can be followed live and reconstructed afterwards;
- the limit on parallel runs holds per local clone, not per repository;
- every pull request is opened as a draft;
- nothing is left lying around;
- everything is documented well, above all how a developer uses autoclaude on their own
  repository.

## 2. What the benchmark run shows

The run directory and every review process's session transcript were kept, so the loss could be
traced step by step.

|                                              | Source, best run         | autoclaude run                                                            |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Whole review                                 | about 40 min             | 3 min                                                                     |
| `bugs` angle                                 | Opus, high effort        | Sonnet, medium; 8 tool calls, 21 s, "nothing wrong"                       |
| `tests` angle                                | Opus, high               | Sonnet, medium; 29 s                                                      |
| `performance` angle                          | Opus, high               | Opus, medium; 35 tool calls; found the must and quoted the library source |
| Candidates reaching the scorer               | all eleven at least seen | **3**                                                                     |
| Scorer on the scheduling regression (a must) | 9                        | **3**, without opening a single library file                              |

**R1 — the comparison was not like for like.** The trial used the consumer's model configuration of
2026-10-15. It had moved `bugs` and `tests` from Opus/high to Sonnet/medium, and `performance` from
high to medium effort. A benchmark that does not pin the model configuration cannot tell an engine
regression from a cheaper configuration.

**R2 — a rule the source review never had.** Every ported review prompt says _"A denied command is
the fence speaking: do not retry it or look for another way to the same effect."_ The source has that
sentence only where it guards an effect: in the implementer and the orchestrator. For a reader it
forbids reading by an allowed route once another route was denied. The scorer did exactly that.
`git diff … | head -80` was denied, and its next action was to submit its scores.

**R3 — the scorer lost its inputs.** In the source, the review lead hands the scorer the diff, the
criteria, the catalogue, the rubric, the false-positive list and the candidates. When the lead
became engine code, only the candidates and the catalogue survived.

**R4 — the port drifted from proven text.** One 640-line review skill was split into fifteen prompt
files and rewritten as it moved. R2 came in that way. R3 went unnoticed because no file
corresponded to the lead's step that hands the scorer its inputs.

R2, R3 and R4 have one cure: port the skills as they are (§ 3.1, § 3.2). R1 needs a benchmark that
pins its configuration (§ 3.9).

## 3. Decisions

### 3.1 A stage is a process; inside it, the source's skill with its subagents (owner)

The engine starts **one process per stage**: triage, plan, plan-review, implement and code-review.
Each process gets the stage's skill. Inside the process the skill works exactly as in the source
pipeline:

- the **code-review** stage is the review lead; it dispatches the configured angles and the scorer
  as **subagents**;
- the **plan-review** stage dispatches its scorer as a subagent;
- plan, implement and triage work as one agent, as in the source.

The process boundary keeps everything the engine needs: the exit code, the wall clock, the fence,
the budget gate and the per-stage log.

It also closes the failure class of the source's run F at that boundary. A subagent that stopped to
wait for a background command was once taken for finished. Background subagents keep a `claude -p`
run open until they end, so the process exit is the stage's end. The skills' own rules (every shell
command in the foreground; the lead waits for every angle) stay as they are.

The engine's own fan-out from Phase 1 (one process per angle and scorer, report assembly in code)
is **retired**. The engine keeps everything the source also did deterministically:

- the red step, run before the code-review stage in that stage's worktree (§ 3.5), with its verdict
  in the dispatch file;
- the evidence check and the review decision;
- publishing;
- posting the review comment;
- parsing every report.

**Models and effort of subagents** work as in the source. The skill passes the model's short name
(the first word after `claude-`) to the subagent tool and appends the effort sentence ("Think about
this…", "Think hard…", "Ultrathink…") to the prompt. The engine resolves the model and effort of every
angle and of the scorer from the project config and writes them into the dispatch file, so a skill
does not depend on the config's key names.

The stage fence allows the subagent tool in every stage, as the source's settings did. Every
subagent inherits the stage's fence, hooks and MCP servers; the source measured this in September.

**Spike S6, first task of § 5 step 1** (designer's call). The Claude Code docs state two things
that this decision rests on: subagents run under `claude -p`, and their events stream with a
`parent_tool_use_id`, while background subagents keep the run open. S6 confirms both on the
pinned CLI version: a lead with four background subagents gets every completion and writes its
report, and every subagent tool call is attributable in `stream-json`.

If S6 disproves either claim, the fallbacks need no change to the skill text:

- **No completions for background subagents:** the source skill's own degraded path applies,
  "dispatch the same angles in the foreground, still all in one message", and the report says so
  in `fan-out:`.
- **No attribution in the stream:** the run report reads the subagent transcripts from the
  runtime's session directory instead.

**Codex.** Codex has subagents of its own, with a different mechanism, and whether they work under
`codex exec` is undocumented. A spike at the start of Phase 3 settles it. Until then `doctor`
refuses a Codex runtime for the plan-review and code-review stages (designer's call).

### 3.2 The skills are taken over 1:1 (owner)

```
skills/
  autoclaude-triage/SKILL.md
  autoclaude-plan/SKILL.md
  autoclaude-plan-review/SKILL.md
  autoclaude-implement/SKILL.md
  autoclaude-implement/procedures/{test-driven-development,systematic-debugging,
                                   receiving-code-review,verification-before-completion}.md
  autoclaude-code-review/SKILL.md
NOTICE                       the superpowers MIT notice
```

**Names are fixed by convention:** `autoclaude-<stage>`. This is the source's scheme with the new
prefix. The folder name and the `name:` line agree, and a test fails if they do not. There is no
orchestrate skill: the orchestrator is code.

**The text is the source's text.** Only these mechanical substitutions are allowed:

| #   | Source                                                                | autoclaude                                                                                  |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `.autodev/…` paths and config key names                               | `.autoclaude/…`, and the dispatch file's resolved values where the source read a config key |
| 2   | `node node_modules/tsx/dist/cli.mjs scripts/autodev/ledger.ts note …` | `autoclaude note …`                                                                         |
| 3   | `EnterWorktree`, the worktree self-check                              | removed: the stage starts inside its worktree                                               |
| 4   | `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr list`             | the dispatch file, prefetched by the engine (stages hold no forge credential)               |
| 5   | `git fetch origin <integration>`                                      | removed: the engine fetched before the stage                                                |
| 6   | `npx tsx scripts/autodev/red-step.ts --json`                          | the red-step verdict in the dispatch file                                                   |
| 7   | `npx tsx scripts/autodev/post-review.ts …`                            | removed: the engine posts                                                                   |
| 8   | `npx tsx scripts/autodev/check-rebased.ts`                            | `autoclaude check-rebased`                                                                  |
| 9   | "invoke `superpowers:<x>`"                                            | "follow `procedures/<x>.md` beside this skill"                                              |
| 10  | `config.commands.*` gates                                             | `autoclaude gates …`                                                                        |

**A parity test enforces this.** It applies the table to a pinned snapshot of the source skills
(`test/fixtures/source-skills/`, with the source commit recorded) and requires the result to equal
the new skills, apart from deviations listed with a reason in `skills/DEVIATIONS.md`. The source
skills carry no project facts (the source's port-checklist test asserted that), so the snapshot can
live in the public repository.

**What `DEVIATIONS.md` may hold** (designer's call). It may only replace a **mechanism**: which
tool, path, command or component does a thing, and where a value comes from. Rules, briefs, the
rubric, thresholds, output formats and their wording are frozen. A change to any of them needs
the owner's sign-off, recorded in the entry with its date.

Mechanism replacements already known:

- **implement Step 1:** the engine has bootstrapped and copied `worktrees.copy`. The skill checks
  the marker and stops with `blocked` if it is missing.
- **code-review Step 6:** "you cannot run an experiment" describes autoclaude's fence instead of
  the source guard's `scripts/autodev/` rules.
- **Config keys:** the skills' reads of `config.paths.source`, `labels.migrationOk`,
  `commands.formatWrite`, `commands.envCheck` and `triggers.*` become values the engine resolves
  into the dispatch file.
- **Names:** references to `autodev-orchestrate` and `post-review.ts` name the engine instead.

Ported this way, R2's rule does not appear in the review skills, and R3's hand-over of the diff to
the scorer is back, because both are what the source text says.

### 3.3 One complete issue run first, at any time (owner)

- **`autoclaude issue <n>`** runs one issue unattended, from claim to a draft pull request, or to a
  state a human has to look at (`needs-shaping`, `blocked`). The chain is: plan, then plan review,
  repeating while the review finds a must; implement; code review, repeating with fix rounds; then
  publish.
- **The entry gate** (designer's calls, derived from the owner's "an identified issue must be
  startable"). An explicit start is a human's decision, so the triage skill's skip rules,
  which exist for the automatic sweep, do not apply to it:
  - **ready label present:** the run starts with the plan.
  - **No agent label, or `needs-shaping`:** the run starts with the triage stage, in a mode the
    dispatch file names. In it, triage assesses form and exclusions and skips nothing; for an
    answered `needs-shaping` issue it applies C14's promotion rule. `needs-shaping` again ends the
    run with triage's comment.
  - **`agent-blocked` from an earlier run:** a fresh attempt. The claim clears the blocked and
    counter labels, as the source's claim does.
  - **The working label, i.e. another machine's claim:** refused.
  - **Assigned to someone other than the `gh` user:** refused unless `--force`. Assigned to that
    user: proceeds.
  - **C15** (`triage.since`, the opt-in label) does not apply: the start is the opt-in.
- **After publish, the run carries on until the pull request is ready for a human** (designer's
  call: "an issue worked completely" includes green CI):
  - it waits for the required checks, and **holds no slot while it waits**;
  - it runs CI fix rounds, each followed by a fresh code review, as the source's orchestrator did,
    bounded by the same `caps.fixRounds` counter;
  - it ends at `mergeable` ("gates green, awaiting a human") or `blocked`;
  - checks that never start (the exit record's defect 3) end it as `blocked` with that reason, not
    as red CI.
- **Cleanup after a human merges or closes** is done by `clean` and the daily retention sweep
  (§ 3.8), which detect merged and closed pull requests.
- **`autoclaude run` and `service` in Phase 1b** (designer's call): kept, with their capacity gate
  switched to `concurrency.maxParallelRuns`, and otherwise unchanged until Phase 2 rebuilds the
  orchestrator on single-issue runs.
- **There are no time-of-day rules.** A run starts whenever it is started.
- **`--detach`** keeps the run going after the terminal closes; its output goes to the run's log
  (designer's call).
- **Several runs may run side by side in one clone**, up to the limit of § 3.4. The per-project
  instance lock of Phase 1 becomes a lock **per run**: per issue, with pid and heartbeat.
- **The later orchestrator** starts exactly these runs. There is one pipeline, not two.

### 3.4 Parallel runs are limited per local clone (owner)

- **Where it is set:** `concurrency.maxParallelRuns` in `.autoclaude/config.local.json`. It is a
  personal value, so it is never committed. The default is 2 (designer's call).
- **What counts:** the runs of **this clone** that are in a working state: from claim until the pull
  request is open, plus every CI fix round. A run waiting for CI or for a human does not count. Runs on other machines and in
  other clones do not count. The GitHub claim still makes sure no two machines work on the same issue
  (owner).
- **When the limit is reached, an interactive start asks:**
  `Maximum parallel runs reached (2/2). Start anyway? [y/N]`
  - **`y`** starts the run beyond the limit, and the events log records the override.
  - **`N`, Enter or Ctrl-C at the prompt** waits: `Waiting for a free slot (position 1)…`. The run
    starts by itself when a slot frees. Ctrl-C while waiting aborts without having claimed anything.

  CLI text is English, like everything in the repository (designer's call).

- **Without a terminal** (a service, a script), a start waits. `--force` starts beyond the limit;
  `--wait` waits without asking.
- **The claim is taken only when the run starts.** If another machine claimed the issue in the
  meantime, the waiting start reports that and exits.
- **Removed:** the day/night profiles (`schedule.profiles`, `nightStopsTakingWorkAt`),
  `caps.concurrency.day/night`, `caps.issuesPerNight`, and the repository-wide `repoWorking` gate.
  The loader refuses each old key with a message naming its replacement.
- **The budget thresholds stay** (Phase 2).

### 3.5 Every stage in its own worktree; every code review in a separate one (owner)

- **The implementation worktree** belongs to the issue and holds plan, plan review, implement and
  every fix round, as now.
- **Every code-review round gets its own worktree**, `<worktrees.root>/review+<n>-<round>`:
  - detached at the commit under review;
  - bootstrapped with the project's `bootstrap`;
  - with the red step's base worktree beside it, as now.

  The reviewer therefore never sees the implementer's untracked files or working state. The cost is
  one bootstrap per review round.

- **After the round,** the report and the stage's logs are archived into the run directory, and the
  review worktree is removed.

### 3.6 Every pull request is a draft (owner)

- Publish opens every pull request with `--draft` and leaves it a draft on every update.
- The merge verdict's check "not a draft" stays.
- Auto-merge (Phase 4) marks an eligible pull request ready as its last step before merging, and
  only for the configured categories (designer's call).
- Everything else stays a draft until a human marks it ready.

### 3.7 Run logging, live and afterwards (owner)

**Capture.** A stage process runs with streaming JSON output: Claude Code
`--output-format stream-json --verbose`, Codex `--json` (Phase 3). Each event line is appended to
`<runDir>/<stage>-<k>/stream.jsonl` as it arrives, and the final result is taken from that stream.
Subagent events carry their parent tool-use id, so every tool call is attributed to the stage itself
or to a named subagent.

**Live: the events log.** From the stream the engine writes milestone lines into the issue's
`events.log` as they happen:

- **Stage:** start, with the configured model and effort; end, with duration, exit, the models
  actually used, tokens and cost.
- **Subagent:** start, with its description (the angle), model and effort; end, with duration and
  the number of tool calls.
- **Commands:** every denied command; every MCP tool call, as `mcp <server>/<tool>`.
- **Progress:** gate results; the red-step verdict; every round transition (plan round k, plan
  review round k, fix round k, CI round k).
- **Engine actions:** budget holds and resumes; worktree creation and removal; claims, releases and
  overrides of the limit.

**Live: the view.** `autoclaude watch [--issue <n>]` shows each running issue as a tree: stage →
subagents. Each node carries its state (running, done, failed), model, effort and elapsed time.
Below the tree come the last events.

**Afterwards: the run report.** `run-report.md` and `run-report.json` are written per issue in
`.autoclaude/state/reports/<issue>/`. They are updated at the end of every stage and kept by every
cleanup. They contain:

- the timeline;
- for every stage and round:
  - the processes and subagents;
  - the configured against the actually used models, and the effort;
  - durations, tokens and cost;
  - tool calls and denied commands;
  - the MCP servers configured and the MCP tools called;
  - the gates and the red step;
  - findings per tier and what became of them;
- the loop counts: plan ↔ plan review, fix rounds, CI rounds;
- totals.

`autoclaude report <issue>` re-renders it.

**Afterwards: in the pull request.** The engine posts a summary as one pull-request comment and
updates it in place each round, keyed by a marker. It covers rounds, agents, models, durations,
cost totals and MCP use, with a link to nothing local. The body stays publish's (designer's call).

### 3.8 Cleanup (designer's calls)

**Automatic, at the end of every round and run:**

- the review and red-step worktrees are always removed;
- the implementation worktree is removed after merge, close, block or rollback, as now;
- a retention sweep runs once a day, when a run starts.

**`autoclaude clean [--dry-run] [--older-than <days>] [--runtime-transcripts]`:**

- removes worktrees under `worktrees.root` that no live run or ledger entry holds, then runs
  `git worktree prune`;
- deletes run directories older than `retention.runDays` (default 30, in `config.local.json`), but
  keeps their run reports;
- deletes local branches whose worktree is gone and whose pull request is merged or closed;
- with `--runtime-transcripts`, also deletes the runtimes' own session transcripts of autoclaude
  worktrees, such as Claude Code's `~/.claude/projects/<slug>` for slugs under `worktrees.root`.

**Never deleted:** run reports, the ledger, branches of open pull requests, and anything outside
`worktrees.root` and `.autoclaude/state/`.

### 3.9 The benchmark pins its configuration (fixes R1)

- **`autoclaude bench <expected.json> --base <sha> --head <sha>`** runs the code-review stage on a
  commit range in its own review worktree. It keeps the report and scores it with the existing
  matcher. No pull request is needed, which closes the exit record's defect 2.
- **The output records the resolved model and effort** of the lead, every angle and the scorer.
  A comparison is stated only between runs whose configurations match.
- **`bench.models`** in the config overrides `stages.codeReview` for bench runs only, and
  `bench.angles` overrides `codeReview.angles`.
- **`--issue <n>`** names the issue whose text and acceptance criteria the review reads, as the
  benchmarked run had them.
- **`--exclude-pr <n>…`** (designer's call). The engine leaves these pull requests out of every
  prefetch, so the review cannot read the benchmark's own pull request, whose review comments are
  the answer key.

  The source's README records that its `prior-prs` and `history` angles could reach that pull
  request. A clean run is therefore, if anything, harder than the target it is held to.

- **Model versions:** a subagent's model is a short name (`opus`, `sonnet`), so it resolves to
  whatever the CLI maps it to that day. The output records what each process and subagent
  actually ran on, and that is the comparison's basis.

### 3.10 User documentation (owner)

Everything is documented well, above all **how a developer uses autoclaude on their own
repository**.

**Who it is for.** A developer who has never seen the source pipeline: they clone autoclaude,
point it at their own repository, and run issues on their own Claude or Codex subscription. It is
written in English, like the repository.

**What it consists of** (designer's call on the structure):

| File                             | Answers                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                      | What autoclaude is, the chain in one picture, prerequisites, install, a ten-minute quickstart to a first draft pull request, links into the guide                                                                                                                                                                                                                                                                                                         |
| `docs/guide/install.md`          | Prerequisites per OS (Node, git, `gh`, Git Bash on Windows, the runtime CLIs and their logins); clone, build and link; `doctor`; update; uninstall                                                                                                                                                                                                                                                                                                        |
| `docs/guide/onboarding.md`       | `init`; every file in `.autoclaude/` and what it is for; writing `config.json` (gates, red step, labels, stages and models), with **complete example configurations for at least two stacks** (TypeScript with npm, Python with pytest); `invariants.md` with its row grammar and example rows; `project.md`'s six headings and "absent means not applicable"; `config.local.json` and which values are personal; creating the labels; the first `doctor` |
| `docs/guide/writing-issues.md`   | What an issue an agent can work from looks like: problem, checkable criteria, scope, with good and bad examples; what triage checks; the priority, ready and automerge labels                                                                                                                                                                                                                                                                             |
| `docs/guide/running-an-issue.md` | `autoclaude issue <n>`: the entry gate; the chain stage by stage with its rounds; the parallel-run limit and its prompt; `--detach`, `--force` and `--wait`; what ends a run; the draft pull request and what the human does next                                                                                                                                                                                                                         |
| `docs/guide/following-a-run.md`  | `watch` and its tree; the events log and every line type; `status` and "Waiting for you"; the run report, field by field; the pull-request summary                                                                                                                                                                                                                                                                                                        |
| `docs/guide/reviews.md`          | How the code review works (lead, angles, scorer, models); how a finding becomes must, should, later or uncertain; red-step verdicts; fix rounds; `review --pr`; `bench`                                                                                                                                                                                                                                                                                   |
| `docs/guide/stages.md`           | Each stage skill: what it does, its inputs and outputs, its subagents and models, and where its text lives                                                                                                                                                                                                                                                                                                                                                |
| `docs/guide/housekeeping.md`     | `clean` and retention; where worktrees and state live; `rollback`; `pause`, `drain` and `resume`                                                                                                                                                                                                                                                                                                                                                          |
| `docs/guide/troubleshooting.md`  | `doctor` failures; denied commands and how to extend `fence.allow`; usage limits; CI that never starts; stale claims; Windows specifics (Git Bash, paths with spaces); recovering after a crash or reboot                                                                                                                                                                                                                                                 |
| `docs/reference/cli.md`          | Every verb, its flags and its exit codes                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `docs/reference/config.md`       | Every key: type, default, and whether it is committed or personal (replaces today's `docs/config.md`)                                                                                                                                                                                                                                                                                                                                                     |
| `docs/reference/events.md`       | Every events-log line type                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/reference/run-report.md`   | The schema of `run-report.json`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/security.md`               | The fence layers, the stage environment and the residual risk, kept current                                                                                                                                                                                                                                                                                                                                                                               |

**The documentation cannot fall behind the code.** These are tests in the suite:

- every verb and flag the CLI accepts appears in `docs/reference/cli.md`;
- every config key in the schema appears in `docs/reference/config.md`;
- every event type the engine writes appears in `docs/reference/events.md`;
- every field of `run-report.json` appears in `docs/reference/run-report.md`;
- every relative link in `README.md` and `docs/` resolves;
- every `autoclaude` command in the README quickstart and the guide names a verb and flags that
  exist;
- the two example configurations in the onboarding guide load without error.

**And a rule for every change** (owner): a pull request that adds or changes a verb, a flag, a
config key, an event, a stage's behaviour or a default updates the documentation in the same pull
request.

## 4. Acceptance

1. **Benchmark** (designer's calls on what "like for like" pins):
   - the source benchmark's issue and commit range, with its own pull request excluded;
   - the **eight angles** of the source's best run, without `security`, which came a week later;
   - lead Opus/high; `bugs`, `performance` and `tests` Opus/high; the other angles and the scorer
     Sonnet/medium;
   - **the better of two runs**, as the target itself was.

   It reaches **must 2/2, should at least 3/4, overall at least 7/11**. Recorded for information:
   a run with all nine angles, and a run with the consumer's current configuration.

2. **Parity:** the parity test of § 3.2 is green.
3. **Concurrency:** two `issue` runs run side by side in one clone. A third asks; `y` starts it, and
   `N` waits and starts it when one ends. A run in another clone does not count.
4. **Worktrees:** every code-review round ran in its own worktree, which is gone afterwards while
   its report is kept.
5. **Draft:** every pull request opened is a draft.
6. **Run report:** for a code review it lists the lead and its subagents (every configured angle
   and the scorer) with their configured and used models, durations and tool calls. It also lists
   the plan ↔ plan-review loop count and every MCP tool called.
7. **Cleanup:** `clean --dry-run` lists exactly the orphaned worktrees and expired run directories,
   and no run report.
8. **Documentation:**
   - every file of § 3.10 exists, and its documentation tests are green;
   - the owner follows only the README and the guide on Windows, from a fresh clone of autoclaude
     to a first draft pull request on a project that has never used it;
   - every point where the documents did not suffice is fixed before Phase 1b closes.

## 5. Order of work (designer's call)

This amendment is **Phase 1b**, before the main design's Phase 2:

1. spike S6, then the skills 1:1 with subagents, and the parity test (§ 3.1, § 3.2);
2. `autoclaude bench` (§ 3.9), then acceptance 1;
3. single-issue runs with their entry gate, CI rounds, local concurrency, per-run locks and draft
   pull requests (§ 3.3, § 3.4, § 3.6);
4. review worktrees (§ 3.5);
5. logging (§ 3.7);
6. cleanup (§ 3.8);
7. the documentation pass and acceptance 8 (§ 3.10).

Each of steps 1–6 already updates the documents it touches, under § 3.10's rule; step 7 completes
the guide and walks through it.

The main design's Phase 2 (budget, daily triage, the queue, notifications) becomes the orchestrator
phase built on these runs.

## 6. Changes to the main design

- **C2**: superseded by § 3.1. The fan-out is the review lead's subagents inside the code-review
  stage, not engine processes.
- **C3**: superseded by § 3.2.
- **C11**: `review --pr` runs the code-review stage in a review worktree (§ 3.5) and keeps its
  report.
- **§ 2, goal 6, and § 9**: the day/night profiles are gone (§ 3.4); daily triage stays an
  orchestrator feature.
- **§ 7.2**: `prompts/` becomes `skills/` as in § 3.2.
- **§ 7.3**: the per-project instance lock becomes a per-run lock (§ 3.3).
- **§ 7.4**: the review stage's worktree is its own (§ 3.5); the dispatch file carries the resolved
  subagent models and the red-step verdict.
- **§ 8.2**: `concurrency.maxParallelRuns` and `retention.runDays` replace `schedule.profiles`,
  `caps.concurrency` and `caps.issuesPerNight`; both live in `config.local.json`.
- **§ 12**: publish opens drafts; auto-merge marks ready before merging (§ 3.6).
- **§ 14**: new or changed verbs: `issue <n> [--detach] [--force|--wait]`, `report <issue>`,
  `clean`, `check-rebased`, and `bench --base/--head`.
- **§ 15**: Phase 1b as in § 5, including the user documentation of § 3.10.
- **§ 17**: the prompt templating mechanism and the lead question are decided by § 3.1–3.2.

## 7. Left to the builder

- the stream-event mapping per runtime version;
- the exact text and layout of `watch`;
- how the PR summary is formatted, within one comment;
- how `--detach` is implemented per OS;
- whether a review worktree may reuse the implementation worktree's installed dependencies when
  the project declares that safe;
- the order in which the Phase 1 prompt files and the engine fan-out are retired, provided the
  parity test and acceptance 1 are green before they are deleted.
