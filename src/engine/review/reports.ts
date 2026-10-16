/**
 * The three skills end with a fixed block "the orchestrator parses". This is the parser.
 *
 * The command line that prints these as JSON (exit 1 for no block, unterminated or a value
 * outside the contract; exit 2 for a review block whose status line is not "complete")
 * is a later task's; this module is the library it calls.
 *
 * The blocks are a small YAML-like shape — scalars, lists of strings, lists of
 * mappings — read by an indentation-aware hand parser rather than a YAML library, so
 * the contract stays exactly what the skills print and nothing more. A block that is
 * missing, unterminated or carries a value outside the contract throws: a run that
 * ends without its block failed, whatever else it printed.
 *
 * A review block states a rule id and a confidence and **no level**. The level comes from
 * the catalogue and the class — must, should, later — from `policy()`, so the two review
 * parsers take a `ClassifyOptions` and nobody can escalate a finding by writing a word
 * into the block. The same file also holds the renderers the pull request body and the
 * review comment are composed from, because they render what this parser produced.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueArg } from "../../cli/args.js";
import type { ProjectConfig } from "../../config/types.js";
import { loadProjectConfig } from "../../config/load.js";
import type { Verdict } from "./red-step-verdict.js";
import type { EvidenceKind, InvariantRule } from "./invariants.js";
import {
  DEFAULT_THRESHOLD,
  catalogueFor,
  LEVELS,
  fingerprintOf,
  isScore,
  policy,
  type FindingClass,
  type Level,
} from "./rules.js";

export type Stage = "plan" | "plan-review" | "implement" | "code-review";

export interface PlanReport {
  issue: number;
  /**
   * `needs-shaping` is not a failed plan: it is an issue that may not be planned at all,
   * because it carries no acceptance criteria. The planner stops before reading any code
   */
  status: "planned" | "needs-human" | "needs-shaping";
  reason: string;
  /** Whether the change needs a database migration, from the block's `db-migration-required`. */
  dbMigrationRequired: boolean;
  planFile: string;
}

/** One acceptance criterion as a report states it: met or not, and the text after the dash. */
export interface Criterion {
  /**
   * `true` for `met`, `false` for `not met`, and `null` for a line that says neither.
   *
   * The third state only ever comes out of `parseStoppedCodeReview`: a completed report
   * whose list cannot be read is still refused. It is not folded into `false`, because
   * "not met" is a verdict a reviewer wrote and this is a line it never finished
   */
  met: boolean | null;
  text: string;
}

export interface ImplementReport {
  issue: number;
  status: "done" | "needs-shaping" | "needs-human" | "blocked";
  reason: string;
  /** Whether the change carries a database migration, from `db-migration-required`. */
  dbMigrationRequired: boolean;
  commit: string;
  criteria: Criterion[];
  testsAdded: string;
  observedNotDone: string[];
}

/**
 * The three classes a finding can be reported in, in the order a reader wants them.
 *
 * `uncertain`, the fourth class `policy` can return, is not a tier: it is the absence of
 * one. Such a finding is not reported as a finding at all — it moves to `uncertain` as a
 * line saying why — so nothing here ever has to render it.
 */
export type Tier = Exclude<FindingClass, "uncertain">;
export const TIERS = ["must", "should", "later"] as const satisfies readonly Tier[];

/**
 * The tier vocabulary as a reader sees it, one heading per class.
 *
 * Four maps stated the same three words — the pull request body's two, the fix dispatch's
 * and the review comment's — and the only real difference between them is the body's
 * "Should, open", which it spreads over this one. One list, so a class renamed is renamed
 * everywhere or nowhere.
 */
export const TIER_HEADINGS: Record<Tier, string> = {
  must: "Must",
  should: "Should",
  later: "Later",
};

/**
 * What a finding has to be read against: the catalogue its rule is looked up in, and the
 * threshold its confidence is measured against.
 *
 * Both parsers take this, and no caller may skip it. A parse without the catalogue would
 * send every finding to `uncertain` and the review would come back looking like it found
 * nothing — the same failure `loadCatalogue` refuses half a catalogue for.
 */
export interface ClassifyOptions {
  /** Every rule a review may cite, from `loadCatalogue()`. */
  catalogue: InvariantRule[];
  /** `config.<stage>.scoreThreshold`; `rules.ts`'s `DEFAULT_THRESHOLD` when none. */
  threshold?: number;
  /** `cfg.worktrees.root`: what a quoted path is normalised against; the default root when absent. */
  worktreesRoot?: string;
}

export interface ReviewFinding {
  rule: string;
  /**
   * The rule's level from the catalogue, never from the block. A model that could write
   * its own level could escalate any finding to blocking (design, section 7).
   */
  level: Level;
  /** `policy(level, confidence, threshold)`. Never `uncertain`: those are not findings. */
  tier: Tier;
  /**
   * Whether this rule's finding evidences itself with a quoted line or with a measurement
   * of the diff — the row's `Evidence` cell, read here for the same reason the level is:
   * it belongs to the rule, and a finding that could state its own would be exempt from
   * the evidence check by writing a word into the block.
   *
   * `review-decision.ts` reads it instead of matching the rule id against a list of
   * families, which is what made a project's own measurement rule — an error rule about
   * what the diff does not contain — withdrawn every time it fired.
   */
  evidenceKind: EvidenceKind;
  confidence: number;
  file: string;
  line: number;
  evidence: string;
  message: string;
  /**
   * The finding's identity across rounds, `fingerprintOf(rule, evidence, file)`: how a
   * `later` item already deferred in an earlier round is recognised instead of listed
   * again. Computed here, once, so every reader of a report compares the same key.
   */
  fingerprint: string;
}

