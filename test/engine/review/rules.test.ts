import { afterAll, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInvariants } from "../../../src/engine/review/invariants.js";
import {
  DEFAULT_THRESHOLD,
  LEVELS,
  escapeRegExp,
  familyOf,
  fingerprintOf,
  isScore,
  catalogueFor,
  loadCatalogue,
  normaliseQuotedPath,
  policy,
} from "../../../src/engine/review/rules.js";

/**
 * Engine-level tests. The catalogue's grammar, the policy, the fingerprint and the engine
 * half of the catalogue itself hold for any project, so this file travels to another
 * repository unchanged — no assertion here names a rule the project states, a path it
 * uses or a word from its vocabulary.
 *
 * The three claims about *this* repository live in project-config.test.ts, the file a port
 * rewrites: which rules it adds, that its own rules survive the merge with the engine's,
 * and that the engine's catalogue names none of its facts. The last one reads like an
 * engine claim and is not: the marker list it tests with is this repository's vocabulary,
 * so here it would test the wrong words after a port and pass on anything.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** The two halves of a catalogue as paths; the project file is absent when `project` is null. */
function fixtureHalves(
  engine: string,
  project: string | null,
): { engine: string; project: string } {
  const r = mkdtempSync(join(tmpdir(), "autoclaude-rules-"));
  roots.push(r);
  mkdirSync(join(r, ".autoclaude"), { recursive: true });
  writeFileSync(join(r, "rules.md"), engine);
  if (project !== null) writeFileSync(join(r, ".autoclaude", "invariants.md"), project);
  return { engine: join(r, "rules.md"), project: join(r, ".autoclaude", "invariants.md") };
}

const row = (id: string, level = "error") => `| \`${id}\` | ${level} | what | a breach |`;

const ENGINE_FILE = join("catalogue", "rules.md");
const PROJECT_FILE = join("test", "fixtures", "catalogue", "invariants.md");
const engineRules = parseInvariants(readFileSync(ENGINE_FILE, "utf8"));

describe("loadCatalogue", () => {
  it("merges engine and project rules and refuses a duplicate id", () => {
    // The shipped engine half with the generic project fixture. The project half is proven
    // by counting rather than by naming one of its rules: a project states its own, and an
    // engine test that named one would make this file a place every project has to edit.
    const ids = loadCatalogue({ engine: ENGINE_FILE, project: PROJECT_FILE }).map((r) => r.id);
    expect(ids, "an engine rule is missing").toEqual(
      expect.arrayContaining(["spec/criterion-not-met", "plan/invented-interface"]),
    );
    expect(ids.length, "the project half contributed nothing").toBe(engineRules.length + 6);
    expect(new Set(ids).size, "the two real halves collide").toBe(ids.length);

    // And on controlled input: both halves, in engine-then-project order.
    const merged = loadCatalogue(fixtureHalves(row("spec/only-engine"), row("layer/only-project")));
    expect(merged.map((r) => r.id)).toEqual(["spec/only-engine", "layer/only-project"]);

    // A collision across the two files names both, because the fix is in one of them and
    // the message is all the porter gets.
    const clashing = fixtureHalves(row("spec/clash"), row("spec/clash", "warning"));
    for (const named of [/spec\/clash/, /rules\.md/, /invariants\.md/]) {
      expect(() => loadCatalogue(clashing), `the message does not name ${named}`).toThrow(named);
    }

    // Within one file it is the same mistake with the same consequence: the level a
    // finding gets depends on which row won, which no reader could tell.
    expect(() =>
      loadCatalogue(fixtureHalves([row("spec/twice"), row("spec/twice", "note")].join("\n"), "")),
    ).toThrow(/spec\/twice/);
  });

  // Half a catalogue is worse than none: every rule of the missing half becomes an
  // unknown id, so every finding citing one is withdrawn to `uncertain` and the review
  // looks like it found nothing.
  it("refuses an engine half it cannot read", () => {
    expect(() => loadCatalogue({ engine: "/nope/rules.md", project: PROJECT_FILE })).toThrow(
      /rules\.md/,
    );
  });

  it("loads the engine half without a project file", () => {
    expect(loadCatalogue({ engine: ENGINE_FILE, project: "/nope" }).length).toBeGreaterThan(30);
  });

  it("catalogueFor reads the packaged engine half and the project's .autoclaude/invariants.md", () => {
    const root = mkdtempSync(join(tmpdir(), "autoclaude-cataloguefor-"));
    roots.push(root);
    expect(catalogueFor(root)).toHaveLength(engineRules.length);
    mkdirSync(join(root, ".autoclaude"), { recursive: true });
    writeFileSync(join(root, ".autoclaude", "invariants.md"), row("layer/only-project"));
    expect(catalogueFor(root).map((r) => r.id)).toContain("layer/only-project");
  });
});

