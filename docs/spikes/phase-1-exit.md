# Phase 1 exit record

Date: 2026-10-17. The acceptance run of Task I3 ran on the first consumer project, a private web application whose source pipeline autoclaude replaces. It used autoclaude `main` at 422b848 plus the fence fix below.

## Setup

- **Machine:** Windows 11, Node 24.14, Git for Windows 2.55, claude 2.1.301. No real runs happened on macOS or Linux; CI covers those (I1 is green on all three OSes).
- **Configuration:** `.autoclaude/` was written by hand rather than by `autoclaude init`. It stayed local and uncommitted, and its ignore lines went into `.git/info/exclude`. This kept the consumer's tracked files untouched during the trial.
- **Separation from the source pipeline:** the source pipeline was still active on another machine, holding claims and open pull requests. So autoclaude got its own queue and working labels (`autoclaude-ready`, `autoclaude-working`, …) and its own `branchPrefix` (`autoclaude/`). The two never touched the same issue.
- **`worktrees.root`:** placed outside the checkout, so the project's own test discovery, `tsconfig` and ESLint never see the worktrees.
- **`doctor`:** green after the labels were created.

## Attended run: issue #319 to pull request #323

The issue was a small defect in a pure helper function, with three acceptance criteria.

| Attempt | Outcome | Cause |
| --- | --- | --- |
| 1 | blocked: "run ended without a report, twice" | **autoclaude defect, fixed.** The fence could not write the plan, see below. |
| 2 | blocked at the `test` gate | **Consumer environment.** 66 tests in one directory fail on Windows on the integration branch itself; they require POSIX `0700` permissions. autoclaude reported this precisely ("identical before my change"). For the trial, the local gate excludes that directory; CI still runs the full suite. |
| 3 | pull request #323 | Plan, plan review, implement and code review, then publish. |

**Pull request #323:**
- **Change:** +13/−1 in two files: the fix and two tests.
- **Red step:** `proven`.
- **Review:** all nine angles ran; every criterion has quoted evidence; there are no findings.
- **CI:** it did not start, because the consumer's GitHub Actions billing was exhausted. GitHub reported that the job was not started, and every required check failed after 2 s. Not an autoclaude matter. The pull request waits for its CI and for a human merge.

## Unattended night

Not run, by the owner's decision: the attended run covered the pipeline end to end, and the service itself is covered by H1's tests. **The Phase 1 exit criterion "at least one unattended night ending in a pull request" is therefore not met by this record.**

## Review benchmark

The benchmark used the diff of the source pipeline's run E: closed pull request #159, head `4cd27f0`, base `5f65a22`, 9 files, +787/−74.
- **Draft pull request:** `review --pr` reviews only open pull requests, so the same commit was pushed to a temporary branch under the trial prefix and opened as draft #328. Its diff is identical to #159's. Afterwards #328 was closed and the branch deleted.
- **Scoring:** `review --pr` does not keep the raw report (see below), so the posted comment was scored by hand with `bench`'s rules. A hit is a reported finding. "Seen" is an `uncertain` line that names the file or the rule family.

| Tier | Run 2 (target) | autoclaude | Seen, not reported |
| --- | --- | --- | --- |
| must (2) | 2/2 | 0/2 | 2 |
| should (4) | 3/4 | 1/4 | 2 (one missed) |
| overall (11) | 7/11 | 1/11 | 6 |

**The benchmark is below run 2 on must and should.**

The angles found both `must` findings and backed them with quotes from the installed framework sources. The scorer then gave them 3 and 6 against a threshold of 7. The scorer's attempt to re-read the diff with a compound shell command was refused by the permission layer. The loss is in scoring, not in finding.

## Defects and gaps found

1. **Fence: the report and plan directories were not writable (fixed).**
   - Claude Code refuses a path when a deny rule matches any directory above it ("File is in a directory that is denied"). This was verified live on 2.1.301.
   - The carve-out for a forbidden `.autoclaude/**` therefore denied `.autoclaude/state/reports/` and `plans/` through `.autoclaude/*` and `.autoclaude/state/*`.
   - Fix: deny the entries present at stage start by name. The test now checks every ancestor, as Claude Code does.
2. **`review --pr` cannot measure.** It refuses closed pull requests, fetches by head branch name (a deleted branch fails), and removes its worktree together with the raw report after posting. `bench` needs that report.
3. **CI that never started is read as red CI.** A billing or runner failure would send the entry into fix rounds that cannot succeed. The checks reported failure with zero steps; that state could be told apart.
4. **Compound shell commands are refused in review stages.** Commands such as `git diff … && git diff …`, `cat`, and `cd <worktree> && git diff` were refused by `dontAsk`, because not every part has an allow rule. The stages fell back to the Read and Grep tools; the scorer lost a verification step.
5. **The CLAUDE.md pointer invites `cat`.** Stages first tried `cat CLAUDE.md` through Bash. That was refused, and then they used the Read tool. Harmless, but one refused call per stage.
6. **The worktree has no `.autoclaude/config.json` when the config is not committed.** Angles that wanted `codeReview.scoreThreshold` reported it as uncertain. In normal use the config is committed, so this is specific to the trial.

## Deviations from the source pipeline's behaviour

- Plan, implement and review behaved as in the source: criteria evidence, a red-step verdict, fan-out over nine angles, and the scorer threshold.
- The benchmark recall is lower than run 2's, because the scorer drops what the angles found (see above).
- Separate labels and a separate branch prefix were a trial measure. At cut-over autoclaude uses the source's labels and prefix.
