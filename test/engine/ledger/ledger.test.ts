import { afterAll, describe, it, expect } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  activeClaims,
  appendTransitions,
  emptyLedger,
  flag,
  gatherFacts,
  issueArg,
  loadLedger,
  parseClaim,
  recentNotes,
  recordedInstance,
  reconcile,
  renameWithRetry,
  renderStatus,
  saveLedger,
  transition,
  archivePlanFile,
  archiveReport,
  archivedReportsOf,
  decisionStamp,
  entryForPr,
  ledgerCli,
  parseArchiveHeader,
  parseDecisionStamp,
  readLatestReport,
  parseLimit,
  updateLedger,
  withLedgerLock,
  withLedgerLockAsync,
  type GitHubFacts,
} from "../../../src/engine/ledger/ledger.js";
import { loadProjectConfig } from "../../../src/config/load.js";
import type { ProjectConfig } from "../../../src/config/types.js";
import type { Forge, IssueView } from "../../../src/forge/github.js";
import type { Stage } from "../../../src/engine/review/reports.js";

const cfg = {
  branches: { integration: "develop", production: "main" },
  forge: { remote: "origin" },
  branchPrefix: "agent/",
  labels: {
    working: "agent-working",
    blocked: "agent-blocked",
    needsShaping: "needs-shaping",
    fixRound: "agent-fix-",
    reviewRetry: "agent-retry-",
  },
  queue: { ready: "agent-ready" },
  caps: { staleClaimHours: 2 },
} as unknown as ProjectConfig;

const now = new Date("2026-09-08T22:00:00Z");

// Every temporary root this file makes, removed at the end: a test run left a tree per
// case behind, and on the orchestrator machine the red step runs the suite all night
//.
const tempRoots: string[] = [];
function tempRoot(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(r);
  return r;
}
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
const claimComment = (machine: string, at: string) => ({
  author: { login: "octo" },
  createdAt: at,
  body: `<!-- autodev-claim machine="${machine}" at="${at}" -->\nautodev claim by ${machine}`,
});
const issue = (
  n: number,
  labels: string[],
  comments: IssueView["comments"],
  state: "OPEN" | "CLOSED" = "OPEN",
): IssueView => ({
  number: n,
  title: `Issue ${n}`,
  body: "",
  state,
  labels: labels.map((name) => ({ name })),
  assignees: [],
  comments,
  updatedAt: now.toISOString(),
});

describe("claims", () => {
  it("parses a claim marker and ignores prose", () => {
    expect(parseClaim(claimComment("box-a/dev", "2026-09-08T21:00:00Z").body)).toEqual({
      machine: "box-a/dev",
      at: "2026-09-08T21:00:00Z",
    });
    expect(parseClaim("just a comment")).toBeNull();
  });

  it("counts only claims after the last release, oldest first", () => {
    const comments = [
      claimComment("old", hoursAgo(5)),
      {
        author: { login: "x" },
        createdAt: hoursAgo(4),
        body: '<!-- autodev-release machine="old" -->\nreleased',
      },
      claimComment("b", hoursAgo(1)),
      claimComment("a", hoursAgo(2)),
    ];
    expect(activeClaims(comments).map((c) => c.machine)).toEqual(["a", "b"]);
  });
});

describe("transition", () => {
  it("moves the state, stamps the time, records an event", () => {
    const l = emptyLedger("me");
    transition(
      l,
      126,
      "claimed",
      { title: "t", branch: "agent/126-t", worktree: ".autoclaude/worktrees/agent+126-t" },
      now,
    );
    const e = transition(
      l,
      126,
      "planning",
      {
        stage: {
          stage: "plan",
          mode: "fresh",
          pid: null,
          instance: "me-instance",
          processStartedAt: null,
          startedAt: now.toISOString(),
        },
      },
      now,
    );
    expect(e.state).toBe("planning");
    expect(e.updatedAt).toBe(now.toISOString());
    expect(l.events.map((ev) => ev.to)).toEqual(["claimed", "planning"]);
  });

  it("clears the stage on a state change unless a new one is given", () => {
    const l = emptyLedger("me");
    transition(l, 1, "claimed", { title: "t", branch: "agent/1-t", worktree: "w" }, now);
    transition(
      l,
      1,
      "planning",
      {
        stage: {
          stage: "plan",
          mode: "fresh",
          pid: null,
          instance: "me-instance",
          processStartedAt: null,
          startedAt: now.toISOString(),
        },
      },
      now,
    );
    expect(transition(l, 1, "implementing", {}, now).stage).toBeNull();
  });
});

describe("gatherFacts", () => {
  it("asks the forge for the working label across all states, and for every pull request", () => {
    const calls: unknown[][] = [];
    const forge = {
      listIssues: (...a: unknown[]) => (calls.push(["issues", ...a]), [issue(1, [], [])]),
      listPrs: (...a: unknown[]) => (calls.push(["prs", ...a]), []),
    } as unknown as Forge;
    const facts = gatherFacts(forge, cfg);
    expect(calls).toEqual([
      ["issues", "agent-working", "all"],
      ["prs", "all"],
    ]);
    expect(facts.working).toHaveLength(1);
  });
});