/** A finding as the block states it, before the catalogue has been consulted. */
type StatedFinding = Omit<ReviewFinding, "level" | "tier" | "evidenceKind" | "fingerprint">;

export interface ReviewReport {
  issue: number;
  findings: ReviewFinding[];
  /**
   * The lines the reviewer wrote under `uncertain:`, then the findings the classification
   * withdrew — a rule the catalogue does not state, or a confidence below the threshold.
   * Both are observations without a claim, which is why they share one list.
   */
  uncertain: string[];
  complete: boolean;
}

/**
 * What a plan review adds: who scored its findings. It has no diff and no tests, so this
 * is the whole of its account of itself — and a plan review that scored its own findings
 * must not read like one a second reader scored.
 */
export interface PlanReviewReport extends ReviewReport {
  scoredBy: string;
}

/**
 * The red step's outcome, in `red-step-verdict.ts`'s own words rather than a second vocabulary:
 * its `verdict.kind` is `proven`, `not-proven` or `could-not-run`, and its exit 3 (the
 * diff adds no test file vitest collects) carries no verdict at all, which is
 * `no-test-files` here.
 */
export type RedStepVerdict = Verdict["kind"] | "no-test-files";

/**
 * What a code review adds to the shared findings shape: an account of what it *did*.
 *
 * An earlier version of this contract was closed unmerged on the absence of `redStep` and `criteria`. The block carried
 * `findings: []` against 836 added lines and nothing else, so a review that skipped the
 * red step and the per-criterion check produced a byte-identical report to one that did
 * both. `fanOut` and `scoredBy` are required for the same reason and say the same kind of
 * thing: how the review was run. None of the four can force a reviewer to be thorough;
 * what they change is that a report which does not state them no longer parses, and an
 * unparseable report is a failed run rather than a clean review.
 *
 * The plan review states only who scored it: it has no diff and no tests to run.
 */
export interface CodeReviewReport extends StoppedCodeReview {
  redStep: RedStepVerdict;
}

/**
 * A code review that stopped before it reached its own account: the same fields, with the
 * ones a reviewer interrupted at Step 2 or Step 6 cannot have left empty.
 *
 * `CodeReviewReport` narrows `redStep` back to a verdict, so a complete report is this
 * shape with one more promise and every reader of one still has it. Nothing else has to
 * know the difference: the renderers take this type, because what they do with a stopped
 * report is render what it had written.
 *
 * It exists because the banner `post-review.ts` promises — a stopped report on the pull
 * request under "the review did not finish" — was unreachable. The strict parser refuses
 * exactly the fields such a reviewer has not written, so the result was exit 2, "the
 * report did not parse", which is the one outcome that leaves a human with nothing
 */
export interface StoppedCodeReview extends ReviewReport {
  /** Null when the review stopped before the red step ran; a verdict otherwise. */
  redStep: RedStepVerdict | null;
  /** Required for `could-not-run`, where nothing else in the report explains the verdict. */
  reason: string;
  /**
   * Which angles were dispatched, or `sequential` or `none`. Free text, and required for
   * the reason `red-step:` is: a review with eight pairs of eyes and a review with one
   * are different evidence, and a report that does not say which it was must not look
   * like one that ran fully. Empty only in a report that stopped.
   */
  fanOut: string;
  /** Which model re-scored the findings, or `lead` when the reviewer scored its own. */
  scoredBy: string;
  /** One entry per acceptance criterion, its text being where the evidence was found. */
  criteria: Criterion[];
  /**
   * `criteria: none`: the target names no issue, so there is nothing to check against.
   * Only a pull request can be in that position; a worktree review always has its issue.
   */
  criteriaNone: boolean;
}

const MARKERS: Record<Stage, { start: string; end: string }> = {
  plan: { start: "AUTODEV-PLAN", end: "AUTODEV-PLAN-END" },
  "plan-review": { start: "AUTODEV-PLAN-REVIEW", end: "PLAN-REVIEW-STATUS:" },
  implement: { start: "AUTODEV-REPORT", end: "AUTODEV-REPORT-END" },
  "code-review": { start: "AUTODEV-CODE-REVIEW", end: "CODE-REVIEW-STATUS:" },
};

export function reportPath(stage: Stage): string {
  return join(".autoclaude", "state", "reports", `${stage}.md`);
}

export function readReport(worktree: string, stage: Stage): string {
  return readFileSync(join(worktree, reportPath(stage)), "utf8");
}

/** Lines strictly between the start marker and the end marker, both required. */
function extractBlock(stage: Stage, text: string): { lines: string[]; endLine: string } {
  const lines = text.split(/\r?\n/);
  const { start, end } = MARKERS[stage];
  const s = lines.findIndex((l) => l.trim() === start);
  if (s < 0) throw new Error(`report: no ${start} block found; the run ended without its report`);
  const e = lines.findIndex((l, i) => i > s && l.trim().startsWith(end));
  if (e < 0) throw new Error(`report: ${start} block is not terminated by ${end}`);
  return { lines: lines.slice(s + 1, e), endLine: lines[e]!.trim() };
}

type Item = string | Record<string, string>;
interface Block {
  scalars: Record<string, string>;
  lists: Record<string, Item[]>;
}

const KEY = /^([a-z][a-z0-9-]*):(?:\s+(.*))?$/;
const BULLET = /^(?:-|\d+\.)\s+(.*)$/;

