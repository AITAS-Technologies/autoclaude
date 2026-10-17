/**
 * The merge decision from design section 7, as code and not a judgement.
 *
 * Library half; the verb that wraps it is built later (`can-merge <pr> [--json]`) and its
 * exit-code contract is recorded here for it:
 *   exit 0  merge allowed: every check passed
 *   exit 1  refused (a check failed or is unavailable) or the verdict could not be
 *           computed at all (a `gh` or git call failed)
 * With `--json` the verb prints `{ pr, review: { issue, archive } | null, allowed, checks }`
 * (`canMerge`'s result without `code`); otherwise `renderVerdict`'s table. The pull
 * request number goes through `prArg`, in front of anything that reaches `gh`.
 *
 * Phase 2 runs it and records the verdict; nothing acts on it. Checks 3 and 6 read the
 * code review `publish` archived with its stamp — what the review left open, and the sha
 * the push it belonged to sent — so a review that blocks and a branch that moved after its
 * review are both answered from the archive rather than from a model's word for it. Check
 * 8 of the design, the re-read of the integration tip inside the lock, belongs to the
 * merge action itself and has no home until phase 4.
 *
 * The rule every check shares: an absent signal is a refusal. An empty rollup, a required
 * check that never reported, a merge state GitHub has not computed, a pull request no
 * ledger entry owns — each looks exactly like "nothing failed", and none of them is ever
 * `pass`. Where the signal is missing rather than bad the check says `unavailable`, which
 * is a refusal too: `allowed` asks every check to have passed.
 */

import { join } from "node:path";
import type { ProjectConfig } from "../../config/types.js";
import { git, Forge, type Exec, type PrView, type RollupNode } from "../../forge/github.js";
import {
  archivedReportsOf,
  entryForPr,
  foldNote,
  loadLedger,
  parseDecisionStamp,
  runDir,
  type ArchivedReport,
  type Ledger,
  type StampedDecision,
} from "../ledger/ledger.js";
import { STATE_DIR } from "../ledger/lock.js";
import { approvalsNeeded } from "../publish.js";
import { isRebasedOnto } from "../rebased.js";
import {
  classifyOptions,
  findingsByTier,
  isReportComplete,
  locationOf,
  parseCodeReviewReport,
  type ClassifyOptions,
  type CodeReviewReport,
} from "../review/reports.js";

export type Outcome = "pass" | "fail" | "pending" | "skipped" | "unknown";

export function normalizeRollup(nodes: RollupNode[]): Array<{ name: string; outcome: Outcome }> {
  return nodes.map((n): { name: string; outcome: Outcome } => {
    if (typeof n.name === "string" && typeof n.status === "string") {
      if (n.status !== "COMPLETED") return { name: n.name, outcome: "pending" };
      const c = n.conclusion ?? "";
      const outcome: Outcome =
        c === "SUCCESS"
          ? "pass"
          : c === "SKIPPED"
            ? "skipped"
            : [
                  "FAILURE",
                  "CANCELLED",
                  "TIMED_OUT",
                  "ACTION_REQUIRED",
                  "STARTUP_FAILURE",
                  "STALE",
                ].includes(c)
              ? "fail"
              : "unknown";
      return { name: n.name, outcome };
    }
    if (typeof n.context === "string" && typeof n.state === "string") {
      const outcome: Outcome =
        n.state === "SUCCESS"
          ? "pass"
          : ["PENDING", "EXPECTED"].includes(n.state)
            ? "pending"
            : ["FAILURE", "ERROR"].includes(n.state)
              ? "fail"
              : "unknown";
      return { name: n.context, outcome };
    }
    return { name: "?", outcome: "unknown" };
  });
}

export interface Verdict {
  id: number;
  name: string;
  result: "pass" | "fail" | "unavailable";
  detail: string;
  /**
   * Check 2 only: the checks that did report (at most `REPORTED_SHOWN`), when not one of them
   * carries a required name. A `requiredChecks` entry that never matches (a matrix job reports
   * as `test (ubuntu-latest)`, never as `test`) looks like silent gates; these say otherwise.
   */
  reported?: string[];
}