describe("catalogue/rules.md, the engine catalogue", () => {
  it("every engine rule has a level of error, warning or note", () => {
    expect(engineRules.length, "the engine catalogue states no rule at all").toBeGreaterThan(0);
    for (const r of engineRules) {
      expect(LEVELS as readonly string[], `rule ${r.id} has level "${r.level}"`).toContain(r.level);
    }
  });

  // These cells are the checklist a reviewer subagent reads. An empty one is a rule
  // nobody can apply, and it would still parse, load and classify.
  it("says what to inspect and what a breach looks like for every engine rule", () => {
    for (const r of engineRules) {
      expect(r.whatToInspect.length, `rule ${r.id} has no "what to inspect"`).toBeGreaterThan(0);
      expect(r.breachLooksLike.length, `rule ${r.id} has no "a breach looks like"`).toBeGreaterThan(
        0,
      );
    }
  });

  /**
   * Which rows the evidence check leaves alone, read off the catalogue instead of a
   * prefix list in `review-decision.ts`.
   *
   * A `spec/` or `plan/` finding is about what a file does not contain and a `paths/`
   * finding is the changed file list against a glob: none of the three has a line to
   * quote, and the check withdrew them. Every other family does have one, and the
   * exemption must not widen quietly — a `bug/` must with no `evidence:` parses clean,
   * so a row wrongly marked `measurement` is a finding that blocks at the cap and that
   * nothing can test.
   */
  it("calls the measured families' evidence a measurement and every other family's a line", () => {
    const kinds = new Map(engineRules.map((r) => [r.id, r.evidence]));
    const of = (family: string) => engineRules.filter((r) => r.id.startsWith(family));
    for (const family of ["spec/", "plan/", "paths/"]) {
      expect(of(family).length, `no engine rule in the ${family} family`).toBeGreaterThan(0);
      for (const r of of(family)) {
        expect(kinds.get(r.id), `${r.id} has to be exempt from the evidence check`).toBe(
          "measurement",
        );
      }
    }
    for (const family of [
      "bug/",
      "perf/",
      "comment/",
      "tests/",
      "review/",
      "docs/",
      "scope/",
      "security/",
    ]) {
      expect(of(family).length, `no engine rule in the ${family} family`).toBeGreaterThan(0);
      for (const r of of(family)) {
        expect(kinds.get(r.id), `${r.id} has to quote a line`).toBe("line");
      }
    }
  });

  // A family dropped in an edit is invisible: the skill keeps citing its ids, the
  // catalogue no longer has them, and every such finding lands in `uncertain`.
  it("states every rule family the reviewers cite", () => {
    const families = new Set(engineRules.map((r) => r.id.split("/")[0]));
    for (const f of [
      "spec",
      "tests",
      "bug",
      "perf",
      "paths",
      "comment",
      "review",
      "docs",
      "scope",
      "plan",
      "security",
    ]) {
      expect([...families], `no engine rule in the ${f}/ family`).toContain(f);
    }
  });

  // The security angle's own rows. Each of the first five is a way in, so a verified one
  // blocks; a redirect or a new dependency is a risk that needs a human's weighing, so it
  // costs a fix round without blocking.
  it("states the security rows at the levels they cost", () => {
    const level = new Map(engineRules.map((r) => [r.id, r.level]));
    for (const id of [
      "security/authz-missing",
      "security/path-traversal",
      "security/ssrf",
      "security/unsafe-deserialisation",
      "security/secret-exposed",
    ]) {
      expect(level.get(id), id).toBe("error");
    }
    for (const id of ["security/open-redirect", "security/dependency-risk"]) {
      expect(level.get(id), id).toBe("warning");
    }
  });
});