/**
 * Which lists hold mappings. Everywhere else a bullet is a string, even when it
 * contains a colon: `1. met: the header is set` is a criterion, `- docs: the README
 * still names the old flag` is an observation. Reading those as mappings made the
 * parser reject or garble input its own contract allows.
 */
const MAPPING_LISTS: ReadonlySet<string> = new Set(["findings"]);

function parseBlock(lines: string[]): Block {
  const scalars: Record<string, string> = {};
  const lists: Record<string, Item[]> = {};
  let current: string | null = null;
  let lastScalar: string | null = null;
  let lastField: string | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      lastField = null;
      const m = line.match(KEY);
      if (!m) throw new Error(`report: cannot read line "${line}"`);
      if (m[2] !== undefined && m[2] !== "") {
        scalars[m[1]!] = m[2]!;
        current = null;
        lastScalar = m[1]!;
      } else {
        // `reason:` with nothing after it is an empty scalar; it only becomes a list
        // if indented items follow. Keep it addressable as both.
        scalars[m[1]!] = "";
        lists[m[1]!] = [];
        current = m[1]!;
        lastScalar = null;
      }
      continue;
    }
    if (!current) {
      // An indented line under a scalar is the scalar wrapping onto a second line,
      // `tests-added:` most often. A model that wraps a line has not stopped reporting.
      if (lastScalar) {
        scalars[lastScalar] = `${scalars[lastScalar]} ${line}`;
        continue;
      }
      throw new Error(`report: indented line outside a list: "${line}"`);
    }
    const items = lists[current]!;
    const bullet = line.match(BULLET);
    if (bullet) {
      const kv = MAPPING_LISTS.has(current)
        ? bullet[1]!.match(/^([a-z][a-z0-9-]*):\s+(.*)$/)
        : null;
      items.push(kv ? { [kv[1]!]: kv[2]! } : bullet[1]!);
      lastField = kv ? kv[1]! : null;
      continue;
    }
    const last = items[items.length - 1];
    const kv = MAPPING_LISTS.has(current) ? line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/) : null;
    if (last && typeof last === "object" && kv) {
      last[kv[1]!] = kv[2]!;
      lastField = kv[1]!;
      continue;
    }
    // A wrapped value: a message that ran onto a second line, a criterion that
    // continues. Treated as a continuation of the previous value, not as a failed run;
    // a model that wraps a line has not stopped reporting.
    if (last && typeof last === "object" && lastField) {
      last[lastField] = `${last[lastField]} ${line}`;
      continue;
    }
    if (typeof last === "string") {
      items[items.length - 1] = `${last} ${line}`;
      continue;
    }
    // A bare key whose value starts on the next line: `reason:` followed by an indented
    // sentence, the natural way to write a long reason. It is the scalar's value, not a
    // list item.
    if (last === undefined) {
      scalars[current] = scalars[current] ? `${scalars[current]} ${line}` : line;
      continue;
    }
    throw new Error(`report: cannot place line "${line}"`);
  }
  return { scalars, lists };
}

/**
 * A value with one wrapping pair of quotes taken off, whichever of the three it is.
 *
 * The backtick is in the list because the catalogue prints every rule id inside one, so
 * that is how a reviewer copying an id out of it writes the id down. Read raw, such an id
 * matched no catalogue row, the finding went to `uncertain` as "not in the catalogue", and
 * a `must` disappeared with nothing in the report saying why (`/code-review` on the
 * review-tiers branch).
 *
 * A single character is left alone: a lone `"` is not a pair, and slicing it away would
 * turn a malformed value into an empty one that reads like a quote nobody wrote.
 */
function unquote(s: string): string {
  const t = s.trim();
  const quoted = ['"', "'", "`"].some((q) => t.length > 1 && t.startsWith(q) && t.endsWith(q));
  return quoted ? t.slice(1, -1).trim() : t;
}

function scalar(b: Block, key: string): string {
  return (b.scalars[key] ?? "").trim();
}

/**
 * A whole positive number a report states, by the rule every CLI token goes through.
 *
 * `Number.parseInt` stopped at the first non-digit and had no opinion about sign or zero,
 * so a model-written `issue: 5x` read as 5, and `0` and `-1` passed into a field the
 * archive path and the ledger lookup are keyed on. `issueArg` is the same rule the CLIs
 * apply to the token an operator types; the usage string names the key, because a report
 * carries more than one number.
 */
function intOf(b: Block, key: string): number {
  return issueArg(scalar(b, key), `report: "${key}"`);
}

function yesNo(b: Block, key: string): boolean {
  const v = scalar(b, key).toLowerCase();
  if (v !== "yes" && v !== "no") throw new Error(`report: "${key}" must be yes or no, got "${v}"`);
  return v === "yes";
}

/** The field's name before the rename, accepted for one release. */
const LEGACY_MIGRATION_KEY = "migration";

/**
 * `db-migration-required:`, or the `migration:` a report written before the rename holds.
 *
 * `loadLedger` upgrades a legacy entry's state and stage names so that no entry falls to
 * `ownerStep === "none"`, which promises such a run a resume — and an upgraded entry past
 * implement reaches `publish.ts` → `parseImplementReport`, where `yesNo` threw on the
 * line that is not there. So the promise could not be kept, and the run stopped at the
 * step that was supposed to carry it.
 *
 * Tolerance for the archives on disk, not a second contract: the skills print the new
 * name, `orchestrate-skill.test.ts` pins that they do, and the new name wins wherever
 * both appear. It comes out again once no `runs/` directory predates the rename.
 */
