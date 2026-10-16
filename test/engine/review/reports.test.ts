import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyOptions,
  defuseMentions,
  isReportComplete,
  parseImplementReport,
  parsePlanReport,
  parsePlanReviewReport,
  parseCodeReviewReport,
  reportPath,
  parseStoppedCodeReview,
  findingsAsMarkdown,
  findingsByTier,
  reviewAccountAsMarkdown,
  tierSections,
  uncertainSection,
  TIERS,
  type ReviewFinding,
} from "../../../src/engine/review/reports.js";
import { fingerprintOf, loadCatalogue } from "../../../src/engine/review/rules.js";
import type { ProjectConfig } from "../../../src/config/types.js";

const fx = (name: string) => readFileSync(`test/fixtures/reports/${name}.md`, "utf8");

/**
 * The real catalogue, because the class a finding gets has to be the one the shipped rules
 * give it: a confidence says nothing without the level its rule carries. Both parsers are
 * called through it here, the way every caller has to call them.
 */
const catalogue = loadCatalogue({
  engine: "catalogue/rules.md",
  project: "test/fixtures/catalogue/invariants.md",
});
const codeReview = (text: string) => parseCodeReviewReport(text, { catalogue });
const planReview = (text: string) => parsePlanReviewReport(text, { catalogue });

describe("parseImplementReport", () => {
  const r = parseImplementReport(fx("implement"));

  it("reads the scalars, an empty reason included", () => {
    expect(r.issue).toBe(126);
    expect(r.status).toBe("done");
    expect(r.reason).toBe("");
    expect(r.dbMigrationRequired).toBe(false);
    expect(r.commit).toBe("2a7e958a7b8df67bd77066bcf2d1919a2bb45959");
  });

  it("reads met and not met criteria", () => {
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0]).toEqual({
      met: true,
      text: "Ä, Ö, Ü, ä, ö, ü are preserved in the download file name",
    });
    expect(r.criteria[1]?.met).toBe(false);
  });

  it("reads the lists", () => {
    expect(r.testsAdded).toContain("renderers.test.ts");
    expect(r.observedNotDone).toEqual([
      "documents-route.test.ts asserts a route this change does not touch",
    ]);
  });

  // A run that ends without its block failed, whatever else it printed.
  it("throws when the block is absent", () => {
    expect(() => parseImplementReport("I did lots of work.\nAUTODEV-REPORT\nissue: 1\n")).toThrow(
      /AUTODEV-REPORT-END/,
    );
    expect(() => parseImplementReport("nothing")).toThrow(/AUTODEV-REPORT/);
  });

  it("throws on a status outside the contract", () => {
    expect(() =>
      parseImplementReport(fx("implement").replace("status: done", "status: finished")),
    ).toThrow(/status/);
  });
});

describe("parseCodeReviewReport", () => {
  const r = codeReview(fx("code-review"));

  it("reads findings as mappings with their evidence unquoted", () => {
    expect(r.findings).toHaveLength(4);
    expect(r.findings[0]?.rule).toBe("tests/passes-without-change");
    expect(r.findings[0]?.level).toBe("error");
    expect(r.findings[0]?.confidence).toBe(9);
    expect(r.findings[0]?.line).toBe(41);
    expect(r.findings[0]?.evidence).toBe(
      "it('keeps the umlauts in the Content-Disposition header', async () => {",
    );
    expect(r.findings[2]?.level).toBe("warning");
  });

  it("reads the uncertain list and the completion sentinel", () => {
    // One line the reviewer wrote, and one finding the threshold withdrew.
    expect(r.uncertain).toHaveLength(2);
    expect(r.complete).toBe(true);
  });

  it("is incomplete without CODE-REVIEW-STATUS: complete", () => {
    expect(() => codeReview(fx("code-review").replace("CODE-REVIEW-STATUS: complete", ""))).toThrow(
      /CODE-REVIEW-STATUS/,
    );
  });

  // An empty findings list stays a legitimate answer — but only from a review that
  // still says what it checked. This block used to be the whole contract, and it is
  // exactly the report PR #155 could not tell from a cursory one.
  it("accepts an empty findings list from a review that accounts for itself", () => {
    const r2 = codeReview(
      [
        "AUTODEV-CODE-REVIEW",
        "issue: 5",
        "red-step: proven",
        "fan-out: sequential",
        "scored-by: lead",
        "criteria:",
        "  1. met — src/x.ts:12",
        "findings:",
        "uncertain:",
        "CODE-REVIEW-STATUS: complete",
        "",
      ].join("\n"),
    );
    expect(r2.findings).toEqual([]);
    expect(r2.complete).toBe(true);
    expect(r2.redStep).toBe("proven");
  });

  it("renders findings for a fix round, with the tier the implementer has to act on", () => {
    const md = findingsAsMarkdown(r.findings);
    expect(md).toContain("tests/passes-without-change");
    expect(md).toContain("documents-route.test.ts:41");
    expect(md).toContain("must");
    expect(md).toContain("later");
  });

  // `spec/criterion-not-met` — the commonest blocking rule there is — carries no file and
  // no line, and every renderer printed it as "at `:0`". `can-merge.ts` had the one
  // version that did not; `locationOf` is that version, shared (whole-branch review,
  // Minor 5).
  it("names no location for a finding that has none", () => {
    const quoteless: ReviewFinding = {
      rule: "spec/criterion-not-met",
      level: "error",
      tier: "must",
      // What the catalogue row says of this rule: it is about what the diff does not
      // contain, which is why it has no file and no line in the first place.
      evidenceKind: "measurement",
      confidence: 9,
      file: "",
      line: 0,
      evidence: "",
      message: "criterion 2 has no evidence in the diff",
      fingerprint: "x",
    };
    const md = findingsAsMarkdown([quoteless]);
    expect(md, "a location that resolves to nothing must not be printed").not.toContain(":0");
    expect(md).not.toContain(" at ");
    expect(md).toContain("spec/criterion-not-met");
    expect(md).toContain("criterion 2 has no evidence in the diff");
    // And a finding that does have one still shows it.
    expect(findingsAsMarkdown([{ ...quoteless, file: "src/x.ts", line: 4 }])).toContain(
      "at `src/x.ts:4`",
    );
  });
});

