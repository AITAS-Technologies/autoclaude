/**
 * What the orchestrator does next with a review: computed from the report, the ledger's
 * counters and the caps, never judged.
 *
 * This module is the library half. The command that consumed it has the exit-code contract
 * below (recorded for the verb that wraps it):
 *   exit 0  decided; the action is in the JSON
 *   exit 1  cannot decide — no ledger entry, no report, a malformed block, `criteria: none`
 *           from a worktree; the orchestrator's "run ended without a report" path
 *   exit 2  the report is not marked complete
 *   exit 64 the command line was wrong, which costs the review no retry
 *
 * It writes nothing — no label, no ledger transition, no archive — because those stay
 * with the orchestrator, where the handling of a failed `gh issue edit` lives. The seven
 * review rows of the orchestrator's table collapse to one per stage: run this, do what it
 * says. `publish.ts` calls the same `decide` and refuses to publish when the action is
 * anything but `publish`.
 *
 * Two things are checked here rather than believed, both from section 7 of the pipeline
 * design. The **evidence**: every quoted line has to be within five lines of the line the
 * finding states, in the worktree, or the claim is withdrawn to `uncertain` — and a
 * finding that quotes nothing at all is withdrawn too. Exempt are the findings that are
 * not claims about a line: a rule whose catalogue row calls its evidence a `measurement`,
 * because it is about what the diff does not contain, and the `tests/` must the parser
 * requires behind `red-step: not-proven`. A worktree that is not on disk runs no check at
 * all, because a claim that could not be tested is not a claim that failed. And
 * the **fingerprint**: a finding the previous archived report of the same stage already
 * carried is marked `seenBefore`, so a later item deferred in round 1 reads as noted
 * rather than as a new finding. Neither changes what a class means; the first withdraws
 * claims that do not hold and the second says what is a repeat.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadProjectConfig } from "../../config/load.js";
import type { ProjectConfig } from "../../config/types.js";
import type { InvariantRule } from "./invariants.js";
import { archivedReportsOf, foldNote, loadLedger, type LedgerEntry } from "../ledger/ledger.js";
import {
  classifyOptions,
  findingsAsMarkdown,
  findingsByTier,
  isReportComplete,
  parseCodeReviewReport,
  parsePlanReviewReport,
  readReport,
  TIER_HEADINGS,
  TIERS,
  type ClassifyOptions,
  type CodeReviewReport,
  type PlanReviewReport,
  type RedStepVerdict,
  type ReviewFinding,
  type ReviewReport,
} from "./reports.js";
import { normaliseEvidence, normaliseQuotedPath } from "./rules.js";
import { repoRoot } from "../root.js";

/** The two stages that produce findings, and therefore the two this script decides for. */
export type ReviewStage = "code-review" | "plan-review";
export const REVIEW_STAGES = ["code-review", "plan-review"] as const satisfies readonly ReviewStage[]; // prettier-ignore

/**
 * What happens to the issue next.
 *
 * `fix` dispatches the implementer (or the planner) with `Mode: fix` and the findings;
 * `block` releases the issue to a human; `publish` opens or updates the pull request;
 * `retry` re-runs the review while `caps.reviewRetries` allows, which is the bound the
 * orchestrator's own re-dispatch rule counts against; `proceed` moves a reviewed plan on
 * to implement. The first four are the code review's, the last the plan review's.
 */
export type DecisionAction = "fix" | "block" | "publish" | "retry" | "proceed";

/**
 * A finding as the decision sees it: the parser's finding plus the two facts this script
 * establishes.
 *
 * `seenBefore` says the previous archived report of the same stage already carried this
 * rule and this quoted line. `demotion` is the line that replaces the finding under
 * `uncertain` once its evidence did not verify, and is set only on the findings under
 * `Decision.demoted`.
 */
export interface DecidedFinding extends ReviewFinding {
  seenBefore: boolean;
  demotion?: string;
}