/** How many reported check names a verdict carries for a human to compare with `requiredChecks`. */
export const REPORTED_SHOWN = 10;

/**
 * The required checks judged by name, one problem per name or none. After a re-run
 * the rollup may carry one node per run, in no documented order: every node of the
 * name has to pass, one pending or failed re-run is a refusal, and a name with no
 * node at all "is not reported". Shared with `status.ts`, which used to count nodes
 * against names and called a pull request green that this refuses.
 */
export function requiredCheckProblems(
  rollup: Array<{ name: string; outcome: Outcome }>,
  required: string[],
): string[] {
  return required
    .map((name) => {
      const found = rollup.filter((r) => r.name === name);
      if (!found.length) return `${name}: not reported`;
      const bad = found.find((r) => r.outcome !== "pass");
      return bad ? `${name}: ${bad.outcome}` : null;
    })
    .filter((p): p is string => p !== null);
}

/**
 * What checks 3 and 6 need from the archived code review, read once so that `evaluate`
 * stays a judgement on facts and touches neither the disk nor git.
 *
 * The stamp's own shape and its reader live in `ledger.ts`, beside `archiveReport` and
 * `parseArchiveHeader`: `publish.ts` writes those seven attributes and this reads them
 * back, and two lists of seven literals could drift apart with nothing to say they had.
 */
export interface ReviewFacts {
  /**
   * The issue the ledger names for this pull request, or `null` when the ledger itself
   * could not be read — the one thing that has to be read before anything else here.
   */
  issue: number | null;
  /**
   * What the facts below were read from, which is one of three things.
   *
   * The path of the newest archived code review carrying a head stamp, normally. When the
   * archives could not be read at all, the directory they are in, because that is the only
   * thing left to name. And when the *ledger* could not be read, `ledger.json` itself —
   * neither an archive nor a directory, but the file a human has to repair, and the only
   * name there is once the issue is unknown.
   */
  archive: string;
  /** From the archive header; null when the archive carries no stamp, or an empty one. */
  reviewed: string | null;
  head: string | null;
  /**
   * The parsed report, or null when the archive does not parse or did not finish. Non-null
   * therefore means a review that reached its verdict: `reviewFactsFor` is the only
   * producer, and it refuses an incomplete block before it parses one.
   */
  report: CodeReviewReport | null;
  /**
   * The decision `publish.ts` acted on, or null for an archive written before the stamp
   * existed — in which case check 3 classifies the report itself, as it used to. Null
   * with `unavailable` set means the archive named a decision this cannot read.
   */
  decision: StampedDecision | null;
  /** Why `report` is null although the archive was read, one line; null otherwise. */
  problem: string | null;
  /**
   * Why the checks have no signal to read at all — the archives could not be read, or the
   * decision stamp on the one that matters could not be. Distinct from `problem`, which
   * is an archive that says something unusable: the file's own rule is that a missing
   * signal is `unavailable` and a bad one is a `fail`, and both refuse the merge.
   */
  unavailable: string | null;
}

/** What `reviewFactsFor` reads unless the caller already holds it. */
export interface ReviewFactsOptions {
  /** Defaults to `loadLedger(root)`. */
  ledger?: Ledger;
  /**
   * The project's config, for the threshold the default `classify` reads. Absent loads it
   * from `root`; a config that cannot be read is a refusal of check 3, never a pass on
   * findings classified against a threshold nobody chose.
   */
  cfg?: ProjectConfig;
  /**
   * The catalogue and the threshold the archived report is read against. Defaults to
   * `classifyOptions("code-review", { cfg, projectRoot: root })` — the engine's rules plus
   * the project's own `.autoclaude/invariants.md` under `root`, and the configured
   * threshold.
   *
   * One object rather than a `catalogue` and a `threshold` of its own, which restated
   * `ClassifyOptions` and were rebuilt with a default of their own: a caller passing only
   * the catalogue classified against `DEFAULT_THRESHOLD` instead of the configured one.
   *
   * It decides less than it used to: check 3 counts the classes off the archive's
   * `decision` stamp, so a rule renamed or removed since the review no longer turns an
   * archived must into an `uncertain` and a pass. What the catalogue still decides is
   * whether the report parses at all.
   */
  classify?: ClassifyOptions;
}