/**
 * Section 7 of the pipeline design: the model emits a rule id and a confidence and **no
 * level**; the level belongs to the rule and the class follows from both. A model that
 * could write its own level could escalate any finding to blocking, and the vocabulary
 * would drift. So the parser is where the catalogue is consulted, once, for both reviews.
 */
describe("the class of a finding comes from the catalogue and the confidence", () => {
  it("classifies findings from the catalogue and the confidence, not from the block", () => {
    const r = codeReview(fx("code-review"));
    expect(r.findings.map((f) => [f.rule, f.level, f.confidence, f.tier])).toEqual([
      ["tests/passes-without-change", "error", 9, "must"],
      ["bug/general-case", "error", 7, "should"],
      ["tests/no-positive-control", "warning", 8, "should"],
      ["scope/follow-up", "note", 7, "later"],
    ]);
    // The fifth finding scored below the threshold: the observation is kept, the claim
    // that it is real is withdrawn.
    expect(r.uncertain.join("\n")).toMatch(/perf\/inefficiency — confidence 5 is below/);
  });

  it("ignores a level line the reviewer wrote anyway", () => {
    const withLevel = fx("code-review").replace(
      "    confidence: 9",
      "    level: note\n    confidence: 9",
    );
    const r = codeReview(withLevel);
    // `note` in the block would have made it `later`; the catalogue says error, and 9 is
    // above the threshold.
    expect(r.findings[0]?.level).toBe("error");
    expect(r.findings[0]?.tier).toBe("must");
  });

  // A typo in a rule id must not cost a thirty-minute review retry, and it must not pass
  // as a finding either: the level it would be classified with does not exist.
  it("sends an unknown rule to uncertain with a note", () => {
    const typo = fx("code-review").replace("rule: bug/general-case", "rule: bug/genral-case");
    const r = codeReview(typo);
    expect(r.findings.map((f) => f.rule)).not.toContain("bug/genral-case");
    expect(r.findings).toHaveLength(3);
    expect(r.uncertain.join("\n")).toMatch(/bug\/genral-case — not in the catalogue/);
  });

  // The threshold is `config.codeReview.scoreThreshold`, and both boundaries move with it.
  it("classifies against the threshold the caller passes", () => {
    const r = parseCodeReviewReport(fx("code-review"), { catalogue, threshold: 8 });
    expect(r.findings.map((f) => [f.rule, f.tier])).toEqual([
      ["tests/passes-without-change", "must"],
      ["tests/no-positive-control", "should"],
    ]);
    expect(r.uncertain.join("\n")).toContain("below the threshold of 8");
  });

  // The same fingerprint helper the decision script compares rounds with, not a second
  // implementation of it: a `later` item deferred in round 1 is recognised by this string.
  // The file is part of it, because the same quote under the same rule recurs across files
  // and used to read as one finding (`/code-review` on the review-tiers branch).
  it("fingerprints every finding by its rule, its file and its quoted line", () => {
    for (const f of codeReview(fx("code-review")).findings) {
      expect(f.fingerprint).toBe(fingerprintOf(f.rule, f.evidence, f.file));
      expect(f.fingerprint, "the file a reader has to be able to see").toContain(f.file);
    }
  });

  it("refuses a confidence that is not a whole number from 1 to 10, naming the finding", () => {
    for (const bad of ["0", "11", "8.5", "high", ""]) {
      const text = fx("code-review").replace("confidence: 9", `confidence: ${bad}`);
      expect(() => codeReview(text), `confidence "${bad}" parsed`).toThrow(/confidence/);
      expect(() => codeReview(text), `the message does not name the finding`).toThrow(
        /tests\/passes-without-change/,
      );
    }
  });

  it("reads the plan review through the same catalogue", () => {
    const r = planReview(fx("plan-review"));
    expect(r.findings.map((f) => [f.rule, f.level, f.tier])).toEqual([
      ["plan/invented-interface", "error", "must"],
      ["plan/test-asserts-mock", "warning", "should"],
    ]);
    expect(r.findings[0]?.fingerprint).toContain("plan/invented-interface");
    const typo = fx("plan-review").replace("rule: plan/test-asserts-mock", "rule: plan/mocks");
    expect(planReview(typo).findings.map((f) => f.rule)).toEqual(["plan/invented-interface"]);
    expect(planReview(typo).uncertain.join("\n")).toMatch(/plan\/mocks — not in the catalogue/);
  });
});

describe("parsePlanReport", () => {
  it("reads status, migration and the plan file", () => {
    const r = parsePlanReport(fx("plan"));
    expect(r.issue).toBe(56);
    expect(r.status).toBe("planned");
    expect(r.dbMigrationRequired).toBe(false);
    expect(r.planFile).toBe(".autoclaude/state/plans/56.md");
  });
});