export interface Decision {
  action: DecisionAction;
  /**
   * `attempts.fix + 1`, or `attempts.plan + 1` for the plan review.
   *
   * It is also what "the first round" means, the round in which `later` items still cost
   * a round instead of travelling: a `firstRound` field beside it serialised `round === 1`
   * a second time.
   */
  round: number;
  /** The code review's red-step verdict; null for the plan review, which runs no tests. */
  redStep: RedStepVerdict | null;
  /**
   * Every finding that stood, in the report's own order, each with its `seenBefore` flag:
   * the report's findings minus what the evidence check withdrew.
   *
   * `publish.ts` renders the body from this list. It used to rebuild it by matching the
   * report's findings against the two lists below on a key of its own — a third notion of
   * a finding's identity beside the fingerprint and this script's — which worked only
   * while `establish` handed back its findings unchanged.
   */
  kept: DecidedFinding[];
  /**
   * The findings that drove the decision: must ∪ should ∪ (first round ? later : ∅) for
   * the code review, the must findings for the plan review.
   *
   * At the cap with no must open the action is `publish` and this list is not empty: the
   * should findings are both what rule 1 found and what travels to the pull request, so
   * they appear here and under `deferred`.
   */
  blocking: DecidedFinding[];
  /** What is carried forward rather than acted on now. */
  deferred: DecidedFinding[];
  /** The findings whose quoted line did not verify against the worktree, each with its note. */
  demoted: DecidedFinding[];
  /** The findings as a fix dispatch shows them: one section per tier, then the deferred list. */
  dispatchMarkdown: string;
  /** `<labels.fixRound><round>` for a fix, `<labels.reviewRetry><n>` for a retry, else null. */
  label: string | null;
  /** Whether this fix round is the last one and the config names a stage spec for it. */
  escalate: boolean;
  reason: string;
  /** The reason plus what it would cost to be wrong; `block` only, otherwise null. */
  releaseReason: string | null;
}

export interface DecideOptions {
  stage: ReviewStage;
  /**
   * The worktree the review read, for the evidence check. Absent — or empty, which a
   * reconciled entry can be — means no check: a relative join would read the main
   * working directory instead, and a caller reading an archive has no worktree to check
   * against at all.
   */
  worktree?: string;
  /** The newest archived report of the same stage, parsed against the same catalogue. */
  previous?: ReviewReport | null;
}

/** How far from the stated line a quoted line may be and still be the same line. */
const EVIDENCE_WINDOW = 5;

/**
 * Whether the finding names a file, a line and a quote, so that there is a check to run.
 *
 * The quote is measured after `normaliseEvidence`, which is what the lookup compares
 * with: it strips every quote character, so evidence made of nothing but backticks — or a
 * lone quote left over from an unbalanced one — normalises to the empty string, and
 * `String.includes("")` is true of every file there is. Such a finding verified against
 * whatever path it happened to name.
 */
function quotable(f: ReviewFinding): boolean {
  return f.file.trim() !== "" && f.line > 0 && normaliseEvidence(f.evidence) !== "";
}

/**
 * Whether the evidence check has no business touching this finding.
 *
 * Two kinds of finding are **mechanical facts** rather than claims about a line: a rule
 * whose catalogue row calls its evidence a `measurement`, and a `tests/` finding that
 * stands behind what the red step measured. Withdrawing one leaves the report saying one
 * thing and the decision another — the verdict still `not-proven`, the criterion still
 * `not met`, nothing blocking any more — and the change publishes with the missing proof
 * still missing. That is a contradiction the check must not be able to create, so it does
 * not run on them at all.
 *
 * The first kind is read off the finding, where `classify` put the row's own word. It was
 * a list of rule-id prefixes here — `spec/`, `plan/`, `paths/` — and a project's
 * `layer/schema-file-first` is an error rule of exactly that shape, "the diff as a whole"
 * against "a schema change with no schema file": not in the list, so withdrawn every
 * time it fired, and an open must became a publish. The list would have had to be edited
 * for every project that states a measurement rule, which is the one thing the engine
 * must not need.
 *
 * A rule the catalogue does not state never arrives here at all: `classify` sends its
 * finding to `uncertain`, having no level to classify it with.
 *
 * The red step's two verdicts differ in what the parser demands of them.
 * `red-step: not-proven` is refused without a `must` in the `tests/` family, so that must
 * is exempt. `no-test-files` demands nothing, and the skill has the reviewer report the
 * project's own coverage rule with the changed paths as evidence and **no line at all** —
 * a warning, not a must, and it was withdrawn every time, so the missing-test signal a
 * review correctly reported reached nobody.
 * Any `tests/` tier is therefore exempt behind that verdict.
 *
 * Deliberately not conditional on whether the finding happens to quote something. A
 * `spec/criterion-not-met` that adds a quote is still a finding about what the diff does
 * not contain, and a quote pointing at a line that has since moved is not evidence
 * against it.
 */
