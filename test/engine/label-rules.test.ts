import { describe, it, expect } from "vitest";
import { labelChanges } from "../../src/engine/publish.js";
import type { ProjectConfig } from "../../src/config/types.js";

/**
 * Engine-level. `labelRules` replaces the source's single browser-review special case
 * (design section 8.2, `labelRules`): labels the engine adds to a pull request from the
 * paths its diff changed, never from a model's judgement, because a wrong yes costs a
 * slow job and a wrong no ships a broken screen.
 *
 * One entry stands for the old `triggers.ui` / `uiNegative` / `uiForce` / `uiSkip`
 * quartet: `when` is the positive list, `unless` the negative one, `label` the one to
 * add and `suppressedBy` the label a human sets to say no. The globs are generic and
 * nothing asserts they are any project's; this file travels.
 */
const WHEN = ["src/ui/**", "src/views/**/*.tsx", "**/*.css", "theme*"];
const UNLESS = [
  "tests/**",
  "docs/**",
  "*.md",
  "**/*.md",
  "db/migrations/**",
  "scripts/**",
  ".github/**",
  "src/ui/**/*.test.ts",
];
const RULE = { when: WHEN, unless: UNLESS, label: "review:ui", suppressedBy: "review:ui-skip" };
const cfgOf = (...rules: Array<Partial<typeof RULE> & { label: string; when: string[] }>) =>
  ({ labelRules: rules }) as unknown as ProjectConfig;
const cfg = cfgOf(RULE);

describe("labelChanges, which rules fire", () => {
  it("fires when a screen changed", () => {
    expect(labelChanges(["src/ui/profile/page.tsx"], [], cfg)).toEqual({ add: ["review:ui"] });
  });

  it("fires for a component, a view and a stylesheet", () => {
    for (const f of ["src/ui/Button.tsx", "src/views/profile/Form.tsx", "src/styles/globals.css"]) {
      expect(labelChanges([f], [], cfg).add, f).toEqual(["review:ui"]);
    }
  });

  it("does not fire when nothing matches the positive list", () => {
    expect(labelChanges(["src/server/profile/handler.ts"], [], cfg).add).toEqual([]);
  });

  it("does not fire for a diff that is only negative-list files", () => {
    const only = ["tests/unit/foo.test.ts", "docs/x.md", "README.md", "scripts/ci/env-check.ts"];
    expect(labelChanges(only, [], cfg).add).toEqual([]);
  });

  // The negative list overrides *only* when it covers the whole diff. A PR that renames
  // a component and also touches its test is still a UI change; reading "unless
  // overrides when" per file would have hidden it.
  it("still fires when a negative-list file travels with a real UI change", () => {
    const mixed = ["src/ui/Button.tsx", "tests/unit/button.test.ts", "docs/ui.md"];
    expect(labelChanges(mixed, [], cfg).add).toEqual(["review:ui"]);
  });

  it("does not fire for an empty diff rather than throwing", () => {
    expect(labelChanges([], [], cfg).add).toEqual([]);
  });

  // A project with no browser review at all: absent `unless` must not make every
  // diff a UI diff, absent rules must not make the whole thing throw, and a rule with an
  // empty `when` can never fire.
  it("works with `unless` absent, with no rules and with an empty `when`", () => {
    const noUnless = cfgOf({ when: WHEN, label: "review:ui" });
    expect(labelChanges(["src/ui/Button.tsx"], [], noUnless).add).toEqual(["review:ui"]);
    expect(labelChanges(["docs/x.md"], [], noUnless).add).toEqual([]);
    expect(labelChanges(["src/ui/Button.tsx"], [], cfgOf()).add).toEqual([]);
    expect(labelChanges(["src/ui/Button.tsx"], [], cfgOf({ when: [], label: "x" })).add).toEqual(
      [],
    );
  });

  // A .tsx under src/views is UI; a .ts under src/views is not. The positive list draws
  // that line on purpose and a looser match would label a query module.
  it("keeps the extension distinction the positive list draws", () => {
    expect(labelChanges(["src/views/profile/queries.ts"], [], cfg).add).toEqual([]);
    expect(labelChanges(["src/views/profile/Form.tsx"], [], cfg).add).toEqual(["review:ui"]);
  });

  // The two lists below are built inline on purpose: this file pins the engine's
  // behaviour on globs of a given shape, and a project's own config test pins that those
  // are its globs.
  it("an API route alone is not a UI change, an API route with a page is", () => {
    const screens = cfgOf({
      when: ["src/ui/**/*.tsx", "src/views/**/*.tsx", "**/*.css"],
      unless: [...UNLESS, "src/ui/api/**"],
      label: "review:ui",
    });
    expect(labelChanges(["src/ui/api/profile/route.ts"], [], screens).add).toEqual([]);
    expect(
      labelChanges(["src/ui/api/profile/route.ts", "src/ui/profile/page.tsx"], [], screens).add,
    ).toEqual(["review:ui"]);
  });

  it("a framework-free file beside the components is not a UI change", () => {
    const screens = cfgOf({ when: ["src/ui/**/*.tsx", "src/views/**/*.tsx"], label: "review:ui" });
    expect(labelChanges(["src/ui/profile/profile-reducer.ts"], [], screens).add).toEqual([]);
  });

  // The `unless` entry is load-bearing here: a .tsx under src/ui/api matches the positive
  // list, so it is the one case where dropping the negative entry changes the answer —
  // proved by the same file and the same positive list coming back empty with the entry
  // and labelled without it.
  it("excludes a stray .tsx file under src/ui/api only because of the `unless` entry", () => {
    const when = ["src/ui/**/*.tsx", "src/views/**/*.tsx", "**/*.css"];
    const stray = "src/ui/api/profile/preview.tsx";
    const withEntry = cfgOf({ when, unless: [...UNLESS, "src/ui/api/**"], label: "review:ui" });
    const without = cfgOf({ when, unless: UNLESS, label: "review:ui" });
    expect(labelChanges([stray], [], withEntry).add).toEqual([]);
    expect(labelChanges([stray], [], without).add).toEqual(["review:ui"]);
  });

  it("covers the whole diff with a test file beside the components, per the entry's own list", () => {
    expect(labelChanges(["src/ui/Button.test.ts"], [], cfg).add).toEqual([]);
    expect(labelChanges(["src/ui/Button.test.ts", "src/ui/Button.tsx"], [], cfg).add).toEqual([
      "review:ui",
    ]);
  });
});