/**
 * A report written before the rename says `migration:`.
 *
 * `loadLedger` upgrades a legacy entry's state and stage names so that no entry falls to
 * `ownerStep === "none"` — it promises such a run a resume. An upgraded entry past
 * implement then reaches `publish.ts` → `parseImplementReport`, where `yesNo` threw on
 * the missing `db-migration-required:` line: `scalar()` returns "" and there was no
 * alias, so the promise could not be kept and the run stopped there
 * (maintainer's review, 13).
 *
 * Tolerance for one release, in the two parsers that read the field. The skills print the
 * new name and a test pins that; this is about archives on disk, and it comes out again
 * once no `runs/` directory predates the rename.
 */
describe("the field rename, read backwards for one release", () => {
  it("reads migration: as db-migration-required: in the implement and plan blocks", () => {
    const implement = fx("implement").replace("db-migration-required: no", "migration: yes");
    expect(parseImplementReport(implement).dbMigrationRequired).toBe(true);
    const plan = fx("plan").replace("db-migration-required: no", "migration: no");
    expect(parsePlanReport(plan).dbMigrationRequired).toBe(false);
  });

  it("prefers the new name when a block carries both, and still refuses a block with neither", () => {
    const both = fx("implement").replace(
      "db-migration-required: no",
      "db-migration-required: no\nmigration: yes",
    );
    expect(parseImplementReport(both).dbMigrationRequired).toBe(false);
    // The alias is not a second contract for new reports: a block that states neither is
    // a report that did not answer the question.
    expect(() =>
      parseImplementReport(fx("implement").replace("db-migration-required: no", "")),
    ).toThrow(/db-migration-required/);
  });
});

// Review of #145, H4: the parser rejected or garbled input its own contract allows.
describe("the parser reads what the skills are allowed to print", () => {
  it("accepts a criterion written with a colon, met and not met alike", () => {
    const text = fx("implement")
      .replace(
        "1. met — Ä, Ö, Ü, ä, ö, ü are preserved in the download file name",
        "1. met: the header is set",
      )
      .replace(
        "2. not met — ß is preserved on all three operating systems (verified at unit level only)",
        "2. not met: ß survives on all three operating systems",
      );
    const r = parseImplementReport(text);
    expect(r.criteria).toEqual([
      { met: true, text: "the header is set" },
      { met: false, text: "ß survives on all three operating systems" },
    ]);
  });

  it("lets a top-level scalar wrap onto an indented second line", () => {
    const text = fx("implement").replace(
      "tests-added: tests/unit/server/documents/renderers.test.ts, tests/unit/server/documents/orchestrator.test.ts",
      "tests-added: tests/unit/server/documents/renderers.test.ts,\n  tests/unit/server/documents/orchestrator.test.ts",
    );
    expect(parseImplementReport(text).testsAdded).toBe(
      "tests/unit/server/documents/renderers.test.ts, tests/unit/server/documents/orchestrator.test.ts",
    );
  });

  it("keeps a string list item that contains a colon as a string", () => {
    const text = fx("implement").replace(
      "  - documents-route.test.ts asserts a route this change does not touch",
      "  - docs: the README still names the old flag",
    );
    expect(parseImplementReport(text).observedNotDone).toEqual([
      "docs: the README still names the old flag",
    ]);
    const review = fx("code-review").replace(
      "  - spec/out-of-scope — the ASCII slug helper may be wider than criterion 3 asked for",
      "  - spec/out-of-scope: the helper may be wider than asked",
    );
    // The reviewer's own lines come first, before anything the threshold withdrew.
    const { uncertain } = codeReview(review);
    expect(uncertain[0]).toBe("spec/out-of-scope: the helper may be wider than asked");
  });

  // Re-review of #145, N4: a long reason written on the line after its key, the natural
  // shape for status: blocked or needs-human, where the reason matters most.
  it("reads a scalar whose value starts on the next line", () => {
    const text = fx("implement")
      .replace("status: done", "status: blocked")
      .replace(
        "reason:\n",
        "reason:\n  the gates fail on a pre-existing lint error in src/x.ts\n  that this change does not touch\n",
      );
    const r = parseImplementReport(text);
    expect(r.status).toBe("blocked");
    expect(r.reason).toBe(
      "the gates fail on a pre-existing lint error in src/x.ts that this change does not touch",
    );
  });
});

describe("parsePlanReviewReport", () => {
  it("reads the plan reviewer's findings with the same shape as the code reviewer's", () => {
    const r = planReview(fx("plan-review"));
    expect(r.issue).toBe(56);
    expect(r.findings.map((f) => f.rule)).toEqual([
      "plan/invented-interface",
      "plan/test-asserts-mock",
    ]);
    expect(r.findings[0]?.level).toBe("error");
    expect(r.complete).toBe(true);
  });

  // The plan review has no diff and no tests, so it accounts for one thing only: who
  // scored its findings. A plan review that scored itself must not read like a reviewed one.
  it("requires scored-by and reads it", () => {
    expect(planReview(fx("plan-review")).scoredBy).toBe("sonnet");
    expect(() => planReview(fx("plan-review").replace(/^scored-by:.*\n/m, ""))).toThrow(
      /scored-by/,
    );
  });
});