/**
 * The archived code review that belongs to a pull request, read from the run archive.
 *
 * Null when no entry on this machine owns the pull request, and null when the owning
 * entry has no archived code review **that carries a head stamp** — for checks 3 and 6
 * those are one answer, "no review to read", and both are `unavailable` rather than a
 * pass.
 *
 * The newest archive by number is not the one to read. The orchestrator sends every fix
 * round through a fresh code review before it is pushed and archives that report
 * unstamped, so an archive describing a tree that was never pushed sits on top of the
 * stamped one that matches the pull request's head — and check 3 then reported findings
 * against a revision the pull request does not show, while check 6 only said "no head
 * stamp".
 *
 * A report that does not parse, and one that never reached its verdict, are not that
 * case: the archive is there and it does not say what the review found, which is a failed
 * run and a refusal. So both are carried in `problem` instead of thrown, and the whole
 * verdict is still computed.
 *
 * @param pr the pull request number; the head sha is compared in `evaluate`, which is
 *   what keeps this the only function here that reads anything.
 */
export function reviewFactsFor(
  root: string,
  pr: number,
  opts: ReviewFactsOptions = {},
): ReviewFacts | null {
  // The ledger, inside a try of its own and before the archive's: it names the issue every
  // read below is about, so an unreadable one leaves nothing to read — and it sat one line
  // above the try that fixed the same symptom for the archives, so a half-renamed or
  // hand-edited `ledger.json` still threw past this function and the verb exited 1 with no
  // checks table.
  let ledger: Ledger;
  try {
    ledger = opts.ledger ?? loadLedger(root);
  } catch (error) {
    return {
      issue: null,
      // The file that could not be read, because there is no issue to name a run
      // directory for, and this is the path a human repairs.
      archive: join(root, STATE_DIR, "ledger.json"),
      reviewed: null,
      head: null,
      report: null,
      decision: null,
      problem: null,
      unavailable: foldNote(`the ledger cannot be read: ${String(error)}`),
    };
  }
  const entry = entryForPr(ledger, pr);
  if (!entry) return null;
  // Truthy, not merely present: a stamp attribute written empty is no sha, and check 6
  // would otherwise report "archive head " and call it a push after the review.
  //
  // Inside the try, because the read is eager — every archive of the stage — and one
  // EBUSY or EPERM, a ledger archive mid-rename on Windows or a directory in the
  // file's place, threw past this function: the CLI printed the error and exited 1 with
  // no checks table at all, and the orchestrator's `--can-merge` read stdout that never
  // came. The `unavailable` row was designed for exactly this.
  let archived: ArchivedReport | undefined;
  try {
    archived = archivedReportsOf(root, entry.issue, "code-review").find((a) => a.header.head);
  } catch (error) {
    return {
      issue: entry.issue,
      // The directory, the only thing there is left to name: which file failed is inside
      // the error, and a path this could not read is not one to print as the archive.
      archive: runDir(root, entry.issue),
      reviewed: null,
      head: null,
      report: null,
      decision: null,
      problem: null,
      unavailable: foldNote(`the archived code reviews cannot be read: ${String(error)}`),
    };
  }
  if (!archived) return null;
  const read = parseDecisionStamp(archived.header);
  const stamp = {
    issue: entry.issue,
    archive: archived.path,
    reviewed: read.reviewed,
    head: read.head,
    // The decision `publish.ts` acted on, when the archive carries one this can read.
    // Absent for every archive written before the stamp existed, and those are
    // re-classified as before; unreadable is a refusal, not a pass.
    decision: read.decision,
    unavailable: read.problem,
  };
  try {
    // Completeness first, in the order publish.ts and decision.ts decide it. The
    // block's end marker is matched by prefix, so `CODE-REVIEW-STATUS: stopped` parses
    // like any other report and only `complete` says otherwise — and a reviewer that
    // stopped before its verdict usually never wrote `fan-out:` either, so parsing first
    // would blame that missing field for a run that simply did not finish.
    if (!isReportComplete("code-review", archived.text)) {
      // Not "the run did not finish" again: check 3 puts this inside a sentence that
      // already says so, and names the archive while it is at it.
      return { ...stamp, report: null, problem: "its status line is not marked complete" };
    }
    // Inside the try: a config or a project catalogue that cannot be read costs check 3
    // its signal as a failed run, and the table is still printed.
    const report = parseCodeReviewReport(
      archived.text,
      opts.classify ?? classifyOptions("code-review", { cfg: opts.cfg, projectRoot: root }),
    );
    return { ...stamp, report, problem: null };
  } catch (error) {
    // One line, because it is rendered as one cell of one row: the parser's messages are
    // written as single lines today, and a later multi-line one must not break the table.
    // `foldNote`, the one fold this repository has — it trims and caps as well, which a
    // hand-rolled `replace(/\s+/g, " ")` did not.
    const why = error instanceof Error ? error.message : String(error);
    return { ...stamp, report: null, problem: foldNote(why) };
  }
}