describe("reconcile", () => {
  const facts = (working: IssueView[], prs: GitHubFacts["prs"] = []): GitHubFacts => ({
    working,
    prs,
  });

  it("adopts our claim with an open pull request as pr-open, counters from labels", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [
          issue(
            126,
            ["agent-working", "agent-fix-2", "agent-retry-1"],
            [claimComment("me", hoursAgo(1))],
          ),
        ],
        [
          {
            number: 131,
            state: "OPEN",
            headRefName: "agent/126-slug",
            updatedAt: hoursAgo(1),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    const e = l.issues["126"]!;
    expect(e.state).toBe("pr-open");
    expect(e.pr).toBe(131);
    expect(e.branch).toBe("agent/126-slug");
    expect(e.attempts).toEqual({ implement: 1, fix: 2, reviewRetry: 1, plan: 0 });
  });

  it("adopts our claim with a worktree and no pull request as resume-needed", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts([issue(56, ["agent-working"], [claimComment("me", hoursAgo(1))])]),
      ["C:/repo/.autoclaude/worktrees/agent+56-slug"],
      cfg,
      now,
    );
    expect(l.issues["56"]!.state).toBe("resume-needed");
    expect(l.issues["56"]!.worktree).toBe("C:/repo/.autoclaude/worktrees/agent+56-slug");
  });

  it("adopts our claim with neither as claimed", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts([issue(9, ["agent-working"], [claimComment("me", hoursAgo(1))])]),
      [],
      cfg,
      now,
    );
    expect(l.issues["9"]!.state).toBe("claimed");
  });

  it("keeps a running stage this instance dispatched", () => {
    const l0 = emptyLedger("me", "inst-live");
    transition(l0, 9, "claimed", { title: "t", branch: "agent/9-t", worktree: "w" }, now);
    transition(
      l0,
      9,
      "implementing",
      {
        stage: {
          stage: "implement",
          mode: "fresh",
          pid: null,
          instance: "inst-live",
          processStartedAt: null,
          startedAt: hoursAgo(0.5),
        },
      },
      now,
    );
    const l = reconcile(
      l0,
      facts([issue(9, ["agent-working"], [claimComment("me", hoursAgo(1))])]),
      ["C:/x/.autoclaude/worktrees/agent+9-t"],
      cfg,
      now,
    );
    expect(l.issues["9"]!.state).toBe("implementing");
    expect(l.issues["9"]!.stage?.instance).toBe("inst-live");
  });

  // Design section 5: "if the orchestrator dies, the next run reads the ledger and
  // continues." A stage another instance started is not this instance's child, so it can
  // only be replaced; this replaces the dead-session rule.
  it("marks a stage of another instance resume-needed on reconcile", () => {
    const l0 = emptyLedger("me", "new");
    transition(l0, 9, "claimed", { title: "t", branch: "agent/9-t", worktree: "w" }, now);
    transition(
      l0,
      9,
      "implementing",
      {
        stage: {
          stage: "implement",
          mode: "fresh",
          pid: 4242,
          instance: "old",
          processStartedAt: "Fri Oct 16 10:00:00 2026",
          startedAt: hoursAgo(0.5),
        },
      },
      now,
    );
    const l = reconcile(
      l0,
      facts([issue(9, ["agent-working"], [claimComment("me", hoursAgo(1))])]),
      ["C:/x/.autoclaude/worktrees/agent+9-t"],
      cfg,
      now,
    );
    expect(l.issues["9"]!.state).toBe("resume-needed");
    expect(l.issues["9"]!.stage).toBeNull();
    expect(l.events.at(-1)?.note).toMatch(/belonged to instance old/);
  });

  it("orders competing claims by GitHub's clock, not the claimant's", () => {
    const skewed = { ...claimComment("other", hoursAgo(5)), createdAt: hoursAgo(0.5) };
    const mine = { ...claimComment("me", hoursAgo(1)), createdAt: hoursAgo(1) };
    expect(activeClaims([skewed, mine])[0]!.machine).toBe("me");
  });

  it("prunes finished entries after a week and keeps fresh ones", () => {
    const l0 = emptyLedger("me");
    transition(
      l0,
      20,
      "done",
      { title: "old", branch: "agent/20-x", worktree: "w" },
      new Date(now.getTime() - 8 * 86_400_000),
    );
    transition(l0, 21, "done", { title: "new", branch: "agent/21-x", worktree: "w" }, now);
    const l = reconcile(l0, facts([]), [], cfg, now);
    expect(l.issues["20"]!).toBeUndefined();
    expect(l.issues["21"]!).toBeDefined();
  });

  it("lists another machine's claim as foreign, stale only past the cap with no pull request activity", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [
          issue(1, ["agent-working"], [claimComment("other", hoursAgo(1))]),
          issue(2, ["agent-working"], [claimComment("other", hoursAgo(3))]),
          issue(3, ["agent-working"], [claimComment("other", hoursAgo(3))]),
        ],
        [
          {
            number: 5,
            state: "OPEN",
            headRefName: "agent/3-x",
            updatedAt: hoursAgo(0.5),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    expect(Object.keys(l.issues)).toEqual([]);
    expect(l.foreign.map((f) => [f.issue, f.stale])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it("treats a working label without any claim as a stale unknown claim", () => {
    const l = reconcile(emptyLedger("me"), facts([issue(4, ["agent-working"], [])]), [], cfg, now);
    expect(l.foreign).toEqual([{ issue: 4, machine: "unknown", at: null, stale: true }]);
  });

  it("marks our merged pull request as merged, pending cleanup", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [issue(7, ["agent-working"], [claimComment("me", hoursAgo(6))], "CLOSED")],
        [
          {
            number: 8,
            state: "MERGED",
            headRefName: "agent/7-y",
            updatedAt: hoursAgo(1),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    expect(l.issues["7"]!.state).toBe("merged");
  });

  it("drops an entry whose working label is gone, with an event", () => {
    const l0 = emptyLedger("me");
    transition(l0, 11, "code-reviewing", { title: "t", branch: "agent/11-t", worktree: "w" }, now);
    const l = reconcile(l0, facts([]), [], cfg, now);
    expect(l.issues["11"]!).toBeUndefined();
    expect(l.events.at(-1)?.note).toMatch(/released elsewhere/);
  });

  // One staleness clock, GitHub's, for status and takeover alike.
  it("ages a foreign claim by GitHub's clock, not by the marker the claimant wrote", () => {
    const skewed = { ...claimComment("other", hoursAgo(9)), createdAt: hoursAgo(0.5) };
    const l = reconcile(
      emptyLedger("me"),
      facts([issue(1, ["agent-working"], [skewed])]),
      [],
      cfg,
      now,
    );
    expect(l.foreign[0]!.stale).toBe(false);
  });

  // A human closing the issue or the pull request ends the work.
  it("closes an entry whose issue a human closed, and keeps it closed", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts([issue(12, ["agent-working"], [claimComment("me", hoursAgo(1))], "CLOSED")]),
      ["C:/x/.autoclaude/worktrees/agent+12-t"],
      cfg,
      now,
    );
    expect(l.issues["12"]!.state).toBe("closed");
    expect(
      reconcile(
        l,
        facts([issue(12, ["agent-working"], [claimComment("me", hoursAgo(1))], "CLOSED")]),
        [],
        cfg,
        now,
      ).issues["12"]!.state,
    ).toBe("closed");
  });

  it("blocks an entry whose pull request a human closed without merging", () => {
    const l0 = emptyLedger("me");
    transition(l0, 13, "pr-open", { title: "t", branch: "agent/13-t", worktree: "w", pr: 40 }, now);
    const l = reconcile(
      l0,
      facts(
        [issue(13, ["agent-working"], [claimComment("me", hoursAgo(1))])],
        [
          {
            number: 40,
            state: "CLOSED",
            headRefName: "agent/13-t",
            updatedAt: hoursAgo(0.1),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    expect(l.issues["13"]!.state).toBe("blocked");
    expect(l.issues["13"]!.lastError).toMatch(/closed without merge/);
  });

  // Only pull requests that moved since the current claim belong
  // to this attempt. An earlier attempt's closed pull request neither blocks a fresh
  // claim nor revives its rejected work; this attempt's closed pull request ends the
  // attempt even when the ledger was lost.
  it("lets a second attempt survive its first reconcile after an earlier closed pull request", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [issue(16, ["agent-working"], [claimComment("me", hoursAgo(1))])],
        [
          {
            number: 41,
            state: "CLOSED",
            headRefName: "agent/16-t",
            updatedAt: hoursAgo(5),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    expect(l.issues["16"]!.state).toBe("claimed");
    expect(l.issues["16"]!.pr).toBeNull();
  });

  it("blocks this attempt's closed pull request even with a lost ledger and a worktree on disk", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [issue(17, ["agent-working"], [claimComment("me", hoursAgo(3))])],
        [
          {
            number: 42,
            state: "CLOSED",
            headRefName: "agent/17-t",
            updatedAt: hoursAgo(0.5),
            url: "u",
          },
        ],
      ),
      ["C:/x/.autoclaude/worktrees/agent+17-t"],
      cfg,
      now,
    );
    expect(l.issues["17"]!.state).toBe("blocked");
    expect(l.issues["17"]!.pr).toBe(42);
    expect(l.issues["17"]!.lastError).toMatch(/re-apply agent-ready/);
  });

  it("ignores an earlier attempt's merged pull request on an issue reopened afterwards", () => {
    const l = reconcile(
      emptyLedger("me"),
      facts(
        [issue(18, ["agent-working"], [claimComment("me", hoursAgo(1))])],
        [
          {
            number: 43,
            state: "MERGED",
            headRefName: "agent/18-t",
            updatedAt: hoursAgo(48),
            url: "u",
          },
        ],
      ),
      [],
      cfg,
      now,
    );
    expect(l.issues["18"]!.state).toBe("claimed");
  });

  it("does not revive a blocked entry whose working label survived a partial release", () => {
    const l0 = emptyLedger("me");
    transition(
      l0,
      14,
      "blocked",
      { title: "t", branch: "agent/14-t", worktree: "w", lastError: "x" },
      now,
    );
    const l = reconcile(
      l0,
      facts([issue(14, ["agent-working"], [claimComment("me", hoursAgo(1))])]),
      ["C:/x/.autoclaude/worktrees/agent+14-t"],
      cfg,
      now,
    );
    expect(l.issues["14"]!.state).toBe("blocked");
  });

  // A hand-edited entry without attempts must not crash every tick.
  it("survives an entry without an attempts block", () => {
    const l0 = emptyLedger("me");
    transition(l0, 15, "code-reviewing", { title: "t", branch: "agent/15-t", worktree: "w" }, now);
    delete (l0.issues["15"] as Partial<(typeof l0.issues)[string]>).attempts;
    const l = reconcile(
      l0,
      facts([issue(15, ["agent-working", "agent-fix-1"], [claimComment("me", hoursAgo(1))])]),
      [],
      cfg,
      now,
    );
    expect(l.issues["15"]!.attempts).toEqual({ implement: 0, fix: 1, reviewRetry: 0, plan: 0 });
  });
});

// The CLI clears a stage, validates its enums, and the
// archive numbers one stage's reports without catching a neighbour's files.
describe("ledgerCli and the archive", () => {
  const root = () => tempRoot("autoclaude-ledgercli-");

  it("ends a stage without a state change through --stage none", () => {
    const r = root();
    ledgerCli(
      ["set", "5", "claimed", "--title", "t", "--branch", "agent/5-t", "--worktree", "w"],
      r,
      now,
      cfg,
    );
    ledgerCli(["set", "5", "planning", "--stage", "plan", "--instance", "inst-1"], r, now);
    expect(loadLedger(r, "me").issues["5"]!.stage?.instance).toBe("inst-1");
    ledgerCli(
      ["set", "5", "planning", "--stage", "none", "--note", "interrupted by the limit"],
      r,
      now,
    );
    expect(loadLedger(r, "me").issues["5"]!.stage).toBeNull();
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("planning");
  });

  // The plan-review stage is part of the vocabulary the
  // orchestrator types, for the stage run and for the archive.
  it("accepts plan-review as a stage and as an archive target", () => {
    const r = root();
    const wt = join(r, "wt");
    const reports = join(wt, ".autoclaude", "state", "reports");
    mkdirSync(reports, { recursive: true });
    ledgerCli(
      ["set", "5", "claimed", "--title", "t", "--branch", "agent/5-t", "--worktree", wt],
      r,
      now,
      cfg,
    );
    ledgerCli(
      ["set", "5", "plan-reviewing", "--stage", "plan-review", "--instance", "inst-2"],
      r,
      now,
    );
    expect(loadLedger(r, "me").issues["5"]!.stage?.stage).toBe("plan-review");
    writeFileSync(join(reports, "plan-review.md"), "a plan review");
    expect(ledgerCli(["archive", "5", "plan-review"], r, now)).toMatchObject({
      archived: expect.stringMatching(/plan-review-1.md$/),
    });
  });

  // The orchestrator's one way to file a report it must not decide.
  it("archives a late report aside with --late, and refuses any other flag", () => {
    const r = root();
    const wt = join(r, "wt");
    const reports = join(wt, ".autoclaude", "state", "reports");
    mkdirSync(reports, { recursive: true });
    ledgerCli(
      ["set", "5", "claimed", "--title", "t", "--branch", "agent/5-t", "--worktree", wt],
      r,
      now,
      cfg,
    );
    writeFileSync(join(reports, "code-review.md"), "a review nobody decided on");
    expect(ledgerCli(["archive", "5", "code-review", "--late"], r, now)).toMatchObject({
      archived: expect.stringMatching(/code-review-late-1.md$/),
    });
    expect(() => ledgerCli(["archive", "5", "code-review", "--soon"], r, now)).toThrow(
      /unknown option --soon/,
    );
  });

  it("refuses a state, stage or mode outside the vocabulary", () => {
    const r = root();
    expect(() => ledgerCli(["set", "5", "pr_open"], r, now)).toThrow(/state must be one of/);
    expect(() => ledgerCli(["set", "5", "planning", "--stage", "plann"], r, now)).toThrow(
      /--stage/,
    );
    expect(() =>
      ledgerCli(["set", "5", "planning", "--stage", "plan", "--mode", "fixx"], r, now),
    ).toThrow(/--mode/);
    expect(() => ledgerCli(["set", "5", "planning", "--bump", "retries"], r, now)).toThrow(
      /--bump/,
    );
  });

  // `set` validated only that the number was an integer, so `set 0 claimed` created an
  // entry "0" and every later command warned about `runs/0/events.log` — the check the
  // `note` verb already applies, now the same one for both.
  it("refuses an issue number that is not one, and records nothing for it", () => {
    const r = root();
    // The positive control first: a real number goes through.
    expect(ledgerCli(["set", "5", "claimed", "--title", "t"], r, now)).toMatchObject({
      state: "claimed",
    });
    // `Number` accepts more than a decimal integer: `0x10` is 16 and `1e2` is 100, both
    // whole and positive, so the entry was recorded under a number nobody typed. `+5` and
    // ` 5` are the number a reader expects and are refused all the same — the token is
    // what the ledger is keyed on, and one that is not its own number is a typo.
    for (const bad of ["0", "-3", "x", "5.5", "", "0x10", "1e2", "+5", " 5", "5 "]) {
      expect(() => ledgerCli(["set", bad, "claimed"], r, now), `set "${bad}"`).toThrow(
        /not an issue number/,
      );
      expect(() => ledgerCli(["note", bad, "text"], r, now), `note "${bad}"`).toThrow(
        /not an issue number/,
      );
    }
    expect(Object.keys(loadLedger(r, "me").issues)).toEqual(["5"]);
    expect(readdirSync(join(r, ".autoclaude", "state", "runs"))).toEqual(["5"]);
  });

  it("numbers one stage's archive without counting plan-file or plan-review files", () => {
    const r = root();
    const wt = join(r, "wt");
    const reports = join(wt, ".autoclaude", "state", "reports");
    mkdirSync(reports, { recursive: true });
    const entry = transition(
      emptyLedger("me"),
      9,
      "code-reviewing",
      { title: "t", branch: "agent/9-t", worktree: wt },
      now,
    );
    const runs = join(r, ".autoclaude", "state", "runs", "9");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "plan-file-1.md"), "the plan document");
    writeFileSync(join(runs, "plan-review-1.md"), "a plan review");
    writeFileSync(join(reports, "plan.md"), "first plan report");
    expect(archiveReport(r, entry, "plan")).toMatch(/plan-1\.md$/);
    writeFileSync(join(reports, "plan.md"), "second plan report");
    expect(archiveReport(r, entry, "plan")).toMatch(/plan-2\.md$/);
    // The archive stamps a header line on each file so one issue's directory says which
    // attempt a report came from; the report itself follows it unchanged.
    const latest = readLatestReport(r, entry, "plan");
    expect(latest).toContain("second plan report");
    expect(latest).toMatch(/^<!-- autodev-archive issue="9" stage="plan" n="2"/);
  });

  // One past the highest number, so a gap never overwrites the
  // newest file; the plan file is numbered the same way.
  it("numbers past a gap instead of overwriting the newest archive", () => {
    const r = root();
    const wt = join(r, "wt");
    mkdirSync(join(wt, ".autoclaude", "state", "reports"), { recursive: true });
    mkdirSync(join(wt, ".autoclaude", "state", "plans"), { recursive: true });
    const entry = transition(
      emptyLedger("me"),
      10,
      "code-reviewing",
      { title: "t", branch: "agent/10-t", worktree: wt },
      now,
    );
    const runs = join(r, ".autoclaude", "state", "runs", "10");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "code-review-1.md"), "one");
    writeFileSync(join(runs, "code-review-3.md"), "three");
    writeFileSync(join(runs, "plan-file-2.md"), "old plan");
    writeFileSync(join(wt, ".autoclaude", "state", "reports", "code-review.md"), "four");
    writeFileSync(join(wt, ".autoclaude", "state", "plans", "10.md"), "new plan");
    expect(archiveReport(r, entry, "code-review")).toMatch(/code-review-4\.md$/);
    expect(readFileSync(join(runs, "code-review-3.md"), "utf8")).toBe("three");
    expect(archivePlanFile(r, entry)).toMatch(/plan-file-3\.md$/);
  });

  /**
   * A report that arrives after its round was already decided.
   *
   * It cannot be decided — the round is over and the worktree may already be under a fix
   * round — and it cannot stay in the worktree either, where the next review that ends
   * without a report would have it parsed as its own. So it is filed aside: outside the
   * numbered series, so nothing reads it as a round, and `archivedReportsOf` never offers
   * it as the previous round or as the review a push was stamped on.
   */
  it("files a late report aside, outside the numbered series", () => {
    const r = root();
    const wt = join(r, "wt");
    const reports = join(wt, ".autoclaude", "state", "reports");
    mkdirSync(reports, { recursive: true });
    const entry = transition(
      emptyLedger("me"),
      11,
      "fixing-local",
      { title: "t", branch: "agent/11-t", worktree: wt },
      now,
    );
    const runs = join(r, ".autoclaude", "state", "runs", "11");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "code-review-1.md"), "the round that was decided");

    writeFileSync(join(reports, "code-review.md"), "the late report");
    expect(archiveReport(r, entry, "code-review", {}, undefined, { late: true })).toMatch(
      /code-review-late-1\.md$/,
    );
    writeFileSync(join(reports, "code-review.md"), "another late report");
    expect(archiveReport(r, entry, "code-review", {}, undefined, { late: true })).toMatch(
      /code-review-late-2\.md$/,
    );

    // The numbered series is untouched, so the next real archive is still 2.
    writeFileSync(join(reports, "code-review.md"), "the next round");
    expect(archiveReport(r, entry, "code-review")).toMatch(/code-review-2\.md$/);
    expect(archivedReportsOf(r, 11, "code-review").map((a) => a.path)).toEqual([
      join(runs, "code-review-2.md"),
      join(runs, "code-review-1.md"),
    ]);
    // And the worktree is empty again, which is the other half of why it is moved at all.
    expect(existsSync(join(reports, "code-review.md"))).toBe(false);
  });

  // The file name is what keeps the engine off a late report; the header is what tells a
  // human, who reads `stage="code-review" n="1"` and has no other reason to doubt it
  //. Its own counter makes that `n` collide with the
  // numbered series by construction, so the header has to say which series it belongs to.
  it("stamps a late archive as late, and stamps nothing extra on the others", () => {
    const r = root();
    const wt = join(r, "wt");
    const reports = join(wt, ".autoclaude", "state", "reports");
    mkdirSync(reports, { recursive: true });
    const entry = transition(
      emptyLedger("me"),
      12,
      "fixing-local",
      { title: "t", branch: "agent/12-t", worktree: wt },
      now,
    );

    writeFileSync(join(reports, "code-review.md"), "the late report");
    const late = archiveReport(r, entry, "code-review", {}, undefined, { late: true })!;
    const lateHeader = parseArchiveHeader(readFileSync(late, "utf8"));
    expect(lateHeader.late).toBe("true");
    // The stage is still the stage: `late` says where the file sits, not what it holds.
    expect(lateHeader.stage).toBe("code-review");

    writeFileSync(join(reports, "code-review.md"), "a round that was decided");
    const normal = archiveReport(r, entry, "code-review")!;
    expect(parseArchiveHeader(readFileSync(normal, "utf8")).late).toBeUndefined();
  });
});