function dbMigrationRequired(b: Block): boolean {
  const key =
    scalar(b, "db-migration-required") === "" && scalar(b, LEGACY_MIGRATION_KEY) !== ""
      ? LEGACY_MIGRATION_KEY
      : "db-migration-required";
  return yesNo(b, key);
}

function oneOf<T extends string>(b: Block, key: string, allowed: readonly T[]): T {
  const v = scalar(b, key) as T;
  if (!allowed.includes(v))
    throw new Error(`report: "${key}" must be one of ${allowed.join(", ")}, got "${v}"`);
  return v;
}

function strings(b: Block, key: string): string[] {
  return (b.lists[key] ?? []).map((i) => (typeof i === "string" ? i : JSON.stringify(i)));
}

export function parsePlanReport(text: string): PlanReport {
  const b = parseBlock(extractBlock("plan", text).lines);
  return {
    issue: intOf(b, "issue"),
    status: oneOf(b, "status", ["planned", "needs-human", "needs-shaping"] as const),
    reason: scalar(b, "reason"),
    dbMigrationRequired: dbMigrationRequired(b),
    planFile: scalar(b, "plan-file"),
  };
}

const CRITERION = /^(met|not met)\s*(?:—|–|-|:)\s*(.*)$/;

/**
 * The `criteria:` list, in the one shape both the implementer and the reviewer print.
 *
 * `lenient` is the stopped reviewer's reading, and only its. A run that was cut off is the
 * likeliest of all to have a half-written criterion — the reviewer stopped mid-line — and
 * the strict throw turned that into "report did not parse", exit 2, for exactly the case
 * `parseStoppedCodeReview` exists to salvage. The line is kept with no verdict rather than
 * as `not met`, which would be a claim the reviewer never made
 */
function criteriaOf(b: Block, opts: { lenient?: boolean } = {}): Criterion[] {
  return strings(b, "criteria").map((line) => {
    const m = line.match(CRITERION);
    if (!m) {
      if (opts.lenient) return { met: null, text: line.trim() };
      throw new Error(`report: criterion line must start with "met" or "not met": "${line}"`);
    }
    return { met: m[1] === "met", text: m[2]!.trim() };
  });
}

export function parseImplementReport(text: string): ImplementReport {
  const b = parseBlock(extractBlock("implement", text).lines);
  const criteria = criteriaOf(b);
  return {
    issue: intOf(b, "issue"),
    status: oneOf(b, "status", ["done", "needs-shaping", "needs-human", "blocked"] as const),
    reason: scalar(b, "reason"),
    dbMigrationRequired: dbMigrationRequired(b),
    commit: scalar(b, "commit"),
    criteria,
    testsAdded: scalar(b, "tests-added"),
    observedNotDone: strings(b, "observed-not-done"),
  };
}

/** A type guard, because a plain comparison does not narrow the catalogue's `string`. */
function isLevel(v: string): v is Level {
  return (LEVELS as readonly string[]).includes(v);
}

/**
 * The line a finding points at, 0 when it points at none.
 *
 * A finding about something the file does not contain (an uncovered criterion, a plan
 * that is really two issues) has no line, and `-`, `n/a` or no key at all reads as 0
 * instead of making the whole report unparseable — which cost a review retry and then
 * reported a real finding as a run that produced nothing.
 *
 * The first run of digits, so a reviewer who wrote `~42`, `L42` or `line 42` is read as
 * meaning 42. `parseInt` returned NaN for all three and the 0 it defaulted to was
 * indistinguishable from the intentional `-`, so the evidence check withdrew a finding
 * with a real file and a verbatim quote over the way its line was written
 * (`/code-review` on the review-tiers branch).
 */
function lineOf(written: string | undefined): number {
  return Number(/^\D*(\d+)/.exec(written ?? "")?.[1] ?? 0);
}

/** A report as the block states it: findings without a level, a tier or a fingerprint. */
interface StatedReport {
  issue: number;
  stated: StatedFinding[];
  uncertain: string[];
  complete: boolean;
}

/**
 * The code review and the plan review share one shape; only the markers differ. The
 * parsed block comes back with the report, because the code review reads four more
 * fields off it and parsing the same text twice would let the two copies disagree.
 *
 * Nothing here consults the catalogue: this is the block's own contract, and
 * `isReportComplete` has to be answerable without one. A `level:` line a reviewer wrote
 * anyway is simply not read.
 */
function parseFindingsReport(
  stage: "code-review" | "plan-review",
  text: string,
): { report: StatedReport; b: Block } {
  const { lines, endLine } = extractBlock(stage, text);
  const b = parseBlock(lines);
  const stated = (b.lists.findings ?? []).map((item, i) => {
    if (typeof item !== "object") throw new Error(`report: finding ${i + 1} is not a mapping`);
    // Unquoted like the evidence: the id is looked up in the catalogue by exact string,
    // and the catalogue is a table that prints every id in backticks.
    const rule = unquote(item.rule ?? "");
    // Read whole or not at all, deliberately not through `parseInt`, which reads "8.5" as
    // 8: the confidence is half of the class, so a value outside the rubric means the
    // block was misread and the class would be a silent guess. `policy` refuses the same
    // values one step later; refusing them here names the finding they came from.
    const written = (item.confidence ?? "").trim();
    const confidence = /^\d+$/.test(written) ? Number(written) : Number.NaN;
    if (!isScore(confidence)) {
      throw new Error(
        `report: finding ${i + 1} (${rule || "no rule"}) needs "confidence: <1-10>", ` +
          `a whole number, but the block says "${item.confidence ?? ""}"`,
      );
    }
    return {
      rule,
      confidence,
      // Unquoted for the same reason the rule id is: a reviewer that writes the path in
      // backticks — the markdown habit `unquote` was extended for — otherwise produced a
      // `file` with the backticks in it, `resolveQuotedFile` joined the literal name,
      // the read threw, and the finding was withdrawn as "not found within 5 lines"
      file: unquote(item.file ?? ""),
      line: lineOf(item.line),
      evidence: unquote(item.evidence ?? ""),
      message: item.message ?? "",
    };
  });
  return {
    report: {
      issue: intOf(b, "issue"),
      stated,
      uncertain: strings(b, "uncertain"),
      complete: COMPLETE_STATUS.test(endLine),
    },
    b,
  };
}