/**
 * Check 3, from the archived review. Asked in order of what the answer is worth: whether
 * there is a review at all, whether it finished, whether its red step proved anything,
 * and only then what it left open.
 *
 * The red step comes before the findings deliberately. A `not-proven` report carries a
 * must in the `tests/` family — `parseCodeReviewReport` refuses one without — so both
 * branches would fire, and the missing proof is the more precise reason of the two.
 * `no-test-files` does not refuse by itself: the diff added no test file the runner
 * collects, which is a diff with nothing to prove, and the project's own coverage
 * invariant is what holds a source change to a test.
 *
 * **What is open comes from the decision `publish.ts` stamped**, not from re-deriving the
 * classes here. This check used to count the raw archived findings, which meant it
 * applied neither the evidence check nor the catalogue the decision was made against: a
 * must that `decide` withdrew over a quote that did not verify was still a must here, so
 * `publish.ts` correctly opened the pull request and this reported it unmergeable for
 * ever. The re-parse still names the rules
 * behind a stamped must, because a number is not something a human can act on. An archive
 * from before the stamp existed is classified as it always was.
 */
function blockingFindings(review: ReviewFacts | null): { ok: boolean | null; detail: string } {
  if (review === null) {
    return {
      ok: null,
      detail:
        "no entry on this machine owns this pull request, or it has no archived code review with a head stamp",
    };
  }
  // A signal that is missing rather than bad: the archives could not be read, or the
  // stamp on the one that matters could not be. Asked before the report, whose absence
  // would otherwise be reported as "does not parse: null".
  if (review.unavailable !== null) {
    return { ok: null, detail: `${review.archive}: ${review.unavailable}` };
  }
  if (review.report === null) {
    return {
      ok: false,
      detail: `archived review ${review.archive} does not parse or did not finish: ${review.problem}`,
    };
  }
  const { redStep, findings } = review.report;
  if (redStep === "not-proven" || redStep === "could-not-run") {
    return {
      ok: false,
      detail: `red step ${redStep}: an automatic merge needs the proof; a human may still merge`,
    };
  }
  // What the review decided, when it stamped one. Stamped, parsed, stored and read by
  // nothing until now: a pull request whose newest stamped review decided `fix` or
  // `block` is not one an automatic merge may take, whatever the counts beside it say.
  if (review.decision !== null && review.decision.action !== "publish") {
    return {
      ok: false,
      detail: `the review decided \`${review.decision.action}\`, not publish (${review.archive})`,
    };
  }
  const raw = findingsByTier(findings);
  const open = review.decision ?? {
    must: raw.must.length,
    should: raw.should.length,
    later: raw.later.length,
    withdrawn: 0,
  };
  if (open.must > 0) {
    // With a stamp, the count and the archive and nothing else. The count came from the
    // stamp while the names came from the re-classified text, which are two different
    // lists: after the evidence check withdrew one of two musts, the detail named a
    // withdrawn finding as open. The file holds both lists side by side, and a human
    // opens it.
    if (review.decision !== null) {
      return { ok: false, detail: `${open.must} must open, by the stamp in ${review.archive}` };
    }
    // Without one there is nothing but the report, whose classes are re-derived here
    // anyway, so the rules are named as they always were. The position only when there is
    // one: the parser allows a must with no file and no line, and `spec/criterion-not-met`
    // — the commonest blocking rule of all — is exactly that finding, which would
    // otherwise read "at :0". `locationOf` is that rule, in `reports.ts` now, where the
    // three markdown renderers use it too.
    const named = raw.must
      .map((f) => {
        const where = locationOf(f);
        return where ? `${f.rule} at ${where}` : f.rule;
      })
      .join(", ");
    return { ok: false, detail: `${open.must} must open${named ? `: ${named}` : ""}` };
  }
  const withdrawn = open.withdrawn ? `; ${open.withdrawn} withdrawn by the evidence check` : "";
  return {
    ok: true,
    detail: `0 must, ${open.should} should, ${open.later} later open; red step ${redStep}${withdrawn}`,
  };
}