describe("policy", () => {
  it("error at 8 is must, error at 7 is should, warning at 7 is should, note at 7 is later, anything below the threshold is uncertain", () => {
    expect(policy("error", 8)).toBe("must");
    expect(policy("error", 10)).toBe("must");
    expect(policy("error", 7)).toBe("should");
    expect(policy("warning", 7)).toBe("should");
    expect(policy("warning", 10)).toBe("should");
    expect(policy("note", 7)).toBe("later");
    expect(policy("note", 10)).toBe("later");
    for (const level of LEVELS) {
      for (const confidence of [1, 6]) {
        expect(policy(level, confidence), `${level} at ${confidence}`).toBe("uncertain");
      }
    }
  });

  // One threshold, two boundaries. A project that raises it to 8 gets `must` from 9 and
  // `should` at 8; a policy that moved only one of them would quietly reclassify every
  // error finding at the threshold as blocking.
  it("moves both boundaries with the threshold", () => {
    expect(policy("error", 9, 8)).toBe("must");
    expect(policy("error", 8, 8)).toBe("should");
    expect(policy("error", 7, 8)).toBe("uncertain");
    expect(policy("warning", 8, 8)).toBe("should");
    expect(policy("note", 8, 8)).toBe("later");
  });

  // A confidence the scorer never emits means the report was misread, and a class
  // computed from it would be a silent guess at how sure someone was.
  it("refuses a confidence or a threshold outside 1 to 10", () => {
    for (const bad of [0, 11, -1, 7.5, Number.NaN]) {
      expect(() => policy("error", bad), `confidence ${bad}`).toThrow(/confidence/);
    }
    for (const bad of [0, 11, 7.5]) {
      expect(() => policy("error", 8, bad), `threshold ${bad}`).toThrow(/threshold/);
    }
  });

  it("refuses a level outside the catalogue's vocabulary", () => {
    expect(() => policy("critical", 9)).toThrow(/critical/);
    expect(() => policy("", 9)).toThrow(/error, warning, note/);
  });
});

describe("fingerprintOf", () => {
  it("fingerprint ignores whitespace and quotes", () => {
    const a = fingerprintOf("bug/boundary", '  const label = "Ü".repeat(81);  ');
    const b = fingerprintOf("bug/boundary", "const label =\t'Ü'.repeat(81);");
    expect(a).toBe(b);
    // Readable, and the rule is part of it: the same line under two rules is two findings.
    expect(a).toContain("bug/boundary");
    expect(a).toContain("const label = Ü.repeat(81);");
    expect(fingerprintOf("bug/general-case", a.split("|")[1] ?? "")).not.toBe(a);
  });

  // A boilerplate line recurs across files, so rule and quote alone made a new finding in
  // one file the repeat of an old finding in another. The file is part of the identity when
  // the caller has one; a finding about what a file does not contain often has none, and
  // then the key is what it always was.
  it("separates two files that quote the same line under the same rule", () => {
    const here = fingerprintOf("bug/general-case", "return handler(request);", "src/a/route.ts");
    const there = fingerprintOf("bug/general-case", "return handler(request);", "src/b/route.ts");
    expect(here).not.toBe(there);
    expect(here).toContain("src/a/route.ts");
    // Normalised like the quote, so `src\a\route.ts` from a Windows reviewer is the same
    // file as `src/a/route.ts` from the runner.
    expect(fingerprintOf("bug/general-case", "return handler(request);", "src\\a\\route.ts")).toBe(here); // prettier-ignore
    // No file, and the key is the rule and the quote, as every earlier round wrote it.
    const quoteless = fingerprintOf("spec/criterion-not-met", "the header is set");
    expect(quoteless).toBe(fingerprintOf("spec/criterion-not-met", "the header is set", ""));
  });
});

