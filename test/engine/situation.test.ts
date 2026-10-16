import { afterEach, describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLEANUP_STATES,
  cleanupEntries,
  computeSituation,
  countInFlight,
  countRunning,
  newWorkGate,
  PR_STATES,
  selectQueue,
  stalledEntries,
  windowStart,
} from "../../src/engine/situation.js";
import {
  emptyLedger,
  ISSUE_STATES,
  saveLedger,
  transition,
} from "../../src/engine/ledger/ledger.js";
import type { ProjectConfig } from "../../src/config/types.js";
import type { Forge, IssueSummary, IssueView, PrSummary } from "../../src/forge/github.js";
import type { Exec } from "../../src/forge/exec.js";

const cfg = {
  branchPrefix: "agent/",
  labels: { ready: "agent-ready", working: "agent-working" },
  queue: { ready: "agent-ready", priority: [] },
} as unknown as ProjectConfig;
const iss = (n: number, labels: string[], assignees: string[] = []): IssueView =>
  ({
    number: n,
    title: `t${n}`,
    body: "",
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
    assignees: assignees.map((login) => ({ login })),
    comments: [],
    updatedAt: "",
  }) as IssueView;

describe("selectQueue", () => {
  it("takes ready, unassigned, unclaimed issues with no open agent pull request, lowest number first", () => {
    const ledger = emptyLedger("me");
    transition(ledger, 60, "blocked", { title: "t", branch: "agent/60-x", worktree: "w" });
    // In flight on this machine: never offered again, whatever the labels say.
    transition(ledger, 61, "implementing", { title: "t", branch: "agent/61-x", worktree: "w" });
    const prs: PrSummary[] = [
      {
        number: 9,
        state: "OPEN",
        headRefName: "agent/70-x",
        updatedAt: "",
        closedAt: null,
        mergedAt: null,
        url: "",
      },
    ];
    const q = selectQueue(
      [
        iss(126, ["agent-ready"]),
        iss(56, ["agent-ready"]),
        iss(70, ["agent-ready"]),
        iss(80, ["agent-ready"], ["someone"]),
        iss(90, ["agent-ready", "agent-working"]),
        iss(60, ["agent-ready"]),
        iss(61, ["agent-ready"]),
      ],
      ledger,
      prs,
      cfg,
    );
    expect(q.map((i) => i.number)).toEqual([56, 60, 126]);
  });

  // Changed from the source, which sorted by number alone: design § 10 (first row) makes
  // the configured priority labels order the queue, then the number.
  it("orders the queue by priority label, then by number", () => {
    const withPriority = {
      ...cfg,
      queue: { ready: "agent-ready", priority: ["priority: critical", "priority: high"] },
    } as unknown as ProjectConfig;
    const q = selectQueue(
      [
        iss(5, ["agent-ready"]),
        iss(9, ["agent-ready", "priority: high"]),
        iss(12, ["agent-ready", "priority: critical"]),
        iss(3, ["agent-ready", "priority: high"]),
      ],
      emptyLedger("me"),
      [],
      withPriority,
    );
    expect(q.map((i) => i.number)).toEqual([12, 3, 9, 5]);
  });

  it("ranks an issue by the first configured priority label it carries", () => {
    const withPriority = {
      ...cfg,
      queue: { ready: "agent-ready", priority: ["priority: critical", "priority: high"] },
    } as unknown as ProjectConfig;
    const q = selectQueue(
      [
        iss(2, ["agent-ready", "priority: high"]),
        iss(8, ["agent-ready", "priority: high", "priority: critical"]),
        iss(1, ["agent-ready", "unrelated"]),
      ],
      emptyLedger("me"),
      [],
      withPriority,
    );
    expect(q.map((i) => i.number)).toEqual([8, 2, 1]);
  });
});

describe("countRunning", () => {
  it("counts working issues without an open agent pull request, so waiting pull requests do not freeze the night", () => {
    const working = [
      iss(1, ["agent-working"]),
      iss(2, ["agent-working"]),
      iss(3, ["agent-working"]),
    ];
    const prs: PrSummary[] = [
      {
        number: 9,
        state: "OPEN",
        headRefName: "agent/1-x",
        updatedAt: "",
        closedAt: null,
        mergedAt: null,
        url: "",
      },
      {
        number: 10,
        state: "MERGED",
        headRefName: "agent/2-x",
        updatedAt: "",
        closedAt: "",
        mergedAt: "",
        url: "",
      },
    ];
    expect(countRunning(working, prs, cfg)).toBe(2);
  });
});