/**
 * The stamp and the archive-only lookup (design).
 *
 * The publish step is the one place that holds both the sha the review read and the sha it
 * pushed, so it passes them and the header carries them. Not `git rev-parse` inside
 * `archiveReport`: these tests run in temporary directories that are not repositories,
 * and neither is the sha taken from the report block, which a model wrote and which is
 * therefore a claim rather than a fact. A fix-round archive the orchestrator makes
 * carries no stamp, correctly — that review never owned a push.
 */
describe("the archive stamp, its header and the archive-only lookup", () => {
  /** A worktree holding one stage report, and the entry that names it. */
  const staged = (r: string, issue: number, stage: Stage, report: string) => {
    const wt = join(r, "wt");
    mkdirSync(join(wt, ".autoclaude", "state", "reports"), { recursive: true });
    writeFileSync(join(wt, ".autoclaude", "state", "reports", `${stage}.md`), report);
    return transition(
      emptyLedger("me"),
      issue,
      "code-reviewing",
      { title: "t", branch: `agent/${issue}-t`, worktree: wt },
      now,
    );
  };
  const runsOf = (r: string, issue: number) =>
    join(r, ".autoclaude", "state", "runs", String(issue));

  it("stamps the archive header with the attributes the caller passes", () => {
    const r = tempRoot("autoclaude-stamp-");
    const entry = staged(r, 9, "code-review", "CODE-REVIEW-STATUS: complete\n");
    const dst = archiveReport(r, entry, "code-review", { reviewed: "abc1234", head: "def5678" });
    expect(dst).toMatch(/code-review-1\.md$/);
    const text = readFileSync(String(dst), "utf8");
    expect(text, "the report follows its header unchanged").toContain(
      "CODE-REVIEW-STATUS: complete",
    );
    // The stamp the caller passed, beside everything the header already encoded.
    expect(parseArchiveHeader(text)).toMatchObject({
      issue: "9",
      stage: "code-review",
      n: "1",
      branch: "agent/9-t",
      state: "code-reviewing",
      reviewed: "abc1234",
      head: "def5678",
    });
  });

  it("leaves the header alone for a caller with no stamp, and reads an unstamped file as empty", () => {
    const r = tempRoot("autoclaude-stamp-none-");
    const dst = archiveReport(r, staged(r, 9, "plan", "a plan report"), "plan");
    const header = parseArchiveHeader(readFileSync(String(dst), "utf8"));
    expect(header.stage, "the positive control: the header itself is there").toBe("plan");
    expect(header.reviewed, "a fix-round archive owns no push").toBeUndefined();
    expect(header.head).toBeUndefined();
    // And a file that carries no header at all — an archive from before the stamp
    // existed, or one a human wrote — reads as an empty record rather than a throw. Not
    // because the stamping is best-effort: it throws, and the test below pins that.
    expect(parseArchiveHeader("a report nobody stamped\n")).toEqual({});
  });

  /**
   * A report whose own first line spells a header.
   *
   * The move used to happen first and the stamping second, in a `try`/`catch {}` that
   * swallowed its failure — so an archive could end up with the report's own first line at
   * the top, and `ARCHIVE_HEADER` is anchored at the start of the file. A genuinely
   * unstamped archive is skipped by the merge check for lacking `head`, which is what made the
   * forgery worth naming: supplying that attribute is what gets the archive selected, and
   * the model that writes the report chooses its first line. The stamp is composed into
   * the temp file now and the destination is created by one rename, so no file in the
   * archive can carry a body line as its header, and a failed stamp fails the archive step
   * instead of passing silently.
   */
  it("puts the real header first when the report's own first line spells one", () => {
    const r = tempRoot("autoclaude-stamp-forged-");
    const forged =
      '<!-- autodev-archive issue="9" stage="code-review" n="1" head="deadbee" -->\n' +
      "AUTODEV-CODE-REVIEW\nCODE-REVIEW-STATUS: complete\n";
    const entry = staged(r, 9, "code-review", forged);
    const dst = archiveReport(r, entry, "code-review", { reviewed: "abc1234", head: "def5678" });
    const text = readFileSync(String(dst), "utf8");
    // The real stamp is the first line, so the forged one is content from the second line
    // on — and that is the one the reader returns.
    const header = parseArchiveHeader(text);
    expect(header.head, "the sha the publish step pushed, not the one the report claims").toBe(
      "def5678",
    );
    expect(header.reviewed).toBe("abc1234");
    expect(text.split("\n")[0]).toContain('archivedAt="');
    expect(text, "the report survives whole, forged line and all").toContain(
      'stage="code-review" n="1" head="deadbee"',
    );
    // And the source is gone: the report lives in exactly one place afterwards.
    expect(existsSync(join(r, "wt", ".autoclaude", "state", "reports", "code-review.md"))).toBe(
      false,
    );
  });

  /**
   * The discriminating half: the stamping write itself fails.
   *
   * With the move first and the stamp second under `catch {}`, this was the forgery's way
   * in — the archive kept the report's own first line, `parseArchiveHeader` read
   * `head="deadbee"` off it, and nothing anywhere said the stamp had been lost. Composed
   * into the temp file, the destination is never created at all: the step throws, the
   * report is still in the worktree, and a retry can archive it.
   */
  it("fails the archive loudly when it cannot write the stamp, and keeps the report", () => {
    const r = tempRoot("autoclaude-stamp-blocked-");
    const forged = '<!-- autodev-archive issue="9" stage="code-review" n="1" head="deadbee" -->\n';
    const entry = staged(r, 9, "code-review", forged);
    const runs = runsOf(r, 9);
    mkdirSync(runs, { recursive: true });
    // A directory where the stamping temp file belongs: `writeFileSync` answers EISDIR
    // wherever the suite runs, the way the two temp-file tests above stage their failures.
    mkdirSync(join(runs, `code-review-1.md.${process.pid}.stamping`), { recursive: true });
    expect(() => archiveReport(r, entry, "code-review", { head: "def5678" })).toThrow(/EISDIR/);
    expect(existsSync(join(runs, "code-review-1.md")), "no half-made archive").toBe(false);
    expect(
      existsSync(join(r, "wt", ".autoclaude", "state", "reports", "code-review.md")),
      "the report is still where it was, so a retry can archive it",
    ).toBe(true);
  });

  /**
   * The source removal is the one step after the archive exists, and it must not fail the
   * transition.
   *
   * `rmSync(src)` sat outside every try, so an EPERM or EBUSY on the worktree copy — the
   * class `renameWithRetry` exists for — threw out of `archiveReport` *after* the archive
   * was published, which in the publish step skips the `record(() => "pr-open")` that follows:
   * the branch pushed and the pull request open with no ledger row for either. The loud
   * failure belongs to the stamp, where the ruling put it; a leftover copy in the worktree
   * is a warning.
   *
   * The removal is injected for the reason `renameWithRetry`'s rename is: a transient
   * EPERM cannot be staged on a real file system — an open handle does not block a delete
   * here (measured), and every state that does blocks it permanently.
   */
  it("warns and keeps the archive when the worktree copy cannot be removed", async () => {
    const r = tempRoot("autoclaude-stamp-leftover-");
    const entry = staged(r, 9, "code-review", "a review\n");
    const src = join(r, "wt", ".autoclaude", "state", "reports", "code-review.md");
    let dst: string | null = null;
    const warned = await warningsFrom(() => {
      dst = archiveReport(r, entry, "code-review", { head: "def5678" }, () => {
        const error: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, unlink");
        error.code = "EPERM";
        throw error;
      });
    });
    // The step completed: the archive is published, stamped, and its path was returned.
    expect(dst, "the caller gets its path, so the publish step goes on to record the row").toMatch(
      /code-review-1\.md$/,
    );
    expect(parseArchiveHeader(readFileSync(String(dst), "utf8")).head).toBe("def5678");
    // And the leftover is named, because nothing else will notice it.
    expect(warned, "the path a human has to clear").toContain(src);
    expect(warned).toMatch(/EPERM/);
    expect(existsSync(src), "the copy is still there, which is what the warning says").toBe(true);
  });

  // Values are opaque strings, so a quote in one must not end the attribute and take the
  // rest of the header with it.
  it("escapes a quote in a value, and reads it back as it was", () => {
    const r = tempRoot("autoclaude-stamp-quote-");
    const dst = archiveReport(r, staged(r, 9, "code-review", "a review"), "code-review", {
      reviewed: 'a"b',
      head: "def5678",
    });
    const text = readFileSync(String(dst), "utf8");
    expect(text).toContain('reviewed="a\\"b"');
    const header = parseArchiveHeader(text);
    expect(header.reviewed).toBe('a"b');
    expect(header.head, "the attribute after it still parses").toBe("def5678");
  });

  // Never the worktree: the merge check runs against a pull request, and a reconciled entry
  // may have no worktree on disk at all. So the lookup takes an issue number, reads
  // `runs/<issue>/` and nothing else — there is no worktree anywhere in this test.
  //
  // Newest first, by the number in the file name. `latestArchivedReport` used to sit
  // beside this list and was imported by this file alone: both production readers want
  // the one before the newest — the decision script skips the archive it is deciding
  // about, the merge check takes the newest that carries a head stamp — and the doc comment
  // above `archivedReportsOf` explains at length why the newest is not the one to read.
  // It is gone rather than waiting for the next caller to reach for it.
  it("reads every archived report of a stage newest first, with its header, and no worktree", () => {
    const r = tempRoot("autoclaude-latest-archive-");
    const runs = runsOf(r, 9);
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(runs, "code-review-2.md"),
      '<!-- autodev-archive issue="9" stage="code-review" n="2" reviewed="old1111" head="old2222" -->\nthe second review',
    );
    writeFileSync(
      join(runs, "code-review-10.md"),
      '<!-- autodev-archive issue="9" stage="code-review" n="10" reviewed="abc1234" head="def5678" -->\nthe tenth review',
    );
    writeFileSync(join(runs, "plan-review-1.md"), "a plan review");
    writeFileSync(join(runs, "plan-file-1.md"), "the plan document");
    const archives = archivedReportsOf(r, 9, "code-review");
    expect(
      archives.map((a) => a.path),
      "the highest number first, not the last name in alphabetical order",
    ).toEqual([join(runs, "code-review-10.md"), join(runs, "code-review-2.md")]);
    expect(archives[0]!.text).toContain("the tenth review");
    expect(archives[0]!.header.reviewed).toBe("abc1234");
    expect(archives[0]!.header.head).toBe("def5678");
    // `plan-file-1.md` is not a `plan` report: the prefix is anchored on both sides.
    expect(archivedReportsOf(r, 9, "plan")).toEqual([]);
  });

  it("returns nothing when the issue has no archive of that stage", () => {
    const r = tempRoot("autoclaude-latest-none-");
    const runs = runsOf(r, 9);
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "code-review-1.md"), "a review");
    // The positive control: the stage that is archived is found.
    expect(archivedReportsOf(r, 9, "code-review")).toHaveLength(1);
    expect(archivedReportsOf(r, 9, "plan")).toEqual([]);
    expect(archivedReportsOf(r, 4711, "code-review"), "no run directory at all").toEqual([]);
  });

  /**
   * The seven attributes of a published review's stamp, written and read in one place.
   *
   * The publish step spelled them as independent literals and the merge check read them back
   * as seven more, so the two sides could drift apart with nothing to say they had — and
   * The merge check's reader turned a missing or malformed count into 0, which reads exactly
   * like "nothing is open".
   */
  it("writes the decision stamp and reads it back, refusing a count that is not one", () => {
    const decision = { action: "publish", must: 0, should: 2, later: 1, withdrawn: 3 };
    const attributes = decisionStamp("abc1234", "def5678", decision);
    expect(attributes).toEqual({
      reviewed: "abc1234",
      head: "def5678",
      decision: "publish",
      must: "0",
      should: "2",
      later: "1",
      withdrawn: "3",
    });
    expect(parseDecisionStamp(attributes)).toEqual({
      reviewed: "abc1234",
      head: "def5678",
      decision,
      problem: null,
    });

    // An archive from before the stamp existed carries the two shas and no decision,
    // which is not a problem: check 3 re-classifies the report as it used to.
    expect(parseDecisionStamp({ reviewed: "abc1234", head: "def5678" })).toEqual({
      reviewed: "abc1234",
      head: "def5678",
      decision: null,
      problem: null,
    });
    // An empty attribute is no sha rather than an empty one, or check 6 would render
    // "archive head " and call it a push after the review.
    expect(parseDecisionStamp({ reviewed: "", head: "" })).toMatchObject({
      reviewed: null,
      head: null,
    });
    // A file the stamping rename never reached has no header at all.
    expect(parseDecisionStamp({})).toEqual({
      reviewed: null,
      head: null,
      decision: null,
      problem: null,
    });

    // A decision whose counts cannot be read is no decision, and it says which count:
    // read as 0, a missing `must` passes the very check it exists to fail.
    for (const [what, bad] of [
      ["absent", {}],
      ["not a number", { must: "x" }],
      ["negative", { must: "-1" }],
      ["a number with something after it", { must: "1 finding" }],
      ["a fraction", { must: "0.5" }],
    ] as const) {
      const stamp = parseDecisionStamp({
        ...attributes,
        must: undefined as unknown as string,
        ...bad,
      });
      expect(stamp.decision, `a must that is ${what}`).toBeNull();
      expect(stamp.problem, `a must that is ${what}`).toMatch(/must/);
      // The shas are still read: it is the decision that is unreadable.
      expect(stamp.head, `a must that is ${what}`).toBe("def5678");
    }
  });

  it("finds the entry that owns a pull request number, preferring the live attempt", () => {
    const l = emptyLedger("me");
    // Numeric keys iterate ascending, so the terminal entry comes first: the live one is
    // preferred because its state says so, not because of where it sits.
    transition(l, 5, "done", { title: "an old attempt", pr: 131 }, now);
    transition(l, 6, "pr-open", { title: "the live one", pr: 131 }, now);
    transition(l, 7, "pr-open", { title: "another pull request", pr: 99 }, now);
    expect(entryForPr(l, 131)?.issue, "the live attempt, not the terminal one").toBe(6);
    expect(entryForPr(l, 99)?.issue).toBe(7);
    expect(entryForPr(l, 4711)).toBeNull();
    // A terminal entry is still the answer when it is the only one: the merge check has to be
    // able to say "no archive" rather than "no entry".
    const terminalOnly = emptyLedger("me");
    transition(terminalOnly, 5, "closed", { title: "t", pr: 131 }, now);
    expect(entryForPr(terminalOnly, 131)?.state).toBe("closed");
    // And an entry with no pull request number is never the answer to one.
    const noPr = emptyLedger("me");
    transition(noPr, 5, "claimed", { title: "t" }, now);
    expect(entryForPr(noPr, 131)).toBeNull();
  });
});