/**
 * One normalisation of a quoted path, for the three places that have to agree on what
 * file a finding is about: the evidence check's lookup, the fingerprint that recognises
 * the same finding in a later round, and the benchmark's comparison with an expectation.
 *
 * They had three. Round 1 archives a `later` finding as `src/lib/a.ts`, round 2 quotes
 * the same line as the worktree-absolute path an angle reads it at, the evidence check
 * accepts that path, and the fingerprints differ — so `seenBefore` was false and the pull
 * request listed it as new instead of "noted in an earlier round".
 */
describe("normaliseQuotedPath", () => {
  it("reduces every shape a review quotes to the repository-relative path", () => {
    for (const written of [
      "src/lib/a.ts",
      "  src/lib/a.ts  ",
      "./src/lib/a.ts",
      "src\\lib\\a.ts",
      // What `git diff` prints above every hunk.
      "a/src/lib/a.ts",
      "b/src/lib/a.ts",
      // The worktree, repository-relative and absolute, in both separators — the shape an
      // angle produces when it quotes the file it just read.
      ".autoclaude/worktrees/agent+12-x/src/lib/a.ts",
      "C:/my-repo/.autoclaude/worktrees/agent+12-x/src/lib/a.ts",
      "C:\\my-repo\\.autoclaude\\worktrees\\agent+12-x\\src\\lib\\a.ts",
      // And what Git Bash's `pwd` prints, which is a real shape on the platform the
      // pipeline runs on.
      "/c/my-repo/.autoclaude/worktrees/agent+12-x/src/lib/a.ts",
    ]) {
      expect(normaliseQuotedPath(written), written).toBe("src/lib/a.ts");
    }
  });

  it("strips a configured worktrees root (cfg.worktrees.root), not only the default", () => {
    expect(normaliseQuotedPath("/srv/wt/agent-1/src/a.ts", "/srv/wt")).toBe("src/a.ts");
    expect(normaliseQuotedPath("../trees/agent-1/src/a.ts", "../trees/")).toBe("src/a.ts");
    // The default root does not strip another project's layout.
    expect(normaliseQuotedPath("other/agent-1/src/a.ts")).toBe("other/agent-1/src/a.ts");
  });

  it("maps a POSIX drive path to the drive, and leaves a one-letter directory alone", () => {
    expect(normaliseQuotedPath("/c/repo/src/lib/a.ts")).toBe("C:/repo/src/lib/a.ts");
    expect(normaliseQuotedPath("/C/repo/src/lib/a.ts")).toBe("C:/repo/src/lib/a.ts");
    // Not a drive: three characters between the separators, and an absolute POSIX path
    // that happens to start with a directory of one letter keeps its leading slash.
    expect(normaliseQuotedPath("/src/lib/a.ts")).toBe("/src/lib/a.ts");
    expect(normaliseQuotedPath("/home/x/repo/src/a.ts")).toBe("/home/x/repo/src/a.ts");
  });

  it("gives the same fingerprint to the same line however its path was quoted", () => {
    const quote = "export async function GET(request: Request) {";
    const here = fingerprintOf("perf/inefficiency", quote, "src/lib/a.ts");
    for (const written of [
      "C:/my-repo/.autoclaude/worktrees/agent+12-x/src/lib/a.ts",
      "/c/my-repo/.autoclaude/worktrees/agent+12-x/src/lib/a.ts",
      "b/src/lib/a.ts",
    ]) {
      expect(fingerprintOf("perf/inefficiency", quote, written), written).toBe(here);
    }
    // And two files are still two findings: the normalisation makes paths comparable, not
    // equal.
    expect(fingerprintOf("perf/inefficiency", quote, "src/lib/b.ts")).not.toBe(here);
  });
});