function exemptFromEvidence(f: ReviewFinding, redStep: RedStepVerdict | null): boolean {
  if (f.evidenceKind === "measurement") return true;
  if (!f.rule.startsWith("tests/")) return false;
  return redStep === "no-test-files" || (redStep === "not-proven" && f.tier === "must");
}

/**
 * The quoted file as a path inside the worktree, or null when it is not one.
 *
 * `path.join` does not reset on an absolute second segment: it concatenates, so
 * `join("C:/tree", "C:/tree/src/x.ts")` is a path that cannot exist, `readFileSync`
 * throws and the finding is withdrawn as "not found". Every tool inside a worktree prints
 * absolute paths and an angle naturally quotes what it read, so that was the commonest
 * shape there is. What comes off first is
 * `normaliseQuotedPath`'s business — the separators, a diff's `a/`/`b/` prefix, a
 * worktree's own directory, a POSIX drive letter — and it is `rules.ts`'s because the
 * fingerprint has to recognise the same file by the same rule.
 *
 * A path is accepted only when it lies inside the worktree the review was run against.
 * One that does not is **not** read: a quote that verifies in another checkout says
 * nothing about this tree, and reading it would let a finding pass its own check against
 * a file the diff never had. Null is that answer, and the reason names the path.
 *
 * Both shapes go through the one containment test, because `../` reaches out of the tree
 * exactly as an absolute path does: `join(worktree, "../../src/lib/a.ts")` is the main
 * checkout, and a sibling worktree is one segment further. The absolute branch enforced
 * containment and the relative branch did not, so that quote verified against a tree the
 * diff never had — and being a file away from every worktree, it is the common case
 * rather than a corner.
 */
function resolveQuotedFile(worktree: string, file: string, worktreesRoot?: string): string | null {
  const written = normaliseQuotedPath(file, worktreesRoot);
  const path = isAbsolute(written) ? written : join(worktree, written);
  const inside = relative(worktree, path);
  return inside.startsWith("..") || isAbsolute(inside) ? null : path;
}

/**
 * Whether the finding's quoted line is where the review said it is.
 *
 * The window is the stated line plus or minus five, because a diff read at one revision
 * and a worktree rebased since differ by a few lines, and the same normalisation the
 * fingerprint uses is applied to both sides: indentation, a reflowed argument list and a
 * requoted string are the same line. The window is normalised as one string, so a line
 * prettier wrapped is still found.
 *
 * A file that is not there is a miss — `lines` is null for it. That is the point of the
 * check ("roughly twenty lines of code that turn the strongest rule in the section from a
 * hope into a fact"), and a quote from a path that does not exist is exactly what it is
 * meant to catch.
 *
 * @param lines the file's lines, or null when it could not be read. Read by the caller,
 *   once per file: this used to read and split the file itself, per finding, and `decide`
 *   runs twice per publish — the orchestrator's, then `publish.ts`'s defence in depth.
 */
function evidenceFound(lines: string[] | null, f: ReviewFinding): boolean {
  if (lines === null) return false;
  const window = lines.slice(Math.max(0, f.line - 1 - EVIDENCE_WINDOW), f.line + EVIDENCE_WINDOW);
  return normaliseEvidence(window.join("\n")).includes(normaliseEvidence(f.evidence));
}