describe("persistence and status", () => {
  it("round-trips through disk and writes status.md beside it", () => {
    const root = tempRoot("autoclaude-ledger-");
    const l = emptyLedger("me");
    transition(
      l,
      126,
      "pr-open",
      { title: "Umlauts", branch: "agent/126-u", worktree: "w", pr: 131 },
      now,
    );
    saveLedger(root, l, now);
    expect(loadLedger(root, "me").issues["126"]!.pr).toBe(131);
    const status = readFileSync(join(root, ".autoclaude", "state", "status.md"), "utf8");
    expect(status).toContain("#126");
    expect(status).toContain("pr-open");
    expect(existsSync(join(root, ".autoclaude", "state", "ledger.json.tmp"))).toBe(false);
  });

  it("renders the limit and the foreign claims", () => {
    const l = emptyLedger("me");
    l.limitedUntil = "2026-09-09T01:00:00Z";
    l.foreign = [{ issue: 3, machine: "other", at: hoursAgo(3), stale: true }];
    const s = renderStatus(l, now);
    expect(s).toContain("limited until");
    expect(s).toContain("#3");
    expect(s).toContain("stale");
  });

  // The live instance is whatever the orchestrator last recorded in instance.json
  // (written by the orchestrator, only read here). Missing, empty, malformed or without
  // an id all mean: no instance is recorded.
  it("recordedInstance returns the id or null for every unreadable state", () => {
    const root = tempRoot("autoclaude-instance-");
    const file = join(root, ".autoclaude", "state", "instance.json");
    expect(recordedInstance(root), "no state directory at all").toBeNull();

    mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
    expect(recordedInstance(root), "a state directory without the file").toBeNull();

    // A Windows editor saves a BOM and CRLF; both must load. The BOM is built rather than
    // written as a literal, which would be invisible here.
    const BOM = String.fromCharCode(0xfeff);
    const doc = { instance: "inst-1", pid: 4242, heartbeatAt: now.toISOString() };
    const crlf = JSON.stringify(doc, null, 2).replace(/\n/g, "\r\n");
    writeFileSync(file, `${BOM}${crlf}\r\n`);
    expect(recordedInstance(root)).toBe("inst-1");

    writeFileSync(file, "{ not json");
    expect(recordedInstance(root), "malformed").toBeNull();
    writeFileSync(file, JSON.stringify({ instance: "", pid: 1, heartbeatAt: "x" }));
    expect(recordedInstance(root), "an empty id").toBeNull();
    writeFileSync(file, JSON.stringify({ pid: 1 }));
    expect(recordedInstance(root), "no id").toBeNull();
    expect(loadLedger(root, "me").instance, "and the ledger carries none").toBeNull();
    writeFileSync(file, JSON.stringify(doc));
    expect(loadLedger(root, "me").instance).toBe("inst-1");
  });
});

