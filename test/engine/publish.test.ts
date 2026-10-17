import { afterAll, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsNeeded, prBody, prTitle, publish } from "../../src/engine/publish.js";
import {
  parseImplementReport,
  parsePlanReviewReport,
  parseCodeReviewReport,
} from "../../src/engine/review/reports.js";
import {
  emptyLedger,
  loadLedger,
  parseArchiveHeader,
  saveLedger,
  transition,
  type LedgerEntry,
} from "../../src/engine/ledger/ledger.js";
import { decide } from "../../src/engine/review/decision.js";
import { loadCatalogue } from "../../src/engine/review/rules.js";
import { attempts } from "../helpers/reports.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { Forge, type Exec } from "../../src/forge/github.js";

const fx = (n: string) => readFileSync(`test/fixtures/reports/${n}.md`, "utf8");
/** Both reviews are classified against a catalogue, as publish() classifies them. */
const catalogue = loadCatalogue({
  engine: "catalogue/rules.md",
  project: "test/fixtures/catalogue/invariants.md",
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

/**
 * The config both describes use: the push gate's lists, the label rules, the approval
 * entries and everything `decide` reads.
 *
 * The caps, the two label prefixes and the remote are stated with values of their own:
 * a missing cap means no retry, a label built from a literal instead of from the config
 * would pass with the usual prefixes, and a git call that names `origin` instead of
 * `forge.remote` would pass with the usual remote. The footer is not the default's, so a
 * hardcoded one fails here.
 */
const cfg = {
  forge: { remote: "upstream" },
  branches: { integration: "develop", production: "main" },
  branchPrefix: "agent/",
  humans: ["maintainer"],
  forbiddenPaths: [".github/workflows/**", "POLICY.md"],
  policyAdjacentPaths: ["src/features/*/queries.ts"],
  worktrees: { root: ".autoclaude/worktrees", copy: [".env.local", "conf/secrets/"] },
  humanApproval: [{ paths: ["db/migrations/**"], label: "human-approved" }],
  labelRules: [
    {
      when: ["src/ui/**"],
      unless: ["tests/**", "docs/**"],
      label: "review:ui",
      suppressedBy: "review:ui-skip",
    },
  ],
  labels: { fixRound: "fix-", reviewRetry: "retry-" },
  caps: { fixRounds: 2, planRounds: 2, reviewRetries: 2 },
  stages: { implement: {} },
  messages: { footer: "Posted by the test footer", defuseMentions: true },
} as unknown as ProjectConfig;

describe("prTitle", () => {
  it("appends the issue number once", () => {
    expect(prTitle("fix(parser): keep accents in file names", 26)).toBe(
      "fix(parser): keep accents in file names (#26)",
    );
    expect(prTitle("fix: something (#26)", 26)).toBe("fix: something (#26)");
  });

  // No text the engine writes to GitHub or into a commit subject carries a CI skip marker
  // (plan Global Constraints): the pull request's CI would never start, and a required
  // check that never reports reads as a refusal at the merge verdict.
  it("strips CI skip markers from the pull request title", () => {
    expect(prTitle("fix: x [skip ci] [ci skip] [no ci]", 4)).toBe("fix: x (#4)");
  });

  it("strips every marker form, in any case, and the whitespace they leave", () => {
    expect(prTitle("fix: x [SKIP CI]", 4)).toBe("fix: x (#4)");
    expect(prTitle("[skip actions] fix: x", 4)).toBe("fix: x (#4)");
    expect(prTitle("fix:  [Actions Skip]  x", 4)).toBe("fix: x (#4)");
    expect(prTitle("fix: x [no ci] (#4)", 4)).toBe("fix: x (#4)");
  });

  it("leaves brackets that are not markers alone", () => {
    expect(prTitle("fix: parse [ci] lists", 4)).toBe("fix: parse [ci] lists (#4)");
  });
});

describe("prBody", () => {
  const impl = parseImplementReport(fx("implement"));
  const review = parseCodeReviewReport(fx("code-review"), { catalogue });
  const planReview = parsePlanReviewReport(fx("plan-review"), { catalogue });
  /**
   * The decision beside the report, as publish.ts hands it over. No worktree, so the
   * evidence check runs on nothing and every finding stands: the two cases that need a
   * withdrawal or a repeat build their own decision.
   */
  const decision = decide(review, attempts({ fix: 2 }), cfg, { stage: "code-review" });
  const atCap = {
    rounds: { fix: 2, cap: 2 },
    decision,
    messages: cfg.messages,
    humans: cfg.humans,
  };
  const body = (over: Parameters<typeof prBody>[7] = {}) =>
    prBody(42, impl, review, planReview, null, "host/ada", "abc1234", { ...atCap, ...over });

  it("closes the issue, carries the marker, the criteria, the review notes and the attribution", () => {
    const b = body();
    expect(b).toContain("Closes #42");
    expect(b).toContain('<!-- autodev-pr issue="42" machine="host/ada" -->');
    expect(b).toContain("- [x] Leading and trailing spaces are trimmed in the formatted label");
    expect(b).toContain(
      "- [ ] Empty input yields an empty label on every platform (verified at unit level only)",
    );
    expect(b).toContain("bug/general-case");
    expect(b).toContain("rebased onto abc1234");
    // The footer is the config's, last in the body and not a hardcoded product line.
    expect(b.trimEnd().endsWith("Posted by the test footer")).toBe(true);
    expect(b).not.toContain("Claude Code");
  });

  // A pull request body built from the implement and review reports alone says nothing
  // of what the plan review found. The reviewer of the plan is a stage like any other and
  // its warnings belong where a human will see them.
  it("carries the plan review's warnings under a heading of their own", () => {
    const b = body();
    expect(b).toContain("## Plan review");
    expect(b).toContain("plan/test-asserts-mock");
    // The blocker from the same report is not repeated: it cost a fix round already,
    // and a plan that still had an error finding never reached the implement stage.
    expect(b).not.toContain("plan/invented-interface");
    // Still separate from the diff review's own warnings.
    expect(b).toContain("bug/general-case");
  });

  it("says a plan review report was missing rather than letting it read as clean", () => {
    const b = prBody(42, impl, review, null, null, "host/ada", "abc1234", atCap);
    expect(b).toContain("No plan review report was available.");
    expect(b).not.toContain("No findings remained after the plan review.");
  });

  // Three ways for a section to say "nothing was found" when that is not what happened.
  it("says a review did not finish rather than rendering it as a verdict", () => {
    const stopped = { ...planReview, complete: false };
    const b = prBody(42, impl, review, stopped, null, "host/ada", "abc1234", atCap);
    expect(b).toContain("The plan review did not finish");
    // What it had written is still shown; it is the claim of completeness that is withdrawn.
    expect(b).toContain("plan/test-asserts-mock");
  });

  // A workflow that triggers on a mention in a comment would start a run from inside a
  // pull request body, and every message, quote and uncertain line here is model-written
  // text that reaches GitHub verbatim. The channel is older than this diff; the scrub is
  // one line. Config drives it (`messages.defuseMentions`, `humans`) — design section
  // 8.2: the handles of the project's own humans stay mentions.
  it("defuses a mention that would trigger a workflow, and keeps a human's", () => {
    const mentioning = {
      ...review,
      uncertain: ["docs/completeness — @claude, is this still right? cc @maintainer"],
    };
    const opts = { ...atCap, messages: cfg.messages, humans: cfg.humans };
    const b = prBody(42, impl, mentioning, planReview, null, "host/ada", "abc1234", opts);
    expect(b, "the trigger reaches the pull request").not.toMatch(/@claude/i);
    expect(b).toContain("@\u200bclaude, is this still right?");
    expect(b, "a configured human stays a mention").toContain("cc @maintainer");
  });

  it("leaves mentions alone when the config turns defusing off", () => {
    const mentioning = { ...review, uncertain: ["docs/completeness — @claude, still right?"] };
    const messages = { footer: "f", defuseMentions: false };
    const b = prBody(42, impl, mentioning, planReview, null, "host/ada", "abc1234", {
      ...atCap,
      messages,
    });
    expect(b).toContain("@claude, still right?");
  });

  // The body becomes the squash commit body, where GitHub reads skip markers, so a quoted
  // line carrying one is defused (a zero-width space after the bracket), not deleted.
  it("defuses CI skip markers in model-written text and keeps the quote readable", () => {
    const quoting = {
      ...review,
      uncertain: ["docs/completeness — the commit says [skip ci] and [CI Skip] and [no ci]"],
    };
    const b = prBody(42, impl, quoting, planReview, null, "host/ada", "abc1234", atCap);
    expect(b).not.toMatch(/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i);
    expect(b).toContain("[\u200bskip ci] and [\u200bCI Skip] and [\u200bno ci]");
  });

  it("ends with the configured footer, and with the default when none is given", () => {
    expect(
      body({ messages: { footer: "Posted by hand", defuseMentions: true } }).trimEnd(),
    ).toMatch(/\nPosted by hand$/);
    expect(prBody(42, impl, review, planReview, null, "m", null).trimEnd()).toMatch(
      /\nGenerated by autoclaude$/,
    );
  });

  // The verdict is what tells a thorough review from a cursory one, and the human who
  // merges is the only reader left once the orchestrator has published.
  it("shows the red step's verdict", () => {
    expect(body()).toContain("Red step: `not-proven`");
  });

  // The implement report's own criteria are the checkboxes above; this is the reviewer's
  // independent account of where each one is satisfied, which nothing else carries.
  it("lists where the review found the evidence for each criterion", () => {
    expect(body()).toContain("met — tests/unit/lib/format.test.ts:41");
  });

  it("puts a red step that could not run in front of the human, with its reason", () => {
    const couldNot = {
      ...review,
      redStep: "could-not-run" as const,
      reason: "the base collected no tests",
    };
    const b = prBody(42, impl, couldNot, planReview, null, "host/ada", "abc1234", atCap);
    expect(b).toContain("The red step could not run");
    expect(b).toContain("the base collected no tests");
  });

  it("says a report could not be read rather than that it was absent", () => {
    const b = prBody(
      42,
      impl,
      review,
      null,
      "**The plan review report could not be read**: block is not terminated",
      "host/ada",
      "abc1234",
      atCap,
    );
    expect(b).toContain("could not be read");
    expect(b).not.toContain("No plan review report was available.");
    expect(b).not.toContain("No findings remained after the plan review.");
  });

  // A plan-review finding names the plan file, which archivePlanFile has moved and Step 3
  // has deleted the worktree of. The evidence line is what identifies it.
  it("renders a plan review finding by its evidence, not by a path that no longer exists", () => {
    const b = body();
    expect(b).toContain("Evidence:");
    expect(b).not.toContain(".autoclaude/state/plans/12.md:22");
    // The diff review's own findings keep their file and line: that branch still exists.
    expect(b).toContain("src/lib/format.ts:18");
  });

  // Defect 6: the section that named one product's migrations directory is generic. One
  // line per `humanApproval` entry the diff matches, saying which files and which label,
  // and nothing at all when no entry matches.
  it("says so, once per matching entry, when the diff needs a human's label", () => {
    const approvals = approvalsNeeded(
      ["src/a.ts", "db/migrations/001.sql", "db/migrations/002.sql"],
      cfg.humanApproval,
    );
    const b = prBody(42, impl, review, planReview, null, "m", null, { approvals });
    expect(b).toContain(
      "This diff touches `db/migrations/001.sql, db/migrations/002.sql`. It may only be merged by a human, or after a human applies `human-approved`.",
    );
  });

  it("says nothing about human approval when no entry matches", () => {
    const approvals = approvalsNeeded(["src/a.ts"], cfg.humanApproval);
    expect(approvals).toEqual([]);
    const b = prBody(42, impl, review, planReview, null, "m", null, { approvals });
    expect(b).not.toContain("may only be merged by a human");
    expect(b).not.toMatch(/migration/i);
  });

  // The design's four classes, each with the one sentence that says what it costs. Until
  // now the body rendered the `should` tier under "remaining warnings" and dropped the
  // other three: a `later` item reached nobody and an uncertain one reached nobody either.
  it("renders the open should findings under their own heading with the round count", () => {
    const b = body();
    expect(b).toContain("### Should, open (2)");
    expect(b).toContain(
      "These remained open after 2 fix rounds, the cap. A human decides whether they block the merge.",
    );
    expect(b).toContain("`bug/general-case` at `src/lib/format.ts:18`");
  });

  it("renders later items as noted, not fixed", () => {
    const b = body();
    expect(b).toContain("### Later (1)");
    expect(b).toContain("Noted by the review, deliberately not fixed:");
    expect(b).toContain("scope/follow-up");
  });

  // Both reviews' uncertain lists: what the reviewer wrote under `uncertain:` and what the
  // classification withdrew for a confidence below the threshold. Neither is a finding and
  // neither was reaching the pull request at all.
  it("renders the uncertain list of both reviews", () => {
    const b = body();
    expect(b).toContain("### Uncertain (2)");
    expect(b).toContain(
      "Not reported as findings: no quotable line, or scored below the threshold.",
    );
    expect(b).toContain("spec/out-of-scope — the shared trim helper");
    expect(b).toContain("perf/inefficiency — confidence 5 is below the threshold of 7");
    // The plan review's own, under its own section.
    expect(b).toContain("plan/out-of-scope — the trim helper");
    expect(b).toContain("### Uncertain (1)");
  });

  it("states how the review ran", () => {
    expect(body()).toMatch(/How it ran: fan-out `criteria, bugs.*`; scored by `sonnet`/);
  });

  // A finding names the criterion it is about by number, and the sections number their
  // findings from 1 each, so "should 2" is unambiguous.
  it("numbers the criteria evidence and the findings", () => {
    const b = body();
    expect(b).toContain("1. met — tests/unit/lib/format.test.ts:41");
    expect(b).toContain("3. met — src/lib/format.ts:18");
    expect(b).toMatch(/### Must \(1\)\n\n[^\n]+\n\n1\. `tests\/passes-without-change`/);
    expect(b).toMatch(/1\. `bug\/general-case`/);
    expect(b).toMatch(/2\. `tests\/no-positive-control`/);
  });

  // The gate refuses to publish a must finding at all, so this section exists for the one
  // case that gets past it — a body rendered by hand — and says so in its own intro.
  it("renders a must section only when one exists", () => {
    expect(body()).toContain("### Must (1)");
    expect(body()).toContain("These block; this body should not exist.");
    const clean = { ...review, findings: [], uncertain: [] };
    const b = prBody(42, impl, clean, planReview, null, "host/ada", "abc1234", {
      rounds: { fix: 0, cap: 2 },
    });
    expect(b).not.toContain("### Must");
  });

  it("says both reviews were clean in one line each", () => {
    const b = prBody(
      42,
      impl,
      { ...review, findings: [], uncertain: [] },
      { ...planReview, findings: [], uncertain: [] },
      null,
      "host/ada",
      "abc1234",
    );
    expect(b).toContain("No findings remained after the code review.");
    expect(b).toContain("No findings remained after the plan review.");
    // The account still says what the review did: clean is a verdict, not an absence.
    expect(b).toContain("Red step: `not-proven`");
  });

  // Every section renderer returns lines, because this filter works on array elements and
  // never sees a `"\n\n"` inside one. A renderer that joined its own output would collapse
  // the sections it separated.
  it("keeps at most one blank line between sections", () => {
    expect(body()).not.toContain("\n\n\n");
    expect(prBody(42, impl, null, null, null, "host/ada", null, atCap)).not.toContain("\n\n\n");
  });

  // The evidence check's withdrawals. They are not findings any more and must not be
  // rendered as ones, and they are not in `report.uncertain` either: only the decision
  // knows them.
  it("lists what the evidence check withdrew, with the note saying why", () => {
    const withdrawn = decide(review, attempts({ fix: 2 }), cfg, {
      stage: "code-review",
      // A worktree with none of the quoted files in it: every claim the check may touch
      // is withdrawn.
      worktree: tempDir("autoclaude-empty-"),
    });
    const b = prBody(42, impl, review, planReview, null, "host/ada", "abc1234", {
      rounds: { fix: 2, cap: 2 },
      decision: withdrawn,
    });
    // The fixture's report is `red-step: not-proven`, so its `tests/` must is the one
    // finding the check does not touch: the parser refuses that report without it, and a
    // body that dropped it would tick a proof the review says is missing. The three claims about a line are gone.
    expect(b).toMatch(/### Must \(1\)\n\n[^\n]+\n\n1\. `tests\/passes-without-change`/);
    expect(b).not.toContain("### Should, open");
    expect(b).toContain("the quoted line was not found within 5 lines of");
    expect(b).toContain("### Uncertain (5)");
  });

  it("marks a finding an earlier round already reported", () => {
    const repeat = decide(review, attempts({ fix: 2 }), cfg, {
      stage: "code-review",
      previous: review,
    });
    const b = prBody(42, impl, review, planReview, null, "host/ada", "abc1234", {
      rounds: { fix: 2, cap: 2 },
      decision: repeat,
    });
    expect(b).toContain("(noted in an earlier round)");
  });
});

// The step itself under test, driven by a fake runner against a temporary root. Every
// input is read and every gate passed before the first command that changes anything
// outside the worktree; the cases below cover the gates, the lease, the retry and the
// conflict.
describe("publish, the step from a reviewed worktree to a pull request", () => {
  const now = new Date("2026-09-08T22:00:00Z");

  /** The line every report below quotes, at line 3 of `src/a.ts` in the worktree. */
  const EVIDENCE = "const a = 1;";

  /** A code-review block with the given findings, in the shape the parser contracts for. */
  const block = (findings: string[], uncertain: string[] = []) =>
    [
      "AUTODEV-CODE-REVIEW",
      "issue: 9",
      "red-step: proven",
      "fan-out: criteria, bugs, tests",
      "scored-by: sonnet",
      "criteria:",
      "  1. met — src/a.ts:3",
      "findings:",
      ...findings,
      "uncertain:",
      ...uncertain.map((u) => `  - ${u}`),
      "CODE-REVIEW-STATUS: complete",
      "",
    ].join("\n");

  const found = (rule: string, confidence: number, message: string) => [
    `  - rule: ${rule}`,
    `    confidence: ${confidence}`,
    "    file: src/a.ts",
    "    line: 3",
    `    evidence: "${EVIDENCE}"`,
    `    message: ${message}`,
  ];

  const MUST = found("bug/general-case", 9, "Handles the example, not the class it stands for.");
  const SHOULD = found(
    "tests/no-positive-control",
    8,
    "No sibling test shows the counter counting.",
  );
  const LATER = found("scope/follow-up", 7, "The placeholder is worth its own issue.");
  /** The review the default setup publishes: nothing found, so the decision is `publish`. */
  const CLEAN = block([]);
  const OPEN = block(
    [...SHOULD, ...LATER],
    ["perf/inefficiency — the fold's cost was not measured"],
  );

  /** A root with a ledger entry for #9, archived implement and plan-review reports, and a live review report. */
  function setup(
    opts: {
      pr?: number;
      pushedSha?: string;
      review?: string | null;
      implement?: boolean;
      planReview?: boolean;
      /** What the row's `branch` field holds: a hand-edited or mistyped name is the point. */
      branch?: string;
      attempts?: Partial<LedgerEntry["attempts"]>;
    } = {},
  ) {
    const root = tempDir("autoclaude-publish-");
    const wt = join(root, "wt");
    mkdirSync(join(wt, ".autoclaude", "state", "reports"), { recursive: true });
    // The file the reports quote. Without it the evidence check withdraws every finding,
    // and a body test would pass against an empty section.
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), `// 1\n// 2\n${EVIDENCE}\n// 4\n`);
    if (opts.review !== null) {
      writeFileSync(
        join(wt, ".autoclaude", "state", "reports", "code-review.md"),
        opts.review ?? CLEAN,
      );
    }
    if (opts.implement !== false) {
      mkdirSync(join(root, ".autoclaude", "state", "runs", "9"), { recursive: true });
      writeFileSync(
        join(root, ".autoclaude", "state", "runs", "9", "implement-1.md"),
        fx("implement"),
      );
    }
    if (opts.planReview !== false) {
      mkdirSync(join(root, ".autoclaude", "state", "runs", "9"), { recursive: true });
      writeFileSync(
        join(root, ".autoclaude", "state", "runs", "9", "plan-review-1.md"),
        fx("plan-review"),
      );
    }
    const ledger = emptyLedger("me");
    transition(
      ledger,
      9,
      "code-reviewing",
      {
        title: "t",
        branch: opts.branch ?? "agent/9-x",
        worktree: wt,
        pr: opts.pr ?? null,
        pushedSha: opts.pushedSha ?? null,
        attempts: attempts(opts.attempts),
      },
      now,
    );
    saveLedger(root, ledger, now);
    return { root, wt };
  }

  /** Answers by command prefix (after the -c core.quotePath=false git() prepends); records every call. */
  function fake(overrides: Record<string, { status?: number; stdout?: string }> = {}) {
    const calls: string[] = [];
    const stdin: Record<string, string> = {};
    const answers: Record<string, { status?: number; stdout?: string }> = {
      "git -c core.quotePath=false fetch": {},
      // One git directory for the root and the worktree alike (F9).
      "git rev-parse --git-common-dir": { stdout: "/repo/.git\n" },
      "git -c core.quotePath=false rev-parse HEAD": { stdout: "abc123\n" },
      "git rebase": {},
      "git merge-base --is-ancestor": {},
      "git -c core.quotePath=false diff --name-only --no-renames": { stdout: "src/a.ts\n" },
      "git -c core.quotePath=false push": {},
      "git -c core.quotePath=false ls-remote": { stdout: "" },
      "git -c core.quotePath=false log -1": { stdout: "feat: the change\n" },
      "git -c core.quotePath=false rev-parse --short": { stdout: "ab12\n" },
      // The branch gate's own question, read for its status, so it does not go through the
      // throwing `git()` helper and carries no `-c core.quotePath=false`. `agent/9-x` is a
      // legal ref, which is what git answers here; the names the gate refuses in the case
      // below are all refused by an equality, the prefix or the colon, before this runs.
      "git check-ref-format": {},
      "gh -R o/r pr create": { stdout: "https://github.com/o/r/pull/77\n" },
      // Read back to decide the label rules; no labels unless a case says so.
      "gh -R o/r pr view": { stdout: JSON.stringify({ labels: [] }) },
      "gh -R o/r pr edit": {},
      ...overrides,
    };
    // Longest matching prefix wins, so an override for one merge-base question does not
    // shadow the general answer for the other.
    const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
    const exec: Exec = (cmd, args, opts) => {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      const key = keys.find((k) => line.startsWith(k));
      if (opts?.input !== undefined && key !== undefined) stdin[key] = opts.input;
      if (key === undefined) return { status: 1, stdout: "", stderr: `no answer for: ${line}` };
      return { status: answers[key]?.status ?? 0, stdout: answers[key]?.stdout ?? "", stderr: "" };
    };
    return { exec, calls, stdin };
  }
  const pushes = (calls: string[]) => calls.filter((c) => c.includes(" push "));
  /**
   * Every call but the branch gate's own `git check-ref-format`, for the refusals that
   * promise "nothing ran".
   *
   * That one is a read of a name, with no repository and no side effect — the same
   * distinction `rollback.test.ts` draws with its `mutations()` filter. Asserting the raw
   * list as empty would now be asserting where the gate sits rather than that nothing
   * happened.
   */
  const beyondTheGate = (calls: string[]) =>
    calls.filter((c) => !c.startsWith("git check-ref-format"));
  const log = (root: string) =>
    readFileSync(join(root, ".autoclaude", "state", "runs", "9", "events.log"), "utf8")
      .trim()
      .split("\n");

  it("reads the reports, rebases, gates, pushes with -u, opens the pull request and records it", () => {
    const { root } = setup();
    const f = fake();
    const r = publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
    expect(r).toMatchObject({ code: 0, pr: 77, pushed: "abc123" });
    // A full refspec, both sides spelled out, so the stored name can never name a
    // different destination: `entry.branch` is free text with three writers, and
    // `git push upstream agent/9-x:develop` sends this worktree's branch — rebased onto
    // upstream/develop a few lines above — to remote `develop` as a fast-forward, no pull
    // request, no force. The `--branch` gate refuses a colon now; this is the second fence,
    // in the one place that pushes.
    expect(pushes(f.calls)).toEqual([
      "git -c core.quotePath=false push -u upstream refs/heads/agent/9-x:refs/heads/agent/9-x",
    ]);
    const e = loadLedger(root, "me").issues["9"]!;
    expect(e.state).toBe("pr-open");
    expect(e.pr).toBe(77);
    expect(e.pushedSha).toBe("abc123");
  });

  /**
   * The row's branch, through the one rule the ledger's branch setter and the rollback
   * already apply.
   *
   * This gate was `entry.branch.startsWith(cfg.branchPrefix)`, which is every agent branch
   * of every issue: a row naming `agent/91-bar` under issue 9 pushed that branch and opened
   * a pull request for it, and `develop` fails only the prefix, not the reading. The
   * refspec stops a stored name from choosing its own destination; it does not
   * stop the wrong branch being published. `notIssueBranch` is the rule, and it runs before
   * the fetch, so nothing has happened when it refuses.
   */
  it("refuses a row whose branch is not this issue's, before any git command runs", () => {
    for (const branch of [
      "agent/91-bar",
      "agent/8-other",
      "develop",
      "main",
      "agent/9-x:develop",
    ]) {
      const { root } = setup({ branch });
      const f = fake();
      expect(
        () => publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
        branch,
      ).toThrow(/branch/);
      // The remedy names a ledger field to correct, never a script of the source product.
      let message = "";
      try {
        publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
      } catch (error) {
        message = String(error);
      }
      expect(message, branch).not.toMatch(/\.ts\b|npx/);
      expect(pushes(f.calls), branch).toEqual([]);
      // Every one of these is refused by an equality, the prefix or the colon, so the
      // gate's own `check-ref-format` is not even reached: nothing ran at all.
      expect(f.calls, branch).toEqual([]);
    }
    // And the issue's own branch still publishes, which is the control this gate needs.
    const { root } = setup();
    const g = fake();
    expect(
      publish(9, false, { exec: g.exec, forge: new Forge("o/r", g.exec), root, cfg, now }),
    ).toMatchObject({ code: 0, pr: 77 });
  });

  // `labelRules` (design section 8.2) replaces the browser-review special case: the label
  // is the only channel a downstream workflow reads, and the rule is applied here from
  // the paths this diff changed, to the labels of the *pull request*.
  it("labels the pull request from the label rules when the diff matches one", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false diff --name-only --no-renames": {
        stdout: "src/ui/Button.tsx\n",
      },
    });
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    expect(f.calls).toContain("gh -R o/r pr edit 77 --add-label review:ui");
  });

  it("does not label a diff that no label rule matches", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false diff --name-only --no-renames": { stdout: "src/server/db.ts\n" },
    });
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    expect(f.calls.some((c) => c.includes("--add-label review:ui"))).toBe(false);
  });

  // A human's suppression survives the next push, which runs this whole path again.
  it("obeys a rule's suppressing label instead of re-applying it", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false diff --name-only --no-renames": {
        stdout: "src/ui/Button.tsx\n",
      },
      "gh -R o/r pr view": { stdout: JSON.stringify({ labels: [{ name: "review:ui-skip" }] }) },
    });
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    expect(f.calls.some((c) => c.includes("--add-label"))).toBe(false);
  });

  it("carries the archived plan review's warnings into the pull request body", () => {
    const { root } = setup();
    const f = fake();
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    const body = f.stdin["gh -R o/r pr create"];
    expect(body).toContain("## Plan review");
    expect(body).toContain("plan/test-asserts-mock");
  });

  it("says the plan review is missing rather than rendering it as clean", () => {
    const { root } = setup({ planReview: false });
    const f = fake();
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    expect(f.stdin["gh -R o/r pr create"]).toContain("No plan review report was available.");
  });

  // a rename out of a forbidden path shows both sides with --no-renames, and the
  // gate runs before the push. Policy-adjacent paths are fenced the same way.
  it("refuses to push a diff that touches a forbidden or policy-adjacent path", () => {
    for (const listed of ["POLICY.md\nPOLICY.old.md\n", "src/features/profile/queries.ts\n"]) {
      const { root } = setup();
      const f = fake({
        "git -c core.quotePath=false diff --name-only --no-renames": { stdout: listed },
      });
      expect(() =>
        publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
      ).toThrow(/refusing to push/);
      expect(pushes(f.calls)).toEqual([]);
    }
  });

  // F9: the fetch, the rebase and the push carry the engine's credentials; a worktree whose
  // `.git` a stage pointed at another git directory gets none of them.
  it("refuses before the fetch when the worktree's git directory is not the project's", () => {
    const { root, wt } = setup();
    const f = fake();
    const exec: Exec = (cmd, args, o) =>
      cmd === "git" && args.includes("--git-common-dir") && o?.cwd === wt
        ? { status: 0, stdout: "/elsewhere/.git\n", stderr: "" }
        : f.exec(cmd, args, o);
    expect(() =>
      publish(9, false, { exec, forge: new Forge("o/r", exec), root, cfg, now }),
    ).toThrow(/uses the git directory .*elsewhere.*not this project's .*refusing to push/);
    expect(f.calls.filter((c) => / (fetch|rebase|push) /.test(` ${c} `))).toEqual([]);
  });

  // R72: what the engine placed in the worktree never leaves it, whatever the project's
  // `.gitignore` says — its state, and a copied entry the base does not track.
  it("refuses a diff that adds or changes the engine's state under .autoclaude/state/", () => {
    for (const listed of [
      ".autoclaude/state/reports/code-review.md\n",
      ".autoclaude/state/bootstrapped\n",
    ]) {
      const { root } = setup();
      const f = fake({
        "git -c core.quotePath=false diff --name-only --no-renames": { stdout: listed },
      });
      expect(() =>
        publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
      ).toThrow(/engine's own state under \.autoclaude\/state\/, refusing to push/);
      expect(pushes(f.calls)).toEqual([]);
    }
  });

  it("refuses a diff that adds a worktrees.copy entry the base does not track, file or directory", () => {
    for (const listed of [".env.local\n", "src/a.ts\nconf/secrets/key.pem\n"]) {
      const { root } = setup();
      // `git cat-file -e` has no answer here: the base does not have the entry.
      const f = fake({
        "git -c core.quotePath=false diff --name-only --no-renames": { stdout: listed },
      });
      expect(() =>
        publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
      ).toThrow(/copied into the worktree \(worktrees\.copy, not tracked on upstream\/develop\)/);
      expect(pushes(f.calls)).toEqual([]);
    }
    // The positive control: an entry the base tracks is the project's own file to change.
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false diff --name-only --no-renames": { stdout: ".env.local\n" },
      "git cat-file -e upstream/develop:.env.local": {},
    });
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
  });

  // an update names the last pushed commit as the lease. Without a recorded
  // sha, the remote head may only be leased on when the worktree already had it before
  // the rebase; a commit nobody here has seen refuses the push. Never a bare lease.
  const remote = {
    "git -c core.quotePath=false ls-remote": { stdout: "remote1\trefs/heads/agent/9-x\n" },
  };
  it("pushes an update with an explicit lease", () => {
    const a = setup({ pr: 77, pushedSha: "old1" });
    const fa = fake(remote);
    publish(9, true, { exec: fa.exec, forge: new Forge("o/r", fa.exec), root: a.root, cfg, now });
    expect(pushes(fa.calls)).toEqual([
      "git -c core.quotePath=false push --force-with-lease=refs/heads/agent/9-x:old1 -u upstream refs/heads/agent/9-x:refs/heads/agent/9-x",
    ]);
    expect(fa.calls.some((c) => c.startsWith("gh -R o/r pr create"))).toBe(false);

    const b = setup({ pr: 77 });
    const fb = fake({ ...remote, "git merge-base --is-ancestor remote1 abc123": { status: 0 } });
    publish(9, true, { exec: fb.exec, forge: new Forge("o/r", fb.exec), root: b.root, cfg, now });
    expect(pushes(fb.calls)[0]).toContain("--force-with-lease=refs/heads/agent/9-x:remote1");

    const c = setup({ pr: 77 });
    const fc = fake({ ...remote, "git merge-base --is-ancestor remote1 abc123": { status: 1 } });
    expect(() =>
      publish(9, true, { exec: fc.exec, forge: new Forge("o/r", fc.exec), root: c.root, cfg, now }),
    ).toThrow(/never had/);
    expect(pushes(fc.calls)).toEqual([]);
  });

  // a retry after the push succeeded but the pull request did not get recorded takes
  // the lease path and creates the pull request once; a leftover branch of an earlier
  // attempt is refused the same way as a foreign commit.
  it("retries after a partial success without a second pull request, and refuses an earlier attempt's branch", () => {
    const partial = setup({ pushedSha: "abc123" });
    const fp = fake(remote);
    const r = publish(9, false, {
      exec: fp.exec,
      forge: new Forge("o/r", fp.exec),
      root: partial.root,
      cfg,
      now,
    });
    expect(r).toMatchObject({ code: 0, pr: 77 });
    expect(pushes(fp.calls)[0]).toContain("--force-with-lease=refs/heads/agent/9-x:abc123");
    expect(fp.calls.filter((c) => c.startsWith("gh -R o/r pr create"))).toHaveLength(1);

    const leftover = setup();
    const fl = fake({ ...remote, "git merge-base --is-ancestor remote1 abc123": { status: 1 } });
    expect(() =>
      publish(9, false, {
        exec: fl.exec,
        forge: new Forge("o/r", fl.exec),
        root: leftover.root,
        cfg,
        now,
      }),
    ).toThrow(/earlier attempt/);
    expect(pushes(fl.calls)).toEqual([]);
    // Defect 8 is about remedies: it names the verb that clears the branch, and no script
    // path of the product this was ported from.
    expect(() =>
      publish(9, false, {
        exec: fl.exec,
        forge: new Forge("o/r", fl.exec),
        root: leftover.root,
        cfg,
        now,
      }),
    ).toThrow(/autoclaude rollback 9/);
  });

  // the inputs are read before anything is pushed, and a missing or
  // unfinished review is a refusal, not "no findings".
  it("touches nothing when a report is missing or the review is unfinished", () => {
    const noImpl = setup({ implement: false });
    const f1 = fake();
    expect(() =>
      publish(9, false, {
        exec: f1.exec,
        forge: new Forge("o/r", f1.exec),
        root: noImpl.root,
        cfg,
        now,
      }),
    ).toThrow(/implement report/);
    expect(beyondTheGate(f1.calls)).toEqual([]);

    const noReview = setup({ review: null });
    const f2 = fake();
    expect(() =>
      publish(9, false, {
        exec: f2.exec,
        forge: new Forge("o/r", f2.exec),
        root: noReview.root,
        cfg,
        now,
      }),
    ).toThrow(/review/);
    expect(beyondTheGate(f2.calls)).toEqual([]);

    const unfinished = setup({
      review: CLEAN.replace("CODE-REVIEW-STATUS: complete", "CODE-REVIEW-STATUS: incomplete"),
    });
    const f3 = fake();
    expect(() =>
      publish(9, false, {
        exec: f3.exec,
        forge: new Forge("o/r", f3.exec),
        root: unfinished.root,
        cfg,
        now,
      }),
    ).toThrow(/not marked complete/);
    expect(beyondTheGate(f3.calls)).toEqual([]);
  });

  // The CLI decides completeness before the code review's own checks. publish.ts has to
  // agree, or a manual run on a stopped review blames the missing verdict instead.
  it("calls a stopped review unfinished even when it never wrote its verdict", () => {
    const early = setup({
      review: CLEAN.replace(/^red-step:.*\n/m, "").replace(
        "CODE-REVIEW-STATUS: complete",
        "CODE-REVIEW-STATUS: stopped",
      ),
    });
    const f = fake();
    expect(() =>
      publish(9, false, {
        exec: f.exec,
        forge: new Forge("o/r", f.exec),
        root: early.root,
        cfg,
        now,
      }),
    ).toThrow(/not marked complete/);
    expect(beyondTheGate(f.calls)).toEqual([]);
  });

  // publish.ts only ever publishes a worktree review, and a worktree always has its issue.
  // `criteria: none` here is a review that skipped the criteria angle; the parser accepts
  // the sentinel from any review, so this is the one place that can refuse it.
  it("refuses a worktree review that says it had no criteria", () => {
    const none = setup({
      review: CLEAN.replace("criteria:\n  1. met — src/a.ts:3", "criteria: none"),
    });
    const f = fake();
    expect(() =>
      publish(9, false, {
        exec: f.exec,
        forge: new Forge("o/r", f.exec),
        root: none.root,
        cfg,
        now,
      }),
    ).toThrow(/criteria: none/);
    expect(beyondTheGate(f.calls)).toEqual([]);
  });

  // exit 3 is a conflict and nothing else; the conflicting files come back with it.
  it("reports a conflict with git's own lines, and any other rebase failure as an error", () => {
    const c = setup();
    const fc = fake({
      "git rebase": { status: 1, stdout: "CONFLICT (content): Merge conflict in src/a.ts\n" },
    });
    const r = publish(9, false, {
      exec: fc.exec,
      forge: new Forge("o/r", fc.exec),
      root: c.root,
      cfg,
      now,
    });
    expect(r.code).toBe(3);
    if (r.code === 3) expect(r.conflict).toContain("src/a.ts");
    expect(fc.calls.some((x) => x.startsWith("git rebase --abort"))).toBe(true);
    expect(pushes(fc.calls)).toEqual([]);

    const d = setup();
    const fd = fake({
      "git rebase": { status: 1, stdout: "error: cannot rebase: You have unstaged changes.\n" },
    });
    expect(() =>
      publish(9, false, {
        exec: fd.exec,
        forge: new Forge("o/r", fd.exec),
        root: d.root,
        cfg,
        now,
      }),
    ).toThrow(/unstaged/);
  });

  // Defence in depth: the orchestrator runs decision.ts and does what it says, and
  // this asks the same function again. A must finding at the cap blocks the issue, and a
  // pull request opened for it would be exactly the body whose own Must section says it
  // should not exist.
  it("refuses to publish a review with a must finding, before any command runs", () => {
    const { root, wt } = setup({ review: block([...MUST, ...SHOULD]), attempts: { fix: 2 } });
    const f = fake();
    expect(() =>
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toThrow(/the review decides `block` \(.*\); refusing to publish/);
    expect(beyondTheGate(f.calls)).toEqual([]);
    // Nothing was archived either: the report stays where the next stage reads it.
    expect(existsSync(join(wt, ".autoclaude", "state", "reports", "code-review.md"))).toBe(true);
  });

  it("refuses a review whose decision is a fix round", () => {
    const { root } = setup({ review: block(MUST) });
    const f = fake();
    expect(() =>
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toThrow(/the review decides `fix`/);
    expect(beyondTheGate(f.calls)).toEqual([]);
  });

  // Check 3 and check 6 of can-merge read these two off the archive header, and this is
  // the one place that holds both: the tip the review was read at, and the sha the push
  // sent. A sha out of the report block would be a model's claim.
  it("stamps the archived review with the reviewed and the pushed sha", () => {
    const { root } = setup();
    const f = fake();
    // HEAD moves between the two reads, as a rebase moves it. One answer for both would
    // let a stamp that read the same sha twice pass.
    let reads = 0;
    const exec: Exec = (cmd, args, opts) =>
      args.join(" ").endsWith("rev-parse HEAD")
        ? { status: 0, stdout: reads++ === 0 ? "reviewed1\n" : "pushed2\n", stderr: "" }
        : f.exec(cmd, args, opts);
    expect(
      publish(9, false, { exec, forge: new Forge("o/r", exec), root, cfg, now }),
    ).toMatchObject({
      code: 0,
      pushed: "pushed2",
    });
    const archived = readFileSync(
      join(root, ".autoclaude", "state", "runs", "9", "code-review-1.md"),
      "utf8",
    );
    const header = parseArchiveHeader(archived);
    expect(header.reviewed).toBe("reviewed1");
    expect(header.head).toBe("pushed2");
    expect(header.stage).toBe("code-review");
  });

  // Check 3 of can-merge used to re-derive the classes from the archived text, against
  // whatever catalogue happened to be on disk and without the evidence check — so a must
  // this decision withdrew was still a must there, and the pull request could never be
  // merged. The decision that was acted on is stamped beside the two shas.
  it("stamps the decision it acted on into the archive", () => {
    const { root } = setup({ pr: 77, pushedSha: "old1", review: OPEN, attempts: { fix: 2 } });
    const f = fake(remote);
    expect(
      publish(9, true, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    const header = parseArchiveHeader(
      readFileSync(join(root, ".autoclaude", "state", "runs", "9", "code-review-1.md"), "utf8"),
    );
    expect(header.decision).toBe("publish");
    // The counts are the findings that stood, by tier: the report carries one should and
    // one later, both quoting a line the worktree has.
    expect([header.must, header.should, header.later]).toEqual(["0", "1", "1"]);
    expect(header.withdrawn).toBe("0");
  });

  it("stamps a withdrawn finding as withdrawn rather than as open", () => {
    // The same should finding, quoting a line the worktree does not have: the evidence
    // check withdraws it, the decision publishes, and check 3 must count what the
    // decision counted — not the must the raw report still states.
    const gone = block(
      [
        "  - rule: bug/general-case",
        "    confidence: 9",
        "    file: src/gone.ts",
        "    line: 40",
        '    evidence: "open(fd);"',
        "    message: Handles the example, not the class it stands for.",
      ],
      [],
    );
    const { root } = setup({ review: gone });
    const f = fake();
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0 });
    const header = parseArchiveHeader(
      readFileSync(join(root, ".autoclaude", "state", "runs", "9", "code-review-1.md"), "utf8"),
    );
    expect([header.decision, header.must, header.withdrawn]).toEqual(["publish", "0", "1"]);
  });

  // The flag was read once, to refuse `--update` without a pull request, and the body was
  // rewritten whenever one existed — so `publish.ts <issue>` typed by hand overwrote a
  // body nobody asked it to touch, against the file's own header.
  it("keeps the body without --update", () => {
    const { root } = setup({ pr: 77, pushedSha: "old1", review: OPEN, attempts: { fix: 2 } });
    const f = fake(remote);
    expect(
      publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0, pr: 77 });
    expect(f.calls.some((c) => c.startsWith("gh -R o/r pr edit 77 --body-file"))).toBe(false);
    // Everything else still happened: the push, the labels and the archive do not depend
    // on the flag.
    expect(pushes(f.calls)).toHaveLength(1);
  });

  // The body written at creation used to stay put through every CI fix round, so a human
  // read the first review's sections against the third push's diff. A hand edit to an
  // agent's body is lost with this, which is the accepted trade.
  it("rewrites the body on --update", () => {
    const { root } = setup({ pr: 77, pushedSha: "old1", review: OPEN, attempts: { fix: 2 } });
    const f = fake(remote);
    expect(
      publish(9, true, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now }),
    ).toMatchObject({ code: 0, pr: 77 });
    expect(f.calls).toContain("gh -R o/r pr edit 77 --body-file -");
    expect(f.calls.some((c) => c.startsWith("gh -R o/r pr create"))).toBe(false);
    const body = f.stdin["gh -R o/r pr edit"];
    expect(body).toContain("Closes #9");
    expect(body).toContain("### Should, open (1)");
    expect(body).toContain("### Later (1)");
    expect(body).toContain("### Uncertain (1)");
  });

  // Every transition the engine makes writes its line to the
  // issue's events log, so a human following a run sees the push and the pull request
  // rather than a gap between `code-reviewing` and a pull request that exists.
  it("writes each of its transitions to the events log, ending at pr-open", () => {
    const { root } = setup();
    const f = fake();
    publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
    const lines = log(root);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("pushed abc123");
    expect(lines[1]).toContain("pull request #77 opened");
    expect(lines[2]).toContain("-> pr-open");
    for (const l of lines) expect(l).toContain("#9");
  });

  // Every git argv and every derived ref names `forge.remote`, never a literal. The
  // config states `upstream`; a call that still said `origin` would be pushing to a
  // remote this project does not have.
  it("names the configured remote in every git call and every derived ref", () => {
    const { root } = setup();
    const f = fake();
    // HEAD moves between the two reads, as a rebase moves it, so the short sha of the base
    // is asked for as well.
    let reads = 0;
    const exec: Exec = (cmd, args, opts) =>
      args.join(" ").endsWith("rev-parse HEAD")
        ? { status: 0, stdout: reads++ === 0 ? "before1\n" : "after2\n", stderr: "" }
        : f.exec(cmd, args, opts);
    publish(9, false, { exec, forge: new Forge("o/r", exec), root, cfg, now });
    const git = f.calls.filter((c) => c.startsWith("git"));
    expect(git.some((c) => c.includes("fetch upstream develop --quiet"))).toBe(true);
    expect(f.calls).toContain("git rebase upstream/develop");
    expect(f.calls).toContain("git -c core.quotePath=false rev-parse --short upstream/develop");
    expect(f.calls.filter((c) => /\borigin\b/.test(c))).toEqual([]);
  });

  it("opens the pull request with the title stripped of CI skip markers, and the configured footer", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false log -1": { stdout: "feat: the change [skip ci]\n" },
    });
    publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
    const create = f.calls.find((c) => c.startsWith("gh -R o/r pr create"))!;
    expect(create).toBe(
      "gh -R o/r pr create --base develop --head agent/9-x --title feat: the change (#9) --body-file -",
    );
    expect(f.stdin["gh -R o/r pr create"]!.trimEnd().endsWith("Posted by the test footer")).toBe(
      true,
    );
  });

  // Defect 6: the diff that needs a human's label says so in the body, from the config's
  // `humanApproval` entries rather than from one product's directory.
  it("states which files need which human label when the diff matches a humanApproval entry", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false diff --name-only --no-renames": {
        stdout: "src/a.ts\ndb/migrations/001.sql\n",
      },
    });
    publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
    expect(f.stdin["gh -R o/r pr create"]).toContain(
      "This diff touches `db/migrations/001.sql`. It may only be merged by a human, or after a human applies `human-approved`.",
    );
  });

  it("says nothing of human approval for a diff no entry matches", () => {
    const { root } = setup();
    const f = fake();
    publish(9, false, { exec: f.exec, forge: new Forge("o/r", f.exec), root, cfg, now });
    expect(f.stdin["gh -R o/r pr create"]).not.toContain("may only be merged by a human");
  });

  it("resolves the repository from the configured remote when no forge is handed in", () => {
    const { root } = setup();
    const f = fake({
      "git -c core.quotePath=false remote get-url upstream": {
        stdout: "https://github.com/o/r.git\n",
      },
    });
    expect(publish(9, false, { exec: f.exec, root, cfg, now })).toMatchObject({ code: 0, pr: 77 });
    expect(f.calls.some((c) => c.startsWith("gh -R o/r pr create"))).toBe(true);
  });
});