/**
 * Every finding with its two established facts, split into the ones that stand and the
 * ones whose evidence did not verify.
 *
 * Nothing is mutated: `decide` is pure, and `publish.ts` renders the very report it hands
 * in here.
 *
 * A named worktree that is not on disk runs **no** check at all, rather than one that
 * misses everything. A missing file inside the tree is a miss — that is what the check is
 * for — but a missing tree is an unrunnable check, and treating it as a miss withdrew every
 * finding of the report and turned an open must into a `publish`: reachable through
 * `--report <archive>` on an entry whose worktree has been removed, which is the one path
 * that never reads the tree for anything else.
 *
 * `unchecked` is the clause the reason carries when no check ran, and there are two ways
 * for that to happen: a worktree that was named and is gone, and an entry that names
 * none. The second used to be silent, so a decision made without any check read exactly
 * like one whose every quote verified.
 */
function establish(
  findings: ReviewFinding[],
  opts: DecideOptions,
  redStep: RedStepVerdict | null,
  worktreesRoot?: string,
): { kept: DecidedFinding[]; demoted: DecidedFinding[]; unchecked: string | null } {
  // Trimmed once and used everywhere below: `existsSync` on a real directory whose path
  // carries a trailing space is false, so an entry written by hand or by another tool
  // reported the tree as gone while it was there.
  const named = opts.worktree?.trim() ?? "";
  const tree = named !== "" && existsSync(named) ? named : null;
  const seen = new Set((opts.previous?.findings ?? []).map((f) => f.fingerprint));
  // One read per file rather than one per finding, and lazy: a report whose findings are
  // all exempt reads nothing at all. Null is a file that could not be read, which is a
  // miss and stays one — remembered, so a rule cited five times in a missing file does
  // not fail five reads.
  const read = new Map<string, string[] | null>();
  const linesOf = (path: string): string[] | null => {
    if (!read.has(path)) {
      try {
        read.set(path, readFileSync(path, "utf8").split(/\r?\n/));
      } catch {
        read.set(path, null);
      }
    }
    return read.get(path) ?? null;
  };
  const kept: DecidedFinding[] = [];
  const demoted: DecidedFinding[] = [];
  const withdraw = (decided: DecidedFinding, why: string) =>
    demoted.push({ ...decided, demotion: `${decided.rule} — ${why}` });
  for (const f of findings) {
    const decided: DecidedFinding = { ...f, seenBefore: seen.has(f.fingerprint) };
    // No tree, or a finding the parser's own consistency rules require: nothing to check.
    if (tree === null || exemptFromEvidence(f, redStep)) {
      kept.push(decided);
      continue;
    }
    if (!quotable(f)) {
      withdraw(decided, "no quotable line, and its rule is one whose evidence is a quoted line");
      continue;
    }
    const path = resolveQuotedFile(tree, f.file, worktreesRoot);
    if (path === null) {
      withdraw(
        decided,
        `${f.file} is outside the worktree the review read, so the quote could not be ` +
          `checked against the diff and the claim is withdrawn`,
      );
      continue;
    }
    if (!evidenceFound(linesOf(path), f)) {
      withdraw(
        decided,
        `the quoted line was not found within ${EVIDENCE_WINDOW} lines of ` +
          `${f.file}:${f.line} in the worktree, so the claim is withdrawn`,
      );
      continue;
    }
    kept.push(decided);
  }
  const unchecked =
    tree !== null
      ? null
      : named !== ""
        ? "the evidence was not checked, the worktree being gone"
        : "the evidence was not checked, the entry naming no worktree";
  return { kept, demoted, unchecked };
}

/** `2 must, 1 should` — the tiers a list holds, in the order a reader wants them. */
function tally(findings: DecidedFinding[]): string {
  const byTier = findingsByTier(findings);
  const parts = TIERS.filter((t) => byTier[t].length).map((t) => `${byTier[t].length} ${t}`);
  return parts.length ? parts.join(", ") : "nothing";
}

