import { afterAll, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canMerge,
  evaluate,
  normalizeRollup,
  renderVerdict,
  reviewFactsFor,
  type ReviewFacts,
} from "../../../src/engine/merge/can-merge.js";
import { emptyLedger, saveLedger, transition } from "../../../src/engine/ledger/ledger.js";
import { loadCatalogue } from "../../../src/engine/review/rules.js";
import type { CodeReviewReport } from "../../../src/engine/review/reports.js";
import { findingBuilders } from "../../helpers/findings.js";
import { codeReview } from "../../helpers/reports.js";
import type { ProjectConfig } from "../../../src/config/types.js";
import { Forge, type Exec, type PrView, type RollupNode } from "../../../src/forge/github.js";

/**
 * Only what the verdict reads. Check 7 iterates `humanApproval` (design section 8.2, defect
 * 6): each entry names the paths that need a human's label and the label. Two entries, so
 * "the label of the entry that matched" is distinguishable from "any entry's label".
 */
const cfg = {
  branches: { integration: "develop", production: "main" },
  requiredChecks: ["test", "lint", "build"],
  humanApproval: [
    { paths: ["db/migrations/**"], label: "human-approved" },
    { paths: ["infra/**"], label: "infra-approved" },
  ],
} as unknown as ProjectConfig;
const rollup = (n: string) =>
  JSON.parse(readFileSync(`test/fixtures/forge/${n}.json`, "utf8")) as RollupNode[];
const pr = (over: Partial<PrView> = {}): PrView => ({
  number: 1,
  state: "OPEN",
  mergedAt: null,
  headRefName: "agent/1-x",
  headRefOid: "abc",
  baseRefName: "develop",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: rollup("rollup-gates-green"),
  labels: [],
  url: "",
  updatedAt: "",
  isDraft: false,
  ...over,
});
const result = (v: ReturnType<typeof evaluate>, id: number) =>
  v.checks.find((c) => c.id === id)?.result;
const detail = (v: ReturnType<typeof evaluate>, id: number) =>
  v.checks.find((c) => c.id === id)?.detail ?? "";

describe("normalizeRollup", () => {
  it("reads both node types and calls anything else unknown", () => {
    expect(normalizeRollup(rollup("rollup-gates-green"))).toEqual([
      { name: "optional-review", outcome: "skipped" },
      { name: "test", outcome: "pass" },
      { name: "lint", outcome: "pass" },
      { name: "build", outcome: "pass" },
      { name: "deploy-preview", outcome: "pass" },
    ]);
    expect(normalizeRollup([{ name: null, status: null, conclusion: null }])).toEqual([
      { name: "?", outcome: "unknown" },
    ]);
    expect(
      normalizeRollup([{ name: "test", status: "IN_PROGRESS", conclusion: null }])[0]?.outcome,
    ).toBe("pending");
    expect(
      normalizeRollup([{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }])[0]?.outcome,
    ).toBe("fail");
  });
});