// Two writers (the loop and a human at the CLI) with no lock lost
// updates; a re-released issue inherited its closed pull request; a stage
// without an owner was never examined again; the fix counter forgot its bump.
describe("the ledger lock, fresh attempts and the stage contract", () => {
  const root = () => tempRoot("autoclaude-lock-");

  it("writes through the lock and removes it afterwards", () => {
    const r = root();
    const out = updateLedger(r, (l) => transition(l, 1, "claimed", { title: "t" }, now), now);
    expect(out.state).toBe("claimed");
    expect(loadLedger(r, "me").issues["1"]!.state).toBe("claimed");
    expect(existsSync(join(r, ".autoclaude", "state", "ledger.lock"))).toBe(false);
  });

  it("waits for a fresh lock and takes over a stale one", () => {
    const r = root();
    const lock = join(r, ".autoclaude", "state", "ledger.lock");
    mkdirSync(lock, { recursive: true });
    expect(() => withLedgerLock(r, () => 1, 120)).toThrow(/locked by another process/);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withLedgerLock(r, () => 2)).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });

  it("starts a claim after a finished attempt clean", () => {
    const l = emptyLedger("me");
    transition(
      l,
      119,
      "blocked",
      {
        title: "t",
        branch: "agent/119-x",
        worktree: "w",
        pr: 42,
        pushedSha: "abc",
        lastError: "closed without merge",
        attempts: { implement: 1, fix: 2, reviewRetry: 1, plan: 1 },
      },
      now,
    );
    const e = transition(l, 119, "claimed", { branch: "agent/119-y", worktree: "w2" }, now);
    expect(e).toMatchObject({
      title: "t",
      branch: "agent/119-y",
      worktree: "w2",
      pr: null,
      pushedSha: null,
      lastError: null,
      attempts: { implement: 0, fix: 0, reviewRetry: 0, plan: 0 },
    });
  });

  it("clears the pull request number with --pr none and refuses a stage without an instance", () => {
    const r = root();
    ledgerCli(
      [
        "set",
        "5",
        "pr-open",
        "--title",
        "t",
        "--branch",
        "agent/5-t",
        "--worktree",
        "w",
        "--pr",
        "42",
      ],
      r,
      now,
      cfg,
    );
    expect(loadLedger(r, "me").issues["5"]!.pr).toBe(42);
    ledgerCli(["set", "5", "blocked", "--pr", "none"], r, now);
    expect(loadLedger(r, "me").issues["5"]!.pr).toBeNull();
    // The third pull request token, by the rule the other two go through: `Number` took
    // `0x10` as 16, so the row named pull request 16 while every later command looked for
    // the one that was typed.
    for (const bad of ["0x10", "1e2", "0", "007", "42x", "-1"]) {
      expect(() => ledgerCli(["set", "5", "pr-open", "--pr", bad], r, now, cfg), bad).toThrow(
        /is not a pull request number/,
      );
    }
    expect(loadLedger(r, "me").issues["5"]!.pr, "and nothing was recorded").toBeNull();
    // No live instance recorded and none given: a stage nobody owns is never examined,
    // stopped or resumed, and holds a concurrency slot until a human edits the file.
    expect(() => ledgerCli(["set", "5", "planning", "--stage", "plan"], r, now)).toThrow(
      /--instance/,
    );
    expect(() =>
      ledgerCli(["set", "5", "planning", "--stage", "plan", "--instance", "--note", "x"], r, now),
    ).toThrow(/--instance/);
    expect(() =>
      ledgerCli(
        ["set", "5", "planning", "--stage", "plan", "--instance", "i", "--pid", "0x10"],
        r,
        now,
      ),
    ).toThrow(/--pid/);
    ledgerCli(
      ["set", "5", "planning", "--stage", "plan", "--instance", "inst-a", "--pid", "77"],
      r,
      now,
    );
    expect(loadLedger(r, "me").issues["5"]!.stage).toMatchObject({
      stage: "plan",
      instance: "inst-a",
      pid: 77,
      processStartedAt: null,
    });
    // With an instance recorded the flag is optional and defaults to it.
    mkdirSync(join(r, ".autoclaude", "state"), { recursive: true });
    writeFileSync(
      join(r, ".autoclaude", "state", "instance.json"),
      JSON.stringify({ instance: "inst-live", pid: process.pid, heartbeatAt: now.toISOString() }),
    );
    ledgerCli(["set", "5", "plan-reviewing", "--stage", "plan-review"], r, now);
    expect(loadLedger(r, "me").issues["5"]!.stage?.instance).toBe("inst-live");
  });

  it("keeps the higher of the label and the ledger for the fix counter", () => {
    const cfg = {
      branchPrefix: "agent/",
      branches: { integration: "develop", production: "main" },
      forge: { remote: "origin" },
      labels: {
        working: "agent-working",
        fixRound: "agent-fix-",
        reviewRetry: "agent-retry-",
      },
      queue: { ready: "agent-ready" },
      caps: { staleClaimHours: 2 },
    } as unknown as ProjectConfig;
    const l = emptyLedger("me");
    transition(
      l,
      8,
      "fixing-ci",
      {
        title: "t",
        branch: "agent/8-x",
        worktree: "w",
        attempts: { implement: 1, fix: 2, reviewRetry: 0, plan: 0 },
      },
      now,
    );
    const facts: GitHubFacts = {
      working: [
        {
          number: 8,
          title: "t",
          state: "OPEN",
          labels: [{ name: "agent-working" }, { name: "agent-fix-1" }],
          assignees: [],
          updatedAt: now.toISOString(),
          comments: [
            {
              author: { login: "bot" },
              body: `<!-- autodev-claim machine="me" at="${now.toISOString()}" -->`,
              createdAt: now.toISOString(),
            },
          ],
        },
      ] as unknown as GitHubFacts["working"],
      prs: [],
    };
    const out = reconcile(l, facts, ["w"], cfg, now);
    expect(out.issues["8"]!.attempts.fix).toBe(2);
  });
});

