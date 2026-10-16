import { afterAll, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReviewComment,
  alreadyPostedFor,
  parsePostReviewArgs,
  REVIEW_COMMENT_MARKER,
  postReview,
} from "../../../src/engine/review/post-review.js";
import { emptyLedger, saveLedger, transition } from "../../../src/engine/ledger/ledger.js";
import { parseCodeReviewReport } from "../../../src/engine/review/reports.js";
import { loadCatalogue } from "../../../src/engine/review/rules.js";
import type { ProjectConfig } from "../../../src/config/types.js";
import type { Exec } from "../../../src/forge/github.js";

const fx = (n: string) => readFileSync(`test/fixtures/reports/${n}.md`, "utf8");
const catalogue = loadCatalogue({
  engine: "catalogue/rules.md",
  project: "test/fixtures/catalogue/invariants.md",
});
const report = parseCodeReviewReport(fx("code-review"), { catalogue });

/**
 * Only what the comment and `decide` read. The prefixes are deliberately not a project's
 * usual ones, and the footer is not the default's: a label or a footer built from a
 * literal in the module passes with the usual values and fails here.
 */
const cfg = {
  forge: { remote: "upstream" },
  humans: ["maintainer"],
  caps: { fixRounds: 2, planRounds: 2, reviewRetries: 2 },
  labels: { fixRound: "fix-", reviewRetry: "retry-" },
  stages: { implement: {} },
  messages: { footer: "Posted by the test footer", defuseMentions: true },
} as unknown as ProjectConfig;
const repo = "o/r";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * A throwaway state root.
 *
 * Every case names one, because `postReview` resolves the pull request's ledger entry to
 * find the worktree its quotes were checked against — and the ledger of the checkout this
 * suite runs in belongs to the sessions running, which may well hold an entry for the
 * number these cases use.
 */
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "autoclaude-post-review-"));
  roots.push(r);
  return r;
}