describe("evaluate", () => {
  it("passes every available check on a green pull request, and is still not allowed while a check is unavailable", () => {
    const v = evaluate({ pr: pr(), files: ["src/a.ts"], behind: false, review: null }, cfg);
    expect(v.checks.map((c) => c.result)).toEqual([
      "pass",
      "pass",
      "unavailable",
      "pass",
      "pass",
      "unavailable",
      "pass",
    ]);
    expect(v.allowed).toBe(false);
  });

  it("refuses a base other than the integration branch", () => {
    expect(
      result(
        evaluate({ pr: pr({ baseRefName: "main" }), files: [], behind: false, review: null }, cfg),
        1,
      ),
    ).toBe("fail");
  });

  it("refuses when a required check is missing, which is how the skip marker looks from here", () => {
    const v = evaluate(
      {
        pr: pr({ statusCheckRollup: rollup("rollup-legacy-only") }),
        files: [],
        behind: false,
        review: null,
      },
      cfg,
    );
    expect(result(v, 2)).toBe("fail");
    expect(v.checks[1]?.detail).toMatch(/not reported/);
    expect(
      result(
        evaluate(
          { pr: pr({ statusCheckRollup: [] }), files: [], behind: false, review: null },
          cfg,
        ),
        2,
      ),
    ).toBe("fail");
  });

  // Check 4 is an allowlist. A draft, an unstable or blocked state,
  // a value not yet seen, and a pull request that is no longer open are all refusals.
  it("passes the merge state only for an open, non-draft, CLEAN pull request", () => {
    const at4 = (over: Partial<PrView>) =>
      result(evaluate({ pr: pr(over), files: [], behind: false, review: null }, cfg), 4);
    expect(at4({})).toBe("pass");
    expect(at4({ mergeStateStatus: "HAS_HOOKS" })).toBe("pass");
    expect(at4({ isDraft: true })).toBe("fail");
    expect(at4({ mergeStateStatus: "DRAFT" })).toBe("fail");
    expect(at4({ mergeStateStatus: "UNSTABLE" })).toBe("fail");
    expect(at4({ mergeStateStatus: "BLOCKED" })).toBe("fail");
    expect(at4({ mergeStateStatus: "SOMETHING_NEW" })).toBe("fail");
    expect(at4({ state: "MERGED" })).toBe("fail");
    expect(at4({ state: "CLOSED" })).toBe("fail");
  });

  it("refuses a dirty or not-yet-computed merge state, and a branch that is behind", () => {
    expect(
      result(
        evaluate(
          { pr: pr({ mergeStateStatus: "DIRTY" }), files: [], behind: false, review: null },
          cfg,
        ),
        4,
      ),
    ).toBe("fail");
    expect(
      result(
        evaluate(
          { pr: pr({ mergeStateStatus: "UNKNOWN" }), files: [], behind: false, review: null },
          cfg,
        ),
        4,
      ),
    ).toBe("fail");
    expect(result(evaluate({ pr: pr(), files: [], behind: true, review: null }, cfg), 5)).toBe(
      "fail",
    );
  });

  // Defect 6 (design section 8.2): check 7 iterates `cfg.humanApproval`. A diff file
  // matching an entry's `paths` needs that entry's `label`, and no other entry's.
  it("requires the humanApproval label for a matching path", () => {
    const files = ["db/migrations/001.sql", "src/a.ts"];
    const refused = evaluate({ pr: pr(), files, behind: false, review: null }, cfg);
    expect(result(refused, 7)).toBe("fail");
    expect(detail(refused, 7)).toBe("1 file(s) without human-approved: db/migrations/001.sql");
    const approved = evaluate(
      { pr: pr({ labels: [{ name: "human-approved" }] }), files, behind: false, review: null },
      cfg,
    );
    expect(result(approved, 7)).toBe("pass");
    expect(detail(approved, 7)).toBe("1 file(s), human-approved present");
  });

  it("passes check 7 with the wording of no matching files when no entry matches", () => {
    const v = evaluate({ pr: pr(), files: ["src/a.ts"], behind: false, review: null }, cfg);
    expect(result(v, 7)).toBe("pass");
    expect(detail(v, 7)).toBe("no matching files");
  });

  it("judges each entry on its own label, and names every entry that is missing one", () => {
    const files = ["db/migrations/001.sql", "infra/main.tf", "infra/vars.tf"];
    // One entry's label does not stand in for the other's.
    const wrong = evaluate(
      { pr: pr({ labels: [{ name: "human-approved" }] }), files, behind: false, review: null },
      cfg,
    );
    expect(result(wrong, 7)).toBe("fail");
    expect(detail(wrong, 7)).toBe(
      "1 file(s), human-approved present; 2 file(s) without infra-approved: infra/main.tf, infra/vars.tf",
    );
    const neither = evaluate({ pr: pr(), files, behind: false, review: null }, cfg);
    expect(detail(neither, 7)).toBe(
      "1 file(s) without human-approved: db/migrations/001.sql; 2 file(s) without infra-approved: infra/main.tf, infra/vars.tf",
    );
    const both = evaluate(
      {
        pr: pr({ labels: [{ name: "human-approved" }, { name: "infra-approved" }] }),
        files,
        behind: false,
        review: null,
      },
      cfg,
    );
    expect(result(both, 7)).toBe("pass");
    expect(detail(both, 7)).toBe(
      "1 file(s), human-approved present; 2 file(s), infra-approved present",
    );
  });

  it("passes check 7 for a project with no humanApproval entries", () => {
    const none = { ...cfg, humanApproval: [] } as unknown as ProjectConfig;
    const v = evaluate(
      { pr: pr(), files: ["db/migrations/001.sql"], behind: false, review: null },
      none,
    );
    expect(result(v, 7)).toBe("pass");
    expect(detail(v, 7)).toBe("no matching files");
  });
});

// --- checks 3 and 6, from the archived review -------------------------------

const catalogue = loadCatalogue({
  engine: "catalogue/rules.md",
  project: "test/fixtures/catalogue/invariants.md",
});
const now = new Date("2026-09-14T12:00:00.000Z");

/**
 * A finding as the parser hands it over: level and tier already computed, fingerprint
 * too, from the builders this test shares with `decision.test.ts`.
 */
const { must, should, later } = findingBuilders({
  finding: { file: "src/a.ts", line: 12 },
  should: { file: "tests/a.test.ts", line: 4 },
});

/**
 * A parsed code review, as `reviewFactsFor` carries it into `evaluate` — the builder this
 * suite shares with the decision tests, whose findings this one passes through `over`.
 */
const report = (over: Partial<CodeReviewReport> = {}): CodeReviewReport => codeReview([], over);

/** The facts of an archived review stamped for this pull request's head, `abc`. */
const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  issue: 5,
  archive: join(".autoclaude", "state", "runs", "5", "code-review-1.md"),
  reviewed: "abc",
  head: "abc",
  report: report(),
  // An archive from before the decision stamp existed; the cases that exercise the stamp
  // build one through the reader, because the wire format is what they are about.
  decision: null,
  problem: null,
  unavailable: null,
  ...over,
});

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