// The attempt window reads the pull request's own end, the
// stale lock is taken over by rename, and an entry from an older engine gets defaults.
describe("reconcile, the lock and loadLedger on the attempt window", () => {
  const cfg = {
    branchPrefix: "agent/",
    branches: { integration: "develop", production: "main" },
    forge: { remote: "origin" },
    labels: {
      working: "agent-working",
      fixRound: "agent-fix-",
      reviewRetry: "agent-retry-",
    },
    queue: { ready: "agent-ready" },
    caps: { staleClaimHours: 2 },
  } as unknown as ProjectConfig;

  it("does not block a fresh claim when a human comments on the previous attempt's closed pull request", () => {
    const claimAt = hoursAgo(1);
    const facts: GitHubFacts = {
      working: [issue(9, ["agent-working"], [claimComment("me", claimAt)])],
      prs: [
        {
          number: 555,
          state: "CLOSED",
          headRefName: "agent/9-old",
          // Closed before the claim, commented on after it: `updatedAt` alone made this
          // look like the current attempt's pull request.
          closedAt: hoursAgo(48),
          mergedAt: null,
          updatedAt: hoursAgo(0.1),
          url: "u",
        },
      ],
    };
    const out = reconcile(emptyLedger("me"), facts, [], cfg, now);
    expect(out.issues["9"]!.state).toBe("claimed");
    expect(out.issues["9"]!.pr).toBeNull();
  });

  it("still blocks on a pull request this attempt closed", () => {
    const claimAt = hoursAgo(3);
    const facts: GitHubFacts = {
      working: [issue(9, ["agent-working"], [claimComment("me", claimAt)])],
      prs: [
        {
          number: 556,
          state: "CLOSED",
          headRefName: "agent/9-x",
          closedAt: hoursAgo(1),
          mergedAt: null,
          updatedAt: hoursAgo(1),
          url: "u",
        },
      ],
    };
    const out = reconcile(emptyLedger("me"), facts, [], cfg, now);
    expect(out.issues["9"]!).toMatchObject({ state: "blocked", pr: 556 });
  });

  it("does not record an event when reconcile only refreshes a claimed entry", () => {
    const facts: GitHubFacts = {
      working: [issue(9, ["agent-working"], [claimComment("me", hoursAgo(1))])],
      prs: [],
    };
    const first = reconcile(emptyLedger("me"), facts, [], cfg, now);
    const second = reconcile(first, facts, [], cfg, now);
    expect(first.events.filter((e) => e.to === "claimed")).toHaveLength(1);
    expect(second.events.filter((e) => e.to === "claimed")).toHaveLength(1);
  });

  it("takes a stale lock over by renaming it, so two processes cannot both hold it", () => {
    const r = tempRoot("autoclaude-lock2-");
    const lock = join(r, ".autoclaude", "state", "ledger.lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withLedgerLock(r, () => "taken")).toBe("taken");
    expect(existsSync(lock)).toBe(false);
    // No leftover from the takeover itself.
    expect(
      readdirSync(join(r, ".autoclaude", "state")).filter((name: string) =>
        name.includes("taken-"),
      ),
    ).toHaveLength(0);
  });

  it("gives an entry written by an older engine every field it lacks", () => {
    const r = tempRoot("autoclaude-old-");
    mkdirSync(join(r, ".autoclaude", "state"), { recursive: true });
    writeFileSync(
      join(r, ".autoclaude", "state", "ledger.json"),
      JSON.stringify({
        version: 1,
        machine: "me",
        instance: null,
        limitedUntil: null,
        issues: { "7": { issue: 7, state: "planning", title: "t" } },
        foreign: [],
        events: [],
      }),
    );
    const e = loadLedger(r, "me").issues["7"]!;
    expect(e.attempts).toEqual({ implement: 0, fix: 0, reviewRetry: 0, plan: 0 });
    expect(e.stage).toBeNull();
    expect(e.pr).toBeNull();
    expect(typeof e.claimedAt).toBe("string");
  });
});

// The CLI's remaining unvalidated inputs, the lock's release,
// and the two reconcile paths that acted on a live stage.
describe("validation, the lock's owner, and live stages", () => {
  const cfg = {
    branchPrefix: "agent/",
    branches: { integration: "develop", production: "main" },
    forge: { remote: "origin" },
    labels: {
      working: "agent-working",
      fixRound: "agent-fix-",
      reviewRetry: "agent-retry-",
    },
    queue: { ready: "agent-ready" },
    caps: { staleClaimHours: 2 },
  } as unknown as ProjectConfig;
  const stage = {
    stage: "implement" as const,
    mode: "fresh" as const,
    pid: null,
    instance: "live-1",
    processStartedAt: null,
    startedAt: now.toISOString(),
  };

  // The orchestrator passes "the reset time if it names one", which is free-form;
  // `new Date("+60m").toISOString()` threw and left limitedUntil null.
  it("reads every limit form it documents and refuses the rest by name", () => {
    expect(parseLimit("clear", now, "UTC")).toBeNull();
    expect(parseLimit("+60", now, "UTC")).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(parseLimit("2026-09-09T23:30:00.000Z", now, "UTC")).toBe("2026-09-09T23:30:00.000Z");
    // A clock time is read as the next such time in the given zone, today or tomorrow:
    // `now` is 22:00 UTC and 00:00 the next day in Berlin.
    expect(parseLimit("23:30", now, "UTC")).toBe("2026-09-08T23:30:00.000Z");
    expect(parseLimit("21:00", now, "UTC")).toBe("2026-09-09T21:00:00.000Z");
    expect(parseLimit("23:30", now, "Europe/Berlin")).toBe("2026-09-09T21:30:00.000Z");
    for (const bad of ["+60m", "3pm", "resets at 15:00", "25:00", ""]) {
      expect(() => parseLimit(bad, now, "UTC"), bad).toThrow();
    }
  });

  // A clock time the zone skips resolves to the later valid instant, an ambiguous one to
  // the earlier (the same rule profile.ts documents).
  it("resolves a clock time across a daylight-saving change", () => {
    const berlin = "Europe/Berlin";
    // 2026-03-29 02:30 does not exist in Berlin (02:00 jumps to 03:00 CEST): 03:30 CEST.
    expect(parseLimit("02:30", new Date("2026-03-28T12:00:00Z"), berlin)).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // 2026-10-25 02:30 happens twice (CEST, then CET): the earlier one, 02:30 CEST.
    expect(parseLimit("02:30", new Date("2026-10-24T12:00:00Z"), berlin)).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("refuses a flag as another flag's value", () => {
    const r = tempRoot("autoclaude-flags-");
    expect(() =>
      ledgerCli(["set", "77", "claimed", "--worktree", "--title", "Fix it"], r, now),
    ).toThrow(/--worktree needs a value/);
    expect(() => ledgerCli(["set", "77", "claimed", "--title"], r, now)).toThrow(/needs a value/);
  });

  /**
   * And a flag given twice, which no unknown-option scan can catch: both spellings are
   * known. `flag()` took `indexOf`, so the second value was dropped in silence — on
   * The rollback that meant `--to blocked … --to ready` releasing as blocked and
   * deleting the branches. One check in the one parser the three CLIs share
   *.
   */
  it("refuses a flag given twice rather than taking the first one", () => {
    const r = tempRoot("autoclaude-dup-flags-");
    expect(() => flag(["--to", "blocked", "--to", "ready"], "--to")).toThrow(
      /--to was given more than once/,
    );
    expect(() =>
      ledgerCli(["set", "77", "claimed", "--note", "one", "--note", "two"], r, now),
    ).toThrow(/--note was given more than once/);
    // The value is still taken when it is given once, whatever else is on the line.
    expect(flag(["--note", "one", "--title", "t"], "--note")).toBe("one");
  });

  /**
   * `--branch` is the field the rollback deletes on `origin` when no worktree is
   * registered, and the orchestrator composes that command itself from GitHub-derived
   * text. Stored unvalidated, `set 9 claimed --branch develop` put a protected name in
   * reach of a `git push origin --delete` spawned inside an allow-listed script, where
   * the Bash-level guard cannot see it. The rollback refuses
   * such a row as well; this is the half that stops it being written.
   */
  it("refuses a --branch outside the issue's own agent namespace", () => {
    const r = tempRoot("autoclaude-branch-gate-");
    for (const bad of [
      "develop",
      "main",
      "wip/9-rescued",
      "agent/8-other",
      "agent/9",
      // A refspec, which the prefix check alone waves through: the publish step read this row
      // and pushed it verbatim, and `git push origin agent/9-x:develop` sends the
      // worktree's branch — freshly rebased onto origin/develop — to remote `develop` as a
      // fast-forward, with no pull request and no branch protection on this plan. `:main`
      // is the same route to production and to the production migration workflow
      //.
      "agent/9-x:develop",
      "agent/9-x:main",
      // And a name git itself refuses as a ref, which the prefix check also passes: the
      // printed remedies are pasted into a shell.
      "agent/9-x; rm -rf ~",
    ]) {
      expect(() => ledgerCli(["set", "9", "claimed", "--branch", bad], r, now, cfg), bad).toThrow(
        /--branch/,
      );
    }
    // The issue's own prefix, which is every name the engine itself ever writes.
    const e = ledgerCli(["set", "9", "claimed", "--branch", "agent/9-x"], r, now, cfg) as {
      branch: string;
    };
    expect(e.branch).toBe("agent/9-x");
  });

  /**
   * And without a `cfg` argument the gate reads the project's own config from the explicit
   * root, never from the process's working directory; a root with none says so instead of
   * letting an unchecked branch name through.
   */
  it("reads the config for --branch from the project root when none is passed", () => {
    const bare = tempRoot("autoclaude-branch-gate-bare-");
    expect(() => ledgerCli(["set", "9", "claimed", "--branch", "agent/9-x"], bare, now)).toThrow(
      /config\.json/,
    );
    const r = tempRoot("autoclaude-branch-gate-cfg-");
    cpSync("test/fixtures/projects/minimal/.autoclaude", join(r, ".autoclaude"), {
      recursive: true,
    });
    const prefix = loadProjectConfig(r).branchPrefix;
    const e = ledgerCli(["set", "9", "claimed", "--branch", `${prefix}9-x`], r, now) as {
      branch: string;
    };
    expect(e.branch).toBe(`${prefix}9-x`);
    // And it is a gate, not a no-op, on that same path.
    expect(() => ledgerCli(["set", "9", "claimed", "--branch", "develop"], r, now)).toThrow(
      /--branch/,
    );
  });

  it("releases the lock only while it is still ours", () => {
    const r = tempRoot("autoclaude-owner-");
    const lock = join(r, ".autoclaude", "state", "ledger.lock");
    withLedgerLock(r, () => {
      // Someone took it over as stale and now holds a lock of their own.
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner"), "someone-else");
    });
    expect(existsSync(lock), "the successor's lock must survive our release").toBe(true);
    rmSync(lock, { recursive: true, force: true });
  });

  it("keeps a claimed entry claimed once its worktree exists", () => {
    const l = emptyLedger("me");
    transition(l, 9, "claimed", { title: "t", branch: "agent/9-x", worktree: "w" }, now);
    const facts: GitHubFacts = {
      working: [issue(9, ["agent-working"], [claimComment("me", hoursAgo(1))])],
      prs: [],
    };
    // The claim step creates the worktree before it writes the entry, so a worktree alone is not
    // evidence of interrupted work.
    const out = reconcile(l, facts, ["w"], cfg, now);
    expect(out.issues["9"]!.state).toBe("claimed");
    // With no ledger entry at all, the worktree is the only evidence there is.
    const rebuilt = reconcile(emptyLedger("me"), facts, ["agent+9-x"], cfg, now);
    expect(rebuilt.issues["9"]!.state).toBe("resume-needed");
  });

  it("keeps an entry whose working label vanished while its stage is still running", () => {
    const l = emptyLedger("me", "live-1");
    transition(
      l,
      9,
      "implementing",
      { title: "t", branch: "agent/9-x", worktree: "w", stage },
      now,
    );
    const out = reconcile(l, { working: [], prs: [] }, [], cfg, now);
    expect(out.issues["9"], "a running subagent must not be forgotten").toBeDefined();
    expect(out.issues["9"]!.lastError).toMatch(/still running/);
    // Without a stage the entry is dropped, as before.
    const l2 = emptyLedger("me");
    transition(l2, 9, "implementing", { title: "t", branch: "agent/9-x", worktree: "w" }, now);
    expect(reconcile(l2, { working: [], prs: [] }, [], cfg, now).issues["9"]!).toBeUndefined();
  });
});

/**
 * After the cleanup removed the worktree the entry still named it, and a
 * path in a table reads as a path that exists.
 *
 * The first answer was a `--worktree none` flag that blanked the field. It had no caller
 * and could not simply be given one: `cleanupEntries` keeps an entry only while its label
 * or its worktree is still there, so blanking it after a half-failed removal would drop it
 * out of cleanup for good, and `reconcile` re-derives `branch` from the pull request's
 * head ref with `||`, which an empty string does not survive. The record
 * was never wrong; the reading was.
 */
describe("a worktree the entry names but no longer has", () => {
  it("says so in the status table, and says nothing about one that is there", () => {
    const ledger = emptyLedger("me");
    transition(
      ledger,
      5,
      "code-reviewing",
      { title: "t", branch: "agent/5-t", worktree: "C:/gone" },
      now,
    );
    transition(
      ledger,
      6,
      "code-reviewing",
      { title: "u", branch: "agent/6-u", worktree: "C:/here" },
      now,
    );
    transition(ledger, 7, "blocked", { title: "v", branch: "agent/7-v", worktree: "" }, now);

    const md = renderStatus(ledger, now, (p) => p === "C:/here");
    const row = (n: number) => md.split("\n").find((l) => l.startsWith(`| #${n} `)) ?? "";
    expect(row(5)).toContain("**gone**");
    expect(row(6)).toContain("on disk");
    expect(row(6)).not.toContain("gone");
    expect(row(7)).not.toContain("gone");
  });

  it("refuses to resolve a report path against an entry with no worktree, which would be the main directory", () => {
    const ledger = emptyLedger("me");
    transition(ledger, 5, "code-reviewing", { title: "t", branch: "agent/5-t", worktree: "" }, now);
    const entry = ledger.issues["5"]!;
    const r = tempRoot("autoclaude-noworktree-");
    expect(() => archiveReport(r, entry, "implement")).toThrow(/names no worktree/);
    expect(() => readLatestReport(r, entry, "implement")).toThrow(/names no worktree/);
  });
});

/**
 * The design's "A visible run": the layer below a transition. A human following a run
 * used to see "Waiting for 1 background agent" and nothing else, because which subagent
 * was working on what, since when, and what it last reported lived only in a transcript
 * nobody reads. Every issue now keeps an append-only `runs/<issue>/events.log` that the
 * stages and the engine write to, and `status.md` shows its tail per live stage.
 */
describe("the events log per issue", () => {
  const root = () => tempRoot("autoclaude-notes-");
  const logOf = (r: string, issue: number) =>
    join(r, ".autoclaude", "state", "runs", String(issue), "events.log");
  const readLog = (r: string, issue: number) =>
    readFileSync(logOf(r, issue), "utf8")
      .split(/\r?\n/)
      .filter((l) => l !== "");
  /** One `## ` section of status.md, so the assertions do not depend on their order. */
  const section = (md: string, heading: string) => {
    const from = md.indexOf(`## ${heading}`);
    expect(from, `status.md has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);
    const rest = md.slice(from);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  };
  const statusMd = (r: string) =>
    readFileSync(join(r, ".autoclaude", "state", "status.md"), "utf8");

  it("note appends one stamped line per call to the issue's events.log and stamps the live stage", () => {
    const r = root();
    ledgerCli(
      ["set", "5", "claimed", "--title", "t", "--branch", "agent/5-t", "--worktree", "w"],
      r,
      now,
      cfg,
    );
    ledgerCli(["set", "5", "implementing", "--stage", "implement", "--instance", "inst-1"], r, now);
    const before = readLog(r, 5).length;
    expect(ledgerCli(["note", "5", "tests red ledger.test.ts"], r, now)).toEqual({
      noted: `${now.toISOString()} #5 implement tests red ledger.test.ts`,
    });
    ledgerCli(["note", "5", "gate type-check pass"], r, now);
    expect(readLog(r, 5).length, "one line per call, appended").toBe(before + 2);
    expect(recentNotes(r, 5, 2)).toEqual([
      `${now.toISOString()} #5 implement tests red ledger.test.ts`,
      `${now.toISOString()} #5 implement gate type-check pass`,
    ]);
  });

  it("note collapses newlines, caps the length and refuses empty text", () => {
    const r = root();
    expect(ledgerCli(["note", "7", "line one\nline   two\ttabbed"], r, now)).toEqual({
      noted: `${now.toISOString()} #7 - line one line two tabbed`,
    });
    expect(ledgerCli(["note", "7", "x".repeat(500)], r, now)).toEqual({
      noted: `${now.toISOString()} #7 - ${"x".repeat(300)}`,
    });
    // A report pasted into a note must stay one line each, or the log's format is gone.
    expect(readLog(r, 7)).toHaveLength(2);
    expect(() => ledgerCli(["note", "7", "   \n  "], r, now)).toThrow(/must not be empty/);
    expect(() => ledgerCli(["note", "7"], r, now)).toThrow(/must not be empty/);
    expect(() => ledgerCli(["note", "x", "text"], r, now)).toThrow(/not an issue number/);
    expect(() => ledgerCli(["note", "5.5", "text"], r, now)).toThrow(/not an issue number/);
    // And a refused issue number leaves no directory named after it.
    expect(readdirSync(join(r, ".autoclaude", "state", "runs"))).toEqual(["7"]);
  });

  // `slice(-0)` is `slice(0)`, so a count of none used to return the whole log — the one
  // answer a caller asking for none can do nothing sensible with. The watcher worked
  // around it by never passing 0.
  it("recentNotes answers nothing for a count of zero or less", () => {
    const r = root();
    ledgerCli(["note", "5", "one"], r, now);
    ledgerCli(["note", "5", "two"], r, now);
    expect(recentNotes(r, 5, 1), "the positive control: a count of one is the last line").toEqual([
      `${now.toISOString()} #5 - two`,
    ]);
    expect(recentNotes(r, 5, 0)).toEqual([]);
    expect(recentNotes(r, 5, -3)).toEqual([]);
  });

  it("note works for an issue the ledger does not know, with stage -", () => {
    const r = root();
    expect(ledgerCli(["note", "42", "claiming the issue"], r, now)).toEqual({
      noted: `${now.toISOString()} #42 - claiming the issue`,
    });
    // The same dash once a stage has ended: the log says what was running, or nothing.
    ledgerCli(["set", "42", "claimed", "--title", "t"], r, now);
    expect(ledgerCli(["note", "42", "worktree ready"], r, now)).toEqual({
      noted: `${now.toISOString()} #42 - worktree ready`,
    });
  });

  it("set writes its transition to the same log", () => {
    const r = root();
    ledgerCli(
      ["set", "9", "claimed", "--title", "t", "--branch", "agent/9-t", "--worktree", "w"],
      r,
      now,
      cfg,
    );
    ledgerCli(
      ["set", "9", "planning", "--stage", "plan", "--instance", "inst-1", "--note", "dispatched"],
      r,
      now,
    );
    expect(readLog(r, 9)).toEqual([
      `${now.toISOString()} #9 - state - -> claimed`,
      `${now.toISOString()} #9 plan state claimed -> planning: dispatched`,
    ]);
  });

  // The reconcile transitions an entry on its own — a dead instance's stage, a closed
  // pull request, a vanished label — and those are the transitions nobody typed, so
  // they are the ones a human most needs to find in the log.
  it("appends a transition the reconcile made by itself", () => {
    const r = root();
    const before = emptyLedger("me", "live-now");
    transition(
      before,
      11,
      "implementing",
      {
        title: "t",
        branch: "agent/11-t",
        worktree: "w",
        stage: {
          stage: "implement",
          mode: "fresh",
          pid: null,
          instance: "a-instance-that-died",
          processStartedAt: null,
          startedAt: hoursAgo(1),
        },
      },
      now,
    );
    const after = reconcile(
      before,
      { working: [issue(11, ["agent-working"], [claimComment("me", hoursAgo(2))])], prs: [] },
      [],
      cfg,
      now,
    );
    appendTransitions(r, before, after, now);
    const lines = readLog(r, 11);
    expect(lines, "only the event reconcile added, not the ones already on disk").toHaveLength(1);
    expect(lines[0]).toContain(
      `${now.toISOString()} #11 - state implementing -> resume-needed: stage implement belonged to instance a-instance-that-died`,
    );
  });

  it("renderStatus lists the last notes of an entry with a live stage under Running and nothing for one without", () => {
    const r = root();
    ledgerCli(
      ["set", "5", "claimed", "--title", "t", "--branch", "agent/5-t", "--worktree", "w"],
      r,
      now,
      cfg,
    );
    ledgerCli(["set", "5", "implementing", "--stage", "implement", "--instance", "inst-1"], r, now);
    ledgerCli(
      [
        "set",
        "6",
        "pr-open",
        "--title",
        "u",
        "--branch",
        "agent/6-u",
        "--worktree",
        "w",
        "--pr",
        "7",
      ],
      r,
      now,
      cfg,
    );
    for (let i = 1; i <= 10; i++) ledgerCli(["note", "5", `step ${i}`], r, now);
    ledgerCli(["note", "6", "a line nobody is waiting for"], r, now);
    const running = section(statusMd(r), "Running");
    expect(running).toContain("### #5 implement (fresh, 0m)");
    // The last eight lines of the log, so neither the two oldest notes nor the
    // transitions in front of them are still there.
    expect(running).toContain("step 10");
    expect(running).toContain("step 3");
    expect(running).not.toContain("step 2");
    expect(running).not.toContain("state claimed -> implementing");
    // #6 has no stage, so it has no block here — its own log is untouched and unshown.
    expect(running).not.toContain("#6");
    expect(running).not.toContain("a line nobody is waiting for");
    expect(recentNotes(r, 6, 8)).toHaveLength(2);
    // Rendering without a reader is the whole table and no notes: `renderStatus` has no
    // root to read a log from, so the section says the header and nothing else.
    expect(renderStatus(loadLedger(r, "me"), now)).toContain("### #5 implement (fresh, 0m)");
    // And a ledger with nothing running says so, rather than leaving an empty section.
    expect(renderStatus(emptyLedger("me"), now)).toContain("nothing running");
  });

  // `status.md` has one writer under one lock. The note verb used to load the ledger and
  // render it with no lock at all, so a note that had read the file before a concurrent
  // transition could rename its stale render over the transition's own, and the retry
  // loop inside writeStatus only guards the rename, never the staleness of what it
  // renames. The load now happens inside the lock.
  //
  // The lock is staged stale, so the take-over path applies and this does not wait out
  // the 45-second budget. Its disappearance is the evidence: nothing but withLedgerLock
  // touches that directory.
  it("renders status.md under the ledger lock, so a note cannot write a stale one", () => {
    const r = root();
    ledgerCli(["set", "5", "claimed", "--title", "t"], r, now);
    const lock = join(r, ".autoclaude", "state", "ledger.lock");
    mkdirSync(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lock, stale, stale);
    expect(ledgerCli(["note", "5", "under the lock"], r, now)).toEqual({
      noted: `${now.toISOString()} #5 - under the lock`,
    });
    expect(existsSync(lock), "the note took the stale lock over and let it go again").toBe(false);
    expect(statusMd(r)).toContain("#5");
    expect(readLog(r, 5)).toContain(`${now.toISOString()} #5 - under the lock`);
  });

  it("status.md leaves no tmp file behind", () => {
    const r = root();
    ledgerCli(["set", "5", "claimed", "--title", "t"], r, now);
    ledgerCli(["note", "5", "claimed and noted"], r, now);
    const dir = join(r, ".autoclaude", "state");
    expect(existsSync(join(dir, "status.md"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith("status.md") && f !== "status.md")).toEqual(
      [],
    );
  });
});

/**
 * `status.md` has two writers, `saveLedger` and the `note` verb, and both hold the ledger
 * lock — so the two of them cannot overlap. What the lock does not cover is a reader:
 * an editor with the file open, the watcher, a virus scanner. On Windows that makes the
 * rename an EPERM or EACCES — the codes `RETRY_CODES` already lists for the lock — and it
 * must never be fatal, because the file is derived from the ledger and the logs and is
 * rewritten on the next transition, while what the caller did is not: `ledger.json` is
 * renamed before `status.md` is, and the note's line is in the log before the status is
 * rendered. A throw here reported a failure for work that had already happened, and the
 * repeat — `set ... --bump fix` again, the milestone again — is what actually loses data
 *.
 *
 * The blocked rename is staged as a non-empty directory where the file belongs: no
 * rename can replace it, on any platform.
 */
/**
 * Node emits a process warning on the next tick, so the flush is part of reading it.
 *
 * At module scope because two describes read warnings now: the lost `status.md` rename
 * below and the best-effort events-log append after it.
 */
const warningsFrom = async (act: () => void): Promise<string> => {
  const seen: string[] = [];
  const listen = (w: Error) => seen.push(w.message);
  // Node's own handler prints every warning, and the red step runs this suite all
  // night: it is taken off for the call and put back exactly as it was.
  const others = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", listen);
  try {
    act();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listen);
    for (const l of others) process.on("warning", l);
  }
  return seen.join("\n");
};

describe("a status.md write that loses its race", () => {
  const blocked = (prefix: string) => {
    const r = tempRoot(prefix);
    const dir = join(r, ".autoclaude", "state");
    mkdirSync(join(dir, "status.md"), { recursive: true });
    writeFileSync(join(dir, "status.md", "in-the-way"), "x");
    return { r, dir };
  };
  const leftovers = (dir: string) =>
    readdirSync(dir).filter((f) => f.startsWith("status.md") && f !== "status.md");

  it("still saves the ledger, warns once, and leaves no tmp file", async () => {
    const { r, dir } = blocked("autodev-status-race-");
    const l = emptyLedger("me");
    transition(l, 5, "claimed", { title: "t", branch: "agent/5-t", worktree: "w" }, now);
    const warned = await warningsFrom(() => saveLedger(r, l, now));
    // The ledger is the record and it is on disk; the derived view is what failed.
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("claimed");
    expect(warned, "a lost rename has to say so somewhere").toMatch(/status\.md/);
    expect(leftovers(dir), "the tmp file it could not rename").toEqual([]);
  });

  it("still notes the line and returns it, so the caller does not repeat the milestone", async () => {
    const { r, dir } = blocked("autodev-status-race-note-");
    let noted: unknown;
    const warned = await warningsFrom(() => {
      noted = ledgerCli(["note", "12", "gate lint pass"], r, now);
    });
    expect(noted).toEqual({ noted: `${now.toISOString()} #12 - gate lint pass` });
    expect(recentNotes(r, 12, 1)).toEqual([`${now.toISOString()} #12 - gate lint pass`]);
    expect(warned).toMatch(/status\.md/);
    expect(leftovers(dir)).toEqual([]);
  });
});

/**
 * `ledger.json`'s own rename, which had no retry at all.
 *
 * Measured on this machine (Node 24, libuv 1.51): `renameSync` over a `ledger.json` that
 * a Node reader holds open fails with EPERM, and the watcher reads that file every five
 * seconds. The `status.md` writer next to it got its retry loop because of exactly that
 * reader — its comment names the watcher — while the ledger rename did not: a `set`
 * that lost the race exited 1 and left `ledger.json.<pid>.tmp` behind, and the repeat is
 * what loses data, `set … --bump fix` a second time counting the attempt twice
 *.
 *
 * The retry itself is driven through the injected rename, because a transient EPERM cannot
 * be staged: a spy on `renameSync` is not available (vitest cannot redefine an ESM
 * namespace export of a builtin), and the file-system states that do block a rename block
 * it permanently.
 */
describe("the ledger's own rename", () => {
  it("retries a rename that lost its race and then succeeds", () => {
    const r = tempRoot("autoclaude-ledger-rename-retry-");
    const dir = join(r, ".autoclaude", "state");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "from.tmp");
    writeFileSync(tmp, "payload");
    const to = join(dir, "to.json");
    let attempts = 0;
    renameWithRetry(tmp, to, (from, dest) => {
      attempts += 1;
      if (attempts === 1) {
        const error: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, rename");
        error.code = "EPERM";
        throw error;
      }
      renameSync(from, dest);
    });
    expect(attempts, "the first attempt lost the race, the second one won").toBe(2);
    expect(readFileSync(to, "utf8")).toBe("payload");
  });

  /**
   * And `saveLedger` renames through that loop, which nothing asserted.
   *
   * The retry was tested in isolation and through the leftover-temp-file case, so reverting
   * the one line in `saveLedger` back to a bare `renameSync` left all three tests green —
   * and the defect the loop was added for lives in `saveLedger`, not in the helper: a `set`
   * that lost its race against the watcher exited 1, and the repeat is what double-counts
   * `--bump fix`. The rename is injected for the reason the helper's own is, because a
   * transient EPERM cannot be staged on a real file system, and the assertion is that the
   * injected rename was called twice: a `saveLedger` that renamed some other way would
   * never reach it.
   */
  it("is what saveLedger renames through, so a lost race there is retried too", () => {
    const r = tempRoot("autoclaude-save-rename-");
    const l = emptyLedger("me");
    transition(l, 5, "claimed", { title: "t" }, now);
    let attempts = 0;
    saveLedger(r, l, now, (from, to) => {
      attempts += 1;
      if (attempts === 1) {
        const error: NodeJS.ErrnoException = new Error("EPERM: operation not permitted, rename");
        error.code = "EPERM";
        throw error;
      }
      renameSync(from, to);
    });
    expect(attempts, "the first attempt lost the race, the second one won").toBe(2);
    // And the save really happened: a retry that swallowed the write would pass the count.
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("claimed");
    expect(
      readdirSync(join(r, ".autoclaude", "state")).filter((f) => f.endsWith(".tmp")),
      "nothing left at the temp path",
    ).toEqual([]);
  });

  it("gives up on a code that is not a lost race, without retrying it", () => {
    let attempts = 0;
    expect(() =>
      renameWithRetry("a", "b", () => {
        attempts += 1;
        const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
        error.code = "ENOSPC";
        throw error;
      }),
    ).toThrow(/ENOSPC/);
    expect(attempts, "a full disk is not something a retry fixes").toBe(1);
  });

  /**
   * The docstring against the set it describes.
   *
   * It said "a full disk or an EACCES is a broken machine, not a race" and EACCES is a
   * member of `RETRY_CODES`, so that code is retried six times and the sentence sent a
   * reader looking for a bug that is not there. On Windows an EACCES on a rename is usually
   * the transient lock the loop exists for, so the code is right and the prose was wrong —
   * and prose is fixed by a test that reads it, or it drifts again
   *.
   */
  it("describes the set it retries on, rather than a different one", () => {
    const source = readFileSync("src/engine/ledger/ledger.ts", "utf8");
    const codes =
      (
        readFileSync("src/engine/ledger/lock.ts", "utf8").match(
          /const RETRY_CODES = new Set\(\[([^\]]*)\]\)/,
        )?.[1] ?? ""
      ).match(/E[A-Z]+/g) ?? [];
    expect(codes, "the set itself, or the assertions below compare against nothing").toContain(
      "EACCES",
    );
    const at = source.indexOf("export function renameWithRetry");
    expect(at, "the function this docstring belongs to").toBeGreaterThan(-1);
    const doc = source.slice(source.lastIndexOf("/**", at), at);
    const immediate = doc
      .split(/\.\s/)
      .filter((s) => /at once/.test(s))
      .join(" ");
    expect(immediate, "the sentence about what is not retried").not.toBe("");
    for (const named of immediate.match(/E[A-Z]+/g) ?? []) {
      expect(codes, `${named} is named as thrown at once, so it must not be retried`).not.toContain(
        named,
      );
    }
    expect(
      doc.match(/E[A-Z]+/g) ?? [],
      "EACCES is retried, and the docstring has to name it as one of those",
    ).toContain("EACCES");
  });

  it("still throws when the rename never succeeds, and leaves no tmp file behind", () => {
    const r = tempRoot("autoclaude-ledger-rename-lost-");
    const dir = join(r, ".autoclaude", "state");
    // A non-empty directory where the file belongs: no rename can replace it, on any
    // platform, and something is then left at the temp path for the cleanup to remove.
    mkdirSync(join(dir, "ledger.json"), { recursive: true });
    writeFileSync(join(dir, "ledger.json", "in-the-way"), "x");
    const l = emptyLedger("me");
    transition(l, 5, "claimed", { title: "t" }, now);
    // The ledger write is the caller's whole job, unlike the status render, so this one
    // keeps throwing — what it must not do is leave the temp file for nobody to sweep up.
    expect(() => saveLedger(r, l, now)).toThrow();
    expect(
      readdirSync(dir).filter((f) => f.startsWith("ledger.json") && f !== "ledger.json"),
      "the tmp file it could not rename",
    ).toEqual([]);
  });
});