describe("renderReviewComment", () => {
  it("carries a marker naming the reviewed commit", () => {
    const body = renderReviewComment(report, "abc1234");
    expect(body).toContain(`${REVIEW_COMMENT_MARKER} sha=abc1234 -->`);
  });

  it("renders every finding with its rule, file, line and evidence", () => {
    const body = renderReviewComment(report, "abc1234");
    const f = report.findings[0]!;
    expect(body).toContain(f.rule);
    expect(body).toContain(`${f.file}:${f.line}`);
    expect(body).toContain(f.evidence);
  });

  // T1: the tiers replace the levels here. must and should both cost a fix round and only
  // must blocks the merge; a later item costs nothing and is recorded. Three different
  // prices, so the reader must not have to sort them.
  const mixed = {
    ...report,
    findings: [
      { ...report.findings[0]!, tier: "must" as const, rule: "bug/boundary" },
      { ...report.findings[0]!, tier: "should" as const, rule: "tests/business-logic-covered" },
      { ...report.findings[0]!, tier: "later" as const, rule: "scope/follow-up" },
    ],
  };

  it("separates must, should and later, because only two of them cost a round", () => {
    const body = renderReviewComment(mixed, "abc1234");
    expect(body).toContain("### Must (1)");
    expect(body).toContain("### Should (1)");
    expect(body).toContain("### Later (1)");
    expect(body.indexOf("bug/boundary")).toBeLessThan(body.indexOf("tests/business-logic-covered"));
    expect(body.indexOf("tests/business-logic-covered")).toBeLessThan(
      body.indexOf("scope/follow-up"),
    );
    // What each class costs, in the section's own intro: the rule id does not say it.
    expect(body).toContain("These block the merge; each one costs a fix round.");
    expect(body).toContain("These cost a fix round without blocking the merge.");
  });

  it("lists later items as noted", () => {
    const body = renderReviewComment(mixed, "abc1234");
    expect(body).toMatch(/### Later \(1\)\n\nNoted by the review, deliberately not fixed now:/);
    expect(body).toContain("scope/follow-up");
  });

  // Free text, and quoted rather than parsed: the two fields prove the review said how it
  // ran, never that what it said is true. Without them a review with one pair of eyes and
  // one with eight read the same.
  it("states how the review ran", () => {
    const body = renderReviewComment(report, "abc1234");
    expect(body).toMatch(/How it ran: fan-out `criteria, bugs.*`; scored by `sonnet`/);
  });

  it("says plainly that nothing was found rather than rendering an empty list", () => {
    const clean = { ...report, findings: [], uncertain: [] };
    const body = renderReviewComment(clean, "abc1234");
    expect(body).toMatch(/[Nn]o findings/);
  });

  // An unfinished review is not a clean one. The same conflation prBody guards against:
  // absence and cleanliness must not look alike.
  it("withdraws the claim of completeness when the review stopped early", () => {
    const stopped = { ...report, complete: false };
    const body = renderReviewComment(stopped, "abc1234");
    expect(body).toMatch(/did not finish/i);
  });

  it("lists what the reviewer was unsure about, separately from its findings", () => {
    const body = renderReviewComment({ ...report, uncertain: ["bug/leak — cannot tell"] }, "a1");
    expect(body).toContain("bug/leak — cannot tell");
  });

  // For a --pr review this comment is all a human reads. Without these, a review that
  // skipped the red step still said "No findings against <sha>", exactly like a thorough one.
  it("states the red step's verdict", () => {
    expect(renderReviewComment(report, "abc1234")).toContain("Red step: `not-proven`");
  });

  it("puts a red step that could not run up front, with its reason", () => {
    const body = renderReviewComment(
      { ...report, redStep: "could-not-run" as const, reason: "the base collected no tests" },
      "abc1234",
    );
    expect(body).toContain("The red step could not run");
    expect(body).toContain("the base collected no tests");
  });

  it("lists where the evidence for each criterion was found", () => {
    const body = renderReviewComment(report, "abc1234");
    expect(body).toContain("met — tests/unit/lib/format.test.ts:41");
  });

  it("says there was nothing to check when the pull request names no issue", () => {
    const body = renderReviewComment({ ...report, criteria: [], criteriaNone: true }, "abc1234");
    expect(body).toMatch(/names no issue/);
  });
});

describe("alreadyPostedFor", () => {
  const commentFor = (sha: string) => ({ body: `${REVIEW_COMMENT_MARKER} sha=${sha} -->\nx` });

  it("is true when this very commit was already reviewed", () => {
    expect(alreadyPostedFor([commentFor("abc1234")], "abc1234")).toBe(true);
  });

  // A new push is a new commit and deserves its own comment; the old one stays as the
  // record of what that commit looked like. This is why the marker carries the sha at
  // all rather than being edited in place.
  it("is false for a different commit, so a new push gets its own comment", () => {
    expect(alreadyPostedFor([commentFor("abc1234")], "def5678")).toBe(false);
  });

  it("is false when the pull request has no review comment at all", () => {
    expect(alreadyPostedFor([], "abc1234")).toBe(false);
    expect(alreadyPostedFor([{ body: "a human's comment" }], "abc1234")).toBe(false);
  });

  // Somebody quoting the marker in prose must not silence the next review.
  it("ignores a marker that is not at the start of a comment", () => {
    expect(
      alreadyPostedFor([{ body: `see the comment with ${REVIEW_COMMENT_MARKER} sha=abc1234 -->` }], "abc1234"), // prettier-ignore
    ).toBe(false);
  });
});

// The wiring, not just the two pure helpers. The file's own docblock offers "do not post
// the same review twice" as the reason it exists as a script, and until this test that
// behaviour was the one thing not driven: dropping the guard kept the suite green and
// showed up as duplicate comments on a pull request.
describe("postReview, driven through an injected runner", () => {
  /** A root with no ledger at all: no entry owns the pull request, so nothing is decided. */
  const noLedger = tempRoot();
  function fake(comments: Array<{ body: string }>) {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec: Exec = (_cmd, args, opts) => {
      calls.push({ args: args.slice(2), input: opts?.input });
      if (args[2] === "pr" && args[3] === "view") {
        return { status: 0, stdout: JSON.stringify({ comments }), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  }
  /** The `gh pr comment` calls, with the body each one sent on stdin. */
  const posted = (calls: Array<{ args: string[]; input?: string }>) =>
    calls.filter((c) => c.args[0] === "pr" && c.args[1] === "comment");

  it("posts the rendered review when the commit has none", () => {
    const f = fake([]);
    const r = postReview(7, fx("code-review"), "abc1234", f.exec, { root: noLedger, cfg, repo });
    expect(r.code).toBe(0);
    expect(posted(f.calls)).toHaveLength(1);
    // The body travels through stdin, so markers and backticks never meet a shell.
    expect(posted(f.calls)[0]!.args).toContain("--body-file");
    const sent = f.calls.find((c) => c.args[1] === "comment")!.input!;
    expect(sent).toContain(`${REVIEW_COMMENT_MARKER} sha=abc1234 -->`);
  });

  it("posts nothing the second time for the same commit", () => {
    const first = fake([]);
    postReview(7, fx("code-review"), "abc1234", first.exec, { root: noLedger, cfg, repo });
    const sent = first.calls.find((c) => c.args[1] === "comment")!.input!;

    const second = fake([{ body: sent }]);
    const r = postReview(7, fx("code-review"), "abc1234", second.exec, {
      root: noLedger,
      cfg,
      repo,
    });
    expect(r.code).toBe(0);
    expect(r.message).toMatch(/already posted/);
    expect(posted(second.calls)).toHaveLength(0);
  });

  it("posts again for the next commit, rather than editing the last one away", () => {
    const prior = fake([]);
    postReview(7, fx("code-review"), "abc1234", prior.exec, { root: noLedger, cfg, repo });
    const old = prior.calls.find((c) => c.args[1] === "comment")!.input!;

    const next = fake([{ body: old }]);
    expect(
      postReview(7, fx("code-review"), "def5678", next.exec, { root: noLedger, cfg, repo }).code,
    ).toBe(0);
    expect(posted(next.calls)).toHaveLength(1);
    expect(posted(next.calls)[0]!.args).not.toContain("--edit-last");
  });

  it("refuses to post a report it could not parse, and says so", () => {
    const f = fake([]);
    const r = postReview(7, "this is not a report block", "abc1234", f.exec, {
      root: noLedger,
      cfg,
      repo,
    });
    expect(r.code).toBe(2);
    expect(posted(f.calls)).toHaveLength(0);
  });

  // The banner this file's own header promises was unreachable: `extractBlock` needs a
  // status line as the block's end marker, and the skill told a reviewer that stopped
  // early to omit that line — so a skill-conformant stopped report threw and came back as
  // exit 2, "the report did not parse". With `CODE-REVIEW-STATUS: stopped` written
  // instead, what the review had found reaches the pull request under the banner.
  it("posts a report that stopped early, under the banner", () => {
    const f = fake([]);
    const stopped = fx("code-review").replace(
      "CODE-REVIEW-STATUS: complete",
      "CODE-REVIEW-STATUS: stopped",
    );
    const r = postReview(7, stopped, "abc1234", f.exec, { root: noLedger, cfg, repo });
    expect(r.code).toBe(0);
    expect(posted(f.calls)).toHaveLength(1);
    const sent = posted(f.calls)[0]!.input!;
    expect(sent).toMatch(/did not finish/i);
    // And what it had written is in the comment, which is the point of posting it at all.
    expect(sent).toContain("tests/passes-without-change");
  });

  /**
   * The shape a real stopped report has, which the case above never exercised: it swaps
   * one word on a complete fixture, so every field the reviewer would not have reached is
   * still filled in. A reviewer that stopped before Step 2 or Step 6 has an empty
   * `red-step:`, `fan-out:` and `scored-by:` and no criteria at all — and
   * `parseCodeReviewReport` refuses exactly those, so the banner this file's header
   * promises was unreachable: exit 2, "report did not parse", on the one path that leaves
   * a human with nothing.
   */
  it("posts the shape a reviewer that stopped before its verdict really leaves", () => {
    const f = fake([]);
    const r = postReview(7, fx("code-review-stopped"), "abc1234", f.exec, {
      root: noLedger,
      cfg,
      repo,
    });
    expect(r.code, r.message).toBe(0);
    expect(posted(f.calls)).toHaveLength(1);
    const sent = posted(f.calls)[0]!.input!;
    expect(sent).toMatch(/did not finish/i);
    // The findings and the uncertain lines it had written, which is what it is posted for.
    expect(sent).toContain("bug/general-case");
    expect(sent).toContain("perf/inefficiency");
    // And the fields it never reached say so rather than reading as a verdict.
    expect(sent).toMatch(/did not reach the red step/i);
    expect(sent).toMatch(/not stated/);
    expect(sent, "no criterion was checked, and none is claimed").not.toContain(
      "Evidence per criterion",
    );
  });

  // The strict parser still decides a report that says it finished: a stopped one is read
  // leniently, and a complete one that does not parse is still exit 2.
  it("still refuses a complete report that is missing a required field", () => {
    const f = fake([]);
    const withoutFanOut = fx("code-review").replace(/^fan-out:.*\n/m, "");
    expect(
      postReview(7, withoutFanOut, "abc1234", f.exec, { root: noLedger, cfg, repo }).code,
    ).toBe(2);
    expect(posted(f.calls)).toHaveLength(0);
  });
});

/**
 * The `--pr` comment rendered every finding as the report stated it, while the pull
 * request body `publish.ts` writes renders the decision — so the two could disagree about
 * the same sha, one listing a must the evidence check had withdrawn and the other not.
 * `entryForPr` exists and `can-merge.ts` uses it; this resolves the worktree the same way
 * and degrades to the raw rendering only when there is no entry or no worktree.
 */
describe("postReview renders the decision when the ledger owns the pull request", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  /** A report whose one finding quotes a file the worktree does not have. */
  const GONE = [
    "AUTODEV-CODE-REVIEW",
    "issue: 5",
    "red-step: proven",
    "fan-out: bugs",
    "scored-by: sonnet",
    "criteria:",
    "  1. met — src/x.ts:3",
    "findings:",
    "  - rule: bug/general-case",
    "    confidence: 9",
    "    file: src/gone.ts",
    "    line: 40",
    '    evidence: "open(fd);"',
    "    message: Handles the example and not the class it stands for.",
    "uncertain:",
    "CODE-REVIEW-STATUS: complete",
    "",
  ].join("\n");

  /** A root whose ledger gives pull request 7 a worktree holding `src/x.ts` and nothing else. */
  function rootWithEntry(worktree = true): string {
    const root = tempRoot();
    const wt = join(root, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.ts"), "// 1\n// 2\nconst a = 1;\n// 4\n");
    const ledger = emptyLedger("me");
    transition(
      ledger,
      5,
      "pr-open",
      { title: "t", branch: "agent/5-x", worktree: worktree ? wt : "", pr: 7 },
      now,
    );
    saveLedger(root, ledger, now);
    return root;
  }

  function fake() {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec: Exec = (_cmd, args, opts) => {
      calls.push({ args: args.slice(2), input: opts?.input });
      if (args[2] === "pr" && args[3] === "view") {
        return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  }
  const sentBy = (calls: Array<{ args: string[]; input?: string }>) =>
    calls.find((c) => c.args[1] === "comment")?.input ?? "";

  it("moves a finding the evidence check withdrew to uncertain, with the reason", () => {
    const f = fake();
    const r = postReview(7, GONE, "abc1234", f.exec, { root: rootWithEntry(), cfg, repo });
    expect(r.code, r.message).toBe(0);
    const sent = sentBy(f.calls);
    expect(sent, "a withdrawn claim is not a finding").not.toContain("### Must (1)");
    expect(sent).toMatch(/No findings against/);
    expect(sent, "the reason the claim was withdrawn").toContain("was not found within 5 lines");
    expect(sent).toContain("bug/general-case");
    expect(r.message, "the count is the decision's, not the report's").toContain("0 findings");
  });

  /**
   * The positive control the block lacked.
   *
   * Every fixture here quoted `src/gone.ts` while the worktree holds `src/x.ts` alone, so
   * every case with a worktree withdrew its finding — and a regression that withdrew
   * *everything* would have passed all of them. This is the other half: the same finding
   * quoting a line the worktree really has, kept and rendered under its tier.
   */
  it("keeps a finding whose quote is in the worktree, under its tier", () => {
    const f = fake();
    // `const a = 1;` is line 3 of the `src/x.ts` the fixture root writes.
    const found = GONE.replace("file: src/gone.ts", "file: src/x.ts")
      .replace("line: 40", "line: 3")
      .replace('evidence: "open(fd);"', 'evidence: "const a = 1;"');
    const r = postReview(7, found, "abc1234", f.exec, { root: rootWithEntry(), cfg, repo });
    expect(r.code, r.message).toBe(0);
    const sent = sentBy(f.calls);
    expect(sent, "the evidence check ran and the claim survived it").toContain("### Must (1)");
    expect(sent).toContain("bug/general-case");
    expect(sent, "nothing was withdrawn").not.toContain("was not found within 5 lines");
    expect(r.message).toContain("1 finding");
  });

  it("renders the report as it stands when no entry owns the pull request", () => {
    const f = fake();
    // The same report against a root with no ledger: nothing checked anything, so the
    // finding stands — which is the honest answer rather than a check run against
    // whatever directory the process happens to stand in.
    const r = postReview(7, GONE, "abc1234", f.exec, { root: tempRoot(), cfg, repo });
    expect(r.code, r.message).toBe(0);
    expect(sentBy(f.calls)).toContain("### Must (1)");
    expect(r.message).toContain("1 finding");
  });

  it("renders the report as it stands when the entry names no worktree", () => {
    // A reconciled entry, rebuilt from an open pull request with nothing on disk: joining
    // an empty worktree would read the main working directory, the one place the engine
    // never touches.
    const f = fake();
    expect(
      postReview(7, GONE, "abc1234", f.exec, { root: rootWithEntry(false), cfg, repo }).code,
    ).toBe(0);
    expect(sentBy(f.calls)).toContain("### Must (1)");
  });

  it("does not decide about a report that stopped early", () => {
    // There is nothing to decide: an unfinished review has no verdict, and `publish.ts`
    // refuses such a report outright. The banner and what it had written still travel.
    const f = fake();
    const r = postReview(7, fx("code-review-stopped"), "abc1234", f.exec, {
      root: rootWithEntry(),
      cfg,
      repo,
    });
    expect(r.code, r.message).toBe(0);
    expect(sentBy(f.calls)).toMatch(/did not finish/i);
    expect(sentBy(f.calls)).toContain("bug/general-case");
  });

  /**
   * A ledger this script cannot read must not cost the comment.
   *
   * Deciding was added to this file in the round above, and with it a dependency on
   * `loadLedger` and `loadConfig` — so a corrupt `ledger.json` or a config the loader
   * refuses turned a `--pr` post into exit 1, on the one path whose whole job is to leave
   * a human with the review. The decision is a refinement of the comment, not a
   * precondition for it: what the review wrote is worth posting either way, and the
   * reader is told the refinement is missing and why.
   *
   * Distinct from the three cases above, which are absences rather than failures: no entry
   * and no worktree mean nothing checked anything, and that needs no explanation beyond
   * the findings standing as written.
   */
  it("posts the review as written when the ledger cannot be read, saying why", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
    writeFileSync(join(root, ".autoclaude", "state", "ledger.json"), "{ not json at all");
    const f = fake();
    const r = postReview(7, GONE, "abc1234", f.exec, { root, cfg, repo });
    expect(r.code, r.message).toBe(0);
    const sent = sentBy(f.calls);
    // The raw rendering: the finding stands, because nothing checked it.
    expect(sent).toContain("### Must (1)");
    expect(sent).toContain("bug/general-case");
    // Plus one line saying the decision is missing, and what stopped it.
    expect(sent, "the reader is not told the refinement is missing").toMatch(
      /decision could not be computed/i,
    );
    expect(sent, "the reason is not named").toMatch(/ledger\.json|JSON/);
    // One line: the reason is folded, so a parser error with a stack does not become the
    // body of the comment.
    expect(sent.split("\n").filter((l) => /decision could not be computed/i.test(l)).length).toBe(
      1,
    );
    expect(r.message).toContain("1 finding");
  });

  /**
   * And the other half of the same rule: the config.
   *
   * `decisionFor` wraps `loadLedger` and the config read, but the `classify` default must
   * not sit outside every try: `classifyOptions` reads the project's
   * `.autoclaude/config.json`, so a config the loader refused would still throw out of
   * `postReview`, land in the caller's outer catch and exit 1 with no comment posted —
   * the outcome the case above set out to remove.
   *
   * The fallback is the default threshold and the catalogue, which is readable either way:
   * the catalogue is the engine's rules plus the project's `.autoclaude/invariants.md`, not
   * the config. A catalogue that cannot be read is a different failure and still throws,
   * because there is then no vocabulary to classify a finding against at all.
   *
   * No `classify` and no `cfg` are passed, so both defaults are what this case is about:
   * the config is read from the root, and the root's is not JSON.
   */
  it("posts the review as written when the config cannot be read, saying why", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".autoclaude"), { recursive: true });
    writeFileSync(join(root, ".autoclaude", "config.json"), "{ not json at all");
    const f = fake();
    const r = postReview(7, GONE, "abc1234", f.exec, { root, repo });
    expect(r.code, r.message).toBe(0);
    const sent = sentBy(f.calls);
    // The review still reaches the pull request, classified against the default threshold.
    expect(sent).toContain("### Must (1)");
    expect(sent).toContain("bug/general-case");
    // And the reader is told the threshold is not this project's, with the reason.
    expect(sent, "the reader is not told the configuration is missing").toMatch(
      /configuration could not be read/i,
    );
    expect(sent, "the reason is not named").toMatch(/config\.json|JSON/);
    expect(sent.split("\n").filter((l) => /configuration could not be read/i.test(l)).length).toBe(
      1,
    );
    expect(r.message).toContain("1 finding");
  });
});

/**
 * The command line, as a value rather than a control-flow accident.
 *
 * The parse used to sit inline in the `process.argv` block with `pr` declared as a `let`
 * and no initialiser, its assignment established by a `catch` that ended in
 * `process.exit` — true, because `process.exit` is typed `never`, but a statement
 * inserted after that catch would have broken it silently. A result the caller narrows is
 * both testable without spawning and impossible to get wrong that way.
 */
describe("parsePostReviewArgs", () => {
  const ok = ["12", "--report", "r.md", "--sha", "abc123"];

  it("takes the pull request number and both flag values", () => {
    expect(parsePostReviewArgs(ok)).toEqual({ pr: 12, reportFile: "r.md", sha: "abc123" });
  });

  it("refuses a token that is not a decimal pull request number, in front of the flags", () => {
    for (const bad of ["0x10", "1e2", "+5", "0", "", "abc"]) {
      const r = parsePostReviewArgs([bad, "--report", "r.md", "--sha", "abc123"]);
      expect(r, String(bad)).toHaveProperty("usage");
      expect("usage" in r && r.usage, String(bad)).toMatch(/is not a pull request number/);
    }
    // In front of the flags, so a bad number cannot spend a file read: the report and the
    // sha are missing here too and the token is still what the message names.
    const r = parsePostReviewArgs(["0x10"]);
    expect("usage" in r && r.usage).toMatch(/is not a pull request number/);
  });

  /**
   * And the flags themselves go through the shared parser.
   *
   * This file imported `flag()`'s sibling for the token above and kept a private `at()`
   * for the two flags: it took the next token whatever it was, so `--report --sha abc123`
   * recorded the report path `--sha` and read a file of that name, and it ignored a repeat,
   * so `--sha` given twice posted the review keyed on the first commit while the caller
   * meant the second.
   */
  it("refuses a repeated flag and a flag whose value is the next flag", () => {
    for (const argv of [
      [...ok, "--report", "other.md"],
      [...ok, "--sha", "def4567"],
    ]) {
      const r = parsePostReviewArgs(argv);
      expect(r, argv.join(" ")).toHaveProperty("usage");
      expect("usage" in r && r.usage, argv.join(" ")).toMatch(/given more than once/);
    }
    const value = parsePostReviewArgs(["12", "--report", "--sha", "abc123"]);
    expect(value).toHaveProperty("usage");
    expect("usage" in value && value.usage).toMatch(/needs a value/);
    // The positive control: the well-formed line still parses.
    expect(parsePostReviewArgs(ok)).toEqual({ pr: 12, reportFile: "r.md", sha: "abc123" });
  });

  it("refuses a missing --report or --sha with the usage line", () => {
    for (const argv of [["12"], ["12", "--report", "r.md"], ["12", "--sha", "abc123"]]) {
      const r = parsePostReviewArgs(argv);
      expect(r, argv.join(" ")).toEqual({
        usage: expect.stringContaining("Usage: post-review"),
      });
    }
  });
});

/**
 * A workflow that triggers on a mention in a pull request comment would start a run from
 * inside a review comment, and every finding's message, evidence and uncertain line in
 * this comment is model-written text that reaches GitHub verbatim. The scrub is one line
 * and closes it. It is the config's (`messages.defuseMentions`, allowing `humans`; design
 * section 8.2), so it can be turned off and a project's own people stay mentionable.
 */
describe("the mention that would trigger a workflow is defused", () => {
  const mentioning = {
    ...report,
    uncertain: ["review/repeat-finding — @Claude asked for this once already, cc @maintainer"],
  };
  const messages = { footer: "f", defuseMentions: true, humans: ["maintainer"] };

  it("replaces it in the comment, case-insensitively, and leaves the words around it", () => {
    const body = renderReviewComment(mentioning, "abc1234", null, {}, messages);
    expect(body, "the trigger reaches the pull request").not.toMatch(/@claude/i);
    expect(body).toContain("@\u200bClaude asked for this once already");
  });

  it("keeps the mention of a configured human", () => {
    const body = renderReviewComment(mentioning, "abc1234", null, {}, messages);
    expect(body).toContain("cc @maintainer");
  });

  it("leaves every mention alone when the config turns defusing off", () => {
    const off = { ...messages, defuseMentions: false };
    const body = renderReviewComment(mentioning, "abc1234", null, {}, off);
    expect(body).toContain("@Claude asked for this once already, cc @maintainer");
  });
});

// The footer is the config's (design section 8.2, `messages.footer`), not a product line
// the module hardcodes. The default is only for a caller that names no messages at all.
describe("the footer", () => {
  it("is the configured one, last in the comment", () => {
    const body = renderReviewComment(
      report,
      "abc1234",
      null,
      {},
      {
        footer: "Posted by hand",
        defuseMentions: true,
        humans: [],
      },
    );
    expect(body.trimEnd().endsWith("Posted by hand")).toBe(true);
    expect(body).not.toContain("Claude Code");
  });

  it("is the engine's default when no messages are given", () => {
    expect(
      renderReviewComment(report, "abc1234").trimEnd().endsWith("Generated by autoclaude"),
    ).toBe(true);
  });

  it("travels in the comment postReview sends", () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const exec: Exec = (_cmd, args, opts) => {
      calls.push({ args: args.slice(2), input: opts?.input });
      return {
        status: 0,
        stdout: args[2] === "pr" && args[3] === "view" ? JSON.stringify({ comments: [] }) : "",
        stderr: "",
      };
    };
    postReview(7, fx("code-review"), "abc1234", exec, { root: tempRoot(), cfg, repo });
    const sent = calls.find((c) => c.args[1] === "comment")!.input!;
    expect(sent.trimEnd().endsWith("Posted by the test footer")).toBe(true);
  });
});

// Every gh call carries `-R <owner>/<repo>`, resolved from `forge.remote` when the caller
// does not already hold it (plan Global Constraints).
describe("the repository every gh call names", () => {
  it("is resolved from the configured remote when none is handed in", () => {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git")
        return { status: 0, stdout: "git@github.com:owner/name.git\n", stderr: "" };
      return {
        status: 0,
        stdout: args.includes("view") ? JSON.stringify({ comments: [] }) : "",
        stderr: "",
      };
    };
    const r = postReview(7, fx("code-review"), "abc1234", exec, { root: tempRoot(), cfg });
    expect(r.code, r.message).toBe(0);
    expect(calls[0]).toBe("git -c core.quotePath=false remote get-url upstream");
    const gh = calls.filter((c) => c.startsWith("gh"));
    expect(gh).toHaveLength(2);
    for (const c of gh) expect(c.startsWith("gh -R owner/name pr ")).toBe(true);
  });
});