// The catalogue prints every rule id wrapped in backticks, which is how a reviewer copying
// one out of it writes it into the block. Read raw, such an id matched no catalogue row,
// so the finding went to `uncertain` as "not in the catalogue" — and a `must` vanished
// without the report saying anything was wrong with it.
describe("a rule id the reviewer wrapped in backticks or quotes", () => {
  const rewritten = (written: string) =>
    fx("code-review").replace("rule: bug/general-case", `rule: ${written}`);

  it("is read as the id it names", () => {
    for (const written of [
      "`bug/general-case`",
      '"bug/general-case"',
      "'bug/general-case'",
      "  bug/general-case  ",
    ]) {
      // prettier-ignore
      const r = codeReview(rewritten(written));
      expect(
        r.findings.map((f) => f.rule),
        `rule: ${written}`,
      ).toContain("bug/general-case");
      expect(r.uncertain.join("\n"), `rule: ${written}`).not.toContain("not in the catalogue");
    }
  });

  // The same habit on the `file:` line: read raw, the backticks travelled into the path,
  // `resolveQuotedFile` joined the literal name, `readFileSync` threw and the finding was
  // withdrawn as "not found within 5 lines" — a `bug/` must moved to Uncertain and the
  // change published. `rule:` and `evidence:` went through `unquote` and this did not.
  it("is read as the path it names, so the evidence check can find the file", () => {
    const text = fx("code-review").replace(
      "file: src/server/documents/filename.ts\n    line: 18",
      "file: `src/server/documents/filename.ts`\n    line: 18",
    );
    const f = codeReview(text).findings.find((x) => x.rule === "bug/general-case");
    expect(f?.file, "the backticks travelled into the path").toBe(
      "src/server/documents/filename.ts",
    );
    // And the identity a later round compares against carries the clean path with it.
    expect(f?.fingerprint).toBe(
      fingerprintOf("bug/general-case", f?.evidence ?? "", f?.file ?? ""),
    );
  });

  // The same defect on the rule the parser's own consistency check looks for made the
  // whole report unparseable instead: a stripped-down report of one finding.
  it("still carries the must the not-proven check looks for", () => {
    const text = fx("code-review").replace(
      "rule: tests/passes-without-change",
      "rule: `tests/passes-without-change`",
    );
    expect(codeReview(text).findings.map((f) => f.rule)).toContain("tests/passes-without-change");
  });
});

// The `tests/` must behind `red-step: not-proven` is the one finding whose absence refuses
// the whole report, and a typo in its rule id is the commonest way to lose it: `classify`
// sends an unknown id to `uncertain` on purpose, and the consistency check then sees no
// must in the family and throws. The refusal stays — the safe direction — and says where
// to look.
describe("the not-proven refusal points at a misspelt rule id", () => {
  it("lists the uncertain tests/ ids the catalogue does not have", () => {
    const text = fx("code-review").replace(
      "rule: tests/passes-without-change",
      "rule: tests/passess-without-change",
    );
    expect(() => codeReview(text)).toThrow(/not-proven/);
    expect(() => codeReview(text)).toThrow(/tests\/passess-without-change/);
    expect(() => codeReview(text)).toThrow(/not in the catalogue/);
  });

  it("says nothing about typos when there are none", () => {
    // The must scored down to the threshold: the same refusal, with no unmatched id to
    // blame it on, so the hint must not appear at all.
    const text = fx("code-review").replace("confidence: 9", "confidence: 7");
    expect(() => codeReview(text)).toThrow(/not-proven/);
    expect(() => codeReview(text)).not.toThrow(/not in the catalogue/);
  });
});

// Review of #147, M13: a finding about something the file does not contain has no line
// to point at; `-` or a missing key reads as 0 instead of failing the whole report.
describe("a finding without a line", () => {
  it("parses with line 0 when the reviewer writes - or omits the key", () => {
    const text = [
      "AUTODEV-PLAN-REVIEW",
      "issue: 7",
      "scored-by: sonnet",
      "findings:",
      "  - rule: plan/criterion-uncovered",
      "    confidence: 9",
      "    file: .autoclaude/state/plans/7.md",
      "    line: -",
      '    evidence: "criterion 3 maps to nothing"',
      "    message: criterion 3 is not covered",
      "  - rule: plan/too-large",
      "    confidence: 8",
      "    file: .autoclaude/state/plans/7.md",
      '    evidence: "eleven files"',
      "    message: two issues",
      "uncertain:",
      "PLAN-REVIEW-STATUS: complete",
    ].join("\n");
    const r = planReview(text);
    expect(r.findings.map((f) => f.line)).toEqual([0, 0]);
    expect(r.complete).toBe(true);
  });

  // `parseInt` reads `~42` and `L42` as NaN, which defaulted to 0 — indistinguishable from
  // the intentional `-` above, and a 0 fails the evidence check's "no quotable line" test,
  // so a finding with a real file and a verbatim quote was withdrawn over the way its line
  // was written.
  it("reads a line a reviewer prefixed, and keeps 0 for the ones that name none", () => {
    const written = (value: string) =>
      [
        "AUTODEV-PLAN-REVIEW",
        "issue: 7",
        "scored-by: sonnet",
        "findings:",
        "  - rule: plan/too-large",
        "    confidence: 8",
        "    file: .autoclaude/state/plans/7.md",
        `    line: ${value}`,
        '    evidence: "eleven files"',
        "    message: two issues",
        "uncertain:",
        "PLAN-REVIEW-STATUS: complete",
      ].join("\n");
    for (const [value, line] of [
      ["42", 42],
      ["~42", 42],
      ["L42", 42],
      ["line 42", 42],
      [":42", 42],
      ["-", 0],
      ["n/a", 0],
      ["", 0],
    ] as const) {
      expect(planReview(written(value)).findings[0]?.line, `line: "${value}"`).toBe(line);
    }
  });
});