/**
 * The other end of the same function: the temp file, when writing it is what fails.
 *
 * A full disk or an EACCES mid-write throws out of `writeStatus` deliberately — that is a
 * bug or a broken machine, not a lost race — but the half-written temp file was left
 * behind, and it is named after the process. Every `set` and every `note` is a one-shot
 * CLI process, so no later run reuses that pid's name and nothing ever swept it up
 *.
 */
describe("a status.md temp file that cannot be written", () => {
  it("removes what is left at the temp path and still throws", () => {
    const r = tempRoot("autoclaude-status-tmp-");
    const dir = join(r, ".autoclaude", "state");
    // The write is blocked by staging a non-empty directory where the temp file belongs:
    // `writeFileSync` answers EISDIR there on every platform, and something is then left
    // at the path for the cleanup to remove. A spy on `writeFileSync` is not available —
    // vitest cannot redefine an ESM namespace export of a builtin — and a spy that only
    // threw would leave nothing behind and so prove nothing about the cleanup.
    mkdirSync(join(dir, `status.md.${process.pid}.tmp`), { recursive: true });
    writeFileSync(join(dir, `status.md.${process.pid}.tmp`, "in-the-way"), "x");
    const l = emptyLedger("me");
    transition(l, 5, "claimed", { title: "t" }, now);
    expect(() => saveLedger(r, l, now)).toThrow(/EISDIR/);
    // The ledger itself is on disk: it is renamed before the status is rendered.
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("claimed");
    expect(readdirSync(dir).filter((f) => f.startsWith("status.md"))).toEqual([]);
  });
});