/**
 * A throwaway state root: a ledger naming issue 5 for pull request 1, and one archived
 * code review per entry of `archives`, numbered from 1.
 *
 * Under `os.tmpdir()`, never the `.autoclaude/state/` of any checkout: these tests write a
 * ledger and read an archive back, and the real one belongs to the sessions running.
 * The header is written out here rather than through `archiveReport`, because the wire
 * format is exactly what the reader under test depends on.
 */
function rootWithArchives(
  archives: Array<{ text: string; stamp?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "autoclaude-can-merge-"));
  tempRoots.push(root);
  const ledger = emptyLedger("me");
  transition(
    ledger,
    5,
    "pr-open",
    { title: "t", branch: "agent/5-x", worktree: join(root, "wt"), pr: 1 },
    now,
  );
  saveLedger(root, ledger, now);
  const runs = join(root, ".autoclaude", "state", "runs", "5");
  mkdirSync(runs, { recursive: true });
  archives.forEach(({ text, stamp }, i) => {
    const attributes = { issue: "5", stage: "code-review", n: String(i + 1), ...stamp };
    const header = Object.entries(attributes)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    writeFileSync(join(runs, `code-review-${i + 1}.md`), `<!-- autodev-archive${header} -->\n${text}`); // prettier-ignore
  });
  return root;
}

/** A complete review block: one must finding, one should finding, the red step proven. */
const REVIEW_TEXT = [
  "AUTODEV-CODE-REVIEW",
  "issue: 5",
  "red-step: proven",
  "fan-out: bugs, tests",
  "scored-by: sonnet",
  "criteria:",
  "  1. met — src/a.ts:12",
  "findings:",
  "  - rule: bug/general-case",
  "    confidence: 9",
  "    file: src/a.ts",
  "    line: 12",
  '    evidence: "const a = 1;"',
  "    message: Handles the example and not the class it stands for.",
  "  - rule: tests/no-positive-control",
  "    confidence: 8",
  "    file: tests/a.test.ts",
  "    line: 4",
  '    evidence: "expect(x).toBeNull();"',
  "    message: A negative assertion with no sibling showing the counter counting.",
  "uncertain:",
  "CODE-REVIEW-STATUS: complete",
  "",
].join("\n");

/**
 * Checks 3 and 6 read the review `publish.ts` archived with its stamp (design,
 * "`can-merge.ts`: checks 3 and 6 become real").
 *
 * `evaluate` reads nothing: `reviewFactsFor` does the reading and hands over facts, so
 * every case here but the two that exercise the reader is a fact table.
 */