const capsCfg = {
  ...cfg,
  caps: { openPullRequests: 4, issuesPerNight: 4, concurrency: { day: 1, night: 2 } },
  schedule: {
    timezone: "UTC",
    profiles: { day: { from: "07:00", to: "22:00" }, nightStopsTakingWorkAt: "05:00" },
  },
} as unknown as ProjectConfig;
const day = { name: "day" as const, concurrency: 1, takesNewWork: true };
const night = { name: "night" as const, concurrency: 2, takesNewWork: true };
const open = { paused: false, draining: false };

// A resume-needed entry has no live stage yet occupies a slot the moment the tick
// dispatches its review, so it counts; an entry without the field counts as not running,
// not as running forever.
describe("countInFlight", () => {
  it("counts everything Step 2 or Step 2b owns, and nothing Step 3 does", () => {
    const stage = {
      name: "plan" as const,
      mode: "fresh" as const,
      taskId: "t",
      session: "s",
      startedAt: "",
    } as never;
    expect(
      countInFlight([
        { state: "planning", stage },
        { state: "resume-needed", stage: null },
        { state: "pr-open", stage: null },
        { state: "claimed", stage: undefined as unknown as null },
      ]),
    ).toBe(3);
  });
});

describe("windowStart", () => {
  // Changed from the source, which measured the window in the machine's zone: design
  // § 11 evaluates every wall-clock time in schedule.timezone, the zone `profileAt` uses,
  // so the fixtures are UTC instants of a UTC schedule.
  it("is today's day.from by day and the last day.to by night", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 9, h, 30));
    expect(windowStart(at(10), capsCfg, day).getUTCHours()).toBe(7);
    const eve = windowStart(at(23), capsCfg, night);
    expect([eve.getUTCDate(), eve.getUTCHours()]).toEqual([9, 22]);
    const small = windowStart(at(2), capsCfg, night);
    expect([small.getUTCDate(), small.getUTCHours()]).toEqual([8, 22]);
  });

  it("reads the window in the configured zone, not the machine's", () => {
    const berlin = {
      ...capsCfg,
      schedule: { ...capsCfg.schedule, timezone: "Europe/Berlin" },
    } as unknown as ProjectConfig;
    // 2026-09-09 10:30 UTC is 12:30 in Berlin (UTC+2): the day window began at 07:00
    // Berlin time, which is 05:00 UTC.
    const start = windowStart(new Date(Date.UTC(2026, 8, 9, 10, 30)), berlin, day);
    expect(start.toISOString()).toBe("2026-09-09T05:00:00.000Z");
  });
});

// The conjunction the tick evaluates before taking a new issue lives here, and
// caps.issuesPerNight has a consumer.
describe("newWorkGate", () => {
  const base = {
    profile: night,
    control: open,
    limitedUntil: null,
    counts: { inFlight: 0, repoWorking: 0, openAgentPrs: 0 },
    queueLength: 1,
    claimedThisWindow: 0,
  };
  const at = new Date(Date.UTC(2026, 8, 9, 1, 0));
  it("allows when every lever is clear", () => {
    expect(newWorkGate(base, capsCfg, at)).toEqual({
      allowed: true,
      reasons: [],
      claimedThisWindow: 0,
    });
  });
  it("names every lever that refuses", () => {
    const g = newWorkGate(
      {
        ...base,
        profile: { ...night, takesNewWork: false },
        control: { paused: true, draining: true },
        limitedUntil: new Date(at.getTime() + 60_000).toISOString(),
        counts: { inFlight: 2, repoWorking: 2, openAgentPrs: 4 },
        queueLength: 0,
        claimedThisWindow: 4,
      },
      capsCfg,
      at,
    );
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(" | ")).toMatch(/no new work/);
    expect(g.reasons.join(" | ")).toMatch(/paused/);
    expect(g.reasons.join(" | ")).toMatch(/draining/);
    expect(g.reasons.join(" | ")).toMatch(/limited until/);
    expect(g.reasons.join(" | ")).toMatch(/inFlight 2 >= concurrency 2/);
    expect(g.reasons.join(" | ")).toMatch(/repoWorking 2/);
    expect(g.reasons.join(" | ")).toMatch(/openAgentPrs 4/);
    expect(g.reasons.join(" | ")).toMatch(/issuesPerNight/);
    expect(g.reasons.join(" | ")).toMatch(/queue empty/);
  });
  it("applies issuesPerNight to the night only, and an expired limit not at all", () => {
    expect(newWorkGate({ ...base, profile: day, claimedThisWindow: 9 }, capsCfg, at).allowed).toBe(
      true,
    );
    expect(
      newWorkGate({ ...base, limitedUntil: new Date(at.getTime() - 1).toISOString() }, capsCfg, at)
        .allowed,
    ).toBe(true);
  });
});