/**
 * Check 6, the sha the review's push sent against the pull request's head.
 *
 * Shas, not patch content: this proves that nothing was pushed after the review, never
 * that the reviewed tree is the tree a merge would produce. The semantic-conflict gap the
 * parent design accepts stays accepted, and check 5 is what keeps the branch current.
 *
 * `reviewed` differs from `head` on most pushes, because publish.ts rebases between
 * reading the review and pushing; that is not a push after the review, and the detail
 * says which sha was read. No stamp at all is `unavailable`: a fix-round archive owns no
 * push and correctly carries none.
 */
function diffMatchesReview(
  review: ReviewFacts | null,
  headRefOid: string,
): { ok: boolean | null; detail: string } {
  if (review === null || review.head === null) {
    return {
      ok: null,
      detail:
        review?.unavailable ??
        "no head stamp: no archived review, a fix-round archive, or one made before the stamp existed",
    };
  }
  if (review.head !== headRefOid) {
    return {
      ok: false,
      detail: `pushed since the review: archive head ${review.head}, pull request head ${headRefOid}`,
    };
  }
  const rebased =
    review.reviewed && review.reviewed !== review.head
      ? ` (rebased before the push; reviewed at ${review.reviewed})`
      : "";
  return { ok: true, detail: `pushed ${review.head} is the pull request head${rebased}` };
}

