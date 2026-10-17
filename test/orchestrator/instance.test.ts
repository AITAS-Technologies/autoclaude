import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../src/config/types.js";
import {
  emptyLedger,
  reconcile,
  recordedInstance,
  transition,
  type Ledger,
} from "../../src/engine/ledger/ledger.js";
import type { IssueView } from "../../src/forge/github.js";
import { acquireInstance, recoverOrphans, sameProcess } from "../../src/orchestrator/instance.js";
import { processStartTime } from "../../src/platform/kill.js";

const tmp: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  // The real sleeping child never outlives its test.
  for (const c of children.splice(0)) c.kill("SIGKILL");
});
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "autoclaude-instance-"));
  tmp.push(root);
  return root;
}
const stateFile = (root: string) => join(root, ".autoclaude", "state", "instance.json");

/** A real child that sleeps for a minute unless killed. */
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(c);
  return c;
}
async function waitFor(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("acquireInstance", () => {
  it("refuses a second live instance", () => {
    const root = project();
    const first = acquireInstance(root);
    try {
      expect(() => acquireInstance(root)).toThrow(/already running/);
    } finally {
      first.release();
    }
    // Released: the next one gets it.
    acquireInstance(root).release();
  });

  it("writes { instance, pid, heartbeatAt } where recordedInstance reads it, atomically", () => {
    const root = project();
    const h = acquireInstance(root);
    try {
      const body = JSON.parse(readFileSync(stateFile(root), "utf8"));
      expect(Object.keys(body).sort()).toEqual(["heartbeatAt", "instance", "pid"]);
      expect(body.pid).toBe(process.pid);
      expect(body.instance).toBe(h.instance);
      expect(recordedInstance(root)).toBe(h.instance);
      expect(
        readdirSync(join(root, ".autoclaude", "state")).filter((f) => f.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      h.release();
    }
    expect(existsSync(stateFile(root))).toBe(false);
  });

  it("takes over a file whose pid is dead", () => {
    const root = project();
    const old = acquireInstance(root, { pid: 4_000_001, alive: () => true, newId: () => "old" });
    const h = acquireInstance(root, { alive: (pid) => pid !== 4_000_001, newId: () => "new" });
    expect(recordedInstance(root)).toBe("new");
    old.release(); // must not remove the new owner's file
    expect(recordedInstance(root)).toBe("new");
    h.release();
  });

  it("takes over a live pid's file only once its heartbeat is older than 120 s", () => {
    const root = project();
    let t = Date.parse("2026-03-01T10:00:00Z");
    const now = () => new Date(t);
    const a = acquireInstance(root, { now, pid: 4_000_002, alive: () => true, newId: () => "a" });
    t += 119_000;
    expect(() => acquireInstance(root, { now, alive: () => true })).toThrow(/already running/);
    t += 2_000;
    const b = acquireInstance(root, { now, alive: () => true, newId: () => "b" });
    expect(recordedInstance(root)).toBe("b");
    a.release();
    b.release();
  });

  it("takes over a file it cannot read", () => {
    const root = project();
    mkdirSync(join(root, ".autoclaude", "state"), { recursive: true });
    writeFileSync(stateFile(root), "{ torn");
    acquireInstance(root).release();
  });

  it("beats on an unref'd timer that release clears", async () => {
    const root = project();
    const spy = vi.spyOn(globalThis, "setInterval");
    const h = acquireInstance(root, { heartbeatMs: 20 });
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef(), "a heartbeat must not keep the process alive").toBe(false);
    const first = JSON.parse(readFileSync(stateFile(root), "utf8")).heartbeatAt as string;
    expect(
      await waitFor(() => JSON.parse(readFileSync(stateFile(root), "utf8")).heartbeatAt !== first),
    ).toBe(true);
    h.release();
    expect(existsSync(stateFile(root))).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(stateFile(root)), "no beat after release").toBe(false);
  });
});

describe("sameProcess (ruling R19)", () => {
  const a = "2026-03-01T10:00:00.000Z";
  const plus = (s: number) => new Date(Date.parse(a) + s * 1000).toISOString();
  it("is exact on Windows", () => {
    expect(sameProcess(a, a, "win32")).toBe(true);
    expect(sameProcess(a, plus(1), "win32")).toBe(false);
  });
  it("tolerates 2 s on POSIX and not 3 s (positive control)", () => {
    expect(sameProcess(a, plus(1), "linux")).toBe(true);
    expect(sameProcess(a, plus(-2), "darwin")).toBe(true);
    expect(sameProcess(a, plus(3), "linux")).toBe(false);
  });
  it("never matches a missing time", () => {
    expect(sameProcess(null, a, "linux")).toBe(false);
    expect(sameProcess(a, null, "linux")).toBe(false);
  });
});

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

function ledgerWithStage(over: { pid: number | null; instance: string; startedAt: string | null }) {
  const l = emptyLedger("me", "new");
  transition(l, 9, "claimed", { title: "t", branch: "agent/9-t", worktree: "w" }, now);
  transition(
    l,
    9,
    "implementing",
    {
      stage: {
        stage: "implement",
        mode: "fresh",
        pid: over.pid,
        instance: over.instance,
        processStartedAt: over.startedAt,
        startedAt: now.toISOString(),
      },
    },
    now,
  );
  return l;
}

function reconciled(l: Ledger): Ledger {
  const at = new Date(now.getTime() - 3600_000).toISOString();
  const issue: IssueView = {
    number: 9,
    title: "Issue 9",
    state: "OPEN",
    labels: [{ name: "agent-working" }],
    assignees: [],
    comments: [
      {
        author: { login: "octo" },
        createdAt: at,
        body: `<!-- autodev-claim machine="me" at="${at}" -->\nautodev claim by me`,
      },
    ],
    updatedAt: at,
    body: "",
  };
  return reconcile(
    l,
    { working: [issue], prs: [] },
    ["C:/x/.autoclaude/worktrees/agent+9-t"],
    cfg,
    now,
  );
}

describe("recoverOrphans", () => {
  it("marks a foreign-instance stage resume-needed", async () => {
    const l = ledgerWithStage({
      pid: 2_147_483_000,
      instance: "old",
      startedAt: "2026-09-08T21:00:00.000Z",
    });
    const kill = vi.fn(async () => {});
    // The pid is dead: nothing to kill; the record is left for the reconcile.
    expect(await recoverOrphans("unused", l, { startTime: () => null, kill })).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    const after = reconciled(l);
    expect(after.issues["9"]!.state).toBe("resume-needed");
    expect(after.issues["9"]!.stage).toBeNull();
  });

  it("kills an orphaned stage only when its recorded start time matches", async () => {
    const child = sleeper();
    const pid = child.pid!;
    expect(await waitFor(() => processStartTime(pid) !== null)).toBe(true);
    const real = processStartTime(pid)!;

    // Positive control: a different start time (a reused pid) is left alone.
    const wrong = new Date(Date.parse(real) - 3_600_000).toISOString();
    const l1 = ledgerWithStage({ pid, instance: "old", startedAt: wrong });
    expect(await recoverOrphans("unused", l1)).toEqual([]);
    expect(processStartTime(pid), "a process with another start time must survive").not.toBeNull();

    // The same pid with its real start time is killed.
    const l2 = ledgerWithStage({ pid, instance: "old", startedAt: real });
    expect(await recoverOrphans("unused", l2)).toEqual([9]);
    expect(await waitFor(() => processStartTime(pid) === null)).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "kills a POSIX process whose recorded time is 1 s off",
    async () => {
      const child = sleeper();
      const pid = child.pid!;
      expect(await waitFor(() => processStartTime(pid) !== null)).toBe(true);
      const off = new Date(Date.parse(processStartTime(pid)!) + 1000).toISOString();
      const l = ledgerWithStage({ pid, instance: "old", startedAt: off });
      expect(await recoverOrphans("unused", l)).toEqual([9]);
      expect(await waitFor(() => processStartTime(pid) === null)).toBe(true);
    },
    30_000,
  );

  it("leaves this instance's own stages, a stage with no pid or no start time", async () => {
    const kill = vi.fn(async () => {});
    const startTime = () => "2026-09-08T21:00:00.000Z";
    for (const l of [
      ledgerWithStage({ pid: 4242, instance: "new", startedAt: startTime() }),
      ledgerWithStage({ pid: null, instance: "old", startedAt: startTime() }),
      ledgerWithStage({ pid: 4242, instance: "old", startedAt: null }),
    ]) {
      expect(await recoverOrphans("unused", l, { startTime, kill })).toEqual([]);
    }
    expect(kill).not.toHaveBeenCalled();
  });
});
