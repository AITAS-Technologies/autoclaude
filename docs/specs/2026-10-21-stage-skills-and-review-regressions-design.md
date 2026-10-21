# Stage skills as the single source, and the review regressions of the Phase 1 benchmark

Date: 2026-10-21
Status: design amendment, approved by the owner in principle (skills per stage); details below are
the designer's calls unless marked as the owner's
Amends: `docs/specs/2026-10-16-autoclaude-design.md` — replaces call **C3**, extends **C2**, and
changes § 7.2, § 7.4, § 14 and § 17 as stated in § 6 below

## 1. Why

The Phase 1 acceptance run measured the code review against the source pipeline's benchmark (a
787-line React concurrency change with eleven independently adjudicated findings). The source
pipeline's best run reached 7 of 11 (must 2/2, should 3/4). autoclaude reached **1 of 11 (must 0/2,
should 1/4)**.

The run directory and the session transcripts of every review process were kept, so the loss
could be traced step by step instead of guessed at. It has four causes, and only one of them is the
configuration.

|                                              | Source, best run         | autoclaude run                                                            |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Whole review                                 | about 40 min             | 3 min                                                                     |
| `bugs` angle                                 | Opus, high effort        | Sonnet, medium; 8 tool calls, 21 s, "nothing wrong"                       |
| `tests` angle                                | Opus, high               | Sonnet, medium; 29 s                                                      |
| `performance` angle                          | Opus, high               | Opus, medium; 35 tool calls, found the must and quoted the library source |
| Candidates reaching the scorer               | all eleven at least seen | **3**                                                                     |
| Scorer on the scheduling regression (a must) | 9                        | **3**, without opening a single library file                              |

## 2. Root causes

**R1 — the comparison was not like for like.** The trial used the consumer's model configuration
of 2026-10-15, which had moved `bugs` and `tests` from Opus/high to Sonnet/medium and `performance`
from high to medium effort. Shallow angles explain most of the missing candidates. This is not an
engine defect, but a benchmark that does not pin the model configuration cannot tell an engine
regression from a cheaper configuration.

**R2 — a rule the source review never had.** Every review prompt (angles, scorer, criteria
re-check) and the plan prompt say: _"A denied command is the fence speaking: do not retry it or look
for another way to the same effect."_ The source carried that sentence only where it guards an
_effect_ — the implementer and the orchestrator. For a read-only reader it forbids reading by an
allowed route after a denied one. The scorer did exactly what it said: `git diff … | head -80` was
denied, and its next action was to submit its scores.

**R3 — the scorer lost its inputs.** In the source, the review lead handed the scorer the diff,
the criteria, the catalogue, the rubric, the false-positive list and the candidates. When the lead
became engine code, only the candidates and the catalogue survived; the scorer has to fetch the diff
itself, through the command that R2 then makes unrecoverable. The angles have the same gap: the
engine computes the file list and never hands any process the diff.

**R4 — the port drifted from proven text.** Splitting one 640-line review skill into fifteen
prompt files rewrote the text it moved. R2 entered that way, and R3 went unnoticed because no file
corresponded to the lead's step that handed the scorer its inputs. A port of text that a benchmark
was tuned on has to be checkable section by section against its source, and the fifteen-file layout
is not.

Aggravating, not causal: every review process lost one turn to a compound command (`| head`,
`; tail`, `cat`) that the fence denies segment by segment, as the source's fence also did.

## 3. Decisions

### 3.1 One skill per stage is the single source (owner's decision; replaces C3)

The stage instructions live as **one `SKILL.md` per stage**, as in the source pipeline, in the
standard skill format both runtimes read (`name` and `description` frontmatter, Markdown body,
supporting files beside it):

```
skills/
  autoclaude-triage/SKILL.md
  autoclaude-plan/SKILL.md
  autoclaude-plan-review/SKILL.md
  autoclaude-implement/SKILL.md
  autoclaude-implement/procedures/{test-driven-development,systematic-debugging,
                                   receiving-code-review,verification-before-completion}.md
  autoclaude-code-review/SKILL.md
NOTICE                          the superpowers MIT notice, as before
```