/** `1 fix round`, `2 fix rounds` — the plural named where an `s` is not it. */
function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** The rules a release reason names, each once, in the order they were reported. */
function ruleList(findings: DecidedFinding[]): string {
  return [...new Set(findings.map((f) => f.rule))].join(", ");
}

/**
 * What it would cost to be wrong, by the family of the first open must finding.
 *
 * A blocked issue waits for a human, and the sentence that decides whether they look at
 * it today is what happens if the review was wrong. The families are the design note's;
 * everything else gets the general sentence rather than no sentence, because a new family
 * must not silently produce a release reason that stops mid-line.
 */
const COST: ReadonlyArray<readonly [string, string]> = [
  ["spec/", "a criterion ships unmet"],
  ["tests/", "the change ships without a test that proves it"],
  ["bug/", "a regression ships"],
  ["perf/", "a regression ships"],
  ["paths/", "a fenced path changes without a human"],
  ["security/", "a vulnerability ships"],
];
const COST_OTHERWISE = "a finding the review called must ships";

function costOf(must: DecidedFinding[]): string {
  const first = must[0];
  if (first === undefined) return COST_OTHERWISE;
  return COST.find(([family]) => first.rule.startsWith(family))?.[1] ?? COST_OTHERWISE;
}

/**
 * The findings as the implementer or the planner reads them in a fix round.
 *
 * Grouped through `findingsByTier` and rendered through `findingsAsMarkdown`, the two
 * helpers `reports.ts` already owns: the tier is what says what a finding costs, and the
 * implementer cannot work that out from the rule id. Deliberately not `tierSections`,
 * whose contract is a one-line renderer plus an intro sentence for the pull request body
 * and the review comment — putting the three-line form through it would either duplicate
 * that form here or number every finding twice.
 *
 * The deferred section's heading names the tiers it holds, so the code review's
 * "Deferred (later)" stays literal while a plan round's deferred list, which carries
 * should items too, does not claim they are later items.
 *
 * A plan review that proceeds renders its deferred list too, and nothing else: the fresh
 * implement dispatch carries it, not owed, to the implementer who is about to write the
 * tests those findings are about. Before, the list reached only the pull request body; in
 * one run that was a `tests/no-positive-control` at confidence 9 against the very test the
 * implementer then wrote without one.
 */
function dispatchMarkdown(
  action: DecisionAction,
  blocking: DecidedFinding[],
  deferred: DecidedFinding[],
): string {
  const out: string[] = [];
  const byTier = findingsByTier(blocking);
  for (const tier of TIERS) {
    const group = byTier[tier];
    if (!group.length) continue;
    // `TIER_HEADINGS` itself: the alias this file kept overrode nothing.
    out.push(`### ${TIER_HEADINGS[tier]} (${group.length})`, "", findingsAsMarkdown(group), "");
  }
  if ((action === "fix" || action === "proceed") && deferred.length) {
    const tiers = TIERS.filter((t) => deferred.some((f) => f.tier === t)).join(", ");
    out.push(`### Deferred (${tiers})`, "", findingsAsMarkdown(deferred), "");
  }
  return out.join("\n").trimEnd();
}

/**
 * The orchestrator's next action, in the design note's order.
 *
 * Code review, with `fix = attempts.fix` and `cap = caps.fixRounds`:
 *
 * 1. `blocking = must ∪ should ∪ (firstRound ? later : ∅)`. Not empty:
 *    `fix < cap` is a **fix** round (the later items travel as deferred from the second
 *    round on); at the cap an open must **blocks**, with what it would cost to be wrong;
 *    at the cap with no must the change **publishes**, the open should items in the body.
 * 2. `red-step: could-not-run` with nothing blocking is a **retry** while
 *    `attempts.reviewRetry < caps.reviewRetries`, because a crashed install can clear on
 *    its own. The note says "once"; the cap is what the orchestrator's own re-dispatch
 *    rule and the config count against, on this same counter.
 * 3. Otherwise **publish**, the later items noted.
 *
 * Rule 1 precedes rule 2, which is what "a must is never set aside for a retry" means.
 *
 * Plan review: `blocking = must`; below `caps.planRounds` a **fix** round with should and
 * later travelling as deferred, at the cap a **block**, otherwise **proceed**. Should and
 * later alone never start a plan round.
 *
 * @param report the parsed report; its findings are already classified by the catalogue
 *   and the scorer's confidence, which is the one place a class is computed
 * @param attempts the ledger entry's counters, cached from the labels
 */
