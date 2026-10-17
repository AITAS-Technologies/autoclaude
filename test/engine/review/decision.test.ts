import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, reviewDecision } from "../../../src/engine/review/decision.js";
import {
  parseCodeReviewReport,
  parsePlanReviewReport,
  type CodeReviewReport,
  type PlanReviewReport,
} from "../../../src/engine/review/reports.js";
import { loadCatalogue } from "../../../src/engine/review/rules.js";
import { findingBuilders } from "../../helpers/findings.js";
import { attempts, codeReview, planReview } from "../../helpers/reports.js";
import {
  emptyLedger,
  saveLedger,
  transition,
  type LedgerEntry,
} from "../../../src/engine/ledger/ledger.js";
import type { ProjectConfig } from "../../../src/config/types.js";

/**
 * `decision.ts`: what the orchestrator does next, computed from the report, the
 * ledger's counters and the caps instead of judged by a model.
 *
 * The rules under test are the design note's, in its order: the blocking set is
 * must ∪ should ∪ (first round ? later : ∅); a non-empty one starts a fix round while
 * rounds remain, blocks at the cap when a must is open and publishes at the cap when none
 * is; only then does a red step that could not run buy one retry; otherwise the change
 * publishes with the later items noted. Before any of that, every quoted line is checked
 * against the worktree and every fingerprint against the previous archived report.
 */