There is no orchestrate skill: the orchestrator is code (C1), and nothing a model reads describes
it.

**Names are fixed by convention, not configured:** `autoclaude-<stage>` with the stages `triage`,
`plan`, `plan-review`, `implement` and `code-review` — the source's scheme with the new prefix. The
folder name and the `name:` line agree, and a test fails if they do not.

### 3.2 The engine composes each process's instructions from named sections (extends C2)

A skill is written in level-two sections with fixed headings. The engine builds a process's prompt
by concatenating named sections of one skill, in order, under a short header that names the dispatch
file and the output contract; it never rewrites their text.

- **`autoclaude-code-review`** has, in this order: `## Inputs`, `## Rules for every reader`,
  `## What is not a finding`, `## Output for a reading`, one `## Angle: <name>` per angle,
  `## Scorer`, `## Output for the scorer`, `## Criteria re-check`, and `## By hand`.
  - an angle process = Inputs + Rules for every reader + What is not a finding + Output for a reading
    - its `## Angle: <name>`;
  - the scorer = Inputs + What is not a finding + Scorer + Output for the scorer;
  - the re-check = Inputs + Criteria re-check.
- **`autoclaude-plan-review`** has `## Inputs`, `## Finder`, `## Scorer`, `## Output`, `## By hand`
  and composes the same way.
- **Triage, plan and implement** are one process each and get their whole skill.

A skill contains **no template variables**. Every value a process needs — issue, mode, worktree,
integration ref, report and plan paths, findings, carried items, gate log, prior pull requests, the
rule catalogue, the diff — is in the dispatch file, and the skill text refers to "the dispatch file".
That keeps the files readable as skills and usable by hand.

### 3.3 Every reader gets the diff (fixes R3)

The engine writes the change once per review into the run directory: `change.diff`
(`git diff <remote>/<integration>...<head>` with `core.quotePath=false`) and `change.files`. The
dispatch file of every angle, the scorer and the re-check carries both paths and the diff's size.
The scorer additionally gets, as in the source: the acceptance criteria, the rule catalogue (both
halves), the rubric, the false-positive list and the candidates, and **no** angle's reasoning. The
plan-review scorer gets the plan file and the criteria the same way. A diff larger than the reader can
take in one read is still one file; the Read tool pages it.

### 3.4 What a denied command means depends on the stage (fixes R2)

- **Read-only stages** (every code-review and plan-review process, triage): a denied command means
  "this form is not allowed", never "stop looking". The skill says which forms run (one git reading
  command per call, no pipes, no `cat`/`grep`/`head`; the file tools for reading and searching) and
  that a denied form is replaced by the allowed one for the same reading. A finding the reader could
  not verify is `uncertain`, never a lower confidence on a candidate it did not check.
- **Stages that change things** (plan, implement): the source rule stays — a denied _effect_
  (a write outside the worktree, a network call, a forge call, running a file the stage wrote) is not
  reached another way.
- **The scorer must open what it scores.** A candidate whose message cites a library line is scored
  only after that line was opened; the scorer's output states for each candidate whether its quoted
  line and its citation were opened. A score for a candidate whose citation was not opened is
  refused by the engine and the scorer is re-run once; a second refusal makes the review `stopped`.

### 3.5 The benchmark pins its configuration (fixes R1)