// Two one-line helpers that existed three and two times over. `familyOf` was a second
// spelling of the family concept beside the evidence check's own prefix list, and the
// character class of a regex escape sat in three scripts.
describe("familyOf and escapeRegExp", () => {
  it("names the family before the slash", () => {
    expect(familyOf("perf/regression")).toBe("perf");
    expect(familyOf("spec/criterion-not-met")).toBe("spec");
    // Whatever a caller hands it: a rule id is `area/name`, and an id without a slash is
    // its own family rather than an error here — `classify` is what refuses an unknown id.
    expect(familyOf("nofamily")).toBe("nofamily");
  });

  it("escapes what a regular expression would otherwise read as syntax", () => {
    expect(escapeRegExp("agent+12-x")).toBe("agent\\+12-x");
    expect(new RegExp(escapeRegExp("a.b*c")).test("a.b*c")).toBe(true);
    expect(new RegExp(escapeRegExp("a.b*c")).test("axbbc")).toBe(false);
    expect(escapeRegExp("plain")).toBe("plain");
  });

  /**
   * And it is one copy, which is the whole claim the comment above makes.
   *
   * The class sat in three scripts: a private `escapeRegExp` in `worktree.ts` and in
   * `bench-review.ts`, and inline in `ledger.ts`'s archive numbering. `bench-review.ts`
   * was converted when this function was written and the other two were not, so the
   * comment describing one copy stood over three. A class that gains a character in one
   * place and not the others is three different escapes, and the failure mode is silent:
   * a name the regex reads as syntax matches the wrong file, or no file
   *
   * Asserted over the source text, because that is where the duplication lives — there is
   * no behaviour to test that would tell one copy from two identical ones.
   *
   * Recursive, and over `.mjs` as well as `.ts`: the first version read
   * `src/engine` one level deep and only `.ts`, so a fourth copy in `some-helper.mjs`
   * or under `scripts/ci/` would have passed. Neither directory has a subdirectory today,
   * which is exactly why the narrow version looked correct.
   */
  it("is the only copy of the character class in the sources that use it", () => {
    const holders = ["src"].flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"))
        .filter((f) =>
          /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/.test(readFileSync(join(dir, f), "utf8")),
        )
        .map((f) => `${dir}/${f.replace(/\\/g, "/")}`),
    );
    expect(holders, "every caller imports rules.ts's escapeRegExp").toEqual([
      "src/engine/review/rules.ts",
    ]);
  });
});

// One range check for a 1-to-10 score, in one place: it was written out four times — the
// parser's confidence, `policy`'s own two loops and both `scoreThreshold` checks in
// `config.ts` — and nothing made them move together.
describe("isScore", () => {
  it("is the 1-to-10 whole number the rubric and the threshold share", () => {
    for (const good of [1, 7, 10]) expect(isScore(good), String(good)).toBe(true);
    for (const bad of [0, 11, -1, 7.5, Number.NaN, "8", null, undefined]) {
      expect(isScore(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is what policy applies to both its numbers", () => {
    // The predicate and the refusals are one rule: a value it rejects is a value `policy`
    // refuses, whichever of the two numbers carries it.
    for (const bad of [0, 11, 7.5]) {
      expect(isScore(bad)).toBe(false);
      expect(() => policy("error", bad), `confidence ${bad}`).toThrow(/1 to 10/);
      expect(() => policy("error", 8, bad), `threshold ${bad}`).toThrow(/1 to 10/);
    }
  });
});

// The parser's default threshold used to be a hand-copied 7 with a comment saying it
// mirrored this one.
describe("DEFAULT_THRESHOLD", () => {
  it("is policy's own default", () => {
    expect(DEFAULT_THRESHOLD).toBe(7);
    expect(isScore(DEFAULT_THRESHOLD)).toBe(true);
    // `policy` called without a threshold classifies as it does at this number.
    for (const level of LEVELS) {
      expect(policy(level, DEFAULT_THRESHOLD)).toBe(policy(level, DEFAULT_THRESHOLD, DEFAULT_THRESHOLD)); // prettier-ignore
    }
  });
});
