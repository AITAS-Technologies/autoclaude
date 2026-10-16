/**
 * The report and counter builders more than one suite needs: a parsed review as the
 * parser would have handed it over, and a ledger entry's attempt counters.
 *
 * One copy, not three. `attempts()` was byte-identical in `review-decision.test.ts` and
 * `publish.test.ts`, and `can-merge.test.ts` built the same `CodeReviewReport` shape under
 * a name of its own — so a field added to either shape had to be added in three places or
 * the suites tested three different reports. It is the same reason `findings.ts` beside
 * this file exists (`/code-review` on the review-tiers branch).
 *
 * Not a `*.test.ts` name, so vitest does not collect it: its include globs take only files
 * ending in `.test.ts` or `.test.tsx`, and this file holds no cases.
 */

import type {
  CodeReviewReport,
  PlanReviewReport,
  ReviewFinding,
} from "../../src/engine/review/reports.js";

/** A ledger entry's attempt counters (the ledger itself is a later task's). */
export interface Attempts {
  implement: number;
  fix: number;
  reviewRetry: number;
  plan: number;
}

/** A ledger entry's counters: one implement attempt spent, nothing else. */
export const attempts = (over: Partial<Attempts> = {}): Attempts => ({
  implement: 1,
  fix: 0,
  reviewRetry: 0,
  plan: 0,
  ...over,
});

/**
 * A code review as `parseCodeReviewReport` returns it: complete, red step proven, one
 * criterion met, and the findings the caller names.
 *
 * `findings` is a parameter of its own because that is what almost every case varies;
 * `over` reaches every other field, `findings` included, and wins.
 */
export function codeReview(
  findings: ReviewFinding[] = [],
  over: Partial<CodeReviewReport> = {},
): CodeReviewReport {
  return {
    issue: 5,
    findings,
    uncertain: [],
    complete: true,
    redStep: "proven",
    reason: "",
    fanOut: "sequential",
    scoredBy: "sonnet",
    criteria: [{ met: true, text: "src/a.ts:12" }],
    criteriaNone: false,
    ...over,
  };
}

/** A plan review as `parsePlanReviewReport` returns it: it has no diff and no tests. */
export function planReview(
  findings: ReviewFinding[] = [],
  over: Partial<PlanReviewReport> = {},
): PlanReviewReport {
  return { issue: 5, findings, uncertain: [], complete: true, scoredBy: "sonnet", ...over };
}
