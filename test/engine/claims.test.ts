import { describe, it, expect } from "vitest";
import {
  claimBlocker,
  claimBody,
  claimIssue,
  cli,
  freshAttemptLabels,
  releaseBody,
  releaseIssue,
  releaseLabels,
} from "../../src/engine/claims.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { Forge, type Exec, type IssueView } from "../../src/forge/github.js";

const cfg = {
  branchPrefix: "agent/",
  humans: ["maintainer"],
  queue: { ready: "agent-ready" },
  labels: {
    working: "agent-working",
    blocked: "agent-blocked",
    needsShaping: "needs-shaping",
    fixRound: "agent-fix-",
    reviewRetry: "agent-retry-",
  },
  caps: { staleClaimHours: 2, fixRounds: 2, reviewRetries: 2 },
} as unknown as ProjectConfig;
const now = new Date("2026-09-08T22:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
const iss = (labels: string[], assignees: string[] = []): IssueView =>
  ({
    number: 1,
    title: "t",
    body: "",
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
    assignees: assignees.map((login) => ({ login })),
    comments: [],
    updatedAt: "",
  }) as IssueView;

describe("claimBlocker", () => {
  it("wants an open issue with the ready label, no assignee and no working label, and says which failed", () => {
    expect(claimBlocker(iss(["agent-ready"]), cfg)).toBeNull();
    expect(claimBlocker(iss([]), cfg)?.code).toBe("not-ready");
    expect(claimBlocker(iss(["agent-ready"], ["jan"]), cfg)?.code).toBe("assigned");
    expect(claimBlocker(iss(["agent-ready", "agent-working"]), cfg)?.code).toBe("working");
    expect(claimBlocker({ ...iss(["agent-ready"]), state: "CLOSED" }, cfg)?.code).toBe("closed");
  });

  // A human re-applied agent-ready after a block: that is a fresh attempt, not the
  // old one continued, so it must not inherit the spent counters.
  it("is claimable with agent-blocked still present, and the claim clears the last attempt's labels", () => {
    expect(claimBlocker(iss(["agent-ready", "agent-blocked", "agent-fix-2"]), cfg)).toBeNull();
    expect(
      freshAttemptLabels(
        ["agent-ready", "agent-blocked", "agent-fix-2", "agent-retry-1", "bug"],
        cfg,
      ),
    ).toEqual(["agent-blocked", "agent-fix-2", "agent-retry-1"]);
  });
});

describe("releaseLabels", () => {
  it("removes the working label and the counters on done, keeps counters on blocked", () => {
    const labels = ["agent-ready", "agent-working", "agent-fix-2", "agent-retry-1", "bug"];
    expect(releaseLabels(labels, "done", cfg)).toEqual({
      remove: ["agent-ready", "agent-working", "agent-fix-2", "agent-retry-1"],
      add: [],
    });
    expect(releaseLabels(labels, "blocked", cfg)).toEqual({
      remove: ["agent-ready", "agent-working"],
      add: ["agent-blocked"],
    });
    expect(releaseLabels(labels, "needs-shaping", cfg)).toEqual({
      remove: ["agent-ready", "agent-working", "agent-fix-2", "agent-retry-1"],
      add: ["needs-shaping"],
    });
    expect(releaseLabels(labels, "ready", cfg)).toEqual({
      remove: ["agent-working", "agent-fix-2", "agent-retry-1"],
      add: ["agent-ready"],
    });
  });
});

// The claim race and the takeover under test, through
// a fake gh whose issue view changes as comments and labels land.
describe("claimIssue and releaseIssue", () => {
  const claimComment = (machine: string, at: string, createdAt = at) => ({
    author: { login: "x" },
    createdAt,
    body: `<!-- autodev-claim machine="${machine}" at="${at}" -->\nclaim`,
  });

  /** A GitHub of one issue: labels and comments change with the commands, and every command is recorded. */
  function github(start: {
    labels: string[];
    comments?: Array<{ author: { login: string }; createdAt: string; body: string }>;
    state?: "OPEN" | "CLOSED";
    prs?: Array<{
      number: number;
      state: string;
      headRefName: string;
      updatedAt: string;
      url: string;
    }>;
    /** A rival's claim that lands on GitHub right after ours, before we re-read. */
    rivalAfterOurs?: { machine: string; createdAt: string };
  }) {
    const labels = new Set(start.labels);
    const comments = [...(start.comments ?? [])];
    const calls: string[] = [];
    let tick = 0;
    const exec: Exec = (cmd, args, opts) => {
      // Every gh call must name its repository; the checks below read the command
      // without that pair.
      const at = args.indexOf("-R");
      if (cmd === "gh" && (at !== 0 || args[1] !== "acme/widgets")) {
        return {
          status: 1,
          stdout: "",
          stderr: `gh call without -R acme/widgets: ${args.join(" ")}`,
        };
      }
      const rest = cmd === "gh" ? args.slice(2) : args;
      const line = `${cmd} ${rest.join(" ")}`;
      calls.push(line);
      if (line.startsWith("gh issue view")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 1,
            title: "t",
            body: "",
            state: start.state ?? "OPEN",
            labels: [...labels].map((name) => ({ name })),
            assignees: [],
            comments,
            updatedAt: "",
          }),
          stderr: "",
        };
      }
      if (line.startsWith("gh issue edit")) {
        const add = rest.indexOf("--add-label");
        if (add >= 0) for (const l of (rest[add + 1] ?? "").split(",")) labels.add(l);
        const rm = rest.indexOf("--remove-label");
        if (rm >= 0) for (const l of (rest[rm + 1] ?? "").split(",")) labels.delete(l);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (line.startsWith("gh issue comment")) {
        const createdAt = new Date(now.getTime() + ++tick * 1000).toISOString();
        comments.push({ author: { login: "me" }, createdAt, body: opts?.input ?? "" });
        if (start.rivalAfterOurs && tick === 1) {
          const r = start.rivalAfterOurs;
          comments.push(claimComment(r.machine, r.createdAt, createdAt.replace("Z", "5Z")));
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (line.startsWith("gh pr list")) {
        return { status: 0, stdout: JSON.stringify(start.prs ?? []), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `no answer for: ${line}` };
    };
    return { exec, calls, labels, comments };
  }
  const deps = (exec: Exec) => ({
    forge: new Forge("acme/widgets", exec),
    cfg,
    machine: "me",
    now,
  });

  it("wins an uncontested claim, with the label and the counters in one edit", () => {
    const gh = github({ labels: ["agent-ready", "agent-blocked", "agent-fix-2"] });
    const r = claimIssue(1, { takeover: false }, deps(gh.exec));
    expect(r.won).toBe(true);
    expect([...gh.labels].sort()).toEqual(["agent-ready", "agent-working"]);
    expect(gh.calls.filter((c) => c.startsWith("gh issue edit"))).toEqual([
      "gh issue edit 1 --add-label agent-working --remove-label agent-blocked,agent-fix-2",
    ]);
  });

  it("does not attempt a claim the blocker refuses, and says why in a code", () => {
    expect(claimBlocker(iss([]), cfg)).toEqual({
      code: "not-ready",
      reason: "no agent-ready label",
    });
    expect(claimBlocker(iss(["agent-ready"], ["jan"]), cfg)?.code).toBe("assigned");
    const gh = github({ labels: ["agent-ready"], state: "CLOSED" });
    expect(claimIssue(1, { takeover: false }, deps(gh.exec))).toMatchObject({
      won: false,
      code: "closed",
    });
    expect(gh.calls.some((c) => c.startsWith("gh issue edit"))).toBe(false);
  });

  it("loses to an earlier claim that landed between the label and the re-read, and touches nothing more", () => {
    const gh = github({
      labels: ["agent-ready"],
      rivalAfterOurs: { machine: "rival", createdAt: hoursAgo(0.01) },
    });
    // The rival's comment is stamped earlier than ours by GitHub's clock.
    const r = claimIssue(1, { takeover: false }, deps(gh.exec));
    expect(r.won).toBe(false);
    expect(r.owner?.machine).toBe("rival");
    expect(gh.calls.filter((c) => c.startsWith("gh issue comment"))).toHaveLength(1);
    // The working label was ours to add, so a lost race takes it back; otherwise a
    // ghost marker in the thread would refuse every later plain claim.
    expect([...gh.labels]).toEqual(["agent-ready"]);
  });

  it("without --takeover, a stale claim still blocks; with it, every stale claim is ignored and released after the win", () => {
    const stale = [claimComment("dead", hoursAgo(5)), claimComment("loser", hoursAgo(4))];
    const plain = github({ labels: ["agent-ready", "agent-working"], comments: stale });
    expect(claimIssue(1, { takeover: false }, deps(plain.exec))).toMatchObject({
      won: false,
      code: "working",
    });

    const take = github({ labels: ["agent-ready", "agent-working"], comments: stale });
    const r = claimIssue(1, { takeover: true }, deps(take.exec));
    expect(r.won).toBe(true);
    const bodies = take.comments.map((c) => c.body);
    expect(
      bodies.some(
        (b) => b.includes("autodev-release") && b.includes("dead") && b.includes("loser"),
      ),
    ).toBe(true);
    // After the release marker only our claim is active.
    expect(bodies.at(-1)).toContain('machine="me"');
  });

  it("refuses a takeover while any claim is live, by GitHub's clock or a moving pull request", () => {
    const fresh = github({
      labels: ["agent-ready", "agent-working"],
      comments: [claimComment("other", hoursAgo(1))],
    });
    expect(claimIssue(1, { takeover: true }, deps(fresh.exec))).toMatchObject({
      won: false,
      code: "live-claim",
    });
    const busy = github({
      labels: ["agent-ready", "agent-working"],
      comments: [claimComment("other", hoursAgo(5))],
      prs: [
        { number: 2, state: "OPEN", headRefName: "agent/1-x", updatedAt: hoursAgo(0.2), url: "" },
      ],
    });
    expect(claimIssue(1, { takeover: true }, deps(busy.exec)).code).toBe("live-claim");
    expect(busy.calls.some((c) => c.startsWith("gh issue edit"))).toBe(false);
  });

  it("releases with one label edit and refuses a target outside the vocabulary", () => {
    const gh = github({ labels: ["agent-ready", "agent-working", "agent-fix-1"] });
    const r = releaseIssue(1, "blocked", "wall clock", deps(gh.exec));
    expect(r).toMatchObject({
      removed: ["agent-ready", "agent-working"],
      added: ["agent-blocked"],
    });
    expect(gh.calls.filter((c) => c.startsWith("gh issue edit"))).toEqual([
      "gh issue edit 1 --add-label agent-blocked --remove-label agent-ready,agent-working",
    ]);
    expect(() => releaseIssue(1, "Blocked" as never, "x", deps(gh.exec))).toThrow(
      /--to must be one of/,
    );
  });

  /**
   * The free `--reason` text goes into an issue comment, and a workflow may trigger on a
   * mention in one: an operator's rollback note, or a review's own words quoted into one,
   * would start a run from inside the release that ends the attempt. The mention is
   * defused except for the configured humans, who are meant to be notified.
   */
  // Changed from the source test on purpose (port notes: claim.ts @claude scrubbing -> project
  // option; C2 ruling): `defuseMentions(text, cfg.humans)` replaces the fixed `@claude` scrub.
  it("defuses the mention in a release reason before it reaches the comment, except a configured human's", () => {
    const gh = github({ labels: ["agent-ready", "agent-working"] });
    releaseIssue(
      1,
      "blocked",
      "rolled back by hand: @claude asked for this, see @Claude above, cc @maintainer",
      deps(gh.exec),
    );
    const body = gh.comments.at(-1)?.body ?? "";
    expect(body, "the at that starts a workflow run").not.toMatch(/@claude/i);
    // The word and its casing survive; only a zero-width space is inserted.
    expect(body).toContain("@\u200bclaude asked for this");
    expect(body).toContain("@\u200bClaude above");
    expect(body, "a human the project names is still mentioned").toContain("cc @maintainer");
    expect(body, "and the rest of the reason is untouched").toContain("rolled back by hand:");
  });

  it("writes the claim and release markers byte for byte as archived claims have them", () => {
    expect(claimBody("host/user", "2026-09-08T22:00:00.000Z")).toBe(
      '<!-- autodev-claim machine="host/user" at="2026-09-08T22:00:00.000Z" -->\nautodev: claimed by `host/user` at 2026-09-08T22:00:00.000Z. The earliest claim comment wins; a claim older than the configured stale window with no pull request activity may be taken over.',
    );
    expect(releaseBody("host/user", "done", [])).toBe(
      '<!-- autodev-release machine="host/user" -->\nautodev (host/user): done',
    );
  });

  /**
   * The release verb's own command line. A flag given twice is refused rather than
   * resolved by position, because both spellings are known and taking the first silently
   * drops the second: `release 9 --to blocked --reason x --to ready` must not release as
   * blocked with the typed `ready` gone. This verb edits an issue's labels and posts to
   * it, so the refusal has to come before either call.
   */
  describe("the release verb's flags", () => {
    it("refuses a repeated flag before anything reaches gh", () => {
      for (const argv of [
        ["release", "9", "--to", "blocked", "--reason", "x", "--to", "ready"],
        ["release", "9", "--to", "blocked", "--reason", "x", "--reason", "y"],
      ]) {
        const gh = github({ labels: ["agent-ready", "agent-working"] });
        expect(() => cli(argv, deps(gh.exec)), argv.join(" ")).toThrow(/given more than once/);
        expect(gh.calls, "the label edit and the comment are what must not have happened").toEqual(
          [],
        );
      }
    });

    it("refuses a flag whose value is the next flag, and a missing one", () => {
      const gh = github({ labels: ["agent-ready"] });
      expect(() => cli(["release", "9", "--to", "--reason", "x"], deps(gh.exec))).toThrow(
        /needs a value/,
      );
      expect(() => cli(["release", "9", "--to", "blocked"], deps(gh.exec))).toThrow(/--reason/);
      expect(gh.calls).toEqual([]);
    });

    // The positive control, without which every assertion above would pass on a verb that
    // refuses everything.
    it("releases on a well-formed line", () => {
      const gh = github({ labels: ["agent-ready", "agent-working"] });
      expect(cli(["release", "9", "--to", "blocked", "--reason", "wrong approach"], deps(gh.exec))).toBe(0); // prettier-ignore
      expect(gh.calls.some((c) => c.startsWith("gh issue edit"))).toBe(true);
      expect(gh.calls.some((c) => c.startsWith("gh issue comment"))).toBe(true);
    });
  });
});