// Attended run of #56 (2026-09-10): an issue with no acceptance criteria may not be
// planned at all, so the plan report has a third status and it comes with no plan file.
describe("a plan report that refuses to plan", () => {
  it("reads needs-shaping and an empty plan-file", () => {
    const r = parsePlanReport(
      [
        "AUTODEV-PLAN",
        "issue: 56",
        "status: needs-shaping",
        "reason: the issue has no acceptance criteria",
        "db-migration-required: no",
        "plan-file:",
        "AUTODEV-PLAN-END",
      ].join("\n"),
    );
    expect(r).toMatchObject({ issue: 56, status: "needs-shaping", planFile: "" });
    expect(r.reason).toMatch(/no acceptance criteria/);
  });
  it("still refuses a status outside the three", () => {
    const text = [
      "AUTODEV-PLAN",
      "issue: 1",
      "status: shaped",
      "db-migration-required: no",
      "AUTODEV-PLAN-END",
    ].join("\n");
    expect(() => parsePlanReport(text)).toThrow(
      /must be one of planned, needs-human, needs-shaping/,
    );
  });
});

/**
 * A code review has to report what it *did*, not only what it found. PR #155 closed
 * unmerged on exactly this: `findings: []` against 836 added lines, with no way to tell
 * a thorough review from a cursory one, because the block carried neither the red step's
 * verdict nor the per-criterion evidence although both are mandatory steps of the skill.
 * A reviewer that skipped them produced a byte-identical report.
 *
 * These fields do not make a lazy review impossible; they make it unparseable, which
 * puts it on the orchestrator's "run ended without a report" path instead of passing
 * for a clean one.
 */
describe("the code review's account of itself", () => {
  const r = codeReview(fx("code-review"));

  it("reads the red step's verdict", () => {
    expect(r.redStep).toBe("not-proven");
  });

  it("reads one evidence location per acceptance criterion", () => {
    expect(r.criteria).toHaveLength(3);
    expect(r.criteria[0]).toEqual({
      met: true,
      text: "tests/unit/app/api/documents-route.test.ts:41",
    });
  });

  // `fan-out:` and `scored-by:` are required for the reason `red-step:` is: a report that
  // does not say how it ran must not look like one that ran fully. Eight angles with an
  // independent scorer and one pair of eyes are different evidence.
  it("reads how the review ran", () => {
    expect(r.fanOut).toContain("criteria");
    expect(r.scoredBy).toBe("sonnet");
  });

  it("refuses a code review without fan-out or scored-by", () => {
    for (const key of ["fan-out", "scored-by"]) {
      const without = fx("code-review").replace(new RegExp(`^${key}:.*\\n`, "m"), "");
      expect(() => codeReview(without), `a report without ${key} parsed`).toThrow(new RegExp(key));
      const empty = fx("code-review").replace(new RegExp(`^(${key}):.*$`, "m"), "$1:");
      expect(() => codeReview(empty), `a report with an empty ${key} parsed`).toThrow(
        new RegExp(key),
      );
      // The commonest way to write an empty one is a bare key with the angles bulleted
      // underneath, the shape `criteria:` and `findings:` have on either side of it. The
      // refusal says what to write instead, because "required and must not be empty"
      // reads like a missing line to a reviewer who wrote several.
      const bulleted = fx("code-review").replace(
        new RegExp(`^(${key}): (.*)$`, "m"),
        (_all, k: string, value: string) =>
          `${k}:\n${value
            .split(",")
            .map((v) => `  - ${v.trim()}`)
            .join("\n")}`,
      );
      expect(() => codeReview(bulleted), `a bulleted ${key} parsed`).toThrow(new RegExp(key));
      expect(() => codeReview(bulleted), `the refusal does not say to write it inline`).toThrow(
        /inline/,
      );
    }
  });

  it("refuses a report that states no red-step verdict", () => {
    const without = fx("code-review").replace(/^red-step:.*\n/m, "");
    expect(() => codeReview(without)).toThrow(/red-step/);
  });

  it("accepts no-test-files, which is red-step.ts's exit 3 and carries no verdict of its own", () => {
    const none = fx("code-review").replace("red-step: not-proven", "red-step: no-test-files");
    expect(codeReview(none).redStep).toBe("no-test-files");
  });

  it("refuses a red-step verdict it does not know", () => {
    const bogus = fx("code-review").replace("red-step: not-proven", "red-step: looked-fine");
    expect(() => codeReview(bogus)).toThrow(/red-step/);
  });

  it("refuses a report that lists no criteria", () => {
    const without = fx("code-review").replace(/^criteria:\n(?: {2}.*\n)+/m, "criteria:\n");
    expect(() => codeReview(without)).toThrow(/criteri/);
  });

  it("accepts could-not-run only with a reason", () => {
    const withReason = fx("code-review").replace(
      "red-step: not-proven",
      "red-step: could-not-run\nreason: npm ci failed in the base worktree",
    );
    expect(codeReview(withReason).redStep).toBe("could-not-run");
    expect(codeReview(withReason).reason).toBe("npm ci failed in the base worktree");
  });

  it("refuses could-not-run with no reason, because that is the one verdict nothing else explains", () => {
    const withoutReason = fx("code-review").replace(
      "red-step: not-proven",
      "red-step: could-not-run",
    );
    expect(() => codeReview(withoutReason)).toThrow(/reason/);
  });

  /**
   * The one internal contradiction worth catching: Step 1 of the skill says an
   * unsatisfied criterion *is* a finding. A report claiming a criterion is unmet while
   * finding nothing about it has not done both steps, whichever one it skipped.
   */
  it("refuses an unmet criterion that no finding accounts for", () => {
    const inconsistent = fx("code-review").replace(
      "1. met — tests/unit/app/api/documents-route.test.ts:41",
      "1. not met — no evidence for the header",
    );
    expect(() => codeReview(inconsistent)).toThrow(/spec\/criterion-not-met/);
  });

  it("asks none of this of the plan review, which has no tests to run and no diff", () => {
    expect(() => planReview(fx("plan-review"))).not.toThrow();
  });
});

