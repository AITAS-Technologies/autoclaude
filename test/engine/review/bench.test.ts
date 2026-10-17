import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExpected, matchFindings, type Expected } from "../../../src/engine/review/bench.js";
import { classifyOptions, parseCodeReviewReport } from "../../../src/engine/review/reports.js";

const BENCH = "test/fixtures/bench";

/**
 * The sample pair, read the way the CLI reads them: the report through the real parser and
 * `classifyOptions`, the expectations through the script's own loader. A stub report would
 * let the matcher agree with a shape the parser never produces, and a catalogue without the
 * configured threshold would classify these findings against another number than the CLI
 * does — the tiers here are the ones `policy` gives these rules at these confidences.
 */
const sampleText = readFileSync(`${BENCH}/sample-report.md`, "utf8");
const report = parseCodeReviewReport(
  sampleText,
  classifyOptions("code-review", { projectRoot: "test/fixtures/projects/full" }),
);
const expected = loadExpected(`${BENCH}/sample-expected.json`);
const result = matchFindings(report, expected);

/** One expectation of the sample list, by id, so a test can vary a single field of it. */
function sample(id: string): Expected {
  const found = expected.find((e) => e.id === id);
  if (!found) throw new Error(`the sample expected list has no "${id}"`);
  return found;
}

const outcomeOf = (id: string) =>
  result.hits.some((h) => h.expected.id === id)
    ? "hit"
    : result.seen.some((s) => s.expected.id === id)
      ? "seen"
      : result.misses.some((m) => m.id === id)
        ? "miss"
        : "absent";

const hitOf = (id: string) => result.hits.find((h) => h.expected.id === id);
const seenOf = (id: string) => result.seen.find((s) => s.expected.id === id);