/** The one status line that says a review ran to the end; the block's end marker carries it. */
const COMPLETE_STATUS = /^(CODE-REVIEW|PLAN-REVIEW)-STATUS:\s*complete$/;

/** Either a classified finding, or the line that replaces it once its claim is withdrawn. */
type Classified = { kind: "finding"; finding: ReviewFinding } | { kind: "uncertain"; note: string };

/**
 * One finding, read against the catalogue and the threshold. The only place a class is
 * computed, shared by both reviews.
 *
 * A rule the catalogue does not state does not fail the report: the finding moves to
 * `uncertain` with a note, so a typo in a rule id costs nobody a thirty-minute review
 * retry. It cannot stay a finding either, because there is no level to classify it with.
 * A rule whose row carries a word outside the vocabulary *is* refused, loudly: that is a
 * malformed catalogue, and every finding citing the rule would be classified blind.
 *
 * @param at the finding's position in the block, for a message a human can act on
 */
function classify(
  stated: StatedFinding,
  rows: Map<string, InvariantRule>,
  threshold: number,
  at: number,
  worktreesRoot?: string,
): Classified {
  const where = stated.file ? ` (${stated.file}:${stated.line})` : "";
  // By id, from the map the caller built once: this was a `find` per finding over the
  // whole catalogue, which is fifty-odd comparisons times the number of findings for a
  // lookup the id is a key of. One row per id either way — `loadCatalogue` refuses a
  // duplicate, so a map cannot lose one.
  const row = rows.get(stated.rule);
  if (!row) {
    const cited = stated.rule || "(no rule id)";
    return { kind: "uncertain", note: `${cited} — not in the catalogue${where}` };
  }
  if (!isLevel(row.level)) {
    throw new Error(
      `report: finding ${at} cites ${row.id}, whose catalogue row says level ` +
        `"${row.level}"; expected ${LEVELS.join(", ")}. The row is malformed, and every ` +
        `finding citing that rule would be classified blind.`,
    );
  }
  const level = row.level;
  const tier = policy(level, stated.confidence, threshold);
  if (tier === "uncertain") {
    return {
      kind: "uncertain",
      note: `${stated.rule} — confidence ${stated.confidence} is below the threshold of ${threshold}${where}`,
    };
  }
  return {
    kind: "finding",
    finding: {
      ...stated,
      level,
      tier,
      // The row's own kind. `parseInvariants` refuses any word outside the two, so there
      // is nothing to validate here — unlike the level, which is whatever the row says.
      evidenceKind: row.evidence,
      fingerprint: fingerprintOf(stated.rule, stated.evidence, stated.file, worktreesRoot),
    },
  };
}

/**
 * The shared report with every finding classified. The withdrawn ones are appended to the
 * reviewer's own `uncertain:` lines, in that order: what a human wrote comes before what
 * the policy computed.
 */
function classifiedReport(
  stage: "code-review" | "plan-review",
  text: string,
  opts: ClassifyOptions,
): { report: ReviewReport; b: Block } {
  const { report, b } = parseFindingsReport(stage, text);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const rows = new Map(opts.catalogue.map((r) => [r.id, r]));
  const findings: ReviewFinding[] = [];
  const withdrawn: string[] = [];
  report.stated.forEach((stated, i) => {
    const c = classify(stated, rows, threshold, i + 1, opts.worktreesRoot);
    if (c.kind === "finding") findings.push(c.finding);
    else withdrawn.push(c.note);
  });
  return {
    report: {
      issue: report.issue,
      findings,
      uncertain: [...report.uncertain, ...withdrawn],
      complete: report.complete,
    },
    b,
  };
}

/**
 * Every verdict, spelled out once at runtime because the parser needs the strings. The
 * record type keeps it honest: a verdict `red-step.ts` adds and this list lacks fails
 * the type-check here, instead of every report carrying it being refused at runtime.
 */
const VERDICTS: Record<RedStepVerdict, true> = {
  proven: true,
  "not-proven": true,
  "no-test-files": true,
  "could-not-run": true,
};
const RED_STEP = Object.keys(VERDICTS) as RedStepVerdict[];

const CRITERION_NOT_MET = "spec/criterion-not-met";

/**
 * Why `fan-out:` and `scored-by:` are refused when absent, in the message a reviewer
 * whose report was rejected reads.
 */
const HOW_IT_RAN =
  "a report that does not say how it ran must not look like one that ran fully. " +
  "The content is free text; only absence is refused. Write the value inline after the " +
  "key, comma-separated — not as an indented list, which leaves the key itself empty " +
  "however many items follow it.";

/** A scalar the contract requires to carry something. */
function requiredScalar(b: Block, key: string, why: string): string {
  const value = scalar(b, key);
  if (!value) throw new Error(`report: "${key}" is required and must not be empty: ${why}`);
  return value;
}