describe("labelChanges, what a human already decided", () => {
  const screen = ["src/ui/Button.tsx"];

  // A human who set the suppressing label has decided. The engine does not argue with it.
  it("obeys a human's suppressing label", () => {
    expect(labelChanges(screen, ["review:ui-skip"], cfg).add).toEqual([]);
  });

  // Idempotent: publish runs again on every push with --update.
  it("does not re-apply a label that is already there", () => {
    expect(labelChanges(screen, ["review:ui"], cfg).add).toEqual([]);
  });

  // Never removes it, and never adds on a diff that does not call for it. A human may
  // have forced the label onto a diff whose paths do not call for one, and taking it off
  // again would undo that silently: the result has an `add` and nothing else.
  it("leaves a human's forced label alone on a diff that does not need it", () => {
    const r = labelChanges(["src/server/db.ts"], ["review:ui"], cfg);
    expect(r).toEqual({ add: [] });
  });

  it("a rule without `suppressedBy` is suppressed by nothing", () => {
    const open = cfgOf({ when: WHEN, label: "review:ui" });
    expect(labelChanges(screen, ["review:ui-skip"], open).add).toEqual(["review:ui"]);
  });
});

// New with the generalisation: the source had exactly one rule, so independence between
// rules and the shape of the result had no case.
describe("labelChanges over several rules", () => {
  const two = cfgOf(RULE, {
    when: ["db/migrations/**"],
    label: "needs:db-review",
    suppressedBy: "db-review-skip",
  });

  it("evaluates each rule on its own and adds each label once", () => {
    const changed = ["src/ui/Button.tsx", "db/migrations/001.sql"];
    expect(labelChanges(changed, [], two).add).toEqual(["review:ui", "needs:db-review"]);
    // The first is suppressed, the second still fires.
    expect(labelChanges(changed, ["review:ui-skip"], two).add).toEqual(["needs:db-review"]);
    // Two rules naming one label add it once.
    const same = cfgOf({ when: ["a/**"], label: "x" }, { when: ["b/**"], label: "x" });
    expect(labelChanges(["a/1", "b/1"], [], same).add).toEqual(["x"]);
  });

  it("judges `unless` against the whole diff, not the files its own `when` matched", () => {
    // The migration is covered by the first rule's `unless`, but that rule's `when` does
    // not match it, and the second rule has no `unless` at all.
    expect(labelChanges(["db/migrations/001.sql"], [], two).add).toEqual(["needs:db-review"]);
  });
});
