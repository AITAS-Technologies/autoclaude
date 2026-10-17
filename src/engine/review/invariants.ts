/**
 * Reading .autoclaude/invariants.md — the project's review rules as a table.
 *
 * Engine code: it knows the file's shape, never its content. Which rules a project
 * states is that project's business.
 */

/**
 * How a rule's finding is evidenced.
 *
 * `line` is the ordinary case: the finding quotes the source line that triggers it, and
 * `review-decision.ts` looks that line up in the worktree. `measurement` is a rule about
 * what the diff does **not** contain — an acceptance criterion nothing satisfies, a
 * changed file list against a glob, a schema change with no migration file — which has no
 * line to quote, so the evidence check leaves it alone.
 *
 * It is a property of the rule and therefore of the catalogue row, not of the family the
 * id happens to start with: the check's exempt set was a prefix list in the engine, so a
 * project rule of the measurement shape was withdrawn every time it fired and the engine
 * had to be edited for each project that shipped one.
 */
export const EVIDENCE_KINDS = ["line", "measurement"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One row of the invariants table. */
export interface InvariantRule {
  /** `area/rule-name`, the id a review finding cites. */
  id: string;
  /**
   * `error` blocks; `warning` costs a fix round without blocking; `note` is recorded and
   * deliberately not fixed now. The vocabulary is `rules.ts`'s `LEVELS`, and `policy()`
   * there turns this level and a confidence into a class.
   *
   * Typed as a string rather than as that union on purpose: this is whatever the row
   * says, and the parser promises the file's shape, never its content. A word outside the
   * vocabulary is refused where it is computed with — loudly, by `policy()` — and pinned
   * by the tests that read the real catalogues.
   */
  level: string;
  whatToInspect: string;
  breachLooksLike: string;
  /**
   * `line` or `measurement`, from the optional last column headed `Evidence`. An absent
   * or empty cell is `line`, so a file written before the column existed reads as one
   * whose every finding quotes a line — the conservative answer, since a `line` rule is
   * checked and a `measurement` rule is not.
   *
   * Typed as the union rather than as a string, unlike `level` above: the two words are
   * the engine's own vocabulary and not the project's, so a third one is refused here
   * rather than where it is computed with.
   */
  evidence: EvidenceKind;
}

/**
 * A row whose first cell is wrapped in backticks is a rule. The header and the
 * `| --- |` separator have no backticks, so they fall out without a special case.
 *
 * This used to be `/^\| `[a-z]/`, which silently dropped anything that did not fit:
 * a capitalised area, a stray space before the leading pipe. Since the reviewer stops
 * checking an invariant it never sees, and the count test only asserted a lower bound,
 * losing a rule was both invisible and green. A malformed row is now an error.
 */
const RULE_ROW = /^\s*\|\s*`[^`]+`\s*\|/;
const RULE_ID = /^[a-z]+\/[a-z-]+$/;

/**
 * The cell the evidence kind is read from: the fifth column, which is the last one the
 * grammar has. A four-column row has nothing there — `split("|")` leaves the text after
 * the closing pipe, which is empty — so the column is optional without a special case.
 */
const EVIDENCE_CELL = 5;

/**
 * A markdown table's separator row, `| --- | --- |`: what marks the line above it as the
 * table's header.
 */
const SEPARATOR_ROW = /^\s*\|[\s:|-]+\|\s*$/;

/** What the fifth header must say, so `EVIDENCE_CELL` cannot end up reading another column. */
const EVIDENCE_HEADER = "evidence";

/**
 * The header of every table in this document that holds rule rows.
 *
 * Per table rather than per file, because a document may carry a prose table of its own
 * and its columns are none of this parser's business. A table with no rule row in it is
 * therefore skipped whatever it is headed.
 */
function ruleTableHeaders(lines: string[]): string[] {
  const headers: string[] = [];
  lines.forEach((line, i) => {
    if (!SEPARATOR_ROW.test(line)) return;
    let holdsRules = false;
    for (let j = i + 1; j < lines.length && /^\s*\|/.test(lines[j]!); j++) {
      if (RULE_ROW.test(lines[j]!)) {
        holdsRules = true;
        break;
      }
    }
    if (holdsRules) headers.push(lines[i - 1] ?? "");
  });
  return headers;
}

/**
 * Every rule row, parsed. Non-table lines, the header and the separator are ignored.
 *
 * @throws when a row looks like a rule but its id is not `area/rule-name`. Dropping it
 * quietly would disarm exactly one invariant and leave every test green.
 * @throws when its evidence cell is neither `line` nor `measurement` nor empty, naming
 * the row: read as `line`, a mistyped `measurement` puts a rule with no line to quote
 * back under a check that withdraws it, and nothing else would notice.
 * @throws when a rule table has a fifth header that does not say `Evidence`. The kind is
 * read from that cell by position, so a column inserted before it would be read as the
 * kind — loudly when it holds a word, and silently as `line` when it happens to be empty.
 */
export function parseInvariants(markdown: string): InvariantRule[] {
  const lines = markdown.split("\n");
  for (const header of ruleTableHeaders(lines)) {
    const fifth = header.split("|").map((c) => c.trim())[EVIDENCE_CELL] ?? "";
    if (fifth !== "" && fifth.toLowerCase() !== EVIDENCE_HEADER) {
      throw new Error(
        `invariants: the fifth column of a rule table is headed "${fifth}", not ` +
          `"Evidence". The evidence kind is read from that cell by position, so a column ` +
          `inserted in front of it becomes the kind — as an error if it holds a word, and ` +
          `silently as "${EVIDENCE_KINDS[0]}" if it is empty. Put the evidence column last.`,
      );
    }
  }
  return lines
    .filter((line) => RULE_ROW.test(line))
    .map((line) => {
      const cells = line.split("|").map((c) => c.trim());
      const id = cells[1]!.replace(/`/g, "");
      if (!RULE_ID.test(id)) {
        throw new Error(
          `invariants: "${id}" is not a rule id. Expected area/rule-name, lower case, ` +
            `e.g. layer/auth-in-server. A row that does not parse is a rule the ` +
            `reviewer would never check.`,
        );
      }
      const written = cells[EVIDENCE_CELL] ?? "";
      const evidence = written === "" ? "line" : written;
      if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence)) {
        throw new Error(
          `invariants: rule "${id}" says its evidence is "${written}". Expected ` +
            `${EVIDENCE_KINDS.join(" or ")}, or an empty cell for ${EVIDENCE_KINDS[0]}. ` +
            `A rule read as the wrong kind is either checked for a line it cannot have, ` +
            `or exempt from a check it needs.`,
        );
      }
      return {
        id,
        level: cells[2] ?? "",
        whatToInspect: cells[3] ?? "",
        breachLooksLike: cells[4] ?? "",
        evidence: evidence as EvidenceKind,
      };
    });
}

/**
 * Just the rule ids. The review skill cites these in its findings, so they have to
 * be well-formed and unique — which is what the engine's test asserts.
 */
export function ruleIds(markdown: string): string[] {
  return parseInvariants(markdown).map((r) => r.id);
}
