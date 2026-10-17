import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EVIDENCE_KINDS, parseInvariants } from "../../../src/engine/review/invariants.js";
import { LEVELS } from "../../../src/engine/review/rules.js";

const INVARIANTS_FIXTURE = "test/fixtures/catalogue/invariants.md";

/**
 * Engine-level tests: the grammar of an invariants file, which holds for any
 * project's. This file travels to another repository unchanged.
 *
 * Which rules *this* project states is asserted in project-config.test.ts.
 */
describe("parseInvariants", () => {
  it("reads a rule row into its four parts, with the evidence kind defaulting to a line", () => {
    const md = "| `area/rule-name` | error | inspect this | a breach is that |";
    expect(parseInvariants(md)).toEqual([
      {
        id: "area/rule-name",
        level: "error",
        whatToInspect: "inspect this",
        breachLooksLike: "a breach is that",
        evidence: "line",
      },
    ]);
  });

  /**
   * The fifth column, and the reason it exists: a rule whose finding is about what the
   * diff does **not** contain has no line to quote, and the evidence check withdrew it.
   * Which rules those are was a prefix list in `review-decision.ts` — `spec/`, `plan/`,
   * `paths/` — so a project shipping a measurement rule of its own had to edit the
   * engine, against the rule that the engine learns a project fact from `.autoclaude/` and
   * nowhere else.
   */
  it("reads the evidence kind from the last column, and refuses a word outside the two", () => {
    const rows = parseInvariants(
      [
        "| `area/measured` | error | the diff as a whole | nothing quotable | measurement |",
        "| `area/quoted`   | error | a line              | a line            | line        |",
        "| `area/blank`    | error | a line              | a line            |             |",
      ].join("\n"),
    );
    expect(rows.map((r) => [r.id, r.evidence])).toEqual([
      ["area/measured", "measurement"],
      ["area/quoted", "line"],
      ["area/blank", "line"],
    ]);
    // The four cells before it keep their positions, so a file that gains the column
    // does not shift what a reviewer reads.
    expect(rows[0]).toMatchObject({
      level: "error",
      whatToInspect: "the diff as a whole",
      breachLooksLike: "nothing quotable",
    });
    // A third word is a malformed row, named: silently reading it as `line` would put the
    // measurement rule back under a check that withdraws it, and every test would pass.
    expect(() => parseInvariants("| `area/typo` | error | x | y | mesaurement |")).toThrow(
      /area\/typo/,
    );
    expect(() => parseInvariants("| `area/typo` | error | x | y | mesaurement |")).toThrow(
      /line|measurement/,
    );
  });

  // Both shapes used to vanish without a word, and losing exactly one rule still
  // passed the ">= 10" count assertion — so the reviewer would quietly stop checking
  // that invariant and every test would stay green.
  it("refuses a rule row whose id is not area/rule-name", () => {
    expect(() => parseInvariants("| `Layer/Capitalised` | error | x | y |")).toThrow(
      /not a rule id/,
    );
    expect(() => parseInvariants("| `no-area` | error | x | y |")).toThrow(/not a rule id/);
  });

  it("reads a row that carries extra padding around the pipes", () => {
    const md = "|  `example/padded`  | error | x | y |";
    expect(parseInvariants(md).map((r) => r.id)).toEqual(["example/padded"]);
  });

  it("ignores the header, the separator and prose around the table", () => {
    const md = [
      "# Invariants",
      "",
      "Some prose about the rules.",
      "| Rule id | Level | What to inspect | A breach looks like |",
      "| --- | --- | --- | --- |",
      "| `area/rule-name` | error | x | y |",
    ].join("\n");
    expect(parseInvariants(md).map((r) => r.id)).toEqual(["area/rule-name"]);
  });

  /**
   * The evidence kind is read from the fifth cell by position, so the fifth *header* has
   * to say that is what the column is.
   *
   * A port that inserts a column before it gets the kind read from the wrong cell: loudly
   * when the misread cell holds a word — the refusal above — and silently as `line` when
   * it happens to be empty, which puts a rule with no line to quote back under a check
   * that withdraws it. The plan asked for "a **last** column headed `Evidence`" and only
   * the position was enforced.
   *
   * Checked per table that holds rule rows, not per file: a prose table elsewhere in the
   * document is none of this parser's business.
   */
  it("refuses a rule table whose fifth column is not the evidence column", () => {
    const table = (header: string) =>
      [
        `| Rule id | Level | What to inspect | A breach looks like | ${header} |`,
        "| --- | --- | --- | --- | --- |",
        "| `area/rule-name` | error | x | y | measurement |",
      ].join("\n");
    // The positive control first: the spelling both real files use parses.
    expect(parseInvariants(table("Evidence")).map((r) => r.evidence)).toEqual(["measurement"]);
    // Case and padding are not the point; the word is.
    expect(parseInvariants(table("  evidence  ")).map((r) => r.evidence)).toEqual(["measurement"]);
    // Anything else is a parse error naming the header it found, because the next reader
    // has to know which column the parser was looking at.
    for (const wrong of ["Owner", "Since", "Notes"]) {
      expect(() => parseInvariants(table(wrong)), wrong).toThrow(/Evidence/);
      expect(() => parseInvariants(table(wrong)), wrong).toThrow(new RegExp(wrong));
    }
    // A four-column table has no fifth header and is still valid: the column is optional,
    // which is the whole reason it is read positionally.
    const four = [
      "| Rule id | Level | What to inspect | A breach looks like |",
      "| --- | --- | --- | --- |",
      "| `area/rule-name` | error | x | y |",
    ].join("\n");
    expect(parseInvariants(four).map((r) => r.evidence)).toEqual(["line"]);
    // And a table with no rule row in it is not a rule table, whatever it is headed.
    const prose = [
      "| Stage | Model | Cap | Why | Owner |",
      "| --- | --- | --- | --- | --- |",
      "| implement | sonnet | 2 | cost | jan |",
    ].join("\n");
    expect(parseInvariants(prose)).toEqual([]);
  });

  // The two real files, which is what a port breaks and what this rule exists for.
  it("is the header both catalogue halves actually carry", () => {
    for (const file of ["catalogue/rules.md", INVARIANTS_FIXTURE]) {
      expect(parseInvariants(readFileSync(file, "utf8")).length, file).toBeGreaterThan(0);
    }
  });
});

