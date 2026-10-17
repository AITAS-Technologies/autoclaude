/**
 * The rule catalogue, and the policy that turns a level and a confidence into a class.
 *
 * A reviewer reports a rule id and a confidence, never a class. The level belongs to the
 * rule and comes from the catalogue; the class follows from `policy(level, confidence)`.
 * That split is what keeps the vocabulary from drifting: a model that could write its own
 * level could escalate any finding to blocking.
 *
 * The catalogue has two halves in one grammar. `catalogue/rules.md` is the engine's and
 * travels with this code; `.autoclaude/invariants.md` is the project's and is written by
 * each project. `loadCatalogue` reads both through `parseInvariants` and refuses a
 * duplicate id, because a rule stated twice has two levels and the class then depends on
 * which row was read last.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInvariants, type InvariantRule } from "./invariants.js";

/**
 * The level vocabulary, SARIF's, so the later conversion needs no translation table.
 * `error` blocks, `warning` costs a fix round without blocking, and `note` marks the
 * rules whose findings are recorded and deliberately not fixed now.
 */
export const LEVELS = ["error", "warning", "note"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * What a finding is worth. The first three are the tiers a report groups by — the
 * pipeline design's `blocking`, `fixNow` and `advisory`. `uncertain` is not a tier but
 * the absence of one: the observation is kept, the claim that it is real is withdrawn.
 */
export type FindingClass = "must" | "should" | "later" | "uncertain";

/**
 * The engine's half of the catalogue. `src/engine/review/*.ts` and
 * `dist/engine/review/*.js` sit at the same depth below the package root, so the one
 * relative URL resolves from both.
 */
const ENGINE_RULES = fileURLToPath(new URL("../../../catalogue/rules.md", import.meta.url));

/** The project's half, relative to the project root. */
const PROJECT_RULES = join(".autoclaude", "invariants.md");

/**
 * The engine's half is required. A missing one is refused rather than read as "no rules":
 * every rule of the absent half would become an unknown id, so every finding citing one
 * would be withdrawn to `uncertain` and the review would come back looking like it found
 * nothing.
 */
function readEngineHalf(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `catalogue: cannot read ${path} (${(err as Error).message}). The engine's rules ship ` +
        `with the code and are required.`,
    );
  }
}

/**
 * Every rule a review may cite: the engine's rules, then the project's.
 *
 * A project that states no rules of its own has no `invariants.md`, and that is a valid
 * project: only the engine's half is then in force. A project file that exists but is
 * unreadable or malformed is refused.
 *
 * @param opts.engine path to the engine's `catalogue/rules.md`
 * @param opts.project path to the project's `.autoclaude/invariants.md`; may not exist
 * @throws when the engine half is unreadable, when a row does not parse as a rule, or
 *   when an id appears twice
 */
export function loadCatalogue(opts: { engine: string; project: string }): InvariantRule[] {
  const rules: InvariantRule[] = [];
  const statedIn = new Map<string, string>();
  const halves: Array<[string, string]> = [[opts.engine, readEngineHalf(opts.engine)]];
  if (existsSync(opts.project)) halves.push([opts.project, readFileSync(opts.project, "utf8")]);
  for (const [source, text] of halves) {
    for (const rule of parseInvariants(text)) {
      const first = statedIn.get(rule.id);
      if (first !== undefined) {
        const where =
          first === source ? `twice in ${source}` : `in ${first} and again in ${source}`;
        throw new Error(
          `catalogue: rule id "${rule.id}" is stated ${where}. Two rows mean two levels ` +
            `for one id, so a finding's class would depend on which row was read last. ` +
            `Rename one of them.`,
        );
      }
      statedIn.set(rule.id, source);
      rules.push(rule);
    }
  }
  return rules;
}

/** The catalogue for one project: the packaged engine half and the project's own. */
export function catalogueFor(projectRoot: string): InvariantRule[] {
  return loadCatalogue({ engine: ENGINE_RULES, project: join(projectRoot, PROJECT_RULES) });
}

/**
 * The threshold a report is read against when nothing names one: `policy`'s default, and
 * `reports.ts` imports it rather than restating the number.
 *
 * The real source is `cfg.codeReview.scoreThreshold` and
 * `cfg.planReview.scoreThreshold`; this is what a project that configures neither gets.
 */