export function evaluate(
  input: { pr: PrView; files: string[]; behind: boolean; review: ReviewFacts | null },
  cfg: Pick<ProjectConfig, "branches" | "requiredChecks" | "humanApproval">,
): { allowed: boolean; checks: Verdict[] } {
  const { pr, files, behind, review } = input;
  const checks: Verdict[] = [];
  const add = (id: number, name: string, ok: boolean | null, detail: string) =>
    checks.push({ id, name, result: ok === null ? "unavailable" : ok ? "pass" : "fail", detail });

  add(1, "base branch", pr.baseRefName === cfg.branches.integration, `base is ${pr.baseRefName}`);

  const rollup = normalizeRollup(pr.statusCheckRollup);
  if (rollup.length === 0) {
    add(
      2,
      "required checks",
      false,
      "no checks reported at all: skip marker, paths filter, or not started",
    );
  } else {
    const problems = requiredCheckProblems(rollup, cfg.requiredChecks);
    add(
      2,
      "required checks",
      problems.length === 0,
      problems.length ? problems.join(", ") : `${cfg.requiredChecks.join(", ")} all SUCCESS`,
    );
    // Checks reported, and none of them by a required name: say which did, so the user can
    // correct `requiredChecks` rather than look for a skip marker that is not there.
    const names = [...new Set(rollup.map((r) => r.name))];
    const check2 = checks[checks.length - 1];
    if (check2 && !names.some((n) => cfg.requiredChecks.includes(n)))
      check2.reported = names.slice(0, REPORTED_SHOWN);
  }

  const open = blockingFindings(review);
  add(3, "no blocking findings", open.ok, open.detail);
  // An allowlist, like every other check here: a state not yet seen is a refusal, a
  // draft is the human's "not this one", and a closed or merged pull request has
  // nothing left to merge. HAS_HOOKS is CLEAN with pre-receive
  // hooks on the server, which this repository does not have; accepted as CLEAN.
  const mergeable =
    pr.state === "OPEN" &&
    !pr.isDraft &&
    (pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "HAS_HOOKS");
  add(
    4,
    "merge state",
    mergeable,
    `state ${pr.state}, ${pr.isDraft ? "draft" : "not a draft"}, mergeStateStatus ${pr.mergeStateStatus}`,
  );
  add(
    5,
    "not behind",
    !behind,
    behind
      ? `tip of ${cfg.branches.integration} is not in the pull request's history`
      : "contains the integration tip",
  );
  const matches = diffMatchesReview(review, pr.headRefOid);
  add(6, "diff matches the review", matches.ok, matches.detail);

  // Check 7, defect 6 (design section 8.2): every `humanApproval` entry the diff touches
  // needs its own label on the pull request. The detail keeps one clause per entry, each
  // naming the label and the files, so a human reads which approval is missing.
  const approvals = approvalsNeeded(files, cfg.humanApproval);
  const labelled = (label: string) => pr.labels.some((l) => l.name === label);
  add(
    7,
    "human approval where the diff needs it",
    approvals.every((a) => labelled(a.label)),
    approvals.length === 0
      ? "no matching files"
      : approvals
          .map((a) =>
            labelled(a.label)
              ? `${a.files.length} file(s), ${a.label} present`
              : `${a.files.length} file(s) without ${a.label}: ${a.files.join(", ")}`,
          )
          .join("; "),
  );

  return { allowed: checks.every((c) => c.result === "pass"), checks };
}

/** The verdict as the table a human reads: one row per check, the id, result, name and detail. */
export function renderVerdict(pr: number, v: ReturnType<typeof evaluate>): string {
  const rows = v.checks.map(
    (c) =>
      `${String(c.id).padStart(2)}  ${c.result.padEnd(11)} ${c.name.padEnd(36)} ${c.detail}` +
      (c.reported ? `; reported instead: ${c.reported.join(", ")}` : ""),
  );
  return [`can-merge #${pr}: ${v.allowed ? "ALLOWED" : "REFUSED"}`, ...rows].join("\n");
}

export interface CanMergeDeps {
  forge: Forge;
  exec: Exec;
  /** The main working directory: the ledger, the run archive and the git commands live here. */
  root: string;
  cfg: ProjectConfig;
}

/**
 * The whole verdict for one pull request: read it, fetch, list the diff, test the rebase,
 * read the archived review, evaluate.
 *
 * The file list comes from git after the fetch, with both sides of a rename, so a file
 * moved out of a guarded folder still counts; no patch download per pull request per
 * tick either. The archive lives under the main working directory, which every session
 * shares.
 *
 * Throws when a `gh` or git call fails; the verb maps that to exit 1 with the message on
 * stderr, the same exit as a refusal.
 */
export function canMerge(
  n: number,
  deps: CanMergeDeps,
): ReturnType<typeof evaluate> & {
  pr: number;
  review: { issue: number | null; archive: string } | null;
} {
  const { forge, exec, root, cfg } = deps;
  const pr = forge.viewPr(n);
  const remote = cfg.forge.remote;
  const base = `${remote}/${cfg.branches.integration}`;
  git(["fetch", remote, cfg.branches.integration, pr.headRefName, "--quiet"], exec, root);
  const files = git(
    ["diff", "--name-only", "--no-renames", `${base}...${pr.headRefOid}`],
    exec,
    root,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const behind = !isRebasedOnto(base, pr.headRefOid, (args) => exec("git", args, { cwd: root }));
  const review = reviewFactsFor(root, n, { cfg });
  const v = evaluate({ pr, files, behind, review }, cfg);
  return { pr: n, review: review && { issue: review.issue, archive: review.archive }, ...v };
}
