/**
 * The measuring stick for the code review: one report against a list of findings an
 * independent reader made on the same diff.
 *
 * This module is the library half: `matchFindings` and `loadExpected`. The command that
 * reads the two files, prints the table or the JSON and returns an exit code is the
 * `autoclaude bench` verb (exit 0 measured whatever the numbers say; 1 a file that cannot
 * be read, a report the parser refuses, a review that never reached its verdict, or an
 * expected list that is not one; 64 the command line was wrong).
 *
 * A review once reported no findings on a diff an independent review found eleven things
 * in, and nothing in the pipeline could say so. An expected list holds such an independent
 * review as a list of expectations; this module says how many of them a report hits. The
 * expected list is **not** exhaustive, which is why what no expectation claims is
 * `unmatched` rather than a false positive: the reviewer may well have found something the
 * independent reader missed.
 *
 * Three numbers come out of it. `recall` is the share of expectations a finding claimed —
 * recall 1.0 on must and should is the exit criterion of the review work. `seenRate` adds
 * the expectations a report only wondered about, because "saw it and withdrew the claim"
 * and "never looked" are different failures and the fix for them is different. And the
 * per-tier count says which class the misses are in, since a missed `later` costs nothing.
 *
 * The report is read through `parseCodeReviewReport` with the catalogue of the project,
 * exactly as the engine reads it: the tier of a finding is `policy`'s and never a value
 * this module computes.
 */

import { readFileSync } from "node:fs";
import { escapeRegExp, familyOf, normaliseQuotedPath } from "./rules.js";
import { TIERS, type ReviewFinding, type ReviewReport, type Tier } from "./reports.js";

/**
 * One finding an independent reader made, as the thing a report has to find again.
 *
 * Every field except `id` and `file` is optional, and **an absent field is not checked**:
 * an expectation without `lines` is satisfied by a finding anywhere in the file, one
 * without `family` by a finding citing any rule. That is deliberate — the expectation
 * should name what identifies the finding and nothing more, because every named field is
 * one more way for a review that found the thing to be scored as having missed it.
 */
export interface Expected {
  /** Short and stable; it is the row label in the table and the handle in a discussion. */
  id: string;
  /** Repository-relative. Separators are normalised on both sides before comparing. */
  file: string;
  /** Inclusive line window the finding is quotable in, wide enough for every line a reader might quote. */
  lines?: [number, number];
  /** The part of a rule id before the `/`, such as `perf` or `tests`. */
  family?: string;
  /**
   * The **least** the finding is worth: a finding classed more severely still matches.
   *
   * Not an equality, because these tiers are what an independent reader thought the
   * finding was worth while the matcher compares them with what `policy` computes from the
   * rule's level and the scorer's confidence. Every `bug/*` rule is an `error`, so one
   * quoted mechanism is a `should` at confidence 7 and a `must` at 8 — and a review that
   * classes a should as a must has not missed it. How precisely a review scores what it
   * found is a later phase's measurement; this one asks whether it found it at all.
   */
  tier?: Tier;
  /** One line a human reads when the expectation is missed. */
  note?: string;
}

/** An expectation a finding claimed, with the finding that claimed it. */
export interface Hit {
  expected: Expected;
  finding: ReviewFinding;
}

/**
 * An expectation no finding claimed, but an `uncertain` line named: the review looked at
 * it and withdrew the claim, which is not a hit and is not nothing either.
 */
export interface Seen {
  expected: Expected;
  uncertain: string;
}

export interface BenchResult {
  hits: Hit[];
  seen: Seen[];
  misses: Expected[];
  /** Findings no expectation claimed. Not false positives: the expected list is partial. */
  unmatched: ReviewFinding[];
  /** `hits / expected`. */
  recall: number;
  /** `(hits + seen) / expected`. */
  seenRate: number;
}

/**
 * Whether a finding's tier is at least what an expectation asks for.
 *
 * Read off `TIERS`, which is ordered most severe first, so that the order lives in one
 * place: a second list here would let the two disagree the day a class is added.
 */
function atLeastAsSevere(tier: Tier, atLeast: Tier): boolean {
  return TIERS.indexOf(tier) <= TIERS.indexOf(atLeast);
}

