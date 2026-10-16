import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flag, issueArg, prArg } from "../../src/cli/args.js";

/**
 * "Is this an issue number" had two rules and five spellings: `> 0` in `appendNote`, the
 * `note` verb, `rollback.ts` and `watch.ts`, and a bare `Number.isInteger` in `set`,
 * `claim.ts`, `worktree.ts` and `publish.ts`. `set 0 claimed` wrote a row keyed `"0"` and
 * then warned about `runs/0/events.log` through its own note. One exported helper now, and
 * `Number` is not what decides: `0x10` is 16 and `1e2` is 100, both whole and positive, so
 * an entry would be written under a number nobody typed and every later command would look
 * for it under the one they did.
 */
describe("issueArg", () => {
  it("takes decimal digits and nothing else, naming the token it refuses", () => {
    expect(issueArg("5", "u")).toBe(5);
    expect(issueArg("163", "u")).toBe(163);
    for (const bad of [
      "0",
      "0x10",
      "1e2",
      "+5",
      " 5",
      "5 ",
      "-3",
      "5.0",
      "",
      undefined,
      "abc",
      // Digits that are not their own number, which the docstring's rule always covered
      // and the test did not. `007` passed as 7, so the work was done under an issue every
      // later command then looked for under the token that was typed; and a digit string
      // past the safe integer is rounded by `Number` — `9007199254740993` becomes
      // ...992 — which is the same defect with a number nobody could have meant. 2**53
      // itself is the first value above `Number.MAX_SAFE_INTEGER`.
      "007",
      "0007",
      "9007199254740992",
      "9007199254740993",
      "99999999999999999999",
    ]) {
      expect(() => issueArg(bad, "usage line"), String(bad)).toThrow(/is not an issue number/);
    }
    // The usage line is in the message, because these throws reach a terminal.
    expect(() => issueArg("0", "rollback <issue>")).toThrow(/rollback <issue>/);
    // The positive control for the pair above: the largest token that is its own number.
    expect(issueArg("9007199254740991", "u")).toBe(9007199254740991);
  });
});

/**
 * The shared parsers live in a module that imports nothing, so no importer of it can
 * close a cycle. Asserted rather than assumed: "inert" would otherwise be a property of
 * today's module bodies and not a rule.
 */
describe("args.ts, the module the CLIs share", () => {
  const cliArgs = readFileSync("src/cli/args.ts", "utf8");

  it("imports nothing, so no importer of it can close a cycle", () => {
    expect(
      cliArgs.match(/^\s*import\b.*$/gm) ?? [],
      "a leaf: not from the engine, not from anywhere",
    ).toEqual([]);
  });

  it("is the one place the parsers are defined", () => {
    for (const file of ["src/engine/ledger/ledger.ts", "src/engine/review/reports.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /^(export )?function (flag|issueArg|prArg|positiveInteger)\(/m,
      );
    }
  });
});

/**
 * A pull request number is the same rule about a different thing, and the two CLIs that
 * take one had the rule `issueArg` was written to replace: a bare `Number.isInteger`, so
 * `can-merge 0x10` asked GitHub about pull request 16 and `post-review 0x10` posted a
 * review onto it. Both are the reads and writes an operator types at a terminal, and 16
 * is a plausible pull request number in this repository.
 *
 * `positiveInteger` is the shared body, and `what` is the only difference — so the two
 * cannot drift apart on what a whole positive number is, and neither can claim the other's
 * noun. `issueArg`'s message is unchanged by the generalisation, which the describe above
 * and the five-CLI spawn test below both pin.
 */
describe("prArg", () => {
  it("takes decimal digits and nothing else, naming the token and what it is not", () => {
    expect(prArg("77", "u")).toBe(77);
    expect(prArg("164", "u")).toBe(164);
    for (const bad of [
      "0",
      "0x10",
      "1e2",
      "+5",
      " 5",
      "5 ",
      "-3",
      "5.0",
      "",
      undefined,
      "abc",
      // The same two, on the noun that reaches `gh pr view` and `gh pr review`.
      "007",
      "9007199254740993",
    ]) {
      expect(() => prArg(bad, "usage line"), String(bad)).toThrow(/is not a pull request number/);
    }
    // The usage line is in the message, because these throws reach a terminal.
    expect(() => prArg("0x10", "can-merge <pr> [--json]")).toThrow(/can-merge <pr> \[--json\]/);
    // And it says "pull request", not "issue": the two nouns are what tells an operator
    // which of the two numbers they mistyped.
    expect(() => prArg("0x10", "u")).not.toThrow(/issue number/);
  });
});