export const DEFAULT_THRESHOLD = 7;

/**
 * Whether a number is a score on the rubric: a whole number from 1 to 10.
 *
 * One predicate for the four places that check it — the parser's `confidence`, `policy`'s
 * own two numbers, and both `scoreThreshold` checks in the config validator — because they are one
 * rule, and four copies of a range are four things that have to be edited the day the
 * rubric changes. Each caller keeps its own message: what a 0 means depends on whether a
 * reviewer wrote it or a config did.
 */
export function isScore(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10;
}

/**
 * The class of a finding, from its rule's level and the scorer's confidence.
 *
 * | Class       | Condition                                                 |
 * | ----------- | --------------------------------------------------------- |
 * | `must`      | `error` above the threshold                                |
 * | `should`    | `error` at the threshold, or `warning` at or above it      |
 * | `later`     | `note` at or above the threshold                           |
 * | `uncertain` | anything below the threshold                               |
 *
 * One deviation from section 7 of the pipeline design, stated with its reason: there, an
 * `error` rule at confidence 7 is `advisory`. Here it is `should`, because "a plausible
 * bug whose trigger is only theoretical" is a thing the maintainer wants a fix round for,
 * and "a security or isolation rule at confidence 7 must not end as nice-to-have".
 *
 * The two boundaries are one number. `threshold` is the configured `scoreThreshold`, and
 * `must` starts one above it, so raising the threshold to 8 moves both — `must` from 9,
 * `should` at 8 — instead of leaving a gap or an overlap between them.
 *
 * A rule that is not in the catalogue at all never reaches here: its finding goes to
 * `uncertain` with a note, so a typo in a rule id costs nobody a review retry.
 *
 * @throws when the confidence or the threshold is not a whole number from 1 to 10, or
 *   when the level is outside `LEVELS`. Both mean a report or a config was misread, and a
 *   class computed from either would be a silent guess.
 */
export function policy(
  level: string,
  confidence: number,
  threshold = DEFAULT_THRESHOLD,
): FindingClass {
  for (const [name, value] of [
    ["confidence", confidence],
    ["threshold", threshold],
  ] as const) {
    if (!isScore(value)) {
      throw new Error(`policy: ${name} must be a whole number from 1 to 10 but is ${value}`);
    }
  }
  if (!(LEVELS as readonly string[]).includes(level)) {
    throw new Error(
      `policy: "${level}" is not a level. Expected one of ${LEVELS.join(", ")} — the row ` +
        `that carries it is malformed, and its findings would otherwise be classified blind.`,
    );
  }
  if (confidence < threshold) return "uncertain";
  if (level === "error") return confidence > threshold ? "must" : "should";
  return level === "warning" ? "should" : "later";
}

/** The part of a rule id before the `/`: `perf/regression` is the `perf` family. */
export function familyOf(rule: string): string {
  return rule.split("/")[0]!;
}

/**
 * A literal for use inside a regular expression.
 *
 * One copy, because the same character class sat in `worktree.ts`, `bench-review.ts` and
 * inline in `ledger.ts`, and a class that gains a character in one place and not the
 * others is three different escapes.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Everything up to and including any worktree's directory, `…/<worktrees root>/<name>/` —
 * whichever worktree the quote names, not only the reviewed one; `normaliseQuotedPath` below
 * says why that is safe.
 *
 * The root is the project's `cfg.worktrees.root`. This module takes no config, so callers
 * that have one pass the root and the rest get the config's own default.
 */
export const DEFAULT_WORKTREES_ROOT = ".autoclaude/worktrees";

function worktreePrefix(worktreesRoot: string): RegExp {
  const root = worktreesRoot.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return new RegExp(`^.*${escapeRegExp(root)}/[^/]+/`);
}