const criterionNotMet = (confidence: number, line: number) =>
  [
    "  - rule: spec/criterion-not-met",
    `    confidence: ${confidence}`,
    "    file: src/server/documents/filename.ts",
    `    line: ${line}`,
    '    evidence: "export function downloadFilename(name: string) {"',
    "    message: The criterion has no quotable evidence in the diff.",
    "",
  ].join("\n");

const withUnmet = (criteria: number[], findings: string) =>
  criteria
    .reduce(
      (text, n) =>
        text.replace(new RegExp(`^  ${n}\\. met — .*$`, "m"), `  ${n}. not met — no evidence`),
      fx("code-review"),
    )
    .replace("uncertain:\n", `${findings}uncertain:\n`);

/**
 * The fields only help if the report cannot state them and contradict them at once.
 * Each case below parsed, took the "no error findings" row and was published.
 *
 * The consistency rules hold in the new classes: the finding that carries a verdict or an
 * unmet criterion has to be a `must`, which no reviewer can write into the block — it
 * comes from an `error` rule scored above the threshold.
 */
describe("the code review's account has to add up", () => {
  it("refuses not-proven without a must in the tests family", () => {
    // The fixture's only tests/ must, scored down to the threshold: copy the verdict,
    // block on nothing.
    const text = fx("code-review").replace("confidence: 9", "confidence: 7");
    expect(() => codeReview(text)).toThrow(/not-proven/);
  });

  it("refuses an unmet criterion whose finding is only a should", () => {
    const text = withUnmet([1], criterionNotMet(7, 12));
    expect(() => codeReview(text)).toThrow(/spec\/criterion-not-met/);
  });

  /**
   * `policy("error", 7, 7)` is a `should`, so a scorer that comes back at exactly the
   * threshold leaves the report unparseable — and the message said only that no finding
   * carried the rule as a must, which sent a reader looking for a finding that was written
   * and scored one point too low. It names what it found instead, and the number that
   * would have made it a must, so the reconcile step is obvious from the error alone.
   */
  it("names the finding it found, its tier and the confidence a must needs", () => {
    const text = withUnmet([1], criterionNotMet(7, 12));
    expect(() => codeReview(text)).toThrow(/a should at confidence 7/);
    expect(() => codeReview(text)).toThrow(/a must needs 8 or more/);

    // The threshold the caller passes moves that number with it: at 8 a finding scored 8
    // is still a should, and a must needs 9.
    const strict = () =>
      parseCodeReviewReport(withUnmet([1], criterionNotMet(8, 12)), { catalogue, threshold: 8 });
    expect(strict).toThrow(/a should at confidence 8/);
    expect(strict).toThrow(/a must needs 9 or more/);

    // And with nothing carrying the rule at all there is no tier to name, so the sentence
    // is not appended to a report that simply left the finding out.
    expect(() => codeReview(withUnmet([1], ""))).toThrow(/spec\/criterion-not-met/);
    expect(() => codeReview(withUnmet([1], ""))).not.toThrow(/a must needs/);
  });

  it("refuses two unmet criteria that share one finding", () => {
    const text = withUnmet([1, 2], criterionNotMet(8, 12));
    expect(() => codeReview(text)).toThrow(/spec\/criterion-not-met/);
  });

  it("accepts two unmet criteria with a must finding each", () => {
    const text = withUnmet([1, 2], criterionNotMet(8, 12) + criterionNotMet(9, 30));
    expect(codeReview(text).criteria.filter((c) => !c.met)).toHaveLength(2);
  });

  // A pull request whose body names no issue has no acceptance criteria. The skill tells
  // the reviewer to say so, and an empty list is still refused, so the saying needs a word.
  /**
   * The `issue:` key of a model-written report, read by the rule the CLIs share.
   *
   * `intOf` used `Number.parseInt`, which stops at the first non-digit and has no opinion
   * about sign or zero: `5x` read as 5, `0` and `-1` passed, and the field is written by a
   * model rather than typed at a terminal. One rule for "is this an issue number", the one
   * `issueArg` already applies to every CLI token
   * (maintainer's re-review of pull request 2, follow-up 7).
   */
  it("reads the issue key as decimal digits and nothing else", () => {
    // Not `" 5"`: `scalar()` trims the value, so surrounding whitespace is the block
    // parser's to drop and never reaches the number rule.
    for (const bad of ["5x", "0", "-1", "0x10", "1e2", "007", ""]) {
      const text = fx("code-review").replace("issue: 126", `issue: ${bad}`);
      expect(() => codeReview(text), JSON.stringify(bad)).toThrow(/is not an issue number/);
    }
    // The message names the key as well as the token: a report has more than one number.
    expect(() => codeReview(fx("code-review").replace("issue: 126", "issue: 5x"))).toThrow(
      /"issue".*"5x"/,
    );
    expect(codeReview(fx("code-review")).issue, "the positive control").toBe(126);
  });

  it("accepts criteria: none, and says so in the result", () => {
    const text = fx("code-review").replace(/^criteria:\n(?: {2}.*\n)+/m, "criteria: none\n");
    const r = codeReview(text);
    expect(r.criteria).toEqual([]);
    expect(r.criteriaNone).toBe(true);
    expect(codeReview(fx("code-review")).criteriaNone).toBe(false);
  });
});