export function decide(
  report: CodeReviewReport | PlanReviewReport,
  attempts: LedgerEntry["attempts"],
  cfg: ProjectConfig,
  opts: DecideOptions,
): Decision {
  const isCode = opts.stage === "code-review";
  // A property test rather than a cast: the plan review's report has no red step, and
  // nothing here may read one off it.
  const codeReport = isCode && "redStep" in report ? report : null;
  const { kept, demoted, unchecked } = establish(
    report.findings,
    opts,
    codeReport?.redStep ?? null,
    cfg.worktrees?.root,
  );
  const byTier = findingsByTier(kept);
  const spent = isCode ? attempts.fix : attempts.plan;
  const cap = isCode ? cfg.caps.fixRounds : cfg.caps.planRounds;
  const round = spent + 1;
  const firstRound = spent === 0;
  // What the check did, in the reason, because both of its answers change what the
  // decision rests on: findings withdrawn, or nothing checked at all.
  const withdrawn =
    unchecked !== null
      ? `; ${unchecked}`
      : demoted.length
        ? `; ${demoted.length} withdrawn for evidence that did not verify in the worktree`
        : "";

  const assemble = (
    action: DecisionAction,
    parts: {
      blocking: DecidedFinding[];
      deferred: DecidedFinding[];
      reason: string;
      label?: string | null;
      releaseReason?: string | null;
      escalate?: boolean;
    },
  ): Decision => ({
    action,
    round,
    redStep: codeReport?.redStep ?? null,
    kept,
    blocking: parts.blocking,
    deferred: parts.deferred,
    demoted,
    dispatchMarkdown: dispatchMarkdown(action, parts.blocking, parts.deferred),
    label: parts.label ?? null,
    escalate: parts.escalate ?? false,
    reason: `${parts.reason}${withdrawn}`,
    releaseReason: parts.releaseReason ?? null,
  });

  const blocking = isCode
    ? [...byTier.must, ...byTier.should, ...(firstRound ? byTier.later : [])]
    : byTier.must;
  const nonBlocking = isCode ? byTier.later : [...byTier.should, ...byTier.later];
  const what = isCode ? "fix round" : "plan revision";

  // Rule 1: something has to be addressed.
  if (blocking.length) {
    // The code review's later items are blocking in the first round and deferred from the
    // second; the plan review defers its should and later items in every round.
    const deferred = isCode && firstRound ? [] : nonBlocking;
    const capSpent = `${plural(cap, what)} are spent`;
    if (spent < cap) {
      const carried = deferred.length ? `; ${plural(deferred.length, "item")} deferred` : "";
      return assemble("fix", {
        blocking,
        deferred,
        reason: `${what} ${round} of ${cap} on ${tally(blocking)}${carried}`,
        // The implementer's label and the implementer's escalated model: a plan round has
        // neither. `reconcile` rebuilds `attempts.fix` from the fix-round labels, so
        // labelling a plan round would spend one of the implementer's rounds, and the
        // escalated model is the one a last *implement* attempt is worth.
        label: isCode ? `${cfg.labels.fixRound}${round}` : null,
        escalate: isCode && round === cap && cfg.stages.implement.escalated !== undefined,
      });
    }
    if (byTier.must.length) {
      const reason =
        `${capSpent} and ${plural(byTier.must.length, "must finding")} ` +
        `${byTier.must.length === 1 ? "is" : "are"} open: ${ruleList(byTier.must)}`;
      return assemble("block", {
        blocking,
        deferred: [],
        reason,
        // The reason plus the cost, so the sentence a human reads on the issue ends in
        // what happens if the review was wrong.
        releaseReason: `${reason}${withdrawn} — if wrong, ${costOf(byTier.must)}`,
      });
    }
    // The cap with nothing that blocks a merge: the change publishes and the human decides
    // whether the open should items block it. The plan review never arrives here — its
    // blocking set *is* its must set, so the branch above has already answered.
    //
    // Everything that stood is what travels, which at this branch is `kept` itself: the
    // must list is empty, so must ∪ should ∪ later is should ∪ later, in the order the
    // report stated them rather than grouped by tier twice over.
    return assemble("publish", {
      blocking,
      deferred: kept,
      reason: `${capSpent} and no must finding is open; ${tally(kept)} travel to the pull request`,
    });
  }

  // Rule 2: the red step could not run, and that is worth a re-dispatch while the retry
  // cap has one left. The counter is shared with runs that ended without a report and is
  // not reset per fix round, so a review whose predecessor crashed may already have spent
  // it — which is why the cap, and not the note's literal `=== 0`, is the condition
  //.
  if (codeReport?.redStep === "could-not-run" && attempts.reviewRetry < cfg.caps.reviewRetries) {
    return assemble("retry", {
      blocking: [],
      deferred: nonBlocking,
      reason: `the red step could not run (${foldNote(codeReport.reason)}) and nothing is blocking, so the code review runs again as retry ${attempts.reviewRetry + 1} of ${cfg.caps.reviewRetries}`,
      label: `${cfg.labels.reviewRetry}${attempts.reviewRetry + 1}`,
    });
  }

  // Rule 3: nothing is blocking.
  const noted = nonBlocking.length ? `; ${tally(nonBlocking)} noted` : "";
  const repeatedFailure =
    codeReport?.redStep === "could-not-run"
      ? `the red step could not run (${foldNote(codeReport.reason)}) and ${plural(attempts.reviewRetry, "retry", "retries")} of the review ${attempts.reviewRetry === 1 ? "is" : "are"} spent against a cap of ${cfg.caps.reviewRetries}, so nothing more is blocking`
      : null;
  return assemble(isCode ? "publish" : "proceed", {
    blocking: [],
    deferred: nonBlocking,
    reason: repeatedFailure ?? `nothing is blocking after ${plural(spent, what)}${noted}`,
  });
}