export function parseCodeReviewReport(text: string, opts: ClassifyOptions): CodeReviewReport {
  const { report, b } = classifiedReport("code-review", text, opts);
  const redStep = oneOf(b, "red-step", RED_STEP);
  const reason = scalar(b, "reason");
  // The one verdict the rest of the report cannot explain. `not-proven` comes with its
  // finding, `no-test-files` with the changed paths; "I could not run it" says nothing
  // on its own, and it is the verdict that costs a review retry rather than a fix round.
  if (redStep === "could-not-run" && !reason) {
    throw new Error('report: "red-step: could-not-run" needs a reason saying what failed');
  }
  const fanOut = requiredScalar(b, "fan-out", HOW_IT_RAN);
  const scoredBy = requiredScalar(b, "scored-by", HOW_IT_RAN);
  const { must } = findingsByTier(report.findings);
  // `not-proven` means a test passes on the base or the head is not green, and either is a
  // blocking finding against the tests. A report that copies the verdict and blocks on
  // nothing is the cursory review these fields exist to expose. A `must` and not merely an
  // `error` rule: a claim the scorer withdrew below the threshold blocks nothing.
  if (redStep === "not-proven" && !must.some((f) => f.rule.startsWith("tests/"))) {
    // The refusal stays: a report that copies the verdict and blocks on nothing is the
    // cursory review these fields exist to expose. But the commonest way to lose that
    // must is a typo in its rule id — `classify` sends an unknown id to `uncertain` on
    // purpose, so the finding is gone from `findings` and this check sees no must in the
    // family. Where such an id is sitting in `uncertain`, the message names it, because
    // "needs a must in the tests/ family" sent a reader looking for a missing finding
    // that was written and misspelt (`/code-review` on the review-tiers branch).
    const typos = report.uncertain.filter(
      (line) => /^tests\//.test(line.trim()) && line.includes("not in the catalogue"),
    );
    throw new Error(
      'report: "red-step: not-proven" needs a must finding in the tests/ family, such as tests/passes-without-change — an error rule scored above the threshold' +
        (typos.length ? `. Check the rule id for a typo: ${typos.join("; ")}` : ""),
    );
  }
  const criteriaNone = scalar(b, "criteria") === "none";
  const criteria = criteriaNone ? [] : criteriaOf(b);
  if (!criteriaNone && !criteria.length) {
    throw new Error(
      'report: "criteria" must carry one line per acceptance criterion, each naming where the evidence was found, or read "criteria: none" when the target names no issue',
    );
  }
  // Step 1 of the skill says an unsatisfied criterion *is* a finding, and a blocking one.
  // Counted, not merely present: one finding cannot stand for several criteria, and
  // anything short of a must would let the orchestrator publish a pull request whose body
  // ticks the very criterion the review called unmet.
  const unmet = criteria.filter((c) => !c.met).length;
  const carried = must.filter((f) => f.rule === CRITERION_NOT_MET).length;
  if (carried < unmet) {
    // What was found, and the number that would have made it a must. `policy` classes an
    // `error` rule at exactly the threshold as a `should`, and the rubric's own rung 7 is
    // the number a cautious scorer writes — so the commonest way to arrive here is a
    // finding that was written and scored one point too low, while the message named only
    // the rule that was missing and sent the reader looking for it.
    const short = report.findings.filter((f) => f.rule === CRITERION_NOT_MET && f.tier !== "must");
    const needs = (opts.threshold ?? DEFAULT_THRESHOLD) + 1;
    const found = short.length
      ? `. The finding${short.length === 1 ? "" : "s"} carrying it ${short.length === 1 ? "is" : "are"} ` +
        `${short.map((f) => `a ${f.tier} at confidence ${f.confidence}`).join(", ")}; ` +
        `a must needs ${needs} or more — re-score it, or write "met" with the evidence and drop the finding`
      : "";
    throw new Error(
      `report: ${unmet} criteria are marked "not met" but ${carried} finding(s) carry the rule ${CRITERION_NOT_MET} as a must${found}`,
    );
  }
  return { ...report, redStep, reason, fanOut, scoredBy, criteria, criteriaNone };
}

/**
 * A code review that did not finish, read leniently: the shared findings shape, plus
 * whatever of the four account fields the reviewer reached.
 *
 * Every check `parseCodeReviewReport` applies is about a report that claims to be whole —
 * a verdict copied without the finding it needs, a criterion marked unmet with nothing
 * accounting for it. A report that says `CODE-REVIEW-STATUS: stopped` claims none of
 * that, so refusing it over an empty `fan-out:` throws away the findings it did write.
 * The findings themselves are read exactly as always, against the same catalogue and the
 * same threshold: nothing here is more permissive about what a finding is.
 *
 * Only for a block whose status line is not `complete` — `isReportComplete` is the test,
 * and it is the caller's to make. A complete report goes through the strict parser, whose
 * refusals are what keep a cursory review from reading like a thorough one.
 */
export function parseStoppedCodeReview(text: string, opts: ClassifyOptions): StoppedCodeReview {
  const { report, b } = classifiedReport("code-review", text, opts);
  const written = scalar(b, "red-step");
  return {
    ...report,
    // The verdict when the reviewer got that far, null when it did not. A word outside
    // the four is read as none as well: this parser's job is to salvage, and a verdict
    // nobody can read is not one the banner should quote.
    redStep: (RED_STEP as readonly string[]).includes(written) ? (written as RedStepVerdict) : null,
    reason: scalar(b, "reason"),
    fanOut: scalar(b, "fan-out"),
    scoredBy: scalar(b, "scored-by"),
    criteria: scalar(b, "criteria") === "none" ? [] : criteriaOf(b, { lenient: true }),
    criteriaNone: scalar(b, "criteria") === "none",
  };
}