/**
 * A quoted path reduced to what names the file, whatever shape the review wrote it in.
 *
 * One normalisation for the three places that have to agree on which file a finding is
 * about: `review-decision.ts`, which looks the quoted line up in the worktree;
 * `fingerprintOf` below, which decides whether a later round is reporting the same
 * finding; and `bench-review.ts`, which compares a finding with an expectation. They had
 * three, and the fingerprint used the weakest — so round 1 archived a `later` finding as
 * `src/lib/a.ts`, round 2 quoted the same line as the absolute path an angle read it at,
 * the evidence check accepted that path, the fingerprints differed, and the pull request
 * listed the finding as new instead of "noted in an earlier round".
 *
 * What comes off, in order:
 *
 * - separators, normalised — a reviewer quoting `src\x.ts` on Windows would otherwise
 *   have every finding withdrawn on the Linux runner, where a backslash is a legal
 *   character in a file name rather than a separator;
 * - a POSIX drive path, `/c/…` → `C:/…`, which is what Git Bash's `pwd` prints and what
 *   an angle quoting its working directory on the platform this pipeline runs on writes.
 *   A single letter between separators only, so `/src/x.ts` and `/home/…` are left alone;
 * - a leading `./`;
 * - everything up to and including `<worktrees root>/<name>/`, which covers both the
 *   repository-relative form and the absolute one — and **any** worktree's directory, not
 *   only the reviewed one;
 * - a diff's `a/` or `b/` prefix, which is what `git diff` prints above every hunk.
 *
 * What is left is the repository-relative path, or an absolute path outside any worktree —
 * which the evidence check then refuses for being outside the tree it read.
 *
 * That the prefix is any worktree's is safe rather than lax, and worth being exact about
 * A quote naming a sibling worktree —
 * `…/.autoclaude/worktrees/agent+99-other/src/a.ts` — comes out as `src/a.ts`, which the
 * evidence check re-joins against the worktree it was told to read and looks up there. So
 * it is checked against *this* tree under that name, never against the foreign checkout;
 * `../` is still refused, so nothing climbs out either. The effect is that such a quote is
 * withdrawn as a line that was not found rather than as a path outside the worktree — a
 * different reason, the same outcome. Narrowing the pattern to the reviewed worktree would
 * need the worktree path here, which this function deliberately does not take: the
 * fingerprint has to normalise the same way with no tree in hand.
 */
export function normaliseQuotedPath(
  file: string,
  worktreesRoot: string = DEFAULT_WORKTREES_ROOT,
): string {
  return file
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/([A-Za-z])\//, (_all, drive: string) => `${drive.toUpperCase()}:/`)
    .replace(/^\.\//, "")
    .replace(worktreePrefix(worktreesRoot), "")
    .replace(/^[ab]\//, "");
}

/**
 * A quoted line reduced to what identifies it.
 *
 * Whitespace is collapsed and quotes are dropped, because a reformatted or requoted line
 * is the same line: prettier moving an argument onto its own line, or a reviewer quoting
 * with double quotes what the source wrote with single ones, must not read as a new
 * finding. The case is kept — a renamed symbol is not the same line.
 *
 * Exported because two places have to agree on it: the fingerprint below, and
 * `review-decision.ts`, which looks the quoted line up in the worktree. If they normalised
 * differently, a finding could verify against the file in one round and fail to match its
 * own fingerprint in the next.
 */
export function normaliseEvidence(evidence: string): string {
  return evidence.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * A finding's identity across rounds: its rule id, the file it is about and the line it
 * quoted, normalised.
 *
 * Today it marks a `later` item already deferred in an earlier round as "noted in round
 * 1" instead of listing it again; SARIF's `partialFingerprints` later. Not hashed, on
 * purpose — a person reading a report or a ledger has to be able to see what matched. The
 * SARIF phase may hash it then.
 *
 * The file is part of it because a quote recurs: a route-handler signature or any other
 * boilerplate line, cited by the same rule in another file on a later round, was read as
 * the same finding and reached the pull request marked "noted in an earlier round".
 * The file goes through `normaliseQuotedPath`, the same normalisation the evidence check
 * resolves a quote with: separators alone left a
 * finding quoted at the worktree's absolute path with a different identity from the same
 * finding quoted repository-relative, which is the shape two rounds really produce. A
 * caller with no file — the rules whose findings are about what a file does not contain —
 * passes none, and the key is then the rule and the quote, exactly as every earlier round
 * wrote it.
 */
export function fingerprintOf(
  rule: string,
  evidence: string,
  file = "",
  worktreesRoot: string = DEFAULT_WORKTREES_ROOT,
): string {
  const where = normaliseQuotedPath(file, worktreesRoot);
  return `${rule}|${where ? `${where}|` : ""}${normaliseEvidence(evidence)}`;
}
