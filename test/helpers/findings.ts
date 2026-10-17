/**
 * The finding builders both decision tests need: a finding as the parser would have
 * handed it over, with the level and the tier already computed from the catalogue and a
 * fingerprint that matches the rule and the evidence.
 *
 * One copy, not two. `review-decision.test.ts` and `can-merge.test.ts` each had the same
 * four builders with a different sample file in them, and a change to the shape — the
 * fingerprint recomputation is the one that bites — had to be made twice or the two
 * suites tested two different findings (whole-branch review, test helper).
 *
 * Not a `*.test.ts` name, so vitest does not collect it: its include globs take only
 * files ending in `.test.ts` or `.test.tsx`, and this file holds no cases.
 */

import { fingerprintOf, loadCatalogue } from "../../src/engine/review/rules.js";
import type { ReviewFinding } from "../../src/engine/review/reports.js";

/**
 * The evidence kind of every rule the real catalogue states, by id.
 *
 * `classify` reads it off the row, and so does this: a case that names
 * `spec/criterion-not-met` or a project rule about the diff as a whole gets the kind that
 * rule really carries, without having to state it. A case that wants the other kind
 * overrides it like any other field.
 */
const EVIDENCE_OF = new Map(
  loadCatalogue({
    engine: "catalogue/rules.md",
    project: "test/fixtures/catalogue/invariants.md",
  }).map((r) => [r.id, r.evidence]),
);

/** The shared shape: an `error` rule scored above the threshold, so a `must`. */
const BASE: Omit<ReviewFinding, "evidenceKind"> = {
  rule: "bug/general-case",
  level: "error",
  tier: "must",
  confidence: 9,
  file: "src/a.ts",
  line: 10,
  evidence: "const a = 1;",
  message: "one sentence",
  fingerprint: "",
};

/** A `warning` above the threshold, which is a `should`. */
const SHOULD: Partial<ReviewFinding> = {
  rule: "tests/no-positive-control",
  level: "warning",
  tier: "should",
  confidence: 8,
  evidence: "expect(x).toBeNull();",
};

/** A `note` at the threshold, which is a `later`. */
const LATER: Partial<ReviewFinding> = {
  rule: "scope/follow-up",
  level: "note",
  tier: "later",
  confidence: 7,
  evidence: "// TODO: the other half",
};

export type Build = (over?: Partial<ReviewFinding>) => ReviewFinding;

export interface FindingBuilders {
  finding: Build;
  must: Build;
  should: Build;
  later: Build;
}

/**
 * The four builders, with this suite's own sample positions folded in.
 *
 * `finding` is applied to all three tiers, which is how a test whose temporary worktree
 * holds one file gets every finding pointing into it; `should` and `later` then override
 * what that tier states differently. A test's own argument wins over both.
 */
export function findingBuilders(
  over: {
    finding?: Partial<ReviewFinding>;
    should?: Partial<ReviewFinding>;
    later?: Partial<ReviewFinding>;
  } = {},
): FindingBuilders {
  const build = (tier: Partial<ReviewFinding>, callers: Partial<ReviewFinding>): ReviewFinding => {
    const f = { ...BASE, ...over.finding, ...tier, ...callers };
    // Recomputed after the overrides, so a case that changes the quote or the file changes
    // the identity with it — which is what the fingerprint means, and what the parser
    // computes from the same three fields. The evidence kind comes from the rule's own
    // catalogue row unless a case states one, exactly as `classify` reads it.
    return {
      ...f,
      evidenceKind: f.evidenceKind ?? EVIDENCE_OF.get(f.rule) ?? "line",
      fingerprint: fingerprintOf(f.rule, f.evidence, f.file),
    };
  };
  const finding: Build = (callers = {}) => build({}, callers);
  return {
    finding,
    must: finding,
    should: (callers = {}) => build(SHOULD, { ...over.should, ...callers }),
    later: (callers = {}) => build(LATER, { ...over.later, ...callers }),
  };
}