describe("checks 3 and 6, from the archived review", () => {
  /** The whole verdict for a green pull request whose head is `abc`, given these facts. */
  const at = (review: ReviewFacts | null) =>
    evaluate({ pr: pr(), files: [], behind: false, review }, cfg);

  it("reports checks 3 and 6 unavailable when no entry on this machine owns the pull request", () => {
    const v = at(null);
    expect(result(v, 3)).toBe("unavailable");
    expect(detail(v, 3)).toMatch(/no entry on this machine owns this pull request/);
    expect(result(v, 6)).toBe("unavailable");
    expect(v.allowed).toBe(false);
  });

  it("passes check 3 on an archived review with no must finding, should findings included", () => {
    const v = at(facts({ report: report({ findings: [should(), later()] }) }));
    expect(result(v, 3)).toBe("pass");
    expect(detail(v, 3)).toBe("0 must, 1 should, 1 later open; red step proven");
  });

  it("passes check 3 on later findings alone", () => {
    const v = at(
      facts({
        report: report({ findings: [later(), later({ rule: "docs/completeness" })] }),
      }),
    );
    expect(result(v, 3)).toBe("pass");
    expect(detail(v, 3)).toBe("0 must, 0 should, 2 later open; red step proven");
  });

  it("refuses check 3 on an open must finding", () => {
    const v = at(facts({ report: report({ findings: [must(), should()] }) }));
    expect(result(v, 3)).toBe("fail");
    expect(detail(v, 3)).toBe("1 must open: bug/general-case at src/a.ts:12");
    // Every must is named, not only the first: a human reads this line and nothing else.
    const two = at(
      facts({ report: report({ findings: [must(), must({ rule: "bug/boundary", line: 30 })] }) }),
    );
    expect(detail(two, 3)).toBe("2 must open: bug/general-case at src/a.ts:12, bug/boundary at src/a.ts:30"); // prettier-ignore

    // The parser allows a must with no file and no line, and the commonest blocking rule
    // of all is exactly that finding: naming a position it does not have reads "at :0".
    const unmet = at(
      facts({
        report: report({
          findings: [must({ rule: "spec/criterion-not-met", file: "", line: 0, evidence: "" })],
        }),
      }),
    );
    expect(detail(unmet, 3)).toBe("1 must open: spec/criterion-not-met");
  });

  it("refuses check 3 on red-step not-proven and on could-not-run", () => {
    // A real `not-proven` report carries a must in the tests/ family — the parser refuses
    // one without — so the red step is asked before the must list, and the detail says
    // which of the two refused.
    const notProven = at(
      facts({
        report: report({
          redStep: "not-proven",
          findings: [must({ rule: "tests/passes-without-change" })],
        }),
      }),
    );
    expect(result(notProven, 3)).toBe("fail");
    expect(detail(notProven, 3)).toBe(
      "red step not-proven: an automatic merge needs the proof; a human may still merge",
    );

    const couldNotRun = at(
      facts({ report: report({ redStep: "could-not-run", reason: "npm ci failed" }) }),
    );
    expect(result(couldNotRun, 3)).toBe("fail");
    expect(detail(couldNotRun, 3)).toContain("red step could-not-run");

    // `no-test-files` is not a missing proof but a diff with nothing to prove, and the
    // invariant tests/business-logic-covered is what holds a source change to a test.
    const noTestFiles = at(facts({ report: report({ redStep: "no-test-files" }) }));
    expect(result(noTestFiles, 3)).toBe("pass");
    expect(detail(noTestFiles, 3)).toContain("red step no-test-files");
  });

  it("refuses check 3 when the archived review does not parse or did not finish", () => {
    // Through the reader, because the refusal starts as a throw out of the parser: a
    // review that stopped before its status line is a failed run, and a failed run must
    // not read as "found nothing". Every archive here carries a head stamp, or the reader
    // would skip it as a review that owned no push and never reach the parser at all.
    const pushed = { reviewed: "abc", head: "abc" };
    const unfinished = rootWithArchives([
      { text: REVIEW_TEXT.replace("CODE-REVIEW-STATUS: complete\n", ""), stamp: pushed },
    ]);
    const stopped = reviewFactsFor(unfinished, 1, { classify: { catalogue } });
    expect(stopped?.report).toBeNull();
    expect(stopped?.problem).toMatch(/CODE-REVIEW-STATUS/);
    const v = at(stopped);
    expect(result(v, 3)).toBe("fail");
    expect(detail(v, 3)).toContain("does not parse or did not finish");
    expect(detail(v, 3)).toContain("code-review-1.md");
    expect(detail(v, 3)).toContain(String(stopped?.problem));

    // And a block whose lines the parser cannot read at all.
    const garbled = rootWithArchives([
      {
        text: "AUTODEV-CODE-REVIEW\nnot a key at all\nCODE-REVIEW-STATUS: complete\n",
        stamp: pushed,
      },
    ]);
    const unreadable = reviewFactsFor(garbled, 1, { classify: { catalogue } });
    expect(unreadable?.problem).toMatch(/cannot read line/);
    expect(result(at(unreadable), 3)).toBe("fail");

    // And the case that parses. The block's end marker is matched by prefix, so a status
    // line saying the run stopped reads as a whole report and only `complete` says
    // otherwise. With nothing in its findings — the shape a stopped reviewer leaves — this
    // is check 3's most dangerous pass: "0 must, 0 should, 0 later open" for a review that
    // never finished looking.
    const unmarked = rootWithArchives([
      {
        text: [
          "AUTODEV-CODE-REVIEW",
          "issue: 5",
          "red-step: proven",
          "fan-out: bugs, tests",
          "scored-by: sonnet",
          "criteria:",
          "  1. met — src/a.ts:12",
          "findings:",
          "uncertain:",
          "CODE-REVIEW-STATUS: stopped",
          "",
        ].join("\n"),
        stamp: pushed,
      },
    ]);
    const incomplete = reviewFactsFor(unmarked, 1, { classify: { catalogue } });
    expect(incomplete?.report, "an unfinished review is no review").toBeNull();
    expect(incomplete?.problem).toMatch(/not marked complete/);
    const refused = at(incomplete);
    expect(result(refused, 3)).toBe("fail");
    expect(detail(refused, 3)).toContain("did not finish");
  });

  it("passes check 6 when the archived head is the pull request's head, rebased or not", () => {
    const straight = at(facts({ reviewed: "abc", head: "abc" }));
    expect(result(straight, 6)).toBe("pass");
    expect(detail(straight, 6)).toBe("pushed abc is the pull request head");

    // publish.ts rebases between reading the review and pushing, so the two shas differ
    // on most pushes. That is not a push after the review, and the detail says so.
    const rebased = at(facts({ reviewed: "old1111", head: "abc" }));
    expect(result(rebased, 6)).toBe("pass");
    expect(detail(rebased, 6)).toBe(
      "pushed abc is the pull request head (rebased before the push; reviewed at old1111)",
    );
  });

  it("refuses check 6 when the pull request was pushed after the review", () => {
    const v = at(facts({ reviewed: "old1111", head: "def5678" }));
    expect(result(v, 6)).toBe("fail");
    expect(detail(v, 6)).toBe(
      "pushed since the review: archive head def5678, pull request head abc",
    );
    expect(v.allowed).toBe(false);
  });

  it("passes check 6 on a half-stamped archive, with no rebased sha to name", () => {
    // publish.ts stamps both shas or neither, so this is the shape nothing writes today.
    // The clause is guarded on `reviewed` all the same: "reviewed at null" would be worse
    // than saying nothing.
    const v = at(facts({ reviewed: null, head: "abc" }));
    expect(result(v, 6)).toBe("pass");
    expect(detail(v, 6)).toBe("pushed abc is the pull request head");
  });

  it("reads an empty stamp value as no stamp at all", () => {
    // An empty value read as a sha makes check 6 say "archive head , pull request head
    // abc" and call it a push after the review. No stamp is the honest answer — and an
    // archive with no head stamp is not the review that owned a push, so there are no
    // facts to judge at all.
    const root = rootWithArchives([{ text: REVIEW_TEXT, stamp: { reviewed: "", head: "" } }]);
    expect(reviewFactsFor(root, 1, { classify: { catalogue } })).toBeNull();
    expect(result(at(reviewFactsFor(root, 1, { classify: { catalogue } })), 6)).toBe("unavailable");

    // Half a stamp is still the archive that owned the push, and the empty half is read as
    // no sha rather than rendered as "reviewed at ".
    const halfway = rootWithArchives([{ text: REVIEW_TEXT, stamp: { reviewed: "", head: "abc" } }]);
    const half = reviewFactsFor(halfway, 1, { classify: { catalogue } });
    expect([half?.reviewed, half?.head]).toEqual([null, "abc"]);
    expect(detail(at(half), 6)).toBe("pushed abc is the pull request head");

    // And beside a stamped archive the empty one is skipped rather than preferred for
    // being the newer file.
    const both = rootWithArchives([
      { text: REVIEW_TEXT, stamp: { reviewed: "old1111", head: "abc" } },
      { text: REVIEW_TEXT, stamp: { reviewed: "", head: "" } },
    ]);
    const f = reviewFactsFor(both, 1, { classify: { catalogue } });
    expect([f?.reviewed, f?.head]).toEqual(["old1111", "abc"]);
    expect(result(at(f), 6)).toBe("pass");
  });

  it("reports check 6 unavailable when the archive has no head stamp", () => {
    // A fact table, and `reviewFactsFor` no longer produces this shape: it skips an
    // archive without a head stamp entirely (the case below). `evaluate` still answers
    // honestly for a caller that hands one in — the missing stamp costs check 6 alone.
    const v = at(facts({ reviewed: null, head: null }));
    expect(result(v, 6)).toBe("unavailable");
    expect(detail(v, 6)).toContain("no head stamp");
    expect(result(v, 3)).toBe("pass");
  });

  // The orchestrator sends every fix round through a fresh code review before it is
  // pushed, and archives that report unstamped. So a newer unstamped archive describing a
  // tree that was never pushed used to sit on top of the stamped one that matches the
  // pull request's head, and check 3 reported findings against a revision the pull request
  // does not show while check 6 only said "no head stamp".
  it("reads the newest archive that carries a head stamp, not the newest archive", () => {
    const root = rootWithArchives([
      { text: REVIEW_TEXT, stamp: { reviewed: "old1111", head: "def5678" } },
      { text: REVIEW_TEXT },
    ]);
    const f = reviewFactsFor(root, 1, { classify: { catalogue } });
    expect(f?.archive).toBe(join(root, ".autoclaude", "state", "runs", "5", "code-review-1.md"));
    expect(f?.head).toBe("def5678");
    expect(result(at(f), 6)).toBe("fail");
    expect(detail(at(f), 6)).toContain("def5678");
  });

  it("has no facts at all when no archive carries a head stamp", () => {
    // A fix round archived and not yet pushed: there is no review that owned a push, and
    // "no review to read" is the honest answer for both checks rather than a pass on the
    // findings of a tree nobody can see.
    const root = rootWithArchives([{ text: REVIEW_TEXT }, { text: REVIEW_TEXT }]);
    expect(reviewFactsFor(root, 1, { classify: { catalogue } })).toBeNull();
    const v = at(reviewFactsFor(root, 1, { classify: { catalogue } }));
    expect(result(v, 3)).toBe("unavailable");
    expect(result(v, 6)).toBe("unavailable");
  });

  // Check 3 re-derived the classes from the archived text: it applied neither the evidence
  // check nor the catalogue the decision was made against, so a must `decide` withdrew was
  // still a must here and the pull request could never be merged. `publish.ts` stamps what
  // it acted on; this reads that stamp.
  it("counts must, should and later off the decision stamp", () => {
    const root = rootWithArchives([
      {
        text: REVIEW_TEXT,
        stamp: {
          reviewed: "old1111",
          head: "abc",
          decision: "publish",
          must: "0",
          should: "1",
          later: "0",
          withdrawn: "1",
        },
      },
    ]);
    const f = reviewFactsFor(root, 1, { classify: { catalogue } });
    expect(f?.decision).toMatchObject({ action: "publish", must: 0, should: 1, withdrawn: 1 });
    // The raw report still carries the must the check used to count.
    expect(f?.report?.findings.map((x) => x.tier)).toEqual(["must", "should"]);
    const v = at(f);
    expect(result(v, 3)).toBe("pass");
    expect(detail(v, 3)).toContain("0 must, 1 should, 0 later open");
    expect(detail(v, 3), "how many the evidence check withdrew").toContain("1 withdrawn");
  });

  /**
   * The count comes from the stamp and the names came from the re-parsed text, which are
   * two different lists: after the evidence check withdrew one of two musts, the detail
   * read "1 must open: bug/race at x.ts:10, spec/criterion-not-met" and named a withdrawn
   * finding as open. The count alone plus the archive is what a human can act on — they
   * open the file, which holds the findings and the stamp side by side.
   */
  it("names the archive rather than findings the stamp may not have counted", () => {
    // A stamp that says `publish` and counts a must: `publish.ts` refuses to publish on
    // any other decision, so this is version skew or a hand-edited archive — which is the
    // day this check exists for.
    const root = rootWithArchives([
      {
        text: REVIEW_TEXT,
        stamp: { reviewed: "abc", head: "abc", decision: "publish", must: "1", should: "1", later: "0", withdrawn: "0" }, // prettier-ignore
      },
    ]);
    const v = at(reviewFactsFor(root, 1, { classify: { catalogue } }));
    expect(result(v, 3)).toBe("fail");
    expect(detail(v, 3)).toContain("1 must open");
    expect(detail(v, 3), "the file that holds both lists").toContain("code-review-1.md");
    expect(detail(v, 3), "a name the stamp did not vouch for").not.toContain("bug/general-case");

    // Without a stamp there is nothing but the report, so the rules are named as they
    // always were: that archive predates the stamp and the classes are re-derived anyway.
    const old = at(facts({ report: report({ findings: [must()] }) }));
    expect(detail(old, 3)).toBe("1 must open: bug/general-case at src/a.ts:12");
  });

  /**
   * The action was stamped, parsed, stored and read by nothing but a `toMatchObject` in
   * this file. It is the one field that says what `publish.ts` did with the review, and a
   * pull request whose newest stamped review decided `fix` or `block` is not one an
   * automatic merge may take, whatever the counts say.
   */
  it("refuses check 3 when the stamped decision was not publish", () => {
    const stampedAs = (action: string) =>
      rootWithArchives([
        {
          text: REVIEW_TEXT,
          stamp: { reviewed: "abc", head: "abc", decision: action, must: "0", should: "0", later: "0", withdrawn: "0" }, // prettier-ignore
        },
      ]);
    const v = at(reviewFactsFor(stampedAs("fix"), 1, { classify: { catalogue } }));
    expect(result(v, 3)).toBe("fail");
    expect(detail(v, 3)).toContain("fix");
    expect(detail(v, 3)).toContain("code-review-1.md");

    // The positive control: the same archive stamped `publish` passes, so the case above
    // fails for the action and not for the counts beside it.
    const published = at(reviewFactsFor(stampedAs("publish"), 1, { classify: { catalogue } }));
    expect(result(published, 3)).toBe("pass");

    // And the action is the reason given when both would refuse: a review that decided
    // `block` says more than the count it left behind.
    const blocked = rootWithArchives([
      {
        text: REVIEW_TEXT,
        stamp: { reviewed: "abc", head: "abc", decision: "block", must: "1", should: "0", later: "0", withdrawn: "0" }, // prettier-ignore
      },
    ]);
    const both = at(reviewFactsFor(blocked, 1, { classify: { catalogue } }));
    expect(result(both, 3)).toBe("fail");
    expect(detail(both, 3)).toContain("not publish");
  });

  /**
   * `stampedCount` turned a missing or malformed attribute into 0, so a stamp carrying
   * `decision` and no usable `must` reported "0 must open" while the re-parsed text held
   * one. The file's own header rule is that an absent signal is a refusal, never a pass —
   * and version skew or a hand-edited archive is exactly the day the two sides disagree.
   */
  it("reports check 3 unavailable when the decision stamp carries no usable count", () => {
    const stamped = (counts: Record<string, string>) =>
      reviewFactsFor(
        rootWithArchives([
          { text: REVIEW_TEXT, stamp: { reviewed: "abc", head: "abc", decision: "publish", ...counts } }, // prettier-ignore
        ]),
        1,
        { classify: { catalogue } },
      );

    for (const [what, counts] of [
      ["no must at all", { should: "1", later: "0", withdrawn: "0" }],
      ["a must that is not a number", { must: "x", should: "1", later: "0", withdrawn: "0" }],
      ["a negative must", { must: "-1", should: "1", later: "0", withdrawn: "0" }],
      ["a must with something after it", { must: "1x", should: "0", later: "0", withdrawn: "0" }],
    ] as const) {
      const f = stamped(counts);
      expect(f?.decision, `${what} was read as a decision`).toBeNull();
      expect(f?.unavailable, `${what} says nothing`).toMatch(/must/);
      const v = at(f);
      expect(result(v, 3), what).toBe("unavailable");
      expect(detail(v, 3), what).toContain("code-review-1.md");
      // And the report itself still parsed: it is the stamp that is unreadable.
      expect(f?.report?.findings, what).toHaveLength(2);
    }

    // The positive control: all four counts present and the stamp is read.
    const whole = stamped({ must: "0", should: "1", later: "0", withdrawn: "1" });
    expect(whole?.decision).toMatchObject({ action: "publish", must: 0, should: 1, withdrawn: 1 });
    expect(whole?.unavailable).toBeNull();
    expect(result(at(whole), 3)).toBe("pass");
  });

  /**
   * `archivedReportsOf` reads every archive of the stage eagerly, and it sat outside the
   * try: one EBUSY or EPERM — a concurrent ledger archive mid-rename on Windows, a
   * directory where the file should be — threw past `reviewFactsFor`, the CLI printed the
   * error and exited 1 with no checks table at all, and the orchestrator's `--can-merge`
   * read stdout that never came. The `unavailable` row was designed for this.
   */
  it("reports the checks unavailable when an archive cannot be read, rather than throwing", () => {
    const root = rootWithArchives([{ text: REVIEW_TEXT, stamp: { reviewed: "abc", head: "abc" } }]);
    const runs = join(root, ".autoclaude", "state", "runs", "5");
    // A directory in the place of the archive file, the shape `recentNotes`'s own test
    // uses: `readFileSync` fails with EISDIR wherever the suite runs.
    rmSync(join(runs, "code-review-1.md"));
    mkdirSync(join(runs, "code-review-1.md"));
    const f = reviewFactsFor(root, 1, { classify: { catalogue } });
    expect(f?.unavailable, "the reason a human can act on").toMatch(/cannot be read/);
    expect(f?.report).toBeNull();
    const v = at(f);
    expect(result(v, 3)).toBe("unavailable");
    expect(result(v, 6)).toBe("unavailable");
    expect(v.allowed).toBe(false);
  });

  /**
   * The ledger read, one line above that try.
   *
   * The archive read was moved inside and `loadLedger` was not, so the symptom survived
   * its own fix: a `ledger.json` a concurrent writer left half-renamed, or one edited by
   * hand into something `JSON.parse` refuses, threw past `reviewFactsFor` and the CLI
   * exited 1 with no table. Nothing here can be read without the ledger — it is what
   * names the issue the archives belong to — so the answer is the `unavailable` row on
   * both checks, with the file named.
   */
  it("reports the checks unavailable when the ledger cannot be read", () => {
    const root = rootWithArchives([{ text: REVIEW_TEXT, stamp: { reviewed: "abc", head: "abc" } }]);
    writeFileSync(join(root, ".autoclaude", "state", "ledger.json"), "{ not json");
    const f = reviewFactsFor(root, 1, { classify: { catalogue } });
    expect(f, "a fact table with the reason, not a throw and not null").not.toBeNull();
    expect(f?.unavailable, "the reason a human can act on").toMatch(/ledger/);
    expect(f?.issue, "which issue this is about is exactly what could not be read").toBeNull();
    expect(f?.report).toBeNull();
    expect(f?.head, "and no stamp, so check 6 has nothing to compare").toBeNull();
    const v = at(f);
    expect(result(v, 3)).toBe("unavailable");
    expect(result(v, 6)).toBe("unavailable");
    expect(detail(v, 3), "the file, so the reader knows what to repair").toMatch(/ledger\.json/);
    expect(detail(v, 6)).toMatch(/ledger/);
    expect(v.allowed).toBe(false);
    // And the table is what the CLI prints: seven rows, none of them thrown.
    expect(v.checks).toHaveLength(7);
  });

  // The suite's first `allowed: true`. Every other case above refuses, and that is the
  // rule rather than an accident: an absent signal is a refusal, so an empty rollup, a
  // pull request no ledger entry owns and an archive without a stamp all read as "nothing
  // passed" — only a pull request whose checks are green and whose newest archived review
  // is stamped for exactly this head has said yes to all seven.
  it("is allowed on a green pull request whose newest review is stamped for its head", () => {
    const v = evaluate(
      { pr: pr(), files: ["src/a.ts"], behind: false, review: facts({ reviewed: "old1111" }) },
      cfg,
    );
    expect(v.checks.map((c) => c.result)).toEqual(Array(7).fill("pass"));
    expect(v.allowed).toBe(true);
  });

  it("reads the review facts from a temporary root with a stamped archive", () => {
    // Two rounds archived: the newest is the review that owned the push.
    const root = rootWithArchives([
      { text: REVIEW_TEXT, stamp: { reviewed: "gone1111", head: "gone2222" } },
      { text: REVIEW_TEXT, stamp: { reviewed: "old1111", head: "def5678" } },
    ]);
    const f = reviewFactsFor(root, 1, { classify: { catalogue } });
    expect(f?.issue, "the issue the ledger entry carrying the pull request is for").toBe(5);
    expect(f?.archive).toBe(join(root, ".autoclaude", "state", "runs", "5", "code-review-2.md"));
    expect(f?.reviewed).toBe("old1111");
    expect(f?.head).toBe("def5678");
    expect(f?.problem).toBeNull();
    // An archive made before the decision stamp existed carries none, and check 3 reads
    // the classes off the re-parsed report as it always did.
    expect(f?.decision).toBeNull();
    expect(f?.report?.redStep).toBe("proven");
    // Classified against the catalogue, which is what check 3 then counts.
    expect(f?.report?.findings.map((x) => [x.rule, x.tier])).toEqual([
      ["bug/general-case", "must"],
      ["tests/no-positive-control", "should"],
    ]);
    expect(detail(at(f), 3)).toBe("1 must open: bug/general-case at src/a.ts:12");

    // With no `classify` the rules are the packaged engine half plus the project's own
    // `.autoclaude/invariants.md` under the root the state lives in (design section 8.1),
    // and the threshold is the configured one: handing in `cfg` is enough.
    expect(reviewFactsFor(root, 1, { cfg })?.report?.findings.map((x) => x.tier)).toEqual([
      "must",
      "should",
    ]);
    // And with neither a `classify` nor a `cfg` the config is read from the root; a root
    // with no `.autoclaude/config.json` cannot be read, which is a refusal of check 3 and
    // never a pass on findings classified against a threshold nobody chose.
    const unconfigured = reviewFactsFor(root, 1);
    expect(unconfigured?.report).toBeNull();
    expect(unconfigured?.problem).toMatch(/config/);

    // No facts at all for a pull request no entry carries, and none for an entry whose
    // issue has no archived code review. Both are check 3's and check 6's "unavailable".
    expect(
      reviewFactsFor(root, 99, { classify: { catalogue } }),
      "no entry carries #99",
    ).toBeNull();
    expect(reviewFactsFor(rootWithArchives([]), 1, { classify: { catalogue } }), "the entry has no archive").toBeNull(); // prettier-ignore
  });
});