/**
 * The lenient parser's own criteria list.
 *
 * `parseStoppedCodeReview` exists to salvage what an interrupted reviewer wrote, and it
 * called the strict `criteriaOf`, which throws on a line that does not start with `met` or
 * `not met`. A run that stopped early is exactly the one likely to have a half-written
 * list — the reviewer was cut off mid-line — so `post-review.ts` answered exit 2, "report
 * did not parse", for the case this parser was added to remove. The line is kept with no
 * verdict instead, and the account renders it as "not stated" rather than as an unmet
 * criterion, which would be a claim nobody made
 * (maintainer's re-review of pull request 2, follow-up 2).
 */
describe("parseStoppedCodeReview's criteria", () => {
  const withCriteria = (lines: string) =>
    fx("code-review-stopped").replace("criteria:\n", `criteria:\n${lines}`);

  it("keeps a half-written criterion as its text, with no verdict", () => {
    const r = parseStoppedCodeReview(
      withCriteria("  1. met — tests/unit/x.test.ts:12\n  2. the filename hel\n"),
      { catalogue },
    );
    // The list marker is the block parser's to strip; what is kept is the line as the
    // reviewer left it, so a human can see where it was cut off.
    expect(r.criteria).toEqual([
      { met: true, text: "tests/unit/x.test.ts:12" },
      { met: null, text: "the filename hel" },
    ]);
    // And what a human reads says which of the three it is.
    const account = reviewAccountAsMarkdown(r).join("\n");
    expect(account).toContain("1. met — tests/unit/x.test.ts:12");
    expect(account, 'not "not met", which the reviewer never wrote').toContain(
      "2. not stated — the filename hel",
    );
  });

  // The strict parser keeps throwing: a review that ran to its status line has no excuse
  // for a list nobody can read, and the throw names the line.
  it("still refuses the same line in a completed report", () => {
    const text = fx("code-review").replace(
      "  3. met — src/server/documents/filename.ts:18\n",
      "  3. the filename hel\n",
    );
    expect(() => codeReview(text)).toThrow(/must start with "met" or "not met"/);
  });
});

/**
 * The completeness probe exists to be answerable *before* the code review's own checks:
 * an interrupted reviewer usually never wrote its verdict, and asking the full parser
 * first blames a missing field for what is really a stopped run. It ran the whole parser
 * all the same, so a finding the parser refuses threw out of the probe — the very
 * ordering the probe was added to prevent — and all five of its callers parse the same
 * text again immediately afterwards anyway.
 */
describe("isReportComplete reads the status line and nothing else", () => {
  it("answers complete for a block the parser will refuse", () => {
    const text = fx("code-review").replace("confidence: 9", "confidence: 9/10");
    expect(isReportComplete("code-review", text)).toBe(true);
    // The refusal still happens, one step later and with the parser's own message.
    expect(() => codeReview(text)).toThrow(/needs "confidence: <1-10>"/);
  });

  it("still answers false for a run that never reached its status line", () => {
    const stopped = fx("code-review").replace("-STATUS: complete", "-STATUS: stopped");
    expect(isReportComplete("code-review", stopped)).toBe(false);
    expect(isReportComplete("plan-review", fx("plan-review"))).toBe(true);
    // A block with no end marker at all is not "incomplete" but unreadable, and the throw
    // is the caller's "the block does not parse" path.
    expect(() =>
      isReportComplete("code-review", fx("code-review").replace(/^CODE-REVIEW-STATUS:.*$/m, "")),
    ).toThrow(/CODE-REVIEW-STATUS/);
  });
});

/**
 * The renderers the pull request body and the review comment are composed from. Each one
 * returns lines rather than a block of text, because the body's blank-line filter works
 * on array elements and never sees a `"\n\n"` inside a string.
 */