// --- from the ledger and the report on disk -------------------------------

export interface DecisionDeps {
  /**
   * The main working directory: the one place on this machine that holds the ledger and
   * the run archive. Defaults to `repoRoot(process.cwd())`, deliberately not `process.cwd()`, which in
   * an orchestrated run is a worktree of its own.
   */
  root?: string;
  stage?: ReviewStage;
  /** `--report <path>`: the report to read instead of the entry worktree's copy. */
  report?: string;
  /**
   * The config and the catalogue the findings are read against. Both default to the
   * checkout this code runs in, as `reports.ts` and `post-review.ts` load them: they
   * belong to the code version, while the state belongs to `root`.
   */
  cfg?: ProjectConfig;
  catalogue?: InvariantRule[];
}

export interface DecisionResult {
  code: 0 | 1 | 2;
  decision: Decision | null;
  /** The one line the CLI prints to stderr: `issue N: <action> — <reason>`. */
  message: string;
}

/**
 * The newest archived report of the same stage, parsed — or null when there is none.
 *
 * A previous archive that does not parse is not fatal and is read as "no previous": the
 * only thing it would have said is which findings are repeats, and refusing to decide
 * over an old file would strand a run on an archive nobody can fix any more.
 *
 * `deciding` is the file the caller is deciding about, and an archive at that same path is
 * skipped in favour of the one before it. `--report <archive>` is the documented way to
 * decide about an archived report, and the previous round used to be resolved
 * independently of it: pointed at the newest archive — the obvious thing to point it at —
 * the report being decided *was* the previous one, so its own fingerprints were the `seen`
 * set and a first-round report came back marked as all repeats.
 *
 * Exported for `publish.ts`, the second caller of `decide`: it has to hand in the same
 * `previous` this one does, or the same report would mark repeats here and not there.
 */