// The whole verdict for one pull request, driven through a fake runner. Every git argv
// and every derived ref names `forge.remote` (here `upstream`), never a literal.
describe("canMerge, the whole verdict", () => {
  const stamped = {
    reviewed: "old1111",
    head: "abc",
    decision: "publish",
    must: "0",
    should: "1",
    later: "0",
    withdrawn: "0",
  };
  const drive = (answers: Record<string, { status?: number; stdout?: string }> = {}) => {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      const key = Object.keys(answers).find((k) => line.startsWith(k));
      const a = key === undefined ? {} : answers[key];
      return { status: a?.status ?? 0, stdout: a?.stdout ?? "", stderr: "" };
    };
    return { exec, calls };
  };
  const green = {
    "gh -R o/r pr view 1": { stdout: JSON.stringify(pr()) },
    "git -c core.quotePath=false diff": { stdout: "src/a.ts\n" },
  };
  const wiring = { ...cfg, forge: { remote: "upstream" } } as unknown as ProjectConfig;

  it("allows a green, current, reviewed pull request and names the remote everywhere", () => {
    const root = rootWithArchives([{ text: REVIEW_TEXT, stamp: stamped }]);
    const d = drive(green);
    const v = canMerge(1, { forge: new Forge("o/r", d.exec), exec: d.exec, root, cfg: wiring });
    expect(v.allowed, JSON.stringify(v.checks)).toBe(true);
    expect(v.review).toMatchObject({ issue: 5 });
    expect(d.calls.slice(1)).toEqual([
      "git -c core.quotePath=false fetch upstream develop agent/1-x --quiet",
      "git -c core.quotePath=false diff --name-only --no-renames upstream/develop...abc",
      "git merge-base --is-ancestor upstream/develop abc",
    ]);
    expect(d.calls.filter((c) => /\borigin\b/.test(c))).toEqual([]);
    expect(renderVerdict(1, v)).toMatch(/^can-merge #1: ALLOWED\n/);
  });

  it("refuses a branch that is behind and a diff that needs a label it lacks", () => {
    const root = rootWithArchives([{ text: REVIEW_TEXT, stamp: stamped }]);
    const d = drive({
      ...green,
      "git -c core.quotePath=false diff": { stdout: "db/migrations/001.sql\n" },
      "git merge-base": { status: 1 },
    });
    const v = canMerge(1, { forge: new Forge("o/r", d.exec), exec: d.exec, root, cfg: wiring });
    expect(v.allowed).toBe(false);
    expect(result(v, 5)).toBe("fail");
    expect(result(v, 7)).toBe("fail");
    expect(renderVerdict(1, v)).toMatch(/^can-merge #1: REFUSED\n/);
  });

  it("throws when a gh or git call fails, which the verb reports as exit 1", () => {
    const root = rootWithArchives([]);
    const d = drive({ ...green, "git -c core.quotePath=false fetch": { status: 128 } });
    expect(() =>
      canMerge(1, { forge: new Forge("o/r", d.exec), exec: d.exec, root, cfg: wiring }),
    ).toThrow(/fetch/);
  });
});