describe("an invariants.md, the format", () => {
  const rules = parseInvariants(readFileSync(INVARIANTS_FIXTURE, "utf8"));

  it("states at least one rule", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("parses invariants.md with BOM and CRLF", () => {
    const table = readFileSync(INVARIANTS_FIXTURE, "utf8");
    expect(parseInvariants("\uFEFF" + table.replace(/\n/g, "\r\n"))).toHaveLength(6);
  });

  it("uses area/rule-name ids only", () => {
    for (const r of rules) expect(r.id).toMatch(/^[a-z]+\/[a-z-]+$/);
  });

  it("has no duplicate ids", () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // `policy()` reads the level off each row to compute a finding's class, so a row
  // carrying a word outside the vocabulary is a finding nobody can classify. The set is
  // the one `rules.ts` exports rather than a copy of it: a level the engine learns and
  // this assertion does not would refuse every row that used it.
  it("gives every rule a level of error, warning or note", () => {
    for (const r of rules) {
      expect(LEVELS as readonly string[], `rule ${r.id} has level "${r.level}"`).toContain(r.level);
    }
  });

  // The set the engine exports rather than a copy of it, for the reason the levels are
  // read that way: a kind the engine learns and this assertion does not would refuse
  // every row that used it.
  it("gives every rule an evidence kind of line or measurement", () => {
    for (const r of rules) {
      expect(
        EVIDENCE_KINDS as readonly string[],
        `rule ${r.id} has evidence "${r.evidence}"`,
      ).toContain(r.evidence);
    }
  });

  it("says what to inspect and what a breach looks like for every rule", () => {
    for (const r of rules) {
      expect(r.whatToInspect.length, `rule ${r.id} has no "what to inspect"`).toBeGreaterThan(0);
      expect(r.breachLooksLike.length, `rule ${r.id} has no "a breach looks like"`).toBeGreaterThan(
        0,
      );
    }
  });
});