describe("matchFindings", () => {
  it("matches a finding by file and line window", () => {
    expect(outcomeOf("boundary")).toBe("hit");
    expect(hitOf("boundary")?.finding).toMatchObject({
      rule: "bug/boundary",
      file: "src/lib/pager.ts",
      line: 42,
    });
    // The window decides, not the file: the same expectation moved one line past the
    // finding no longer matches it.
    const moved = matchFindings(report, [{ ...sample("boundary"), lines: [43, 50] }]);
    expect(moved.hits).toHaveLength(0);
    expect(moved.misses.map((m) => m.id)).toEqual(["boundary"]);
  });

  it("matches on rule family or tier only when the expectation names them", () => {
    // A family-only expectation says nothing about the tier, and the finding it claims
    // carries one.
    expect(sample("teardown").tier).toBeUndefined();
    expect(hitOf("teardown")?.finding.tier).toBe("later");
    // A tier-only expectation says nothing about the family, and claims across families.
    expect(sample("inverted").family).toBeUndefined();
    expect(hitOf("inverted")?.finding.rule).toBe("bug/inverted-condition");
    // Named and unmet is not a match either way round: a family that differs at all, and a
    // tier the finding does not reach.
    expect(matchFindings(report, [{ ...sample("teardown"), family: "perf" }]).hits).toHaveLength(0);
    expect(matchFindings(report, [{ ...sample("control"), tier: "must" }]).hits).toHaveLength(0);
  });

  /**
   * The tier is a minimum and not an equality, because the fixture's tiers come from what
   * the independent reader thought the finding was worth while the matcher compares them
   * with what `policy` computes from the rule's level and the scorer's confidence. Every
   * `bug/*` rule is an `error`, so the same finding is a `should` at confidence 7 and a
   * `must` at 8 — and a review that classes a should as a must has not missed it. How
   * precisely a review scores what it found is a later phase's measurement.
   */
  it("matches a finding classed more severely than expected", () => {
    const stricter = matchFindings(report, [{ ...sample("boundary"), tier: "should" }]);
    expect(stricter.hits.map((h) => h.expected.id)).toEqual(["boundary"]);
    expect(stricter.hits[0]?.finding.tier).toBe("must");
    // Not the other way round: a must the review only called a should is still a miss.
    const weaker = matchFindings(report, [{ ...sample("control"), tier: "must" }]);
    expect(weaker.hits).toHaveLength(0);
    expect(weaker.misses.map((m) => m.id)).toEqual(["control"]);
  });

  it("counts an uncertain mention as seen, not as a hit", () => {
    // Named by the file's basename...
    expect(outcomeOf("guardrail")).toBe("seen");
    expect(seenOf("guardrail")?.uncertain).toContain("guardrail.ts");
    // ...and by the rule family.
    expect(outcomeOf("metrics")).toBe("seen");
    expect(seenOf("metrics")?.uncertain).toContain("perf/");
    expect(result.hits.map((h) => h.expected.id)).not.toContain("guardrail");
    // Seen carries no weight in recall; it is the reason seenRate exists beside it.
    const alone = matchFindings(report, [sample("guardrail")]);
    expect(alone.recall).toBe(0);
    expect(alone.seenRate).toBe(1);
  });

  it("claims each finding once and lists the rest as unmatched", () => {
    // Two windows around one finding: the expectation listed first claims it, and the
    // second is a miss rather than a second hit on the same evidence.
    expect(outcomeOf("boundary")).toBe("hit");
    expect(outcomeOf("pager-overlap")).toBe("miss");
    const reversed = matchFindings(report, [sample("pager-overlap"), sample("boundary")]);
    expect(reversed.hits.map((h) => h.expected.id)).toEqual(["pager-overlap"]);
    expect(reversed.misses.map((m) => m.id)).toEqual(["boundary"]);
    // What no expectation claimed, labelled unmatched and not a false positive: the
    // expected list is not exhaustive.
    expect(result.unmatched.map((f) => f.rule)).toEqual(["docs/completeness"]);
  });

  it("reports recall over the expected list", () => {
    expect(result.hits).toHaveLength(5);
    expect(result.seen).toHaveLength(2);
    expect(result.misses).toHaveLength(2);
    expect(result.recall).toBeCloseTo(5 / 9, 10);
    expect(result.seenRate).toBeCloseTo(7 / 9, 10);
    // Over the expected list and not over the report: a report with nothing in it scores
    // 0 against the same nine, and the unmatched finding never counted towards either
    // number in the first place.
    const nothing = matchFindings({ ...report, findings: [], uncertain: [] }, expected);
    expect(nothing.recall).toBe(0);
    expect(nothing.seenRate).toBe(0);
    expect(nothing.misses).toHaveLength(9);
  });

  it("normalises path separators", () => {
    // A Windows-style path on the expectation's side...
    expect(sample("control").file).toContain("\\");
    expect(outcomeOf("control")).toBe("hit");
    // ...and on the report's side, where a reviewer quoted the path as the shell printed it.
    expect(hitOf("cache")?.finding.file).toContain("\\");
    expect(outcomeOf("cache")).toBe("hit");
    // The review runs inside a worktree, so a finding may name the file from its root.
    // The expectation stays repository-relative and still claims it.
    const fromWorktree = matchFindings(
      {
        ...report,
        findings: report.findings.map((f) => ({
          ...f,
          file: `C:\\work\\project\\.autoclaude\\worktrees\\bench-7\\${f.file}`,
        })),
      },
      [sample("boundary")],
    );
    expect(fromWorktree.hits.map((h) => h.expected.id)).toEqual(["boundary"]);
  });

  // `includes` on the basename made `x.ts` a mention of `index.ts`, and any basename
  // shared by two directories a mention of both — and because an uncertain line is claimed
  // once, a false hit also stole the line from the expectation it belonged to. The `seen`
  // bucket is the one number this script exists to make trustworthy.
  it("matches a file mention on a path boundary, not as a substring", () => {
    const seenBy = (line: string, file: string) =>
      matchFindings({ ...report, findings: [], uncertain: [line] }, [{ id: "one", file }]).seen.map(
        (s) => s.expected.id,
      );

    // The signal the fixture relies on: the bare basename, mentioned in a sentence.
    expect(seenBy("the ordering in x.ts is not settled", "src/lib/x.ts")).toEqual(["one"]);
    // The same line must not claim an expectation whose basename it merely ends with.
    expect(seenBy("the ordering in index.ts is not settled", "src/lib/x.ts")).toEqual([]);
    // A line that names a path names *that* path: another directory's file of the same
    // name is a different file.
    expect(seenBy("other/lib/utils.ts was rewritten", "src/lib/utils.ts")).toEqual([]);
    expect(seenBy("src/lib/utils.ts was rewritten", "src/lib/utils.ts")).toEqual(["one"]);
    // The review runs inside a worktree, so the line may name the file from its root; the
    // expectation stays repository-relative and still claims it.
    expect(
      seenBy(
        "C:\\repo\\.autoclaude\\worktrees\\b\\src\\lib\\utils.ts:12 grows",
        "src/lib/utils.ts",
      ),
    ).toEqual(["one"]);
    // And a mention in a position a reader would write: quoted, parenthesised, with a line
    // number after it.
    for (const line of ["`src/lib/utils.ts`", "(src/lib/utils.ts:12)", "utils.ts, at line 12"]) {
      expect(seenBy(line, "src/lib/utils.ts"), line).toEqual(["one"]);
    }
  });

  // The file's name is the stronger of the two signals, so it is assigned first. Matching
  // in one pass let the first expectation of a family absorb a line that named a later
  // expectation's file, and the seen was then attributed to the wrong finding.
  it("gives an uncertain line to the expectation whose file it names", () => {
    const line = "perf/unbounded-growth — the sorted scan in cache.ts was never measured";
    const twoOfAFamily: Expected[] = [
      { id: "metrics", file: "src/lib/metrics.ts", family: "perf" },
      { id: "cache", file: "src/lib/cache.ts", family: "perf" },
    ];
    const r = matchFindings({ ...report, findings: [], uncertain: [line] }, twoOfAFamily);
    expect(r.seen.map((s) => s.expected.id)).toEqual(["cache"]);
    expect(r.misses.map((m) => m.id)).toEqual(["metrics"]);
  });
});