export function previousReport(
  root: string,
  issue: number,
  stage: ReviewStage,
  opts: ClassifyOptions,
  deciding?: string,
): ReviewReport | null {
  try {
    const decided = deciding === undefined ? null : resolve(deciding);
    const archived = archivedReportsOf(root, issue, stage).find(
      (a) => decided === null || resolve(a.path) !== decided,
    );
    if (archived === undefined) return null;
    return stage === "code-review"
      ? parseCodeReviewReport(archived.text, opts)
      : parsePlanReviewReport(archived.text, opts);
  } catch {
    return null;
  }
}

/**
 * The decision for one issue: the ledger entry, the report, the previous archive, then
 * `decide`.
 *
 * The order is the design note's. Completeness is answered first, on the shared shape,
 * because an interrupted reviewer usually never wrote its verdict and asking the code
 * review's own checks first blames a missing field for what is really a stopped run.
 */
export function reviewDecision(issue: number, deps: DecisionDeps = {}): DecisionResult {
  const stage = deps.stage ?? "code-review";
  const root = deps.root ?? repoRoot(process.cwd());
  const line = (what: string, why: string, code: 0 | 1 | 2): DecisionResult => ({
    code,
    decision: null,
    // Folded, because the message is one line by contract and a thrown error's text is
    // not: `loadProjectConfig` alone refuses over several lines.
    message: foldNote(`issue ${issue}: ${what} — ${why}`),
  });
  const cannot = (why: string) => line("cannot-decide", why, 1);

  const entry = loadLedger(root).issues[String(issue)];
  if (entry === undefined) {
    return cannot("no ledger entry on this machine, so there is no run to decide about");
  }

  let text: string;
  if (deps.report !== undefined) {
    try {
      text = readFileSync(deps.report, "utf8");
    } catch (error) {
      return cannot(`the report ${deps.report} cannot be read: ${String(error)}`);
    }
  } else {
    // An empty worktree is refused rather than joined, the trap `ledger.ts` records: the
    // relative path would resolve against the main working directory, which is the one
    // directory the engine never touches and has exactly that file.
    if (!entry.worktree) {
      return cannot("the ledger entry names no worktree, so the report has no path");
    }
    try {
      text = readReport(entry.worktree, stage);
    } catch (error) {
      return cannot(`no ${stage} report in the worktree: ${String(error)}`);
    }
  }

  try {
    if (!isReportComplete(stage, text)) {
      return line("incomplete", `the ${stage} report is not marked complete, so the run did not finish`, 2); // prettier-ignore
    }
  } catch (error) {
    return cannot(`the ${stage} block does not parse: ${String(error)}`);
  }

  const cfg = deps.cfg ?? loadProjectConfig(root);
  // `reports.ts`'s loader, not a fourth copy of the same two lines: a copy that reads the
  // other stage's `scoreThreshold` classifies every finding against another number and
  // fails nowhere.
  const opts = classifyOptions(stage, { cfg, catalogue: deps.catalogue, projectRoot: root });
  let report: CodeReviewReport | PlanReviewReport;
  try {
    report =
      stage === "code-review"
        ? parseCodeReviewReport(text, opts)
        : parsePlanReviewReport(text, opts);
  } catch (error) {
    return cannot(`the ${stage} report does not parse: ${String(error)}`);
  }
  // A worktree review always has its issue, so `criteria: none` from one is a run that
  // ended without a usable report, treated exactly like a missing block.
  if ("criteriaNone" in report && report.criteriaNone) {
    return cannot(
      "the review reports `criteria: none`, and a review of this issue's worktree always has its criteria",
    );
  }

  const decision = decide(report, entry.attempts, cfg, {
    stage,
    worktree: entry.worktree,
    previous: previousReport(root, issue, stage, opts, deps.report),
  });
  return { code: 0, decision, message: foldNote(`issue ${issue}: ${decision.action} — ${decision.reason}`) }; // prettier-ignore
}