const catalogue = loadCatalogue({
  engine: "catalogue/rules.md",
  project: "test/fixtures/catalogue/invariants.md",
});
const fx = (name: string) => readFileSync(`test/fixtures/reports/${name}.md`, "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "autoclaude-decision-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A finding as the parser would have handed it over, from the builders both decision
 * tests share: level and tier already computed from the catalogue, a fingerprint that
 * matches the rule and the evidence, and the positions this suite's temporary worktree
 * holds.
 */
const { must, should, later } = findingBuilders({
  finding: { file: "src/x.ts", line: 10 },
  should: { evidence: "expect(headers.get('X-Extra')).toBeNull();" },
  later: { evidence: "// TODO: the remaining cases" },
});

/**
 * Only what `decide` reads: the two caps, the two label prefixes and whether the
 * implement stage names an escalated spec.
 *
 * The prefixes are deliberately not a project's usual ones: a label built from a literal
 * in the module instead of from the config passes with `agent-fix-` and fails here.
 * `escalated` is the config's `stages.implement.escalated` (design section 8.2), which
 * replaces the source's single escalated-model setting.
 */
function config(
  over: {
    fixRounds?: number;
    planRounds?: number;
    reviewRetries?: number;
    fixRound?: string;
    reviewRetry?: string;
    escalated?: boolean;
  } = {},
): ProjectConfig {
  const spec = { runtime: "claude", model: "model-small", effort: "medium" };
  return {
    caps: {
      fixRounds: over.fixRounds ?? 2,
      planRounds: over.planRounds ?? 2,
      // Two, the point of the case below: a note saying one retry and a re-dispatch rule
      // counting two on this counter must not disagree with the config.
      reviewRetries: over.reviewRetries ?? 2,
    },
    labels: {
      fixRound: over.fixRound ?? "agent-fix-",
      reviewRetry: over.reviewRetry ?? "agent-retry-",
    },
    stages: {
      implement: over.escalated
        ? { ...spec, escalated: { ...spec, model: "model-large", effort: "high" } }
        : spec,
    },
  } as unknown as ProjectConfig;
}

const code = { stage: "code-review" } as const;
const plan = { stage: "plan-review" } as const;

describe("the evidence check: the quote is checked, not believed", () => {
  /** A worktree holding `src/x.ts` with the quoted line at line 12 and nothing else. */
  function worktreeWithX(): string {
    const wt = tempDir();
    mkdirSync(join(wt, "src"), { recursive: true });
    const lines = [
      ...Array.from({ length: 11 }, (_, i) => `// line ${i + 1}`),
      "  const a = 1;",
      ...Array.from({ length: 20 }, (_, i) => `// line ${i + 13}`),
    ];
    writeFileSync(join(wt, "src", "x.ts"), lines.join("\n"));
    return wt;
  }

  it("demotes a finding whose evidence is not near its line to uncertain", () => {
    const wt = worktreeWithX();
    // Two lines out and differently indented: the same line, and the check says so.
    const near = must({ line: 10 });
    // The same quote twenty lines away: nothing near line 30 carries it.
    const far = must({ rule: "bug/boundary", line: 30 });
    const gone = must({ rule: "bug/leak", file: "src/gone.ts", line: 3, evidence: "open(fd);" });
    const report = codeReview([near, far, gone]);

    const d = decide(report, attempts(), config(), { ...code, worktree: wt });
    expect(d.blocking.map((f) => f.rule)).toEqual(["bug/general-case"]);
    expect(d.deferred).toEqual([]);
    expect(d.demoted.map((f) => f.rule)).toEqual(["bug/boundary", "bug/leak"]);
    // The note says which claim was withdrawn and where it was looked for.
    expect(d.demoted[0]?.demotion).toContain("src/x.ts:30");
    expect(d.demoted[1]?.demotion).toContain("src/gone.ts:3");
    expect(d.reason).toContain("2 withdrawn");

    // A caller with no worktree — can-merge reading an archive — checks nothing, and the
    // three findings stand. Without this the "demoted" list above could be produced by a
    // check that demotes everything.
    const unchecked = decide(report, attempts(), config(), code);
    expect(unchecked.demoted).toEqual([]);
    expect(unchecked.blocking).toHaveLength(3);
  });

  // The evidence check may withdraw a claim about a line. It may not withdraw a finding
  // the parser refuses the report without, because the two would then contradict each
  // other: the report says `red-step: not-proven` and carries the `tests/` must the
  // parser demands, the check withdraws that must over a quote that moved, nothing is
  // blocking any more — and the change publishes with the missing proof still missing.
  // Both facts are measured, not claimed about a line.
  it("a not-proven review never publishes", () => {
    const wt = worktreeWithX();
    // The quote is real but twenty lines from where the review put it, which is exactly
    // what the check withdraws for every other family.
    const proof = must({ rule: "tests/passes-without-change", line: 30 });
    const d = decide(codeReview([proof], { redStep: "not-proven" }), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted, "the must the parser requires must not be withdrawn").toEqual([]);
    expect(d.blocking.map((f) => f.rule)).toEqual(["tests/passes-without-change"]);
    expect(d.action).toBe("fix");
  });

  it("an unmet criterion never publishes", () => {
    const wt = worktreeWithX();
    // `spec/criterion-not-met` is exempt whether or not it quotes: a criterion with no
    // evidence in the diff is measured against the diff, and a quote it adds anyway is
    // not what makes it true. Quoting a wrong line used to withdraw it.
    const unmet = must({ rule: "spec/criterion-not-met", line: 30 });
    const d = decide(
      codeReview([unmet], { criteria: [{ met: false, text: "nothing in the diff" }] }),
      attempts(),
      config(),
      { ...code, worktree: wt },
    );
    expect(d.demoted, "the finding the unmet criterion needs must not be withdrawn").toEqual([]);
    expect(d.blocking.map((f) => f.rule)).toEqual(["spec/criterion-not-met"]);
    expect(d.action).toBe("fix");
  });

  // The property behind the two cases above, over the reports the suite actually parses,
  // at both ends of the round counter and with the worktree the quotes miss entirely. A
  // case-by-case test can be satisfied by an exemption keyed on the one rule id it names;
  // this one fails for any finding the parser requires and the check withdraws.
  it("publishes no fixture report whose red step is not-proven or whose criteria are unmet", () => {
    const empty = tempDir();
    for (const stage of ["code-review", "plan-review"] as const) {
      const text = fx(stage);
      const opts = { catalogue };
      // Kept as its own binding rather than narrowed out of the union: only the code
      // review has a red step and criteria, and those are the two facts under test.
      const asCode = stage === "code-review" ? parseCodeReviewReport(text, opts) : null;
      const report: CodeReviewReport | PlanReviewReport =
        asCode ?? parsePlanReviewReport(text, opts);
      for (const spent of [0, 1, 2]) {
        for (const worktree of [undefined, empty, "does-not-exist"]) {
          const d = decide(report, attempts({ fix: spent, plan: spent }), config(), {
            stage,
            worktree,
          });
          if (d.action !== "publish") continue;
          const where = `${stage}, ${spent} spent, worktree ${worktree ?? "none"}`;
          expect(asCode?.redStep ?? null, where).not.toBe("not-proven");
          const unmet = (asCode?.criteria ?? []).filter((c) => !c.met).map((c) => c.text);
          expect(unmet, where).toEqual([]);
        }
      }
    }
  });

  it("keeps a quoteless finding only when its family is about what a file does not contain", () => {
    const wt = worktreeWithX();
    // `reports.ts` reads `line: -` as 0: a criterion the change does not meet, a criterion
    // no task covers. Withdrawing those would silently publish the very finding the parser
    // refuses a report without.
    const noLine = must({ rule: "spec/criterion-not-met", file: "", line: 0, evidence: "" });
    const noQuote = must({ rule: "plan/criterion-uncovered", line: 12, evidence: "" });
    const kept = decide(codeReview([noLine, noQuote]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(kept.demoted).toEqual([]);
    expect(kept.blocking).toHaveLength(2);

    // Every other family has to quote a line. A `bug/` must with no `evidence:` parses
    // clean, because the parser defaults the field, so the exemption would otherwise be
    // the way around the check: a finding that blocks at the cap and cannot be tested.
    const unquoted = must({ rule: "bug/general-case", evidence: "" });
    const noFile = must({ rule: "perf/regression", file: "", evidence: "loop();" });
    const d = decide(codeReview([unquoted, noFile, noLine]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted.map((f) => f.rule)).toEqual(["bug/general-case", "perf/regression"]);
    expect(d.demoted[0]?.demotion).toContain("no quotable line");
    // The unmet criterion is still a must, so the round still happens — but on it alone.
    expect(d.blocking.map((f) => f.rule)).toEqual(["spec/criterion-not-met"]);
  });

  it("pins the window at five lines on either side", () => {
    const wt = worktreeWithX();
    // The quote sits on line 12. Five out is the same line, six is another one.
    const at = (line: number) =>
      decide(codeReview([must({ line })]), attempts(), config(), { ...code, worktree: wt });
    expect(at(17).demoted).toEqual([]);
    expect(at(7).demoted).toEqual([]);
    expect(at(18).demoted).toHaveLength(1);
    expect(at(6).demoted).toHaveLength(1);
  });

  it("runs no check at all when the named worktree is gone", () => {
    // A missing file inside the tree is a miss; a missing tree is an unrunnable check.
    // Reachable through `--report <archive>` on an entry whose worktree was removed, and
    // as a miss it withdrew every finding and turned an open must into a publish.
    const gone = join(tempDir(), "removed");
    const d = decide(codeReview([must(), should()]), attempts(), config(), {
      ...code,
      worktree: gone,
    });
    expect(d.demoted).toEqual([]);
    expect(d.action).toBe("fix");
    expect(d.blocking).toHaveLength(2);
    expect(d.reason).toContain("the evidence was not checked");
    expect(d.reason).toContain("worktree");
  });

  it("finds the line under a path a reviewer wrote with backslashes", () => {
    // This assertion cannot fail on Windows, which accepts either separator: it guards
    // the Linux runner, where a backslash is a legal character in a file name and the
    // path would not resolve, withdrawing every finding of a review that quoted one.
    const wt = worktreeWithX();
    const d = decide(codeReview([must({ file: "src\\x.ts", line: 12 })]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted).toEqual([]);
    expect(d.blocking).toHaveLength(1);
  });

  // `path.join` does not reset on an absolute second segment, so an angle that quoted the
  // path it read — the shape every tool in a worktree prints — produced a garbled path,
  // `readFileSync` threw and the finding was withdrawn as "not found". Three shapes reach
  // the check: a diff's `a/`/`b/` prefix, the worktree-rooted path `bench.ts`
  // already matches by suffix, and an absolute path.
  it("resolves a diff prefix, a worktree-rooted path and an absolute path", () => {
    const wt = worktreeWithX();
    const found = (file: string) =>
      decide(codeReview([must({ file, line: 12 })]), attempts(), config(), {
        ...code,
        worktree: wt,
      });
    for (const file of [
      "b/src/x.ts",
      "a/src/x.ts",
      ".autoclaude/worktrees/agent+5-x/src/x.ts",
      join(wt, "src", "x.ts"),
      join(wt, "src", "x.ts").replace(/\//g, "\\"),
    ]) {
      const d = found(file);
      expect(d.demoted, `${file} was withdrawn`).toEqual([]);
      expect(d.blocking, `${file} did not verify`).toHaveLength(1);
    }
  });

  // The review's Uncertain item, and the one platform the pipeline runs on: Git Bash's
  // `pwd` prints `/c/…`, which `isAbsolute` reads as absolute on win32, `relative()`
  // resolves against the current drive, and the finding was withdrawn as outside the
  // worktree. The shared normaliser maps the drive, so the quote resolves.
  it.runIf(process.platform === "win32")(
    "resolves a POSIX drive path, which is what Git Bash prints",
    () => {
      const wt = worktreeWithX();
      const posix = `/${wt.charAt(0).toLowerCase()}${wt.slice(2).replace(/\\/g, "/")}/src/x.ts`;
      const d = decide(codeReview([must({ file: posix, line: 12 })]), attempts(), config(), {
        ...code,
        worktree: wt,
      });
      expect(d.demoted, `${posix} was withdrawn`).toEqual([]);
      expect(d.blocking).toHaveLength(1);
    },
  );

  it("withdraws an absolute path that is outside the worktree, and says which", () => {
    const wt = worktreeWithX();
    // A second temporary tree: the quote verifies there and nowhere inside the worktree
    // the review was run against, which is exactly the claim the check exists to refuse.
    const elsewhere = tempDir();
    mkdirSync(join(elsewhere, "src"), { recursive: true });
    writeFileSync(join(elsewhere, "src", "x.ts"), "  const a = 1;\n");
    const outside = join(elsewhere, "src", "x.ts");
    const d = decide(codeReview([must({ file: outside, line: 1 })]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted).toHaveLength(1);
    expect(d.demoted[0]?.demotion).toContain(outside);
    expect(d.demoted[0]?.demotion).toContain("outside the worktree");
  });

  // The absolute branch enforced containment and the relative one did not, so
  // `join(worktree, "../../src/lib/a.ts")` resolved into the main checkout or a sibling
  // worktree — a file away from every worktree, and therefore the common case rather than
  // a corner — and the finding was kept as verified against a tree the diff never had.
  it("withdraws a relative path that climbs out of the worktree", () => {
    const parent = tempDir();
    const wt = join(parent, "tree");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.ts"), "// 1\n// 2\n  const a = 1;\n// 4\n");
    // A file beside the worktree carrying the very quote the finding names: this is the
    // shape a quote of the main working directory's own copy has.
    writeFileSync(join(parent, "outside.ts"), "  const a = 1;\n");
    const d = decide(codeReview([must({ file: "../outside.ts", line: 1 })]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted).toHaveLength(1);
    expect(d.demoted[0]?.demotion).toContain("outside the worktree");

    // The positive control: the same quote inside the tree still verifies, so the case
    // above fails for the climb and not because nothing resolves.
    const inside = decide(codeReview([must({ line: 3 })]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(inside.demoted).toEqual([]);
    expect(inside.blocking).toHaveLength(1);
  });

  // `paths/forbidden` and `paths/policy-adjacent` are measured the way the unmet criterion
  // and the red step's verdict are: the changed file list against a glob, with nothing left
  // to interpret. Their line is typically `-` and their quote a description, so the check
  // withdrew them almost every time they fired — silently defeating the one rule that
  // exists to force a human to look at a fenced path.
  it("keeps a paths/ finding, whose evidence is the changed file list", () => {
    const wt = worktreeWithX();
    const fenced = must({
      rule: "paths/forbidden",
      file: ".github/workflows/ci.yml",
      line: 0,
      evidence: "",
    });
    const adjacent = must({
      rule: "paths/policy-adjacent",
      file: "src/policy/rules.ts",
      line: 0,
      evidence: "the changed file list against config.policyAdjacentPaths",
    });
    const d = decide(codeReview([fenced, adjacent]), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted).toEqual([]);
    expect(d.blocking.map((f) => f.rule)).toEqual(["paths/forbidden", "paths/policy-adjacent"]);
    // And the release reason still names what a fenced path costs, which is the other
    // half of the family being blocking at all.
    const atCap = decide(codeReview([fenced]), attempts({ fix: 2 }), config(), {
      ...code,
      worktree: wt,
    });
    expect(atCap.action).toBe("block");
    expect(atCap.releaseReason).toContain("a fenced path changes without a human");
  });

  /**
   * Which findings the check leaves alone is a property of the **catalogue row**, not a
   * prefix list in the engine.
   *
   * `layer/schema-file-first` is a project rule of exactly the shape
   * `spec/criterion-not-met` has: its "what to inspect" is the diff as a whole and its
   * breach is a schema change with no schema file, so it has no
   * line to quote. The list of exempt families was `spec/`, `plan/`, `paths/` and had no
   * way to learn about it, so the one rule that exists to force a human to look at such a
   * change was withdrawn every time it fired and an open must became a publish — and
   * every project shipping a measurement rule would have had to edit the engine, against
   * the rule that the engine learns a project fact from `.autoclaude/` and nowhere else.
   *
   * Parsed rather than built, because the claim is that the parser reads the kind off the
   * row and the decision honours it.
   */
  it("keeps a quoteless finding whose catalogue row calls its evidence a measurement", () => {
    const wt = worktreeWithX();
    const block = (rule: string) =>
      [
        "AUTODEV-CODE-REVIEW",
        "issue: 5",
        "red-step: proven",
        "fan-out: invariants",
        "scored-by: sonnet",
        "criteria:",
        "  1. met — src/x.ts:12",
        "findings:",
        `  - rule: ${rule}`,
        "    confidence: 9",
        "    file: ",
        "    line: -",
        '    evidence: "the diff changes a schema and adds no schema file"',
        "    message: The schema change has no schema file.",
        "uncertain:",
        "CODE-REVIEW-STATUS: complete",
        "",
      ].join("\n");
    const decided = (rule: string) =>
      decide(parseCodeReviewReport(block(rule), { catalogue }), attempts(), config(), {
        ...code,
        worktree: wt,
      });

    const measured = decided("layer/schema-file-first");
    expect(measured.demoted, "a measurement has no line to quote").toEqual([]);
    expect(measured.blocking.map((f) => f.rule)).toEqual(["layer/schema-file-first"]);
    expect(measured.action).toBe("fix");

    // The negative control, the same block under a row whose evidence is a line: every
    // other family still has to quote one, or the exemption is the way around the check.
    const quoted = decided("example/no-console-in-handlers");
    expect(quoted.demoted.map((f) => f.rule)).toEqual(["example/no-console-in-handlers"]);
    expect(quoted.demoted[0]?.demotion).toContain("no quotable line");
    expect(quoted.blocking).toEqual([]);
  });

  // The red step's `no-test-files` is a measurement too: the diff adds no test file the
  // runner collects, and the skill has the reviewer report the project's own coverage rule
  // with the changed paths as evidence and no line at all. Withdrawing it published the
  // missing-test signal as nothing.
  it("keeps a tests/ finding that stands behind the red step's own verdict", () => {
    const wt = worktreeWithX();
    const missing = should({
      rule: "tests/handler-untested",
      file: "src/a.ts",
      line: 0,
      evidence: "src/a.ts, src/b.ts",
    });
    const d = decide(codeReview([missing], { redStep: "no-test-files" }), attempts(), config(), {
      ...code,
      worktree: wt,
    });
    expect(d.demoted, "the coverage rule the red step measured must not be withdrawn").toEqual([]);
    expect(d.blocking.map((f) => f.rule)).toEqual(["tests/handler-untested"]);

    // The negative control: the same lineless finding behind a verdict that measured
    // nothing about it is still a claim about a line, and is still withdrawn.
    const proven = decide(codeReview([missing]), attempts(), config(), { ...code, worktree: wt });
    expect(proven.demoted.map((f) => f.rule)).toEqual(["tests/handler-untested"]);
  });

  // `normaliseEvidence` strips every quote character, and `String.includes("")` is true of
  // any file, so evidence made of nothing but backticks verified against whatever file the
  // finding named.
  it("withdraws evidence that normalises to nothing", () => {
    const wt = worktreeWithX();
    const quotesOnly = must({ line: 12, evidence: "``" });
    const d = decide(codeReview([quotesOnly]), attempts(), config(), { ...code, worktree: wt });
    expect(d.demoted).toHaveLength(1);
    expect(d.demoted[0]?.demotion).toContain("no quotable line");
  });

  it("trims the worktree before it looks for it", () => {
    // `existsSync` on a real directory with a trailing space is false, so a hand-edited or
    // externally written entry turned every finding into an unchecked one while the
    // directory was there all along.
    const wt = worktreeWithX();
    const d = decide(codeReview([must({ line: 12 })]), attempts(), config(), {
      ...code,
      worktree: `  ${wt} `,
    });
    expect(d.demoted).toEqual([]);
    expect(d.reason).not.toContain("the evidence was not checked");
  });

  it("says the check did not run when the entry names no worktree", () => {
    // An empty worktree is a state a reconciled entry can be in, and it runs no check for
    // the same reason a missing one does not — but it used to say nothing at all, so a
    // reader of the decision could not tell a checked report from an unchecked one.
    for (const worktree of ["", undefined]) {
      const d = decide(codeReview([must(), should()]), attempts(), config(), {
        ...code,
        worktree,
      });
      expect(d.demoted).toEqual([]);
      expect(d.reason, `worktree ${JSON.stringify(worktree)}`).toContain(
        "the evidence was not checked",
      );
      expect(d.reason).toContain("naming no worktree");
    }
  });

  it("marks a deferred finding already deferred in an earlier round as seen before", () => {
    const repeat = later();
    const fresh = later({
      rule: "docs/completeness",
      evidence: "the README still names the old flag",
    });
    // The previous archived report of the same stage, parsed the same way. Re-indented and
    // reflowed, because the same line quoted twice by two reviews rarely arrives with the
    // same whitespace — and the fingerprint is what makes it the same finding anyway.
    const previous = codeReview([later({ evidence: '  // TODO:   the remaining  cases' })]); // prettier-ignore

    const d = decide(codeReview([repeat, fresh]), attempts({ fix: 1 }), config(), {
      ...code,
      previous,
    });
    expect(d.deferred.map((f) => [f.rule, f.seenBefore])).toEqual([
      ["scope/follow-up", true],
      ["docs/completeness", false],
    ]);
    // Seen before changes nothing about the class: it is still a later item, not withdrawn.
    expect(d.deferred.map((f) => f.tier)).toEqual(["later", "later"]);
    expect(d.action).toBe("publish");
  });

  // A quote recurs across files — a handler signature, a boilerplate line — so a
  // fingerprint of rule and quote alone marked a genuinely new finding in another file as
  // one an earlier round had already reported, and `publish.ts` relays that flag into the
  // pull request body as "(noted in an earlier round)".
  it("does not call the same rule and quote in another file a repeat", () => {
    const quote = "export async function GET(request: Request) {";
    const here = later({ file: "src/handlers/a.ts", evidence: quote });
    const there = later({ file: "src/handlers/b.ts", evidence: quote });
    const d = decide(codeReview([there]), attempts({ fix: 1 }), config(), {
      ...code,
      previous: codeReview([here]),
    });
    expect(d.deferred.map((f) => f.seenBefore)).toEqual([false]);

    // The positive control: the same rule and quote in the same file is still a repeat.
    const again = decide(codeReview([here]), attempts({ fix: 1 }), config(), {
      ...code,
      previous: codeReview([here]),
    });
    expect(again.deferred.map((f) => f.seenBefore)).toEqual([true]);
  });
});

describe("the code review's rounds", () => {
  it("starts a fix round on must findings while rounds remain, with the later items in the first round only", () => {
    const findings = [must(), should(), later()];
    const first = decide(codeReview(findings), attempts(), config(), code);
    expect(first.action).toBe("fix");
    // `round === 1` is what "first round" means: the field that serialised it twice is
    // gone, and the later items below are the behaviour it stood for.
    expect(first.round).toBe(1);
    expect(first.blocking.map((f) => f.tier)).toEqual(["must", "should", "later"]);
    expect(first.deferred).toEqual([]);
    expect(first.label).toBe("agent-fix-1");
    expect(first.releaseReason).toBeNull();
    expect(first.redStep).toBe("proven");

    const second = decide(codeReview(findings), attempts({ fix: 1 }), config(), code);
    expect(second.action).toBe("fix");
    expect(second.round).toBe(2);
    expect(second.blocking.map((f) => f.tier)).toEqual(["must", "should"]);
    expect(second.deferred.map((f) => f.tier)).toEqual(["later"]);
  });

  it("starts a fix round on should findings alone", () => {
    const d = decide(codeReview([should()]), attempts(), config(), code);
    expect(d.action).toBe("fix");
    expect(d.blocking.map((f) => f.rule)).toEqual(["tests/no-positive-control"]);
    expect(d.label).toBe("agent-fix-1");
  });

  it("starts fix round 1 on later items alone", () => {
    // The accepted cost of the design's decision: the first pass cleans up, so most
    // issues get one round.
    const d = decide(codeReview([later()]), attempts(), config(), code);
    expect(d.action).toBe("fix");
    expect(d.round).toBe(1);
    expect(d.blocking.map((f) => f.tier)).toEqual(["later"]);
    expect(d.deferred).toEqual([]);
  });

  it("keeps later items out of the second round's dispatch and defers them to the pull request", () => {
    const d = decide(codeReview([must(), later()]), attempts({ fix: 1 }), config(), code);
    expect(d.action).toBe("fix");
    expect(d.dispatchMarkdown).toContain("### Must (1)");
    expect(d.dispatchMarkdown).toContain("### Deferred (later)");
    // Not a blocking section any more: from the second round a later item is carried, not
    // worked.
    expect(d.dispatchMarkdown).not.toContain("### Later (");
    expect(d.dispatchMarkdown.indexOf("### Must (1)")).toBeLessThan(
      d.dispatchMarkdown.indexOf("### Deferred (later)"),
    );
  });

  it("blocks on an open must finding at the cap, with a release reason that ends in a cost", () => {
    const d = decide(
      codeReview([must({ rule: "spec/criterion-not-met" }), should()]),
      attempts({ fix: 2 }),
      config(),
      code,
    );
    expect(d.action).toBe("block");
    expect(d.label).toBeNull();
    expect(d.escalate).toBe(false);
    expect(d.reason).toContain("spec/criterion-not-met");
    expect(d.releaseReason).toBe(`${d.reason} — if wrong, a criterion ships unmet`);

    // One cost sentence per rule family, and a catch-all for the rest: what it would cost
    // to be wrong is the last thing a human reads on the blocked issue.
    const costs: Array<[string, string]> = [
      ["spec/criterion-not-met", "a criterion ships unmet"],
      ["tests/proves-nothing", "the change ships without a test that proves it"],
      ["bug/boundary", "a regression ships"],
      ["perf/regression", "a regression ships"],
      ["paths/forbidden", "a fenced path changes without a human"],
      ["security/path-traversal", "a vulnerability ships"],
      ["comment/contract-broken", "a finding the review called must ships"],
    ];
    for (const [rule, cost] of costs) {
      const v = decide(codeReview([must({ rule })]), attempts({ fix: 2 }), config(), code);
      expect(v.action, rule).toBe("block");
      expect(v.releaseReason, rule).toContain(` — if wrong, ${cost}`);
      expect(v.releaseReason?.endsWith(cost), rule).toBe(true);
    }
  });

  it("publishes with the open should list at the cap when no must is open", () => {
    const d = decide(codeReview([should(), later()]), attempts({ fix: 2 }), config(), code);
    expect(d.action).toBe("publish");
    expect(d.releaseReason).toBeNull();
    expect(d.label).toBeNull();
    // Both travel to the pull request; the body lists the should items as open after the
    // cap and the later ones as noted.
    expect(d.deferred.map((f) => f.tier)).toEqual(["should", "later"]);
    // The should finding still drove the decision, so it is in the blocking set too: at
    // the cap it is what rule 1 found, and it is also what travels.
    expect(d.blocking.map((f) => f.tier)).toEqual(["should"]);
    expect(d.reason).toContain("1 should, 1 later");
    expect(d.reason).toContain("no must finding is open");
  });

  it("retries once on could-not-run with nothing blocking, and names agent-retry-1", () => {
    const report = codeReview([], { redStep: "could-not-run", reason: "npm ci failed" });
    const d = decide(report, attempts(), config(), code);
    expect(d.action).toBe("retry");
    expect(d.label).toBe("agent-retry-1");
    expect(d.redStep).toBe("could-not-run");
    expect(d.reason).toContain("npm ci failed");
    expect(d.releaseReason).toBeNull();

    // The counter is shared with runs that ended without a report: a review whose
    // predecessor crashed arrives here with 1 already spent, and the cap — not the note's
    // literal "once" — is what says whether there is another. `caps.reviewRetries` is 2 in
    // this project's config and in the orchestrator's own re-dispatch rule, so refusing
    // here published a pull request whose red step never ran.
    const second = decide(report, attempts({ reviewRetry: 1 }), config(), code);
    expect(second.action).toBe("retry");
    expect(second.label).toBe("agent-retry-2");
    expect(second.reason).toContain("retry 2 of 2");
  });

  it("publishes a repeated could-not-run instead of retrying again", () => {
    const report = codeReview([], { redStep: "could-not-run", reason: "npm ci failed" });
    const d = decide(report, attempts({ reviewRetry: 2 }), config(), code);
    expect(d.action).toBe("publish");
    expect(d.label).toBeNull();
    // The reason says why the retry is not taken rather than repeating the verdict.
    expect(d.reason).toContain("retries");
    expect(d.reason).toContain("cap of 2");

    // A project that configures one retry reaches the same point one round earlier.
    const strict = decide(report, attempts({ reviewRetry: 1 }), config({ reviewRetries: 1 }), code);
    expect(strict.action).toBe("publish");
  });

  it("never sets a must finding aside for a retry", () => {
    const report = codeReview([must()], { redStep: "could-not-run", reason: "npm ci failed" });
    const d = decide(report, attempts(), config(), code);
    expect(d.action).toBe("fix");
    expect(d.label).toBe("agent-fix-1");
    // At the cap the same report blocks; it never becomes a retry either.
    const atCap = decide(report, attempts({ fix: 2 }), config(), code);
    expect(atCap.action).toBe("block");
  });

  it("escalates the last round when the config names an escalated spec, and not otherwise", () => {
    const findings = [must()];
    const last = decide(codeReview(findings), attempts({ fix: 1 }), config({ escalated: true }), code); // prettier-ignore
    expect(last.round).toBe(2);
    expect(last.escalate).toBe(true);

    expect(decide(codeReview(findings), attempts({ fix: 1 }), config(), code).escalate).toBe(false);
    expect(
      decide(codeReview(findings), attempts(), config({ escalated: true }), code).escalate,
    ).toBe(false);
    // Three rounds configured: round 2 of 3 is not the last one.
    expect(
      decide(
        codeReview(findings),
        attempts({ fix: 1 }),
        config({ escalated: true, fixRounds: 3 }),
        code,
      ).escalate,
    ).toBe(false);
  });

  // Design section 8.2: `escalate` reads `stages.implement.escalated`, the stage spec the
  // last fix round runs with, instead of the source's single escalated-model setting.
  it("escalates on the last fix round only when stages.implement.escalated is set", () => {
    const withSpec = config({ escalated: true });
    const withoutSpec = config();
    const report = codeReview([must()]);
    // The last round (round 2 of 2) with the spec set escalates...
    const decision = decide(report, attempts({ fix: 1 }), withSpec, code);
    expect(decision.round).toBe(2);
    expect(decision.escalate).toBe(true);
    // ...the same round without it does not...
    expect(decide(report, attempts({ fix: 1 }), withoutSpec, code).escalate).toBe(false);
    // ...and the spec alone is not enough on a round that is not the last.
    expect(decide(report, attempts(), withSpec, code).escalate).toBe(false);
  });

  it("numbers the fix label from the ledger's counter", () => {
    const one = decide(codeReview([must()]), attempts({ fix: 1 }), config(), code);
    expect(one.label).toBe("agent-fix-2");
    // The prefixes come from the config, not from a literal.
    const ported = decide(
      codeReview([must()]),
      attempts({ fix: 1 }),
      config({ fixRound: "round-" }),
      code,
    );
    expect(ported.label).toBe("round-2");
    const retry = decide(
      codeReview([], { redStep: "could-not-run", reason: "x" }),
      attempts({ fix: 1 }),
      config({ reviewRetry: "again-" }),
      code,
    );
    expect(retry.label).toBe("again-1");
  });

  it("groups the dispatch markdown by tier", () => {
    const report = parseCodeReviewReport(fx("code-review"), { catalogue });
    const d = decide(report, attempts(), config(), code);
    expect(d.action).toBe("fix");
    const md = d.dispatchMarkdown;
    expect(md).toContain("### Must (1)");
    expect(md).toContain("### Should (2)");
    expect(md).toContain("### Later (1)");
    expect(md.indexOf("### Must (1)")).toBeLessThan(md.indexOf("### Should (2)"));
    expect(md.indexOf("### Should (2)")).toBeLessThan(md.indexOf("### Later (1)"));
    // Every finding travels with its rule, its file and its quoted line, which is what
    // the implementer works from.
    expect(md).toContain("tests/passes-without-change");
    expect(md).toContain("bug/general-case");
    expect(md).toContain("tests/no-positive-control");
    expect(md).toContain("scope/follow-up");
    expect(md).toContain("src/lib/format.ts:18");
    // The withdrawn confidence-5 finding is not in the dispatch: the parser moved it to
    // uncertain, and nothing here puts it back.
    expect(md).not.toContain("perf/inefficiency");
  });
});

describe("the plan review's rounds", () => {
  it("plan-review: must starts a plan round, should alone proceeds, the cap blocks", () => {
    const blocker = must({ rule: "plan/invented-interface", file: ".autoclaude/state/plans/5.md" });
    const warning = should({
      rule: "plan/test-asserts-mock",
      file: ".autoclaude/state/plans/5.md",
    });
    const note = later({ rule: "docs/completeness", file: ".autoclaude/state/plans/5.md" });

    const round = decide(planReview([blocker, warning, note]), attempts(), config(), plan);
    expect(round.action).toBe("fix");
    expect(round.round).toBe(1);
    expect(round.blocking.map((f) => f.rule)).toEqual(["plan/invented-interface"]);
    // Should and later never start a plan round; they travel with the dispatch instead.
    expect(round.deferred.map((f) => f.tier)).toEqual(["should", "later"]);
    // A plan round carries no label: `reconcile` rebuilds `attempts.fix` from the fix-round
    // labels, so labelling a plan round would spend one of the implementer's rounds.
    expect(round.label).toBeNull();
    // The plan review runs no tests, and the escalated model is the implementer's.
    expect(round.redStep).toBeNull();
    expect(round.escalate).toBe(false);

    const proceed = decide(planReview([warning, note]), attempts(), config(), plan);
    expect(proceed.action).toBe("proceed");
    expect(proceed.blocking).toEqual([]);
    expect(proceed.deferred.map((f) => f.tier)).toEqual(["should", "later"]);
    expect(proceed.releaseReason).toBeNull();

    const blocked = decide(planReview([blocker]), attempts({ plan: 2 }), config(), plan);
    expect(blocked.action).toBe("block");
    expect(blocked.round).toBe(3);
    expect(blocked.reason).toContain("plan/invented-interface");
    expect(blocked.releaseReason).toContain(" — if wrong, ");

    // The counter is the plan's own: a spent fix round does not shorten the plan rounds.
    const stillFirst = decide(planReview([blocker]), attempts({ fix: 2 }), config(), plan);
    expect(stillFirst.action).toBe("fix");
  });

  // A plan review once deferred `tests/no-positive-control` at confidence 9 against the
  // test the implementer was about to write, and the fresh implement dispatch carried
  // nothing, because this field rendered a deferred section for `fix` alone. The finding
  // reached the pull request body and never the one reader who could act on it cheaply.
  it("gives a proceed's deferred findings to the implementer, under the deferred heading only", () => {
    const warning = should({
      rule: "plan/test-asserts-mock",
      file: ".autoclaude/state/plans/5.md",
    });
    const note = later({ rule: "docs/completeness", file: ".autoclaude/state/plans/5.md" });

    const md = decide(planReview([warning, note]), attempts(), config(), plan).dispatchMarkdown;
    expect(md).toContain("### Deferred (should, later)");
    expect(md).toContain("plan/test-asserts-mock");
    expect(md).toContain("docs/completeness");
    // Carried, not owed: no tier heading, so nothing reads as a finding to address.
    expect(md).not.toMatch(/^### (Must|Should|Later) \(/m);

    const clean = decide(planReview([]), attempts(), config(), plan);
    expect(clean.action).toBe("proceed");
    expect(clean.dispatchMarkdown).toBe("");
  });

  it("leaves the code review's publish and retry dispatch as it was", () => {
    const noted = decide(codeReview([later()]), attempts({ fix: 1 }), config(), code);
    expect(noted.action).toBe("publish");
    expect(noted.dispatchMarkdown).toBe("");

    const retry = decide(
      codeReview([later()], { redStep: "could-not-run", reason: "x" }),
      attempts({ fix: 1 }),
      config(),
      code,
    );
    expect(retry.action).toBe("retry");
    expect(retry.dispatchMarkdown).toBe("");
  });
});

const REPORT_REL = join(".autoclaude", "state", "reports");

/**
 * A root with a ledger entry for issue 5 and, unless told otherwise, a code-review report in
 * its worktree.
 */
function setup(
  opts: {
    report?: string | null;
    stage?: "code-review" | "plan-review";
    worktree?: boolean;
    entry?: boolean;
    attempts?: Partial<LedgerEntry["attempts"]>;
  } = {},
): { root: string; wt: string } {
  const root = tempDir();
  const wt = join(root, "wt");
  mkdirSync(join(wt, REPORT_REL), { recursive: true });
  if (opts.report !== null) {
    writeFileSync(
      join(wt, REPORT_REL, `${opts.stage ?? "code-review"}.md`),
      opts.report ?? fx("code-review"),
    );
  }
  if (opts.entry !== false) {
    const ledger = emptyLedger("me");
    transition(
      ledger,
      5,
      "code-reviewing",
      {
        title: "t",
        branch: "agent/5-x",
        worktree: opts.worktree === false ? "" : wt,
        attempts: attempts(opts.attempts),
      },
      new Date("2026-09-14T12:00:00.000Z"),
    );
    saveLedger(root, ledger, new Date("2026-09-14T12:00:00.000Z"));
  }
  return { root, wt };
}

/** A report whose one finding quotes a line that exists in the worktree. */
const ONE_MUST = [
  "AUTODEV-CODE-REVIEW",
  "issue: 5",
  "red-step: proven",
  "fan-out: bugs, tests",
  "scored-by: sonnet",
  "criteria:",
  "  1. met — src/x.ts:3",
  "findings:",
  "  - rule: bug/general-case",
  "    confidence: 9",
  "    file: src/x.ts",
  "    line: 3",
  '    evidence: "const a = 1;"',
  "    message: Handles the example and not the class it stands for.",
  "uncertain:",
  "CODE-REVIEW-STATUS: complete",
  "",
].join("\n");

/** The same review having found nothing, for the cases where two reports have to differ. */
const NO_FINDINGS = [
  "AUTODEV-CODE-REVIEW",
  "issue: 5",
  "red-step: proven",
  "fan-out: bugs, tests",
  "scored-by: sonnet",
  "criteria:",
  "  1. met — src/x.ts:3",
  "findings:",
  "uncertain:",
  "CODE-REVIEW-STATUS: complete",
  "",
].join("\n");

describe("reviewDecision, from the ledger and the report on disk", () => {
  const deps = (root: string) => ({ root, cfg: config(), catalogue });

  it("exits 1 for a missing report or criteria: none, 2 for an unfinished one", () => {
    // The positive control first: a report that is there and complete decides.
    const ok = setup({ report: ONE_MUST });
    mkdirSync(join(ok.wt, "src"), { recursive: true });
    writeFileSync(join(ok.wt, "src", "x.ts"), "// 1\n// 2\nconst a = 1;\n// 4\n");
    const decided = reviewDecision(5, deps(ok.root));
    expect(decided.code).toBe(0);
    expect(decided.decision?.action).toBe("fix");

    // No report in the worktree at all.
    const none = setup({ report: null });
    const missing = reviewDecision(5, deps(none.root));
    expect(missing.code).toBe(1);
    expect(missing.decision).toBeNull();
    expect(missing.message).toMatch(/^issue 5: /);

    // No ledger entry: there is no run to decide about.
    const noEntry = setup({ entry: false });
    expect(reviewDecision(5, deps(noEntry.root)).code).toBe(1);

    // An entry with no worktree: joining an empty path would read the main working
    // directory's own report, the one directory the engine never touches.
    const noWorktree = setup({ worktree: false });
    const blank = reviewDecision(5, deps(noWorktree.root));
    expect(blank.code).toBe(1);
    expect(blank.message).toMatch(/worktree/);

    // `criteria: none` from a worktree: the review had its issue, so the report is not usable.
    const noCriteria = setup({
      report: ONE_MUST.replace("criteria:\n  1. met — src/x.ts:3", "criteria: none"),
    });
    const criteriaNone = reviewDecision(5, deps(noCriteria.root));
    expect(criteriaNone.code).toBe(1);
    expect(criteriaNone.message).toContain("criteria");

    // A report whose status line is not `complete`: the run did not finish. The idiom is
    // reports.test.ts's — the marker has to stay, or the block is unterminated and the
    // answer is the malformed-block one below instead.
    const stopped = setup({ report: ONE_MUST.replace("-STATUS: complete", "-STATUS: stopped") });
    const unfinished = reviewDecision(5, deps(stopped.root));
    expect(unfinished.code).toBe(2);
    expect(unfinished.decision).toBeNull();
    expect(unfinished.message).toContain("not marked complete");

    // A review interrupted before it wrote its red step is still a stopped run, not a
    // malformed report: completeness is decided first, on the shared shape.
    const early = setup({
      report: ONE_MUST.replace(/^red-step:.*\n/m, "").replace(
        "-STATUS: complete",
        "-STATUS: stopped",
      ),
    });
    expect(reviewDecision(5, deps(early.root)).code).toBe(2);

    // A block that does not parse at all is the same "no report" path.
    const garbled = setup({ report: "I reviewed it and it looked fine.\n" });
    expect(reviewDecision(5, deps(garbled.root)).code).toBe(1);

    // 64 (a wrong command line) is the verb's business, not this function's: the contract
    // is recorded for the `autoclaude` verb that wraps it, and its parser is tested with it.
  });
  it("reads the previous archived report of the stage and marks the repeats", () => {
    const { root, wt } = setup({ report: ONE_MUST });
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.ts"), "// 1\n// 2\nconst a = 1;\n// 4\n");
    mkdirSync(join(root, ".autoclaude", "state", "runs", "5"), { recursive: true });
    writeFileSync(
      join(root, ".autoclaude", "state", "runs", "5", "code-review-1.md"),
      `<!-- autodev-archive issue="5" stage="code-review" n="1" -->\n\n${ONE_MUST}`,
    );
    const r = reviewDecision(5, deps(root));
    expect(r.code).toBe(0);
    expect(r.decision?.blocking.map((f) => f.seenBefore)).toEqual([true]);
  });

  it("reads the file --report names instead of the worktree's report", () => {
    const { root, wt } = setup({ report: ONE_MUST });
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.ts"), "// 1\n// 2\nconst a = 1;\n// 4\n");
    // The positive control: the worktree's own report decides a fix round.
    expect(reviewDecision(5, deps(root)).decision?.action).toBe("fix");

    // The named file is outside the worktree, the way an archived copy is, and it found
    // nothing — so a decision of `publish` can only have come from it.
    const archived = join(root, "code-review-1.md");
    writeFileSync(archived, NO_FINDINGS);
    const r = reviewDecision(5, { ...deps(root), report: archived });
    expect(r.code).toBe(0);
    expect(r.decision?.action).toBe("publish");
    expect(r.decision?.blocking).toEqual([]);
  });

  // `--report <archive>` is the documented way to decide about an archived report, and the
  // previous archive was resolved independently of it: pointed at the newest archive, the
  // report being decided *was* the previous one, so every finding came back as a repeat of
  // itself and a first-round report read as all repeats.
  it("does not read the file --report names as its own previous round", () => {
    const { root, wt } = setup({ report: ONE_MUST });
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "x.ts"), "// 1\n// 2\nconst a = 1;\n// 4\n");
    const runs = join(root, ".autoclaude", "state", "runs", "5");
    mkdirSync(runs, { recursive: true });
    const archive = (n: number, text: string) => {
      const path = join(runs, `code-review-${n}.md`);
      writeFileSync(path, `<!-- autodev-archive issue="5" stage="code-review" n="${n}" -->\n\n${text}`); // prettier-ignore
      return path;
    };

    // One archive only, and it is the file being decided: there is no earlier round.
    const only = archive(1, ONE_MUST);
    const first = reviewDecision(5, { ...deps(root), report: only });
    expect(first.code).toBe(0);
    expect(first.decision?.blocking.map((f) => f.seenBefore)).toEqual([false]);

    // The positive control: with a round before it, the archive under --report reads its
    // predecessor and the repeat is marked.
    const second = archive(2, ONE_MUST);
    const round2 = reviewDecision(5, { ...deps(root), report: second });
    expect(round2.decision?.blocking.map((f) => f.seenBefore)).toEqual([true]);
  });
});