`autoclaude bench <expected.json> --base <sha> --head <sha>` runs the engine-driven review on a
commit range in a detached worktree, keeps the report in the run directory, and scores it with the
existing `bench` matcher; it needs no pull request (closing the exit record's defect 2). A bench run
records the resolved model and effort of every process in its output, and a comparison between two
runs is only stated when those match. The project config may carry a `bench.models` block that
overrides `stages.codeReview` for bench runs only.

### 3.6 By hand

`autoclaude skills install` links `skills/autoclaude-*` into the user-level skill directories of
both runtimes (`~/.claude/skills/` and `~/.agents/skills/`), once per machine; `uninstall` removes
the links. Each skill's `## By hand` section is what a human-started session follows:

- **triage, plan, plan-review, implement:** first `autoclaude dispatch <stage> <issue>` in the
  worktree, which prefetches the same dispatch file the engine would write and prints its path; then
  the rest of the skill as written.
- **code-review:** `autoclaude review --pr <n>` or `autoclaude review --issue <n>` — the engine-driven
  review, so there is one implementation of the fan-out, not a second one in prose.

## 4. Acceptance

1. `autoclaude bench` on the source benchmark with the source's best-run configuration (`bugs`,
   `performance`, `tests` on Opus with high effort; other angles Sonnet/medium; scorer
   Sonnet/medium): **must 2/2, should at least 3/4, overall at least 7/11.**
2. The same with the consumer's current configuration, recorded for information; it decides whether
   the consumer's cheaper configuration is acceptable, not whether the engine is.
3. A parity check: for every section of the source's five stage skills, the new skill either
   contains it (text identical apart from the listed mechanical substitutions — paths, command
   names, "dispatch file" for template values) or the amendment's § 5 names where it went and why.
4. Tests: a skill's folder name equals its `name:`; every section the engine composes exists in
   exactly one skill; no skill contains `{{`; every process prompt of a review names `change.diff`;
   the read-only skills contain no "look for another way" rule and the implement and plan skills do;
   a scorer output with an unopened citation is refused and re-run once.

## 5. Where the source's sections go

| Source skill and section                                         | New place                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `autodev-code-review` Step 0 (targets and inputs)                | engine (§ 3.3), described for readers in `## Inputs`                                                |
| Step 1 (fan-out, model translation, dispatch notes, degradation) | engine (C2); no skill text                                                                          |
| Step 1b (the angles)                                             | `## Angle: <name>` ×9, text as in the source, stack-neutral wording kept from the port              |
| Rules for every angle                                            | `## Rules for every reader`, with § 3.4's read-only rule replacing the port's added sentence        |
| Step 1c (what is not a finding)                                  | `## What is not a finding`                                                                          |
| Step 2 (red step), Step 5 (paths)                                | engine; readers are told the verdict in the dispatch file                                           |
| Steps 3 and 4                                                    | the `bugs` and `invariants` angle sections, as in the source                                        |
| Step 6 (evidence filter, scorer, rubric)                         | filter: engine; scorer and rubric: `## Scorer`                                                      |
| Step 6a (measurement reconciliation)                             | engine plus `## Criteria re-check`                                                                  |
| Steps 7 and 8 (output, posting)                                  | engine; `## Output for a reading`, `## Output for the scorer`                                       |
| `autodev-plan-review` Steps 0–6 / 7 / 8                          | `## Finder` / `## Scorer` / `## Output`                                                             |
| `autodev-triage`, `autodev-plan`, `autodev-implement`            | one skill each, section for section, with the dispatch file for `gh issue view` and template values |
| `autodev-orchestrate`                                            | code (C1); no skill                                                                                 |

## 6. Changes to the main design

- **C3** is replaced by § 3.1–3.2 of this amendment.
- **C2** gains § 3.3 and § 3.4's scorer rule.
- **§ 7.2**: `prompts/` becomes `skills/` as in § 3.1.
- **§ 7.4**: the dispatch file of a review process also carries `change.diff` and `change.files`.
- **§ 14**: new verbs `skills install|uninstall`, `dispatch <stage> <issue>`, and `bench` gains
  `--base`/`--head`.
- **§ 17**: "whether prompts are also exported as skills" is decided (§ 3.6).

## 7. Left to the builder

The exact header the engine puts above composed sections; how `autoclaude dispatch` names its
output; whether `skills install` links or copies on Windows (a junction needs no elevation); the
schema field by which the scorer reports what it opened; the order in which the existing `prompts/`
files are folded into the skills, provided the parity check of § 4.3 is green before the old files are
deleted.