function basenameOf(file: string): string {
  const parts = normaliseQuotedPath(file).split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Whether two paths name the same file, compared as repository-relative paths.
 *
 * `normaliseQuotedPath` is `rules.ts`'s, the one the evidence check resolves a quote with
 * and the one the fingerprint is built from: this was the third normalisation of a path
 * in the engine, and the weakest of them was the one deciding a finding's identity across
 * rounds. It already takes a worktree's own
 * directory off, so the two sides usually compare equal.
 *
 * The suffix rule is kept for what it does not cover: an absolute path outside any
 * worktree, and an expectation written from a deeper root. Scoring such a pair as a miss
 * would send a maintainer looking for a gap in the review that is really a gap here.
 */
function sameFile(finding: string, expected: string): boolean {
  const a = normaliseQuotedPath(finding);
  const b = normaliseQuotedPath(expected);
  return a === b || a.endsWith(`/${b}`);
}

/**
 * Whether a finding is the one an expectation is waiting for: the same file, a line inside
 * the window when the expectation names one, the same family when it names one, and a tier
 * at least as severe as the one it names.
 *
 * A finding with no line reads as line 0 from the parser — the rules whose findings are
 * about what a file does *not* contain quote no line — and never falls inside a window. An
 * expectation that names a window is therefore not satisfied by one; an expectation that
 * names none is.
 */
function isHit(finding: ReviewFinding, expected: Expected): boolean {
  if (!sameFile(finding.file, expected.file)) return false;
  const { lines, family, tier } = expected;
  if (lines && (finding.line < lines[0] || finding.line > lines[1])) return false;
  if (family && familyOf(finding.rule) !== family) return false;
  if (tier && !atLeastAsSevere(finding.tier, tier)) return false;
  return true;
}

/** The two signals an `uncertain` line can carry, strongest first. */
const SIGNALS = ["file", "family"] as const;
type Signal = (typeof SIGNALS)[number];

/**
 * Whether an `uncertain` line is about an expectation, by one signal at a time: the name of
 * its file, or its rule family.
 *
 * One signal at a time because the caller assigns in two passes. Both in one pass let the
 * first expectation of a family absorb a line that names a *later* expectation's file, and
 * the `seen` was then attributed to the wrong finding — the rule is unchanged, the
 * attribution is not.
 *
 * The family has to be matched as a family and not as a substring — `\bperf(/|\b)` hits
 * `perf/unbounded-growth` and `the perf cost` and deliberately not `performance`, which
 * appears in every report that lists its angles.
 */
function mentions(line: string, expected: Expected, by: Signal): boolean {
  if (by === "file") return mentionsFile(line, expected.file);
  if (!expected.family) return false;
  return new RegExp(String.raw`\b${escapeRegExp(expected.family)}(/|\b)`, "i").test(line);
}

/**
 * Every mention of a file's basename in a line, with whatever path the line wrote in
 * front of it.
 *
 * A basename on a boundary: the start of the line, whitespace, a quote or a bracket, or a
 * path separator — never mid-word. The optional group before it is the path the line
 * itself named, and the lookahead lets a line number, a comma or a closing quote follow.
 */
const mentionAt = (base: string) =>
  new RegExp(
    String.raw`(?:^|[\s\`'"(\[])((?:[^\s\`'"()\[\]]*[/\\])?)${escapeRegExp(base)}(?=$|[\s:,;)\]\`'"])`,
    "gi",
  );

/**
 * Whether an `uncertain` line is about this file.
 *
 * Two rules, and the reason for both is that this decides the `seen` bucket — the number
 * this script exists to make trustworthy. `includes` on the basename made `x.ts` a
 * mention of `index.ts` and any basename shared by two directories a mention of both; and
 * because a line is claimed once, a false hit also stole the line from the expectation it
 * really belonged to.
 *
 * So: the basename counts only on a path or word boundary, never as a substring. And
 * where the line named a directory with it, the path it named has to be this file — as a
 * suffix, because the review runs inside a worktree and an angle that quotes
 * `…/worktrees/x/src/lib/a.ts` has named the file the expectation calls `src/lib/a.ts`,
 * the same suffix rule `sameFile` applies to a finding. A bare basename with no directory
 * in front of it stays the weaker signal it always was.
 */
function mentionsFile(line: string, file: string): boolean {
  const path = normaliseQuotedPath(file);
  const base = basenameOf(path);
  if (base === "") return false;
  for (const found of line.matchAll(mentionAt(base))) {
    const named = `${(found[1] ?? "").replace(/\\/g, "/")}${base}`.toLowerCase();
    const wanted = path.toLowerCase();
    if (named === base.toLowerCase() || named === wanted || named.endsWith(`/${wanted}`)) {
      return true;
    }
  }
  return false;
}

/**
 * The report against the expected list.
 *
 * A finding is claimed once and the expectations are walked in list order, so a fixture
 * puts the expectation that matters first where two windows overlap: where
 * a blocking finding shares its lines with two `later` items, a `later`
 * expectation claiming the must's finding would report the must as missed. An `uncertain`
 * line is claimed once for the same reason — one vague sentence must not mark five
 * expectations as seen.
 */
export function matchFindings(report: ReviewReport, expected: Expected[]): BenchResult {
  const claimedFindings = new Set<number>();
  const claimedUncertain = new Set<number>();
  const hit = new Array<ReviewFinding | undefined>(expected.length);
  const wondered = new Array<string | undefined>(expected.length);
  expected.forEach((one, at) => {
    const found = report.findings.findIndex(
      (finding, i) => !claimedFindings.has(i) && isHit(finding, one),
    );
    if (found < 0) return;
    claimedFindings.add(found);
    hit[at] = report.findings[found];
  });
  // The uncertain lines afterwards, by the stronger signal first: a line naming a file
  // belongs to that file's expectation, even when an earlier expectation shares its family.
  for (const by of SIGNALS) {
    expected.forEach((one, at) => {
      if (hit[at] || wondered[at]) return;
      const found = report.uncertain.findIndex(
        (line, i) => !claimedUncertain.has(i) && mentions(line, one, by),
      );
      if (found < 0) return;
      claimedUncertain.add(found);
      wondered[at] = report.uncertain[found];
    });
  }
  // Rebuilt in the expected list's own order, so the three lists read in the order the
  // fixture states rather than in the order the passes assigned them.
  const hits: Hit[] = [];
  const seen: Seen[] = [];
  const misses: Expected[] = [];
  expected.forEach((one, at) => {
    const finding = hit[at];
    const uncertain = wondered[at];
    if (finding) hits.push({ expected: one, finding });
    else if (uncertain !== undefined) seen.push({ expected: one, uncertain });
    else misses.push(one);
  });
  const total = expected.length;
  return {
    hits,
    seen,
    misses,
    unmatched: report.findings.filter((_, i) => !claimedFindings.has(i)),
    // 0 and not NaN for an empty list. `loadExpected` refuses one; a caller that built
    // its own list still gets a number it can print.
    recall: total ? hits.length / total : 0,
    seenRate: total ? (hits.length + seen.length) / total : 0,
  };
}

const KEYS = ["id", "file", "lines", "family", "tier", "note"] as const;

/**
 * One entry of the expected list, read strictly.
 *
 * Every shape error is refused rather than ignored, including a key this contract does not
 * have: `line` written for `lines` would leave the expectation matching the whole file and
 * the benchmark would report a hit that proves nothing.
 */
function expectedAt(raw: unknown, at: number, file: string): Expected {
  const where = `${file} entry ${at + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`bench: ${where} is not an object`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new Error(`bench: ${where} has the unknown key "${key}"; expected ${KEYS.join(", ")}`);
    }
  }
  const text = (key: string): string | undefined => {
    const value = entry[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`bench: ${where} has "${key}" that is not a non-empty string`);
    }
    return value;
  };
  const needed = (key: string): string => {
    const value = text(key);
    if (value === undefined) throw new Error(`bench: ${where} needs "${key}"`);
    return value;
  };
  const parsed: Expected = { id: needed("id"), file: needed("file") };
  if (entry.lines !== undefined) {
    const lines = entry.lines;
    if (
      !Array.isArray(lines) ||
      lines.length !== 2 ||
      !lines.every((n) => Number.isInteger(n) && (n as number) > 0) ||
      (lines[0] as number) > (lines[1] as number)
    ) {
      throw new Error(`bench: ${where} needs "lines": [from, to], whole numbers with from <= to`);
    }
    parsed.lines = [lines[0] as number, lines[1] as number];
  }
  const family = text("family");
  if (family !== undefined) {
    if (!/^[a-z][a-z0-9-]*$/.test(family)) {
      throw new Error(`bench: ${where} has "family": "${family}", which is not a rule family`);
    }
    parsed.family = family;
  }
  if (entry.tier !== undefined) {
    const tier = entry.tier as Tier;
    if (!(TIERS as readonly string[]).includes(tier)) {
      throw new Error(
        `bench: ${where} has "tier": "${String(entry.tier)}", not one of ${TIERS.join(", ")}`,
      );
    }
    parsed.tier = tier;
  }
  const note = text("note");
  if (note !== undefined) parsed.note = note;
  return parsed;
}

/**
 * The expected list, refusing anything that would measure less than it appears to: an
 * empty list scores recall 1.0 on nothing at all, and a repeated id makes two rows of the
 * table indistinguishable.
 */
export function loadExpected(file: string): Expected[] {
  // The byte-order mark taken off first: PowerShell writes UTF-8 with one by default on
  // this project's own machine, so a hand-edited fixture arrives with it and `JSON.parse`
  // then fails with "Unexpected token '﻿'" — a message that names neither the file
  // nor the cause.
  const raw: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`bench: ${file} must hold a non-empty list of expected findings`);
  }
  const expected = raw.map((entry, at) => expectedAt(entry, at, file));
  const seen = new Set<string>();
  for (const one of expected) {
    if (seen.has(one.id)) throw new Error(`bench: ${file} states the id "${one.id}" twice`);
    seen.add(one.id);
  }
  return expected;
}
