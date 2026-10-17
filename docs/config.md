# Configuration

A project is configured by `.autoclaude/config.json`, committed to the project. A developer's own values go in `.autoclaude/config.local.json`, which `autoclaude init` adds to `.gitignore`. Both files are JSON. A leading UTF-8 byte order mark and CRLF line endings are accepted.

The loader checks every key. An unknown key, a wrong type or a missing required key is an error that names the file and the dotted key, for example `config.json: caps.fixRounds must be a whole number of at least 1 but is 0`. `autoclaude doctor` runs the same check.

## Phase 1 status

Phase 1 acts on every key except these, which are accepted and validated but not acted on yet: `budget`, `triage` (all of it) and `automerge`. Phase 1 opens pull requests and never merges them.

## Keys

"Local" says whether `config.local.json` may set the key. "Default" is what applies when the key is absent; "required" means the file does not load without it.

| Key                                        | Type                                | Default                     | Local  | Notes                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------- | --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoclaude`                               | string                              | required                    | no     | Engine version range. Only the form `>=X.Y.Z` is accepted, for example `">=0.1.0"`.                                                                            |
| `forge.remote`                             | string                              | `"origin"`                  | no     | The git remote. Every git call uses it, and every `gh` call names the repository resolved from it.                                                             |
| `branches.integration`                     | string                              | required                    | no     | The branch pull requests target.                                                                                                                               |
| `branches.production`                      | string                              | required                    | no     | The release branch. Must differ from `integration`.                                                                                                            |
| `branchPrefix`                             | string                              | `"agent/"`                  | no     | Prefix of the branches autoclaude creates. Lowercase letters, digits and hyphens, ending in `/`.                                                               |
| `humans`                                   | string list                         | `[]`                        | yes    | GitHub logins that may be mentioned in autoclaude's text. Every other mention is defused.                                                                      |
| `bootstrap`                                | string                              | none                        | no     | Command run through `bash -c` in a fresh worktree before the first stage (for example an install).                                                             |
| `gates`                                    | list of gates                       | required                    | no     | The quality gates. See "Gates". May be empty.                                                                                                                  |
| `redStep.testFiles`                        | string list                         | required, non-empty         | no     | Globs that identify test files.                                                                                                                                |
| `redStep.supportFiles`                     | string list                         | `[]`                        | no     | Globs of files that support tests (fixtures, helpers).                                                                                                         |
| `redStep.exclude`                          | string list                         | `[]`                        | no     | Globs excluded from the test-file match.                                                                                                                       |
| `redStep.run`                              | string                              | required                    | no     | Command that runs the new tests; `{files}` stands for the test files.                                                                                          |
| `redStep.result`                           | `"junit"` or `"exit-code"`          | required                    | no     | How the result of `run` is read.                                                                                                                               |
| `redStep.install.when`                     | string                              | none                        | no     | A file path. When its content differs between the integration branch and the change, `install.run` runs in the base worktree first. `install` needs both keys. |
| `redStep.install.run`                      | string                              | none                        | no     | Command run before the red step when `when` holds.                                                                                                             |
| `worktrees.root`                           | string                              | `".autoclaude/worktrees"`   | no     | Where worktrees are created. Relative to the project root, or absolute.                                                                                        |
| `worktrees.copy`                           | string list                         | `[]`                        | no     | Files copied from the main checkout into each new worktree. A name that does not exist, and a symbolic link, is skipped and noted; a link is never followed.   |
| `stages`                                   | object                              | required                    | partly | See "Stages".                                                                                                                                                  |
| `codeReview.angles`                        | list                                | all nine angles             | no     | The readings the review fans out to. Must contain `criteria`; no repeats.                                                                                      |
| `codeReview.scoreThreshold`                | integer 1-10                        | `7`                         | no     | Findings scored below this are dropped.                                                                                                                        |
| `planReview.scoreThreshold`                | integer 1-10                        | `7`                         | no     | The same for the plan review.                                                                                                                                  |
| `queue.ready`                              | string                              | required                    | no     | The label that marks an issue ready for work.                                                                                                                  |
| `queue.priority`                           | string list                         | `[]`                        | no     | Labels that put an issue ahead in the queue.                                                                                                                   |
| `labels.working`                           | string                              | required                    | no     | Label for an issue in progress.                                                                                                                                |
| `labels.blocked`                           | string                              | required                    | no     | Label for an issue that needs a human.                                                                                                                         |
| `labels.needsShaping`                      | string                              | required                    | no     | Label for an issue whose criteria are not yet clear.                                                                                                           |
| `labels.fixRound`                          | string                              | required                    | no     | Prefix of the fix-round counter label (`agent-fix-` gives `agent-fix-1`, `agent-fix-2`, ...).                                                                  |
| `labels.reviewRetry`                       | string                              | required                    | no     | Prefix of the review-retry counter label.                                                                                                                      |
| `humanApproval`                            | list of `{paths, label}`            | `[]`                        | no     | A change touching any of the `paths` globs gets `label`. `paths` is non-empty.                                                                                 |
| `labelRules`                               | list                                | `[]`                        | no     | Labels applied to pull requests by changed paths. See "Label rules".                                                                                           |
| `requiredChecks`                           | string list                         | required, non-empty         | no     | Names of the CI checks that must pass.                                                                                                                         |
| `forbiddenPaths`                           | string list                         | required, non-empty         | no     | Globs a stage may not write. `publish` refuses to push a diff that touches them.                                                                               |
| `policyAdjacentPaths`                      | string list                         | `[]`                        | no     | Globs treated like `forbiddenPaths` at publish, and flagged to the review.                                                                                     |
| `policyAdjacentReason`                     | string                              | none                        | no     | Text given to the review about those paths.                                                                                                                    |
| `fence.allow`                              | string list                         | `[]`                        | no     | Extra command prefixes a stage may run (for example `npx vitest`). See [security.md](security.md).                                                             |
| `caps.concurrency.day`                     | integer >= 0                        | required                    | no     | Stages run in parallel during the day profile. `0` takes no work.                                                                                              |
| `caps.concurrency.night`                   | integer >= 0                        | required                    | no     | The same at night.                                                                                                                                             |
| `caps.fixRounds`                           | integer >= 1                        | required                    | no     | Rounds of fixes after review findings or red CI.                                                                                                               |
| `caps.reviewRetries`                       | integer >= 1                        | required                    | no     | Retries of a review that did not produce a decidable report.                                                                                                   |
| `caps.planRounds`                          | integer >= 1                        | required                    | no     | Plan and plan-review rounds.                                                                                                                                   |
| `caps.issuesPerNight`                      | integer >= 1                        | required                    | no     | Issues claimed per night.                                                                                                                                      |
| `caps.wallClockMinutesPerStage`            | integer >= 1                        | required                    | no     | A stage running longer is stopped.                                                                                                                             |
| `caps.openPullRequests`                    | integer >= 1                        | required                    | no     | No new work while this many autoclaude pull requests are open.                                                                                                 |
| `caps.staleClaimHours`                     | integer >= 1                        | required                    | no     | Age after which a claim may be taken over.                                                                                                                     |
| `caps.maxTurnsPerStage`                    | integer >= 1                        | `200`                       | no     | Turn limit passed to each stage.                                                                                                                               |
| `schedule.timezone`                        | string                              | required                    | yes    | IANA time zone, for example `"Europe/Berlin"`.                                                                                                                 |
| `schedule.profiles.day.from`               | `HH:MM`                             | required                    | yes    | Start of the day profile.                                                                                                                                      |
| `schedule.profiles.day.to`                 | `HH:MM`                             | required                    | yes    | End of the day profile.                                                                                                                                        |
| `schedule.profiles.nightStopsTakingWorkAt` | `HH:MM`                             | required                    | yes    | The night profile stops taking new work at this time.                                                                                                          |
| `budget.<runtime>.fiveHourPct`             | number 0-100                        | none                        | yes    | Not acted on in Phase 1. `<runtime>` is `claude` or `codex`.                                                                                                   |
| `budget.<runtime>.weeklyPct`               | number 0-100                        | none                        | yes    | Not acted on in Phase 1.                                                                                                                                       |
| `triage.since`                             | `YYYY-MM-DD`                        | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `triage.optInLabel`                        | string                              | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `triage.maxPerDay`                         | integer >= 1                        | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `triage.at`                                | `HH:MM`                             | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `automerge.enabled`                        | boolean                             | none                        | no     | Not acted on in Phase 1. If `automerge` is present, all four keys are required.                                                                                |
| `automerge.label`                          | string                              | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `automerge.categories`                     | string list                         | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `automerge.method`                         | `"squash"`, `"merge"` or `"rebase"` | none                        | no     | Not acted on in Phase 1.                                                                                                                                       |
| `messages.footer`                          | string                              | `"Generated by autoclaude"` | no     | Footer on the text autoclaude posts.                                                                                                                           |
| `messages.defuseMentions`                  | boolean                             | `true`                      | no     | Defuse `@` mentions in text autoclaude posts, except those of `humans`.                                                                                        |

The nine code-review angles are `criteria`, `bugs`, `invariants`, `history`, `prior-prs`, `comments`, `performance`, `tests` and `security`.

### Gates

Each entry of `gates` has:

| Key     | Type                  | Notes                                                            |
| ------- | --------------------- | ---------------------------------------------------------------- |
| `name`  | string                | Required. Unique.                                                |
| `check` | string                | Required. The command; exit 0 passes.                            |
| `fix`   | string                | Optional. A command that repairs what `check` reports.           |
| `when`  | non-empty string list | Optional. Globs; the gate runs only when a changed file matches. |

Project commands (`bootstrap`, `check`, `fix`, `redStep.run`, `redStep.install.run`) run through `bash -c` on every OS. On Windows that is the bash of Git for Windows.

`redStep.run` and `redStep.install.run` always run in the stage environment, with no forge credential and no git access over https or ssh ([security](security.md#layer-1-the-stage-environment)). So does `bootstrap`, except in a fresh worktree of the integration branch before any stage has run in it: a worktree recreated from a pushed agent branch, and a pull request's head under `autoclaude review --pr`, hold a stage's work. An install that needs credentials (a private registry, a dependency fetched over git) fails there.

### Label rules

Each entry of `labelRules` has `when` (non-empty list of path globs), `label` (required) and, optionally, `unless` (path globs that cancel the rule) and `suppressedBy` (a label that suppresses it).

### Stages

`stages` has five required keys: `triage`, `plan`, `planReview`, `implement` and `codeReview`. A stage spec is:

| Key        | Type                                     | Default    |
| ---------- | ---------------------------------------- | ---------- |
| `runtime`  | `"claude"` or `"codex"`                  | required   |
| `model`    | string                                   | required   |
| `effort`   | `"low"`, `"medium"`, `"high"` or `"max"` | `"medium"` |
| `fallback` | `{runtime, model, effort}`               | none       |

Further keys:

- `stages.planReview.scorer` (required): the spec of the scorer.
- `stages.implement.escalated` (optional): the spec used for an escalated attempt.
- `stages.codeReview.scorer` (required): the spec of the scorer.
- `stages.codeReview.angles` (required): an object with a `default` spec and, optionally, a spec for any named angle, which overrides the default for that angle.
- `stages.codeReview.parallel` (integer >= 1, default `4`): reviewers run at once.

Phase 1 runs Claude Code only. Set `runtime` to `"claude"` everywhere. `"codex"` passes validation but is not supported yet. `effort: "max"` is accepted; `doctor` warns that its value for `claude --effort` is unverified.

## `config.local.json`

The file holds a developer's own values, not the project's. Only four top-level keys may appear: `budget`, `schedule`, `humans` and `stages`. Any other key is an error: `config.local.json: <key> is not a personal setting`.

- It is merged over `config.json`: objects merge key by key; lists and scalars replace.
- Under `stages` it may only change `runtime`, `model`, `effort` and `fallback` of a stage spec that `config.json` already has. That covers `triage`, `plan`, `planReview` (and its `scorer`), `implement` (and `escalated`), `codeReview.scorer` and each `codeReview.angles.<angle>`. It cannot add a stage, and it cannot set `codeReview.parallel`.
- `config.json` must be valid on its own. The merged result is validated again, and errors there name `config.local.json`.

Example, using another model for planning and another time zone on one machine:

```json
{
  "stages": {
    "plan": { "model": "sonnet", "effort": "medium" }
  },
  "schedule": {
    "timezone": "Europe/Berlin"
  }
}
```

## A complete minimal example

This is the template `autoclaude init` writes. Change the branch names, gates and test patterns to match the project.

```json
{
  "autoclaude": ">=0.1.0",
  "forge": { "remote": "origin" },
  "branches": { "integration": "main", "production": "release" },
  "humans": [],
  "gates": [{ "name": "test", "check": "npm test" }],
  "redStep": {
    "testFiles": ["test/**/*.test.*", "tests/**/*.test.*"],
    "run": "npm test -- {files}",
    "result": "exit-code"
  },
  "stages": {
    "triage": { "runtime": "claude", "model": "sonnet", "effort": "medium" },
    "plan": { "runtime": "claude", "model": "opus", "effort": "high" },
    "planReview": {
      "runtime": "claude",
      "model": "opus",
      "effort": "medium",
      "scorer": { "runtime": "claude", "model": "sonnet", "effort": "low" }
    },
    "implement": { "runtime": "claude", "model": "sonnet", "effort": "medium" },
    "codeReview": {
      "angles": { "default": { "runtime": "claude", "model": "sonnet", "effort": "medium" } },
      "scorer": { "runtime": "claude", "model": "sonnet", "effort": "low" }
    }
  },
  "codeReview": { "angles": ["criteria", "bugs", "tests", "security"], "scoreThreshold": 7 },
  "queue": { "ready": "agent-ready" },
  "labels": {
    "working": "agent-working",
    "blocked": "agent-blocked",
    "needsShaping": "needs-shaping",
    "fixRound": "agent-fix-",
    "reviewRetry": "agent-retry-"
  },
  "requiredChecks": ["test"],
  "forbiddenPaths": [".github/workflows/**", ".autoclaude/**"],
  "caps": {
    "concurrency": { "day": 1, "night": 2 },
    "fixRounds": 2,
    "reviewRetries": 2,
    "planRounds": 2,
    "issuesPerNight": 5,
    "wallClockMinutesPerStage": 60,
    "openPullRequests": 4,
    "staleClaimHours": 2
  },
  "schedule": {
    "timezone": "UTC",
    "profiles": { "day": { "from": "08:00", "to": "20:00" }, "nightStopsTakingWorkAt": "05:00" }
  }
}
```

The labels in `queue` and `labels`, the counter labels (`agent-fix-1` up to `caps.fixRounds`, `agent-retry-1` up to `caps.reviewRetries`), and every label in `humanApproval` and `labelRules` must exist on the repository. `autoclaude init --create-labels` creates the missing ones. The labels in `queue.ready` and `labels` must all differ from each other.