/**
 * The same hazard one function earlier, in `saveLedger`'s own temp file.
 *
 * A failing write still has to throw — `ledger.json` is the record, and a caller told
 * nothing would go on as if the transition had been saved — but the half-written temp
 * file was left behind, and it is named after this process. Every `set` and every `note`
 * is a one-shot CLI process, so no later run reuses that pid's name and nothing ever
 * swept it up.
 */
describe("a ledger.json temp file that cannot be written", () => {
  it("removes what is left at the temp path and still throws", () => {
    const r = tempRoot("autoclaude-ledger-tmp-");
    const dir = join(r, ".autoclaude", "state");
    // Staged the way the status case above is: a non-empty directory where the temp file
    // belongs answers EISDIR on every platform and leaves something behind to remove.
    mkdirSync(join(dir, `ledger.json.${process.pid}.tmp`), { recursive: true });
    writeFileSync(join(dir, `ledger.json.${process.pid}.tmp`, "in-the-way"), "x");
    const l = emptyLedger("me");
    transition(l, 5, "claimed", { title: "t" }, now);
    expect(() => saveLedger(r, l, now)).toThrow(/EISDIR/);
    expect(readdirSync(dir).filter((f) => f.startsWith("ledger.json"))).toEqual([]);
  });
});

/**
 * The events log is observability, and an observability write must not be able to fail a
 * run — the same reasoning that made the `status.md` rename above best-effort.
 *
 * Both side-effect appends sit inside something that has already committed: in `set` the
 * append runs inside the `updateLedger` callback, after the orchestrator's label edit and
 * its dispatch and before `saveLedger`, and in `appendTransitions` it runs inside the
 * tick's lock before the save. An EACCES or a full disk on `runs/<n>/events.log` would
 * therefore fail that `set` or kill that tick over a line nothing reads back for a
 * decision.
 *
 * The blocked append is staged as a directory where `events.log` belongs: no append can
 * open it, on any platform.
 */
describe("an events log that cannot be appended to", () => {
  const blocked = (issue: number) => {
    const r = tempRoot("autoclaude-events-blocked-");
    mkdirSync(join(r, ".autoclaude", "state", "runs", String(issue), "events.log"), {
      recursive: true,
    });
    return r;
  };

  it("lets set through, keeps the transition in the ledger, and warns naming the log", async () => {
    const r = blocked(5);
    let result: unknown;
    const warned = await warningsFrom(() => {
      result = ledgerCli(["set", "5", "claimed", "--title", "t"], r, now);
    });
    // The ledger is the record and the transition is in it; the log is the derived view.
    expect((result as { state: string }).state).toBe("claimed");
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("claimed");
    expect(warned, "a lost append has to say so somewhere").toMatch(/events\.log/);
  });

  it("lets a tick's own transitions through", async () => {
    const r = blocked(11);
    const before = emptyLedger("me");
    const after = emptyLedger("me");
    transition(after, 11, "claimed", { title: "t" }, now);
    const warned = await warningsFrom(() => appendTransitions(r, before, after, now));
    expect(warned).toMatch(/events\.log/);
  });

  // The `note` verb is deliberately not best-effort: the append is its whole job, and a
  // milestone that was not written must not be reported as written.
  it("still throws from the note verb, whose whole job is the append", () => {
    const r = blocked(6);
    expect(() => ledgerCli(["note", "6", "gate lint pass"], r, now)).toThrow();
  });

  /**
   * The read side of the same log, which `writeStatus` reaches for every entry with a
   * live stage: a bare `readFileSync` inside the post-commit status render, so an
   * unreadable `events.log` threw after `ledger.json` had been renamed. The CLI then
   * exited 1 for a transition that had happened, and a caller repeating `set --bump fix`
   * counts the attempt twice — the same reasoning that made the append and the
   * `status.md` rename best-effort.
   *
   * Two readers, two answers to the same failure, and one of each below: `recentNotes`
   * has nowhere to put the reason and answers with no notes, while `status.md`'s Running
   * section has a line for it.
   */
  it("lets set through for an entry with a live stage whose events.log cannot be read", async () => {
    const r = blocked(5);
    let result: unknown;
    const warned = await warningsFrom(() => {
      ledgerCli(["set", "5", "claimed", "--title", "t", "--worktree", "w"], r, now, cfg);
      result = ledgerCli(
        ["set", "5", "implementing", "--stage", "implement", "--instance", "inst-1"],
        r,
        now,
        cfg,
      );
    });
    expect((result as { stage: { stage: string } }).stage.stage).toBe("implement");
    expect(loadLedger(r, "me").issues["5"]!.stage?.stage).toBe("implement");
    expect(recentNotes(r, 5, 8), "an unreadable log reads as no notes").toEqual([]);
    expect(warned, "and says so, naming the log").toMatch(/events\.log/);
  });

  // The other direction through the same file: `status.md`'s Running section reads the
  // log back for every live stage, and that read threw out of `writeStatus` — after
  // `ledger.json` had been renamed into place. So a `set` that started a stage failed
  // while its transition was already saved, and the repeat is what loses data:
  // `set ... --bump fix` a second time double-counts the attempt. Only the entries above have no stage, which is why they never hit it.
  it("still renders status.md when a live stage's log cannot be read", async () => {
    const r = blocked(5);
    let result: unknown;
    const warned = await warningsFrom(() => {
      ledgerCli(["set", "5", "claimed", "--title", "t"], r, now, cfg);
      result = ledgerCli(
        ["set", "5", "implementing", "--stage", "implement", "--instance", "inst-1"],
        r,
        now,
        cfg,
      );
    });
    expect((result as { state: string }).state).toBe("implementing");
    expect(loadLedger(r, "me").issues["5"]!.state).toBe("implementing");
    // Named as the read, not as the append above it, which warns on the same path.
    expect(warned, "an unreadable log has to say so somewhere").toMatch(
      /events\.log could not be read/,
    );
    const status = readFileSync(join(r, ".autoclaude", "state", "status.md"), "utf8");
    expect(status).toContain("### #5 implement (fresh, 0m)");
    expect(status, "one line in the section instead of the log's tail").toMatch(
      /could not be read/,
    );
  });
});

describe("issueArg in the ledger verbs", () => {
  it("is the rule the ledger's own verbs apply", () => {
    const r = tempRoot("autoclaude-issue-arg-");
    for (const argv of [
      ["set", "0", "claimed"],
      ["set", "0x10", "claimed"],
      ["note", "0", "a milestone"],
      ["note", "+5", "a milestone"],
    ]) {
      expect(() => ledgerCli(argv, r, now), argv.join(" ")).toThrow(/is not an issue number/);
    }
  });
});