export function parsePlanReviewReport(text: string, opts: ClassifyOptions): PlanReviewReport {
  const { report, b } = classifiedReport("plan-review", text, opts);
  return { ...report, scoredBy: requiredScalar(b, "scored-by", HOW_IT_RAN) };
}

/**
 * Whether a review block reached its status line, decided on the shared shape and before
 * the code review's own checks. An interrupted reviewer usually never wrote its verdict,
 * and asking `parseCodeReviewReport` first blames the missing field for what is really a
 * stopped run. The CLI and publish.ts both ask this first, so they cannot disagree.
 *
 * The block and its end line, and nothing else. It used to run the whole shared parser,
 * which validates every finding's confidence — so a report carrying `confidence: 9/10`
 * threw "needs confidence" out of the completeness probe, which is the ordering this
 * probe exists to prevent. Every caller parses the same text again straight afterwards,
 * where that refusal belongs and where it names the finding.
 *
 * @throws only when there is no block, or none terminated by the status line: that is a
 *   text nobody can read as a report, which is the caller's "does not parse" path rather
 *   than an unfinished run.
 */
export function isReportComplete(stage: "code-review" | "plan-review", text: string): boolean {
  return COMPLETE_STATUS.test(extractBlock(stage, text).endLine);
}

/**
 * What a code review did, as the lines a human reads: the red step's verdict, with its
 * reason when it could not run, and where the evidence for each criterion was found.
 * The pull request body and the `--pr` comment both lead with it, because a report that
 * only lists findings reads the same whether the review was thorough or cursory.
 */
export function reviewAccountAsMarkdown(review: StoppedCodeReview): string[] {
  const verdict =
    review.redStep === null
      ? "**The review did not reach the red step.** Nothing here says whether the new tests fail without this change."
      : review.redStep === "could-not-run"
        ? `**The red step could not run:** ${review.reason}. Nothing shows that the new tests fail without this change; check that before merging.`
        : `Red step: \`${review.redStep}\``;
  // Free text, so it is quoted rather than parsed: the two fields prove that the review
  // said how it ran, never that what it said is true. Empty only in a stopped report,
  // where "not stated" is the honest rendering of a field nobody wrote.
  const howItRan = `How it ran: fan-out \`${review.fanOut || "not stated"}\`; scored by \`${review.scoredBy || "not stated"}\``;
  const criteria = review.criteriaNone
    ? ["No acceptance criteria were checked: the pull request names no issue.", ""]
    : review.criteria.length === 0
      ? ["No acceptance criterion was checked before the review stopped.", ""]
      : [
          "Evidence per criterion:",
          "",
          // Numbered, because a finding names the criterion it is about by number. Three
          // words, not two: a line the stopped reviewer never finished says neither `met`
          // nor `not met`, and rendering it as "not met" would put a verdict in the
          // reviewer's mouth.
          ...review.criteria.map(
            (c, i) =>
              `${i + 1}. ${c.met === null ? "not stated" : c.met ? "met" : "not met"} — ${c.text}`,
          ),
          "",
        ];
  return [verdict, howItRan, "", ...criteria];
}

/**
 * Model-written text with every GitHub @mention taken out of it, except the ones of the
 * humans the project configures.
 *
 * Both renderers below put a review's own words — a finding's message, the line it quoted,
 * an `uncertain:` sentence — into a pull request body or a comment verbatim. A mention
 * in that text would notify someone, or start a workflow that triggers on a mention, from
 * inside a review. A zero-width space (U+200B) after the `@` reads the same and matches
 * nothing.
 *
 * A mention is an `@` not preceded by a word character, so an e-mail address such as
 * `a@b.com` is left alone. Handles compare case-insensitively, as GitHub's do, and the
 * handle keeps whatever case it was written in.
 *
 * The channel is older than the review tiers — the review comment posted `message` and
 * `evidence` at the base — so this is a cheap close of a pre-existing hole.
 *
 * @param allow the handles (without the `@`) whose mention is kept
 */
export function defuseMentions(text: string, allow: string[] = []): string {
  const keep = new Set(allow.map((h) => h.replace(/^@/, "").toLowerCase()));
  return text.replace(/(?<![\w])@([A-Za-z0-9][A-Za-z0-9-]*)/g, (all, handle: string) =>
    keep.has(handle.toLowerCase()) ? all : `@\u200b${handle}`,
  );
}

/**
 * The findings by class, in the order a reader wants them. `uncertain` has no entry
 * because it is not a tier: such a finding never reaches a report's `findings`.
 *
 * Generic in the finding, so a caller that added fields of its own gets them back:
 * `review-decision.ts` marks each finding with whether an earlier round already reported
 * it, and grouping through a `ReviewFinding[]` signature would have cost it that flag or
 * a cast.
 */
export function findingsByTier<T extends ReviewFinding>(findings: T[]): Record<Tier, T[]> {
  // Declared in tier order, so `Object.keys` and `Object.entries` are in it too.
  const byTier: Record<Tier, T[]> = { must: [], should: [], later: [] };
  for (const f of findings) byTier[f.tier].push(f);
  return byTier;
}