describe("the renderers group by tier", () => {
  const r = codeReview(fx("code-review"));

  it("groups findings by tier in the order must, should, later", () => {
    const grouped = findingsByTier(r.findings);
    expect(Object.keys(grouped)).toEqual([...TIERS]);
    expect(TIERS).toEqual(["must", "should", "later"]);
    expect(grouped.must.map((f) => f.rule)).toEqual(["tests/passes-without-change"]);
    expect(grouped.should.map((f) => f.rule)).toEqual([
      "bug/general-case",
      "tests/no-positive-control",
    ]);
    expect(grouped.later.map((f) => f.rule)).toEqual(["scope/follow-up"]);
  });

  const sections = tierSections(r.findings, (f) => `\`${f.rule}\` — ${f.message}`, {
    headings: { must: "Must", should: "Should, open", later: "Later" },
    intro: {
      must: "These block; this body should not exist.",
      should: "A human decides whether they block the merge.",
      later: "Noted by the review, deliberately not fixed:",
    },
  });

  it("gives every non-empty tier a heading with its count, the intro and numbered findings", () => {
    const text = sections.join("\n");
    expect(text).toContain("### Must (1)");
    expect(text).toContain("### Later (1)");
    expect(text).toMatch(
      /### Should, open \(2\)\n\nA human decides whether they block the merge\.\n\n1\. `bug\/general-case`/,
    );
    expect(text).toContain("2. `tests/no-positive-control`");
    // In tier order, whatever order the findings arrived in.
    expect(text.indexOf("### Must")).toBeLessThan(text.indexOf("### Should"));
    expect(text.indexOf("### Should")).toBeLessThan(text.indexOf("### Later"));
  });

  // The plan review's map existed only to satisfy the full record: `intro.must: ""` was
  // there because a plan whose review left a must never reaches the pull request at all.
  it("accepts an intro for some tiers and not others", () => {
    const some = tierSections(r.findings, (f) => f.rule, {
      headings: { must: "Must", should: "Should", later: "Later" },
      intro: { should: "These cost a round." },
    });
    const text = some.join("\n");
    expect(text).toContain("### Must (1)");
    expect(text).toContain("These cost a round.");
    // The tier with no intro renders its heading and its findings, and no stray sentence:
    // the same shape a `""` intro produced, which is what the plan review passed.
    expect(text).toMatch(/### Must \(1\)\n[\n]*1\. tests\/passes-without-change/);
  });

  it("writes no heading for an empty tier and nothing at all for no findings", () => {
    const plain = {
      headings: { must: "Must", should: "Should", later: "Later" },
      intro: { must: "", should: "", later: "" },
    };
    const rule = (f: ReviewFinding) => f.rule;
    const later = tierSections(
      r.findings.filter((f) => f.tier === "later"),
      rule,
      plain,
    );
    expect(later.join("\n")).not.toContain("### Must");
    expect(later.join("\n")).toContain("### Later (1)");
    expect(tierSections([], rule, plain)).toEqual([]);
  });

  // The contract is "no blank line inside an element", not "no newline": the review
  // comment renders a finding over three lines, and asserting the single-line form here
  // pinned only this test's own renderer while the shipped one broke the rule.
  it("puts no blank line inside an element, so the body's blank-line filter can see them", () => {
    const wrapped = tierSections(r.findings, (f) => `\`${f.rule}\`\n   ${f.message}`, {
      headings: { must: "Must", should: "Should", later: "Later" },
      intro: { must: "m", should: "s", later: "l" },
    });
    for (const element of [...sections, ...wrapped]) expect(element).not.toContain("\n\n");
    // A multi-line element still leaves the sections separated by exactly one blank line.
    expect(wrapped.join("\n")).not.toContain("\n\n\n");
    expect(wrapped.join("\n")).toMatch(/1\. `tests\/passes-without-change`\n {3}Both tests/);
  });

  // The fourth class, shared by both reviews and both renderers: an observation whose
  // claim to be real was withdrawn. Bullets, not numbers — a finding is numbered because
  // something refers to it; nothing refers to these.
  it("renders the uncertain items under one heading, or nothing at all", () => {
    const section = uncertainSection([...r.uncertain, "bug/leak — the tree was gone"]);
    expect(section[0]).toBe("### Uncertain (3)");
    expect(section.join("\n")).toContain(
      "Not reported as findings: no quotable line, or scored below the threshold.",
    );
    expect(section.join("\n")).toContain("- bug/leak — the tree was gone");
    // The reviewer's own line and the one the classification computed, in that order.
    expect(section.join("\n")).toMatch(/- spec\/out-of-scope[\s\S]*- perf\/inefficiency/);
    expect(uncertainSection([])).toEqual([]);
  });

  // One loader for both reviews and every caller, because three copies of it existed and
  // a caller that read the wrong stage's threshold would classify against another number.
  it("reads each stage's threshold from the config it is given", () => {
    const cfg = {
      codeReview: { scoreThreshold: 9 },
      planReview: { scoreThreshold: 8 },
    } as unknown as ProjectConfig;
    expect(classifyOptions("code-review", { cfg, catalogue }).threshold).toBe(9);
    expect(classifyOptions("plan-review", { cfg, catalogue }).threshold).toBe(8);
    expect(classifyOptions("code-review", { cfg, catalogue }).catalogue).toBe(catalogue);
    // A config that names neither leaves the threshold to the parser's own default.
    expect(
      classifyOptions("code-review", { cfg: {} as ProjectConfig, catalogue }).threshold,
    ).toBeUndefined();
  });

  it("numbers the criteria in the review account", () => {
    const account = reviewAccountAsMarkdown(r).join("\n");
    expect(account).toContain("1. met — tests/unit/app/api/documents-route.test.ts:41");
    expect(account).toContain("3. met — src/server/documents/filename.ts:18");
    expect(account).not.toContain("- met — ");
  });

  it("says how the review ran", () => {
    const account = reviewAccountAsMarkdown(r).join("\n");
    expect(account).toContain("Red step: `not-proven`");
    expect(account).toMatch(/How it ran: fan-out `criteria, bugs.*`; scored by `sonnet`/);
  });

  it("still says when there was nothing to check", () => {
    const account = reviewAccountAsMarkdown({ ...r, criteria: [], criteriaNone: true }).join("\n");
    expect(account).toMatch(/names no issue/);
    expect(account).toContain("How it ran:");
  });
});

describe("reportPath", () => {
  it("is under .autoclaude/state/reports", () => {
    expect(reportPath("code-review").replace(/\\/g, "/")).toBe(
      ".autoclaude/state/reports/code-review.md",
    );
  });
});

describe("defuseMentions", () => {
  it("keeps a configured human's @mention and defuses others", () => {
    expect(defuseMentions("@alice and @bot", ["alice"])).toBe("@alice and @\u200bbot");
  });

  it("defuses every mention when nobody is allowed", () => {
    expect(defuseMentions("@claude and @Alice")).toBe("@\u200bclaude and @\u200bAlice");
  });

  it("compares handles case-insensitively", () => {
    expect(defuseMentions("@Alice", ["alice"])).toBe("@Alice");
  });

  it("leaves an @ that is not a mention alone", () => {
    expect(defuseMentions("mail a@b.com or user@host")).toBe("mail a@b.com or user@host");
  });
});