describe("loadExpected", () => {
  const tmp = mkdtempSync(join(tmpdir(), "autoclaude-bench-load-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // PowerShell writes UTF-8 with a BOM by default here, so a hand-edited fixture arrives
  // with one — and `JSON.parse` then fails with "Unexpected token '﻿'", which names
  // neither the file nor the real cause.
  it("reads a fixture saved with a byte-order mark", () => {
    const file = join(tmp, "bom.json");
    writeFileSync(file, `﻿${JSON.stringify([{ id: "a", file: "src/a.ts" }])}`);
    expect(loadExpected(file).map((e) => e.id)).toEqual(["a"]);
  });

  it("still refuses a file that is not a non-empty list", () => {
    const file = join(tmp, "empty.json");
    writeFileSync(file, "﻿[]");
    expect(() => loadExpected(file)).toThrow(/non-empty list/);
  });
});

/**
 * The shape of a realistic benchmark list, pinned on a generic eight-finding file of our
 * own: the real list belongs to the product it was written for and is not part of this
 * repository (design section 10, the recall benchmark). The thing pinned is the ordering
 * rule the matcher depends on, not a particular product's findings.
 */
describe("a larger expected list", () => {
  const eight = loadExpected(`${BENCH}/eight-findings.json`);

  it("holds eight findings in their tiers, the must entries first", () => {
    expect(eight).toHaveLength(8);
    const tiers = eight.map((e) => e.tier);
    expect(tiers.filter((t) => t === "must")).toHaveLength(2);
    expect(tiers.filter((t) => t === "should")).toHaveLength(3);
    expect(tiers.filter((t) => t === "later")).toHaveLength(3);
    // In tier order, because a finding is claimed once in list order and two of these
    // windows overlap: a later expectation listed first would claim the must's finding.
    expect(tiers).toEqual([
      "must",
      "must",
      "should",
      "should",
      "should",
      "later",
      "later",
      "later",
    ]);
    expect(new Set(eight.map((e) => e.id)).size).toBe(8);
  });
});