/**
 * One section per non-empty tier: a heading with the count, the caller's one-line intro,
 * and the findings numbered within the section.
 *
 * Lines, not a string. `prBody`'s blank-line filter works on array elements and never
 * sees a `"\n\n"` inside one, so a renderer that joined its own output would collapse the
 * sections it separated. The headings and the intros are the caller's, because only the
 * caller knows whether it is writing a pull request body after two fix rounds or a
 * comment on a commit.
 *
 * Generic in the finding, like `findingsByTier` and for the same reason: `publish.ts`
 * renders findings the decision has marked as repeats, and a `ReviewFinding[]` signature
 * would cost it that flag or a cast.
 *
 * @param render one finding as one **element**, which may itself span several lines — the
 *   review comment's does — as long as it contains no blank line. The contract is the
 *   blank-line filter's, not a one-line rule: a `"\n\n"` inside an element is what that
 *   filter cannot see. The number is prefixed here.
 */
export function tierSections<T extends ReviewFinding>(
  findings: T[],
  render: (f: T) => string,
  // The intros are partial: a caller with nothing to say about a tier leaves it out. The
  // plan review's map carried `must: ""` for no other reason than this record demanding
  // all three, on a tier its section cannot reach.
  text: { headings: Record<Tier, string>; intro: Partial<Record<Tier, string>> },
): string[] {
  const byTier = findingsByTier(findings);
  const out: string[] = [];
  for (const tier of TIERS) {
    const group = byTier[tier];
    if (!group.length) continue;
    out.push(`### ${text.headings[tier]} (${group.length})`, "", text.intro[tier] ?? "", "");
    group.forEach((f, i) => out.push(`${i + 1}. ${render(f)}`));
    out.push("");
  }
  return out;
}

/** Why the uncertain items are not findings, in the one sentence both renderers print. */
const UNCERTAIN_INTRO =
  "Not reported as findings: no quotable line, or scored below the threshold.";

/**
 * The fourth class: the observations whose claim to be real was withdrawn, under one
 * heading with its count, or nothing at all when there are none.
 *
 * Lines rather than findings, because that is what the class is: a reviewer's own
 * `uncertain:` line, a rule the catalogue does not state, a confidence below the
 * threshold, and — from `publish.ts` — a quote the evidence check did not find. Bullets
 * and not numbers, because a finding is numbered so that something can refer to it, and
 * nothing refers to these.
 *
 * Shared by the pull request body and the review comment: until this existed, neither
 * showed them at all, so a finding the scorer withdrew reached nobody (design, "Why").
 */
export function uncertainSection(lines: string[]): string[] {
  if (!lines.length) return [];
  return [
    `### Uncertain (${lines.length})`,
    "",
    UNCERTAIN_INTRO,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
  ];
}

/**
 * Where a finding is, `file:line` — or nothing at all when it names no file.
 *
 * The parser allows a finding with no file and no line, and `spec/criterion-not-met`, the
 * commonest blocking rule there is, is exactly that finding: it is about what the diff
 * does not contain. Every renderer printed it as "at `:0`", a position that looks like a
 * file the reader could open. `can-merge.ts` had the one version that asked first; this
 * is that version, shared by all four callers.
 */
export function locationOf(f: Pick<ReviewFinding, "file" | "line">): string {
  return f.file ? `${f.file}:${f.line}` : "";
}

/**
 * What every renderer says first about a finding: its rule, where it is, and how sure the
 * scorer was.
 *
 * `publish.ts`'s body and `post-review.ts`'s comment each built this fragment
 * character by character, so a change to the shape had to be made twice and a finding
 * read differently depending on which of the two a human opened.
 * `findingsAsMarkdown` below deliberately keeps its own head: it leads with the **tier**,
 * because the implementer it writes for cannot tell what a finding costs from the rule id.
 */
export function findingHead(
  f: Pick<ReviewFinding, "rule" | "file" | "line" | "confidence">,
): string {
  const where = locationOf(f);
  return `\`${f.rule}\`${where ? ` at \`${where}\`` : ""} (confidence ${f.confidence})`;
}

/**
 * The findings as the implementer sees them in a fix round: tier, rule, file, line,
 * evidence, message.
 *
 * The tier is what says what the finding costs — a must blocks, a should costs the round,
 * a later is fixed only while it is cheap — and the implementer cannot work that out from
 * the rule id.
 */
export function findingsAsMarkdown(findings: ReviewFinding[]): string {
  return findings
    .map((f, i) => {
      const where = locationOf(f);
      return (
        `${i + 1}. **${f.rule}** (${f.tier}, confidence ${f.confidence})${where ? ` at \`${where}\`` : ""}\n` +
        `   evidence: \`${f.evidence}\`\n   ${f.message}`
      );
    })
    .join("\n");
}

/**
 * The catalogue and the threshold a review report is read against, for one stage.
 *
 * The one loader for every caller: a copy that reads the wrong stage's `scoreThreshold`
 * classifies every finding against another number without failing.
 *
 * Both default to the project at `over.projectRoot` (the working directory when absent):
 * `catalogueFor` and `loadProjectConfig`. A caller that already holds either passes it,
 * which is also how a test hands in a stub.
 */
export function classifyOptions(
  stage: "code-review" | "plan-review",
  over: { cfg?: ProjectConfig; catalogue?: InvariantRule[]; projectRoot?: string } = {},
): ClassifyOptions {
  const root = over.projectRoot ?? process.cwd();
  const cfg = over.cfg ?? loadProjectConfig(root);
  return {
    catalogue: over.catalogue ?? catalogueFor(root),
    threshold:
      stage === "code-review" ? cfg.codeReview?.scoreThreshold : cfg.planReview?.scoreThreshold,
    worktreesRoot: cfg.worktrees?.root,
  };
}