// The states reconcile writes by itself need a step, and the situation is where the tick
// learns which entries are waiting for one.
describe("cleanupEntries and stalledEntries", () => {
  const entry = (issue: number, state: string, stage: unknown = null, worktree = "") =>
    ({ issue, state, stage, pr: null, worktree }) as never;
  const labelled = (...numbers: number[]) =>
    numbers.map((n) => ({ number: n }) as unknown as IssueSummary);

  it("leaves a cleanup entry alone while its stage still runs", () => {
    const stage = {
      name: "implement" as const,
      mode: "fix" as const,
      taskId: "t",
      session: "s",
      startedAt: "",
    };
    const entries = [entry(1, "merged", stage), entry(2, "merged")];
    // Step 2 stops the task first; removing the worktree under a live subagent is what
    // the pair rule prevents.
    expect(cleanupEntries(entries, labelled(1, 2)).map((e) => e.issue)).toEqual([2]);
  });

  it("lists the finished entries whose working label is still on the issue", () => {
    const entries = [
      entry(1, "merged"),
      entry(2, "closed"),
      entry(3, "blocked"),
      entry(4, "needs-shaping"),
      entry(5, "done"),
      entry(6, "pr-open"),
    ];
    expect(cleanupEntries(entries, labelled(1, 2, 3, 4, 5, 6)).map((e) => e.issue)).toEqual([
      1, 2, 3, 4,
    ]);
    // Released already: the label is gone, so there is nothing left to clean up.
    expect(cleanupEntries(entries, labelled(6)).map((e) => e.issue)).toEqual([]);
  });

  it("lists a finished entry whose worktree is still on disk even after the label is gone", () => {
    const entries = [
      entry(1, "merged", null, "/work/agent+1-x"),
      entry(2, "merged", null, "/gone"),
    ];
    expect(cleanupEntries(entries, [], ["/work/agent+1-x"]).map((e) => e.issue)).toEqual([1]);
  });

  it("lists every stage-less working entry, resume-needed included", () => {
    const stage = {
      name: "plan" as const,
      mode: "fresh" as const,
      taskId: "t",
      session: "s",
      startedAt: "",
    };
    const entries = [
      entry(1, "planning", stage),
      entry(2, "planning"),
      entry(3, "claimed"),
      entry(4, "fixing-local"),
      entry(5, "pr-open"),
      entry(6, "merged"),
      entry(7, "resume-needed"),
      entry(8, "done"),
    ];
    // 7 is resume-needed: Step 2b owns it too, because it is work in flight without a
    // stage, and the new-work step would refuse it exactly when its own slot is full.
    expect(stalledEntries(entries).map((e) => e.issue)).toEqual([2, 3, 4, 7]);
  });

  it("covers every state between the two lists, the pull request states and Step 4", () => {
    for (const state of ISSUE_STATES) {
      const owned =
        CLEANUP_STATES.has(state) ||
        PR_STATES.has(state) ||
        state === "done" ||
        state === "resume-needed" ||
        stalledEntries([entry(1, state)]).length === 1;
      expect(owned, `${state} belongs to no list`).toBe(true);
    }
  });

  // Changed from the source, which folded case on every platform: design § 10 (defect 2)
  // matches worktree paths with the file system's own case rules. Two real directories
  // that differ only in case exist only on a case-sensitive file system.
  it.skipIf(process.platform === "win32" || process.platform === "darwin")(
    "does not fold case when matching worktrees on linux (case-sensitive file system only)",
    () => {
      const base = mkdtempSync(join(tmpdir(), "situation-case-"));
      try {
        mkdirSync(join(base, "agent+1-Fix"));
        mkdirSync(join(base, "agent+1-fix"));
        const entries = [entry(1, "merged", null, join(base, "agent+1-Fix"))];
        expect(cleanupEntries(entries, [], [join(base, "agent+1-fix")])).toEqual([]);
        expect(cleanupEntries(entries, [], [join(base, "agent+1-Fix")]).length).toBe(1);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("matches a worktree reported with forward slashes against a native path", () => {
    const base = mkdtempSync(join(tmpdir(), "situation-slash-"));
    try {
      const dir = join(base, "agent+1-x");
      mkdirSync(dir);
      const entries = [entry(1, "merged", null, dir)];
      expect(cleanupEntries(entries, [], [dir.replace(/\\/g, "/")]).length).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("computeSituation", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const fullCfg = {
    ...capsCfg,
    forge: { remote: "origin" },
    labels: {
      ready: "agent-ready",
      working: "agent-working",
      blocked: "agent-blocked",
      needsShaping: "needs-shaping",
    },
    queue: { ready: "agent-ready", priority: ["priority: high"] },
    caps: {
      ...(capsCfg as unknown as { caps: object }).caps,
      staleClaimHours: 2,
    },
  } as unknown as ProjectConfig;
  const now = new Date(Date.UTC(2026, 8, 9, 12, 0));

  const forgeFor = (working: IssueSummary[], ready: IssueSummary[], prs: PrSummary[]) =>
    ({
      listIssues: (label: string) => (label === "agent-working" ? working : ready),
      listPrs: () => prs,
    }) as unknown as Forge;
  const execFor =
    (root: string): Exec =>
    () => ({
      status: 0,
      stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`,
      stderr: "",
    });

  function projectWithStaleClaim(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "situation-root-")));
    roots.push(root);
    const ledger = emptyLedger("me");
    transition(ledger, 7, "claimed", { title: "t", branch: "agent/7-x", worktree: "" });
    saveLedger(root, ledger, now);
    // An old timestamp, so an unwanted rewrite cannot hide inside the same millisecond.
    const old = new Date(Date.UTC(2020, 0, 1));
    utimesSync(join(root, ".autoclaude", "state", "ledger.json"), old, old);
    return root;
  }

  const snapshot = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) {
          out[p] = "dir";
          walk(p);
        } else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
      }
    };
    walk(root);
    return out;
  };

  it("returns exactly the documented keys", () => {
    const root = projectWithStaleClaim();
    const s = computeSituation(root, fullCfg, {
      forge: forgeFor([], [iss(3, ["agent-ready"])], []),
      exec: execFor(root),
      now,
      liveInstance: null,
      readOnly: true,
    });
    expect(Object.keys(s).sort()).toEqual(
      [
        "caps",
        "cleanup",
        "control",
        "counts",
        "foreign",
        "issues",
        "limitedUntil",
        "newWork",
        "profile",
        "queue",
        "stalled",
      ].sort(),
    );
    expect(s.queue).toEqual([{ number: 3, title: "t3" }]);
    expect(s.profile.name).toBe("day");
  });

  it("in read-only mode writes nothing", () => {
    const root = projectWithStaleClaim();
    const before = snapshot(root);
    const s = computeSituation(root, fullCfg, {
      forge: forgeFor([], [], []),
      exec: execFor(root),
      now,
      liveInstance: null,
      readOnly: true,
    });
    // The reconcile did decide something (the claim's issue is no longer labelled)...
    expect(s.issues.find((i) => i.issue === 7)?.state).not.toBe("claimed");
    // ...and none of it reached the disk: ledger, status, events logs, control files, locks.
    expect(snapshot(root)).toEqual(before);
  });

  it("outside read-only mode saves the reconciled ledger and logs the transition", () => {
    const root = projectWithStaleClaim();
    const path = join(root, ".autoclaude", "state", "ledger.json");
    const mtime = statSync(path).mtimeMs;
    computeSituation(root, fullCfg, {
      forge: forgeFor([], [], []),
      exec: execFor(root),
      now,
      liveInstance: null,
      readOnly: false,
    });
    expect(statSync(path).mtimeMs).toBeGreaterThan(mtime);
    expect(readFileSync(path, "utf8")).not.toContain('"state": "claimed"');
    expect(
      statSync(join(root, ".autoclaude", "state", "runs", "7", "events.log")).size,
    ).toBeGreaterThan(0);
    // The lock is released: nothing is left to block the next writer.
    expect(readdirSync(join(root, ".autoclaude", "state")).some((n) => n.includes("lock"))).toBe(
      false,
    );
  });

  it("counts a distinct issue claimed in this window once", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "situation-root-")));
    roots.push(root);
    const ledger = emptyLedger("me");
    transition(ledger, 1, "claimed", { title: "t", branch: "agent/1-x", worktree: "" }, now);
    transition(ledger, 1, "claimed", { title: "t", branch: "agent/1-x", worktree: "" }, now);
    saveLedger(root, ledger, now);
    const s = computeSituation(root, fullCfg, {
      forge: forgeFor([{ ...iss(1, ["agent-working"]), comments: [] }], [], []),
      exec: execFor(root),
      now,
      liveInstance: null,
      readOnly: true,
    });
    expect(s.newWork.claimedThisWindow).toBe(1);
  });
});
