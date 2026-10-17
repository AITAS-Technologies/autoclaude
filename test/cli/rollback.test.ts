import { afterAll, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doneAsJson,
  parseRollbackArgs,
  renderReleaseFailed,
  renderRemaining,
  rollback,
  rollbackVerb,
} from "../../src/cli/rollback.js";
import {
  emptyLedger,
  loadLedger,
  saveLedger,
  transition,
  type IssueState,
  type StageRun,
} from "../../src/engine/ledger/ledger.js";
import { loadProjectConfig } from "../../src/config/load.js";
import { Forge, type Exec } from "../../src/forge/github.js";
import { capture, envFor, MINIMAL } from "../helpers/cli-env.js";

const cfg = loadProjectConfig(MINIMAL);

const now = new Date("2026-09-15T09:00:00Z");
const TODAY = "2026-09-15";

// Every temporary root this file makes, removed at the end, for the reason ledger.test.ts
// gives: on the orchestrator machine the suite runs all night.
const tempRoots: string[] = [];
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "autoclaude-rollback-"));
  tempRoots.push(r);
  return r;
}
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const stage = (instance: string): StageRun => ({
  stage: "implement",
  mode: "fresh",
  pid: 4242,
  instance,
  startedAt: now.toISOString(),
  processStartedAt: null,
});

const stateDir = (root: string) => join(root, ".autoclaude", "state");

/** A root with a ledger entry for #9, a worktree recorded, and an archived run directory. */
function setup(
  opts: {
    state?: IssueState;
    pr?: number | null;
    stage?: StageRun | null;
    /** The orchestrator instance recorded in instance.json; absent means none is recorded. */
    session?: string;
    /** How old its heartbeat is, in seconds (default 10: alive). */
    heartbeatAge?: number;
    /** false leaves the issue without a run archive, the way a run that died early does. */
    runs?: boolean;
    /** No ledger entry at all: the mistyped number. */
    entry?: false;
    /** What the row's `branch` field holds: a hand-edited or mistyped name is the point. */
    branch?: string;
    /** What the row's `worktree` field holds; "" is what reconcile writes for a pull request with nothing on disk. */
    worktree?: string;
  } = {},
): { root: string; worktree: string } {
  const root = tempRoot();
  const state = stateDir(root);
  mkdirSync(state, { recursive: true });
  if (opts.session)
    writeFileSync(
      join(state, "instance.json"),
      JSON.stringify({
        instance: opts.session,
        pid: 4321,
        heartbeatAt: new Date(now.getTime() - (opts.heartbeatAge ?? 10) * 1000).toISOString(),
      }),
    );
  if (opts.runs !== false) {
    mkdirSync(join(state, "runs", "9"), { recursive: true });
    writeFileSync(join(state, "runs", "9", "events.log"), "2026-09-14T00:00:00Z #9 - earlier\n");
  }
  const worktree = join(root, ".autoclaude", "worktrees", "agent+9-x");
  // On disk as well as in the listing, which is the normal state and the one the gates
  // read: a registration whose directory is gone is now told from a live worktree by
  // `existsSync` rather than by a prune in the gate phase, so a fixture that never
  // created the directory would have exercised only the stale half. The one test about a directory deleted by hand removes it again.
  mkdirSync(worktree, { recursive: true });
  const ledger = emptyLedger("host/ada");
  if (opts.entry !== false) {
    transition(
      ledger,
      9,
      opts.state ?? "code-reviewing",
      {
        title: "t",
        branch: opts.branch ?? "agent/9-x",
        worktree: opts.worktree ?? worktree,
        pr: opts.pr ?? 77,
        stage: opts.stage ?? null,
      },
      now,
    );
  }
  saveLedger(root, ledger, now);
  return { root, worktree };
}

/**
 * Answers by command prefix (longest first), recording every call and every stdin body.
 *
 * Stateful where a real git is: the prune drops a registration whose directory is gone,
 * `worktree remove` drops it outright, `branch -D` takes a local branch out of the list
 * `branch --list` answers from, and `push origin --delete` is what takes the remote
 * branch away. Without that, the after-state queries the result is built from could only
 * ever return one answer, which is how the pre-prune snapshot went unnoticed.
 */
function fake(
  root: string,
  overrides: Record<string, { status?: number; stdout?: string }> = {},
  opts: {
    directoryGone?: boolean;
    localBranches?: string[];
    /** false: no worktree is registered for the issue. */
    registered?: boolean;
    /** false: the remote has no branch of the issue. */
    remoteHas?: boolean;
  } = {},
) {
  const wtPath = `${root.replace(/\\/g, "/")}/.autoclaude/worktrees/agent+9-x`;
  let registered = opts.registered ?? true;
  let remote = opts.remoteHas ?? true;
  // The local branches this repository has, asked about in two ways for two reasons —
  // `branch --format` for the whole set, which is where a `--keep-branch-as` name is
  // compared against what exists, and `branch --list <prefix>*` for the issue's namespace
  // inside `removeWorktree`. An answer that ignored the question could not tell them apart.
  const local = new Set(opts.localBranches ?? ["agent/9-x"]);
  const porcelain = () =>
    [
      `worktree ${root.replace(/\\/g, "/")}`,
      "HEAD aaa",
      "branch refs/heads/develop",
      "",
      ...(registered ? [`worktree ${wtPath}`, "HEAD bbb", "branch refs/heads/agent/9-x", ""] : []),
    ].join("\n");
  const calls: string[] = [];
  const stdin: Record<string, string> = {};
  const answers: Record<string, { status?: number; stdout?: string }> = {
    "gh -R acme/widgets pr list": { stdout: "[]" },
    "gh -R acme/widgets issue view": {
      stdout: JSON.stringify({
        number: 9,
        title: "t",
        body: "",
        state: "OPEN",
        labels: [{ name: "agent-ready" }, { name: "agent-working" }],
        assignees: [],
        comments: [],
        updatedAt: "",
      }),
    },
    "gh -R acme/widgets issue edit": {},
    "gh -R acme/widgets issue comment": {},
    "git -c core.quotePath=false worktree list --porcelain": {},
    "git -c core.quotePath=false worktree prune": {},
    "git -c core.quotePath=false worktree remove": {},
    // The namespace listing `removeWorktree` makes, with the flags that keep a decorated
    // or columnised git config out of its parsing: keyed on the spelling with them, so a
    // listing that lost either flag is answered by nothing.
    "git -c core.quotePath=false branch --no-color --no-column --list": {},
    // Every local branch, which is how the keep-branch-as gate compares a name against
    // the ref store rather than against git's own case-sensitive pattern match
    //.
    "git -c core.quotePath=false branch --no-color --format": {},
    "git -c core.quotePath=false branch -D": {},
    "git -c core.quotePath=false branch": {},
    "git push origin --delete": {},
    // Both spellings: the rollback's own `remoteGone` reads the status through a raw
    // `exec`, and `removeWorktree` asks the namespace through the throwing `git()` helper,
    // which prefixes `-c core.quotePath=false`. One answer, two keys, so a fake that
    // knew only the bare form would have failed that listing rather than answering it.
    "git ls-remote --heads origin": {},
    "git -c core.quotePath=false ls-remote --heads origin": {},
    // The two gates that ask git whether a `--keep-branch-as` copy can be cut at all:
    // whether the name is a legal ref, and whether the source branch resolves here.
    // Read for their status, so neither goes through the throwing `git()` helper.
    "git check-ref-format": {},
    "git rev-parse": { stdout: "bbb\n" },
    ...overrides,
  };
  const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
  const exec: Exec = (cmd, args, io) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const key = keys.find((k) => line.startsWith(k));
    if (io?.input !== undefined && key !== undefined) stdin[key] = io.input;
    if (key === undefined) return { status: 1, stdout: "", stderr: `no answer for: ${line}` };
    const status = answers[key]!.status ?? 0;
    // Every branch command this fake answers takes the branch name last.
    const name = args[args.length - 1]!;
    if (status === 0) {
      if (key.endsWith("worktree prune") && opts.directoryGone) registered = false;
      if (key.endsWith("worktree remove")) registered = false;
      if (key.endsWith("branch -D")) local.delete(name);
      if (key === "git push origin --delete") remote = false;
    }
    let stdout = answers[key]!.stdout;
    if (stdout === undefined && key.endsWith("worktree list --porcelain")) stdout = porcelain();
    // `git branch --list <glob>` as well as `--list <name>`: `removeWorktree` asks for
    // the issue's whole namespace (`agent/9-*`), which is how it finds the branch to
    // delete when the registration is already gone, and a fake that only ever matched an
    // exact name would have answered "no such branch" for every one of those.
    if (stdout === undefined && key.endsWith("--list")) {
      const prefix = name.endsWith("*") ? name.slice(0, -1) : null;
      stdout =
        prefix === null
          ? local.has(name)
            ? `  ${name}\n`
            : ""
          : [...local]
              .filter((b) => b.startsWith(prefix))
              .map((b) => `  ${b}\n`)
              .join("");
    }
    // `--format=%(refname:short)`: one name per line, no marker column, the whole set.
    if (stdout === undefined && key.endsWith("--no-color --format"))
      stdout = [...local].map((b) => `${b}\n`).join("");
    if (stdout === undefined && key.endsWith("ls-remote --heads origin"))
      stdout = remote ? "bbb\trefs/heads/agent/9-x\n" : "";
    return { status, stdout: stdout ?? "", stderr: "" };
  };
  return { exec, calls, stdin, worktree: wtPath };
}

const deps = (root: string, exec: Exec, extra: { cwd?: string } = {}) => ({
  exec,
  forge: new Forge("acme/widgets", exec),
  root,
  cfg,
  machine: "host/ada",
  now,
  ...extra,
});
const removals = (calls: string[]) =>
  calls.filter(
    (c) => /worktree remove/.test(c) || /branch -D/.test(c) || /push origin --delete/.test(c),
  );
/**
 * Every call that changes something, for the refusals that promise "nothing ran".
 *
 * The reads a gate makes are not on it — `gh pr list`, `git worktree list`,
 * `branch --list`, `check-ref-format`, `rev-parse`, `ls-remote` — so a refusal's whole
 * contract can be asserted as an empty list even for the gates that ask git something
 * first. `git branch <new> <old>` is a mutation and `git branch --list` is not, which is
 * why the branch pattern below excludes an argument starting with a dash.
 */
const mutations = (calls: string[]) =>
  calls.filter(
    (c) =>
      /worktree (prune|remove)|branch -D|push origin --delete|gh -R \S+ issue (edit|comment)/.test(
        c,
      ) || /^git (-c \S+ )?branch [^-]/.test(c),
  );

describe("rollback, the hand rollback of one agent run", () => {
  const PRS = "gh -R acme/widgets pr list";
  const OPEN_PR = {
    [PRS]: {
      stdout: JSON.stringify([
        { number: 77, state: "OPEN", headRefName: "agent/9-x", updatedAt: "", url: "u" },
      ]),
    },
  };
  const WORKTREE_GONE = {
    "git -c core.quotePath=false worktree list --porcelain": {
      stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
    },
  };

  // Closing the pull request stays a human's verb. With one open the worktree and the local
  // branch still go, the remote branch stays, and the result says why (ruling R63).
  it("keeps the remote branch while a pull request is open, and says so", () => {
    const { root } = setup();
    const f = fake(root, OPEN_PR);
    const r = rollback(9, { to: "blocked", reason: "wrong approach" }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "done", code: 0, worktreeRemoved: true, remoteDeleted: null });
    expect(r.kind === "done" && r.remoteKept).toMatch(/#77 is still open/);
    expect(f.calls).toContain(`git -c core.quotePath=false worktree remove --force ${f.worktree}`);
    expect(f.calls).toContain("git -c core.quotePath=false branch -D agent/9-x");
    expect(f.calls.filter((c) => c.includes("push origin --delete"))).toEqual([]);
    expect(r.kind === "done" && String(doneAsJson(r).remoteDeleted)).toMatch(/^kept: .*#77/);
    // The ledger keeps the open pull request's number: the run is over, the PR is not.
    const e = loadLedger(root, "host/ada").issues["9"]!;
    expect(e.state).toBe("blocked");
    expect(e.pr).toBe(77);
  });

  // The cases the engine's refusal to claim names this verb for (ruling R63): leftover state
  // with no ledger entry at all, cleared idempotently and without anything posted.
  describe("leftover state without a ledger entry", () => {
    const bare = (over: Parameters<typeof fake>[1] = {}, o: Parameters<typeof fake>[2] = {}) => {
      const { root } = setup({ entry: false });
      const f = fake(root, over, o);
      const run = () => rollback(9, { to: null, reason: "" }, deps(root, f.exec));
      return { root, f, run };
    };
    const deleted = (calls: string[]) =>
      calls.filter((c) => c === "git push origin --delete agent/9-x");

    it("a worktree only: removes it and its local branch, deletes nothing remote that is not there", () => {
      const { f, run } = bare({}, { remoteHas: false });
      expect(run()).toMatchObject({
        kind: "done",
        code: 0,
        to: null,
        released: false,
        worktreeRemoved: true,
        ledgerState: null,
        runsMovedTo: null,
      });
      expect(f.calls).toContain("git -c core.quotePath=false branch -D agent/9-x");
      expect(deleted(f.calls)).toEqual([]);
      // Nothing is posted to GitHub: there is no run to release.
      expect(f.calls.some((c) => c.includes(" issue "))).toBe(false);
    });

    it("a remote branch only: deletes it", () => {
      const { f, run } = bare(WORKTREE_GONE, { registered: false, localBranches: [] });
      const r = run();
      // No row and no worktree names a branch, so there is nothing to verify: null, and the
      // namespace deletion ran anyway.
      expect(r).toMatchObject({ kind: "done", worktreeRemoved: false, remoteDeleted: null });
      expect(deleted(f.calls)).toHaveLength(1);
      expect(f.calls.filter((c) => c.includes("branch -D"))).toEqual([]);
    });

    it("both: clears the worktree, the local branch and the remote branch", () => {
      const { f, run } = bare();
      expect(run()).toMatchObject({ kind: "done", worktreeRemoved: true, remoteDeleted: true });
      expect(deleted(f.calls)).toHaveLength(1);
      expect(f.calls).toContain("git -c core.quotePath=false branch -D agent/9-x");
    });

    it("an open pull request: the worktree and local branch go, the remote branch stays, with a message", () => {
      const { f, run } = bare(OPEN_PR);
      const r = run();
      expect(r).toMatchObject({ kind: "done", worktreeRemoved: true, remoteDeleted: null });
      expect(r.kind === "done" && r.remoteKept).toMatch(/#77 is still open.*autoclaude rollback 9/);
      expect(deleted(f.calls)).toEqual([]);
    });

    it("is idempotent: a second run, with nothing left, succeeds and changes nothing", () => {
      const { root, f } = bare();
      const first = rollback(9, { to: null, reason: "" }, deps(root, f.exec));
      expect(first).toMatchObject({ kind: "done", worktreeRemoved: true });
      const before = f.calls.length;
      const second = rollback(9, { to: null, reason: "" }, deps(root, f.exec));
      expect(second).toMatchObject({ kind: "done", code: 0, worktreeRemoved: false });
      // The listings are repeated; no deletion is.
      expect(removals(f.calls.slice(before)).filter((c) => /push|branch -D/.test(c))).toEqual([]);
    });

    it("with --to it still releases the claim, and writes no ledger entry", () => {
      const { root, f } = bare();
      const r = rollback(9, { to: "blocked", reason: "leftovers" }, deps(root, f.exec));
      expect(r).toMatchObject({
        kind: "done",
        released: true,
        ledgerState: "blocked",
        runsMovedTo: null,
      });
      expect(f.calls.some((c) => c.includes(" issue comment"))).toBe(true);
      expect(loadLedger(root, "host/ada").issues["9"]).toBeUndefined();
    });
  });

  it("clears the leftovers of a finished ledger entry without releasing it again", () => {
    const { root } = setup({ state: "blocked" });
    const f = fake(root);
    const r = rollback(9, { to: null, reason: "" }, deps(root, f.exec));
    expect(r).toMatchObject({
      kind: "done",
      released: false,
      worktreeRemoved: true,
      ledgerState: null,
    });
    expect(f.calls.some((c) => c.includes(" issue "))).toBe(false);
    // The entry is left as it was.
    expect(loadLedger(root, "host/ada").issues["9"]!.state).toBe("blocked");
  });

  it("refuses to clear a run the ledger holds without being told where it goes", () => {
    const { root } = setup();
    const f = fake(root);
    const r = rollback(9, { to: null, reason: "" }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(/autoclaude rollback 9 --to/);
    expect(mutations(f.calls)).toEqual([]);
  });

  /**
   * The one place in the tree that deletes a remote branch by a name it was handed.
   *
   * `branch` is `wt?.branch ?? entry.branch`, so with no worktree registered it is the
   * ledger row verbatim, and the removal step pushes `--delete` on it. `removeWorktree`'s
   * own prefix refusal never sees that path — it returns early without a registration —
   * and the stage guard cannot either, because the push is a child process of an
   * stage-allowed verb. A mistyped row is enough; so is
   * `autoclaude ledger set 9 claimed --branch develop`, which the ledger used to store unvalidated
   *.
   */
  it("refuses a row whose branch is outside the agent namespace, with no push and no release", () => {
    // The porcelain lists the main directory only: no registration, so the name the
    // ledger holds is the name the removal would have used.
    const noWorktree = {
      "git -c core.quotePath=false worktree list --porcelain": {
        stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      },
    };
    for (const branch of [
      "develop",
      "main",
      "wip/9-rescued",
      "agent/8-other",
      // A refspec passes a prefix check, and `publish.ts` pushed the stored name verbatim:
      // `git push origin agent/9-x:develop` sends the rebased worktree branch to remote
      // `develop` as a fast-forward, with no pull request; `:main` reaches production.
      // Refused where the name is read as well as where it is
      // written.
      "agent/9-x:develop",
      "agent/9-x:main",
      // And a name git itself refuses as a ref: the remedies this command prints are
      // pasted into a shell.
      "agent/9-x; rm -rf ~",
    ]) {
      const { root } = setup({ branch, worktree: "" });
      // `check-ref-format` answers the way git does, measured: exit 128 for a name with a
      // space, a `~` or a colon in it, exit 0 for the rest. A fake that always said 0
      // would have let the gate's own git call pass everything.
      const f = fake(root, {
        ...noWorktree,
        ...(/[\s~^:?*[\\]/.test(branch) ? { "git check-ref-format": { status: 1 } } : {}),
      });
      const r = rollback(9, { to: "blocked", reason: "x" }, deps(root, f.exec));
      expect(r, branch).toMatchObject({ kind: "refused", code: 1 });
      const refused = r.kind === "refused" ? r.refused : "";
      expect(refused, branch).toContain(branch);
      expect(refused, "the remedy, or the row can never be corrected").toMatch(
        /autoclaude ledger set 9 code-reviewing --branch agent\/9-/,
      );
      expect(mutations(f.calls), branch).toEqual([]);
      expect(f.calls.some((c) => c.includes(" issue ")), branch).toBe(false); // prettier-ignore
      // And the row is untouched, so the correction is the operator's to make.
      expect(loadLedger(root, "host/ada").issues["9"]!.branch, branch).toBe(branch);
    }
    // A name the issue's own prefix covers is what the command is for.
    const ok = setup({ branch: "agent/9-x", worktree: "" });
    const g = fake(ok.root, noWorktree);
    expect(rollback(9, { to: "blocked", reason: "x" }, deps(ok.root, g.exec))).toMatchObject({
      kind: "done",
    });
  });

  // A process cannot remove the directory it is standing in. Measured on Windows: a child
  // `git` given a different cwd still fails with "the process cannot access the file
  // because it is in use by another process", and the directory stays. The worktree is a
  // natural place to be — `repoRoot()` resolves from anywhere inside it — and the failure
  // would land after the release.
  it("refuses when it is run from inside the worktree it would remove, before anything runs", () => {
    const { root, worktree } = setup();
    const f = fake(root);
    const inside = deps(root, f.exec, { cwd: join(worktree, "src", "widgets") });
    const r = rollback(9, { to: "blocked", reason: "x" }, inside);
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(/main working directory/);
    expect(f.calls).toEqual([]);

    // The separator is the whole point of the check: a sibling whose name merely starts
    // with the worktree's is not inside it, and refusing there would refuse a rollback
    // run from the directory next door.
    const other = setup();
    const g = fake(other.root);
    const beside = deps(other.root, g.exec, { cwd: `${other.worktree}-old` });
    expect(rollback(9, { to: "blocked", reason: "x" }, beside)).toMatchObject({ kind: "done" });
  });

  // Windows paths are case-insensitive and `process.cwd()` returns the casing that was
  // typed: `Set-Location` to a lowercase spelling of an existing directory reports it
  // lowercase, `resolve` is lexical, and a case-sensitive comparison then said the process
  // was not in the directory it was standing in — both gates missed and the removal failed
  // after the release, which is the outcome the gate exists to prevent.
  //
  // Windows-only, and CI runs on Linux: this case has no leg in the pipeline that gates
  // the merge, so it is read-verified there and executed on the machine the orchestrator
  // actually runs on. Gating it is still right — `resolve(p).toLowerCase()` is a no-op
  // where the platform is case-sensitive, so the same assertion elsewhere would pass
  // whatever `inside()` did with the casing, which is worse than skipping
  //.
  it.runIf(process.platform === "win32")(
    "refuses from inside the worktree however the path is cased",
    () => {
      const { root, worktree } = setup();
      const f = fake(root);
      const shouted = deps(root, f.exec, { cwd: worktree.toUpperCase() });
      expect(rollback(9, { to: "blocked", reason: "x" }, shouted)).toMatchObject({
        kind: "refused",
        code: 1,
      });
      expect(f.calls).toEqual([]);
    },
  );

  // `ready` and `none` put the issue back within reach of a claim, and that happens
  // before the worktree, the branch and the ledger entry come down. An orchestrator
  // ticking in that window claims the issue and builds a second attempt on top of the
  // first one's teardown.
  it("refuses a release that reopens the issue while an orchestrator instance is live", () => {
    for (const to of ["ready", "none"] as const) {
      const { root } = setup({ session: "orc-2026-09-15" });
      const f = fake(root);
      const r = rollback(9, { to, reason: "x" }, deps(root, f.exec));
      expect(r, `--to ${to}`).toMatchObject({ kind: "refused", code: 1 });
      const refused = r.kind === "refused" ? r.refused : "";
      expect(refused, "the way out, or a rollback gets done by hand again").toMatch(
        /autoclaude pause/,
      );
      expect(f.calls, `--to ${to}`).toEqual([]);
    }
    // `blocked` and `needs-shaping` leave the issue unclaimable, so a recorded session is
    // no reason to refuse: those are the two targets the message offers as the way out.
    for (const to of ["blocked", "needs-shaping"] as const) {
      const { root } = setup({ session: "orc-2026-09-15" });
      const f = fake(root);
      expect(rollback(9, { to, reason: "x" }, deps(root, f.exec)), `--to ${to}`).toMatchObject({
        kind: "done",
      });
    }
  });

  // The other way out the message names has to work, or the message is worse than no
  // message: `autoclaude pause` writes PAUSED and never touches instance.json, so the gate above
  // refused a release the operator had just done everything it asked. A
  // paused orchestrator takes no new work, which is the whole condition the gate is about.
  it("lets a release reopen the issue once the orchestrator is paused", () => {
    const { root } = setup({ session: "orc-2026-09-15" });
    const f = fake(root);
    // Without the pause file, still refused: the pause is what lifts it, not the target.
    expect(rollback(9, { to: "ready", reason: "x" }, deps(root, f.exec))).toMatchObject({
      kind: "refused",
    });
    writeFileSync(join(stateDir(root), "PAUSED"), `${now.toISOString()}\n`);
    expect(rollback(9, { to: "ready", reason: "x" }, deps(root, f.exec))).toMatchObject({
      kind: "done",
      to: "ready",
    });
  });

  // The defect this command exists for: a run rolled back by hand kept a
  // standing claim comment, because the release is the one step that shows nothing on
  // disk. So it goes first, and everything destructive after it.
  it("posts the release comment before any removal, so a failure later cannot leave the claim standing", () => {
    const { root } = setup();
    const f = fake(root);
    expect(rollback(9, { to: "blocked", reason: "wrong approach" }, deps(root, f.exec))).toMatchObject({ kind: "done", code: 0 }); // prettier-ignore
    const comment = f.calls.findIndex((c) => c.includes(" issue comment"));
    const edit = f.calls.findIndex((c) => c.includes(" issue edit"));
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(comment).toBeGreaterThan(edit);
    expect(removals(f.calls).length).toBeGreaterThan(0);
    for (const removal of removals(f.calls)) {
      expect(f.calls.indexOf(removal)).toBeGreaterThan(comment);
    }
    expect(f.stdin["gh -R acme/widgets issue comment"]).toContain("autodev-release");
    expect(f.stdin["gh -R acme/widgets issue comment"]).toContain("wrong approach");
  });

  // The release is two calls, the labels and then the comment. A throw between them used
  // to escape main() raw: the issue kept the released labels with no release marker —
  // the standing-claim state this command exists to prevent — and the output said only
  // what `gh` had said.
  it("reports a release that failed part-way and runs nothing destructive", () => {
    const { root } = setup();
    const f = fake(root, { "gh -R acme/widgets issue comment": { status: 1 } });
    const r = rollback(9, { to: "ready", reason: "gh went away" }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "release-failed", code: 1, released: false });
    const remaining = r.kind === "release-failed" ? r.remaining : [];
    expect(remaining).toEqual(["autoclaude release 9 --to ready --reason 'gh went away'"]);
    // Nothing destructive ran, and the ledger still holds the run: the same command
    // again is the second attempt once `gh` answers.
    expect(removals(f.calls)).toEqual([]);
    const e = loadLedger(root, "host/ada").issues["9"]!;
    expect(e.state).toBe("code-reviewing");
    expect(e.pr).toBe(77);
    // What the CLI prints says which half may have happened; the command is the last line.
    const printed = renderReleaseFailed(remaining, root);
    expect(printed).toMatch(/labels/);
    expect(printed).toMatch(/comment/);
    expect(printed).toContain(root);
    expect(printed.split("\n").slice(-1)).toEqual(remaining);
  });

  it("keeps a copy of the branch under the given name and refuses a name under the agent prefix", () => {
    const kept = setup();
    const f = fake(kept.root);
    const r = rollback(
      9,
      { to: "ready", reason: "keep the work", keepBranchAs: "wip/9-rescued" },
      deps(kept.root, f.exec),
    );
    expect(r).toMatchObject({ kind: "done", keptBranchAs: "wip/9-rescued" });
    // The copy is cut before the worktree and the branch go, and from the branch the
    // worktree list names.
    const copy = f.calls.indexOf("git -c core.quotePath=false branch wip/9-rescued agent/9-x");
    expect(copy).toBeGreaterThanOrEqual(0);
    for (const removal of removals(f.calls)) {
      expect(f.calls.indexOf(removal)).toBeGreaterThan(copy);
    }

    // A name under the agent prefix would be taken for an agent branch again — by
    // removeWorktree, by reconcile and by the claim protocol. Refused in the gates, so
    // nothing runs at all: the release must not happen for a rollback that then refuses.
    const bad = setup();
    const g = fake(bad.root);
    const refused = rollback(
      9,
      { to: "ready", reason: "x", keepBranchAs: "agent/9-x-old" },
      deps(bad.root, g.exec),
    );
    expect(refused).toMatchObject({ kind: "refused", code: 1 });
    expect(refused.kind === "refused" && refused.refused).toMatch(/agent\//);
    expect(g.calls).toEqual([]);
  });

  /**
   * And the prefix is compared the way the file system compares it.
   *
   * Reproduced end to end: with `agent/9-x` a loose ref — the normal state for a fresh
   * worktree branch — `--keep-branch-as Agent/9-rescued` passed this gate, `git branch`
   * wrote the new ref into the existing `refs/heads/agent/` directory, and
   * `removeWorktree`'s namespace loop then deleted the rescued copy while the result still
   * reported `keptBranchAs: "Agent/9-rescued"`. A capitalised typo is all it takes
   *.
   *
   * Windows-only and CI runs on Linux, the way the `inside()` case is gated: lower-casing
   * is a no-op where the platform is case-sensitive, so the same assertion elsewhere would
   * pass whatever the comparison did with the casing — which is worse than skipping
   *.
   */
  it.runIf(process.platform === "win32")(
    "refuses a keep-branch-as under the agent prefix however it is cased",
    () => {
      const { root } = setup();
      const f = fake(root);
      const r = rollback(
        9,
        { to: "ready", reason: "x", keepBranchAs: "Agent/9-rescued" },
        deps(root, f.exec),
      );
      expect(r).toMatchObject({ kind: "refused", code: 1 });
      expect(r.kind === "refused" && r.refused).toMatch(/agent\//);
      expect(f.calls).toEqual([]);
    },
  );

  // `git branch <new> <old>` fails on a name that already exists, and it is the first
  // step *after* the release — so a taken name would stop a rollback half-done, with the
  // claim released, over something a gate can see before anything has happened
  //.
  it("refuses a keep-branch-as name that already exists and runs nothing", () => {
    const { root } = setup();
    const f = fake(root, {}, { localBranches: ["agent/9-x", "wip/9-rescued"] });
    const r = rollback(9, { to: "ready", reason: "keep the work", keepBranchAs: "wip/9-rescued" }, deps(root, f.exec)); // prettier-ignore
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(/wip\/9-rescued/);
    // The gates' own two queries and nothing else: no release, no removal, no ledger write.
    expect(f.calls).toEqual([
      "git check-ref-format --branch wip/9-rescued",
      "git -c core.quotePath=false branch --no-color --format=%(refname:short)",
    ]);
    expect(loadLedger(root, "host/ada").issues["9"]!.state).toBe("code-reviewing");
  });

  /**
   * And that gate compares the way the ref store does, which is the sibling of the prefix
   * comparison one gate over.
   *
   * `git branch --list Wip/9-rescued` matches nothing while `wip/9-rescued` exists, because
   * git's pattern match is case-sensitive and NTFS is not: the gate reported the name free,
   * `git branch` then either refused it after the release or wrote a second spelling into
   * the same ref file. The comparison is folded like `underPrefix`'s, and the refusal names
   * the branch that exists, so the `branch -D` it prints is a command that works
   *.
   *
   * Windows-only, the way the other two folded cases are gated: lower-casing is a no-op
   * where the platform is case-sensitive, so the same assertion elsewhere would pass
   * whatever the comparison did with the casing.
   */
  it.runIf(process.platform === "win32")(
    "refuses a keep-branch-as name that exists in another casing",
    () => {
      const { root } = setup();
      const f = fake(root, {}, { localBranches: ["agent/9-x", "wip/9-rescued"] });
      const r = rollback(9, { to: "ready", reason: "keep the work", keepBranchAs: "Wip/9-rescued" }, deps(root, f.exec)); // prettier-ignore
      expect(r).toMatchObject({ kind: "refused", code: 1 });
      const refused = r.kind === "refused" ? r.refused : "";
      expect(refused, "the name that exists, or the printed remedy deletes nothing").toContain(
        "git branch -D wip/9-rescued",
      );
      expect(mutations(f.calls)).toEqual([]);
    },
  );

  /**
   * The two names a copy must never be kept under.
   *
   * `--keep-branch-as` was compared against the agent prefix and against git's ref rules,
   * never against the integration or production branch — and what kept it off those names
   * was the incidental gate above: `develop` is checked out in the main working directory,
   * so a local branch of that name exists. `main` usually does not, and there the copy
   * succeeded: `git branch main agent/9-x` leaves the main directory one `git push origin
   * main` away from shipping an agent branch to production. Refused by name now, the way
   * `notIssueBranch` refuses the same two.
   */
  it("refuses a keep-branch-as that names the integration or the production branch", () => {
    for (const name of ["develop", "main"]) {
      const { root } = setup();
      // Neither name exists locally in this fixture, so the existence gate cannot be what
      // refuses it: without the rule of its own, `main` would be created and reported kept.
      const f = fake(root, {}, { localBranches: ["agent/9-x"] });
      const r = rollback(9, { to: "ready", reason: "x", keepBranchAs: name }, deps(root, f.exec));
      expect(r, name).toMatchObject({ kind: "refused", code: 1 });
      const refused = r.kind === "refused" ? r.refused : "";
      expect(refused, name).toContain(name);
      expect(refused, name).toMatch(/integration|production/);
      expect(f.calls, `${name}: a refusal runs nothing at all`).toEqual([]);
    }
  });

  // A free name is not the same as a legal one: `git branch --list "wip/9 rescued"`
  // matches nothing and reports the name as free, while `git branch` itself refuses it —
  // after the release, as the first step.
  it("refuses a keep-branch-as name git itself would reject", () => {
    const { root } = setup();
    const f = fake(root, { "git check-ref-format": { status: 1 } });
    const r = rollback(9, { to: "ready", reason: "keep the work", keepBranchAs: "wip/9 rescued" }, deps(root, f.exec)); // prettier-ignore
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(/wip\/9 rescued/);
    expect(f.calls).toEqual(["git check-ref-format --branch wip/9 rescued"]);
  });

  // The other half: the copy's source has to resolve here. A worktree deregistered by
  // hand leaves the ledger naming a branch that only exists on origin, and `git branch
  // <new> <old>` on a local name that is gone fails — again as the first step after the
  // release, and the printed remedy would fail the same way.
  it("refuses a keep-branch-as whose source branch does not resolve locally, naming the remote copy", () => {
    const { root } = setup();
    const f = fake(root, { "git rev-parse": { status: 1, stdout: "" } });
    const r = rollback(9, { to: "ready", reason: "keep the work", keepBranchAs: "wip/9-rescued" }, deps(root, f.exec)); // prettier-ignore
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toContain("origin/agent/9-x");
    // Both halves of that printed remedy quoted, like every other printed value: the row
    // is a stored field, `git check-ref-format --branch` accepts `agent/9-x;rm` and
    // `agent/9-$(id)` (measured, exit 0), so every printed occurrence of it
    // is quoted.
    const refused = r.kind === "refused" ? r.refused : "";
    expect(refused).toContain("git fetch origin 'agent/9-x'");
    expect(refused).toContain("git branch wip/9-rescued 'origin/agent/9-x'");
    expect(f.calls).toContain("git rev-parse --verify --quiet agent/9-x");
    // A read of the pull request list is all that reached GitHub; nothing was changed
    // and nothing was removed. `git worktree prune` used to be among these calls: it
    // stood in the gate phase, so the three refusals that resolve the worktree first
    // broke the contract "a refusal runs nothing at all" — with no test covering it,
    // because the refusals that assert an empty list all exit before the prune
    // .
    expect(f.calls.some((c) => c.includes(" issue "))).toBe(false);
    expect(mutations(f.calls)).toEqual([]);
  });

  // The other two refusals on that side of the old prune: the cwd check against the
  // registration's own path (for the row whose `worktree` field is empty — `reconcile`
  // writes one for a pull request with nothing on disk), and the one for a
  // `--keep-branch-as` with no branch to copy anywhere.
  it("runs nothing for the refusals that have to resolve the worktree first", () => {
    const registered = setup({ worktree: "" });
    const f = fake(registered.root);
    const r = rollback(
      9,
      { to: "blocked", reason: "x" },
      deps(registered.root, f.exec, { cwd: f.worktree }),
    );
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(/main working directory/);
    expect(mutations(f.calls)).toEqual([]);

    const nothing = setup({ branch: "", worktree: "" });
    const g = fake(nothing.root, {
      "git -c core.quotePath=false worktree list --porcelain": {
        stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      },
    });
    const s = rollback(
      9,
      { to: "blocked", reason: "x", keepBranchAs: "wip/9-rescued" },
      deps(nothing.root, g.exec),
    );
    expect(s).toMatchObject({ kind: "refused", code: 1 });
    expect(s.kind === "refused" && s.refused).toMatch(/no branch to copy/);
    expect(mutations(g.calls)).toEqual([]);
  });

  it("deletes the worktree and the remote branch and clears pr and stage in the ledger", () => {
    const { root } = setup({ stage: stage("session-from-yesterday") });
    const f = fake(root);
    const r = rollback(9, { to: "blocked", reason: "wrong approach" }, deps(root, f.exec));
    expect(r).toMatchObject({
      kind: "done",
      code: 0,
      issue: 9,
      to: "blocked",
      released: true,
      keptBranchAs: null,
      worktreeRemoved: true,
      remoteDeleted: true,
      ledgerState: "blocked",
    });
    expect(f.calls).toContain(`git -c core.quotePath=false worktree remove --force ${f.worktree}`);
    expect(f.calls).toContain("git -c core.quotePath=false branch -D agent/9-x");
    expect(f.calls).toContain("git push origin --delete agent/9-x");
    // Both flags are answers to questions asked after the removal, not restatements of
    // what was asked for: the worktree list no longer names it and origin no longer has
    // the branch. Three listings — the gate phase's, which is the "registered before"
    // half of `worktreeRemoved`, `removeWorktree`'s own after its prune, and the one the
    // flag is read from. The fourth one went with the prune that used to stand in the
    // gate phase .
    expect(f.calls.filter((c) => c.includes("worktree list --porcelain"))).toHaveLength(3);
    expect(f.calls.filter((c) => c.includes("worktree prune"))).toHaveLength(1);
    expect(f.calls).toContain("git ls-remote --heads origin agent/9-x");

    const e = loadLedger(root, "host/ada").issues["9"]!;
    expect(e.state).toBe("blocked");
    expect(e.pr).toBeNull();
    expect(e.stage).toBeNull();

    // The note, and the run archive moved aside with it.
    const moved = join(stateDir(root), "runs-old", `9-${TODAY}`);
    expect(r.kind === "done" && r.runsMovedTo).toBe(moved);
    expect(existsSync(join(stateDir(root), "runs", "9"))).toBe(false);
    const log = readFileSync(join(moved, "events.log"), "utf8").trim().split("\n");
    expect(log[0]).toContain("earlier");
    // The note first, stamped with the stage the run died in: the log says where it
    // stopped. It has to run before the ledger step, because the printed remedy for that
    // step — `autoclaude note <issue> '<note>'` — reads the stage from the ledger, and
    // after `set … --stage none` there is none, so the scripted and the printed route
    // wrote different lines while the comment claimed they agreed
    //.
    expect(log[1]).toContain("#9 implement rollback to=blocked keep=- reason=wrong approach");
    // Then the scripted ledger step's transition, through the writer `ledger set`
    // uses, so the log carries the state change whichever way the step ran
    //.
    expect(log[2]).toContain(
      "state code-reviewing -> blocked: rollback to=blocked keep=- reason=wrong approach",
    );
    expect(log).toHaveLength(3);

    // What the CLI prints: the eight fields of the result, and not the discriminant.
    expect(r.kind === "done" && Object.keys(doneAsJson(r))).toEqual([
      "issue",
      "to",
      "released",
      "keptBranchAs",
      "worktreeRemoved",
      "remoteDeleted",
      "ledgerState",
      "runsMovedTo",
    ]);
  });

  // The state a hand rollback usually leaves behind: the directory is gone, its
  // registration is not. `removeWorktree` prunes the registration and returns there, so
  // neither its `branch -D` nor its `push origin --delete` ever runs — and a rollback
  // that stopped at that left the branch on `origin`, where the next attempt's
  // `publish.ts` refuses to lease a remote head the new worktree never had. Reporting
  // `remoteDeleted: false` and exiting 0 is the silent forgotten step this command exists
  // to remove, so the step finishes the job itself.
  it("deletes the local and the remote branch itself when a stale registration ended the removal early", () => {
    const { root, worktree } = setup();
    // The directory, gone the way a human tidies one up; the registration stays.
    rmSync(worktree, { recursive: true, force: true });
    const f = fake(root, {}, { directoryGone: true });
    const r = rollback(9, { to: "blocked", reason: "the directory went by hand" }, deps(root, f.exec)); // prettier-ignore
    expect(r).toMatchObject({
      kind: "done",
      code: 0,
      worktreeRemoved: true,
      remoteDeleted: true,
    });
    // `removeWorktree` itself does these now, from the issue's own namespace rather than
    // from a registration it no longer has: `git branch --list agent/9-*`. The rollback
    // has no branch step of its own any more, and the orchestrator's teardown — the other
    // caller — finishes the job for the first time.
    expect(f.calls).toContain("git push origin --delete agent/9-x");
    expect(f.calls).toContain("git -c core.quotePath=false branch -D agent/9-x");
    expect(f.calls).toContain(
      "git -c core.quotePath=false branch --no-color --no-column --list agent/9-*",
    );
    // A remote that turns out not to have the branch is tolerated rather than asked
    // about first, the way this function has always tolerated it: with one deleter there
    // is no second `push --delete` to guard against.
    expect(removals(f.calls).filter((c) => c.startsWith("git push origin --delete"))).toHaveLength(
      1,
    );
    // And the release still happened, which is the whole point of running this at all.
    expect(f.calls.some((c) => c.includes(" issue comment"))).toBe(true);
  });

  // And the state a half-finished teardown leaves: nothing local names the branch any
  // more — no registration, no local branch — and `origin` still has it. The deletion set
  // used to be the registration plus the *local* namespace, so the remote's fate hung on
  // a local branch still being there, and `removeWorktree` is the only
  // `push origin --delete` in the tree. A push that fails on something the tolerance does
  // not cover throws with `branch -D` already done, and the re-run the rollback prints
  // then iterated an empty set and exited 0.
  it("deletes the remote branch of the issue when nothing local names it any more", () => {
    const { root, worktree } = setup();
    rmSync(worktree, { recursive: true, force: true });
    const f = fake(
      root,
      {
        "git -c core.quotePath=false worktree list --porcelain": {
          stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
        },
      },
      { localBranches: [] },
    );
    const r = rollback(9, { to: "blocked", reason: "half a teardown" }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "done", code: 0, remoteDeleted: true });
    expect(f.calls).toContain("git -c core.quotePath=false ls-remote --heads origin agent/9-*");
    expect(f.calls).toContain("git push origin --delete agent/9-x");
    // And no `branch -D` for a branch that is not there: git refuses that outright, and
    // the throw would land after the release.
    expect(f.calls.filter((c) => c.includes("branch -D"))).toEqual([]);
  });

  // The other half of it: a branch that is already gone must not be pushed at, and
  // `removeWorktree`'s own deletions must not be repeated — a second
  // `push origin --delete` fails on a remote ref that no longer exists.
  it("does not repeat a deletion removeWorktree already made", () => {
    const { root } = setup();
    const f = fake(root);
    expect(rollback(9, { to: "blocked", reason: "x" }, deps(root, f.exec))).toMatchObject({ kind: "done" }); // prettier-ignore
    expect(f.calls.filter((c) => c === "git push origin --delete agent/9-x")).toHaveLength(1);
    expect(f.calls.filter((c) => c.endsWith("branch -D agent/9-x"))).toHaveLength(1);
  });

  /**
   * `remoteDeleted` is read from a second `ls-remote`, one round trip after the push that
   * deleted the branch, and a failure of that verification used to be reported as `false`
   * — "the branch is still on origin", which is a different thing from "I could not ask".
   * A human reading `remoteDeleted: false` goes looking for a branch that is gone
   *.
   */
  it("reports remoteDeleted as unknown when the verification call itself failed", () => {
    const { root } = setup();
    // Only the rollback's own `remoteGone`: `removeWorktree` asks the namespace through
    // the throwing `git()`, which spells the command with `-c core.quotePath=false`, so
    // the two calls are separate keys and its deletion still succeeds.
    const f = fake(root, { "git ls-remote --heads origin": { status: 1 } });
    const r = rollback(9, { to: "blocked", reason: "origin blinked" }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "done", code: 0, worktreeRemoved: true, remoteDeleted: null });
    // And what the CLI prints says it in a word rather than as `null`.
    expect(r.kind === "done" && doneAsJson(r).remoteDeleted).toBe("unknown");
  });

  /**
   * The same conflation one arm over: a row that names no branch reported
   * `remoteDeleted: false`.
   *
   * There is no branch for the field to be about, and the removal step deleted the issue's
   * whole remote namespace anyway — `removeWorktree` asks `origin` for `agent/9-*` rather
   * than for the row's name — so `false` was an answer about a branch the row did not name,
   * and it reads as "the branch is still on origin". Three answers for three states.
   */
  it("reports remoteDeleted as not applicable when the row names no branch", () => {
    const { root } = setup({ branch: "", worktree: "" });
    const f = fake(root, {
      "git -c core.quotePath=false worktree list --porcelain": {
        stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      },
    });
    const r = rollback(9, { to: "blocked", reason: "no branch was ever recorded" }, deps(root, f.exec)); // prettier-ignore
    expect(r).toMatchObject({ kind: "done", code: 0, remoteDeleted: null });
    // The namespace deletion did run, which is the half the field used to deny.
    expect(f.calls).toContain("git -c core.quotePath=false ls-remote --heads origin agent/9-*");
    expect(f.calls).toContain("git push origin --delete agent/9-x");
    // And nothing asked `ls-remote` about a branch: there was none to verify.
    expect(f.calls.filter((c) => c === "git ls-remote --heads origin ")).toEqual([]);
    const printed = r.kind === "done" ? String(doneAsJson(r).remoteDeleted) : "";
    expect(printed, "not the word for a failed verification").not.toBe("unknown");
    expect(printed).toMatch(/not applicable/);
    expect(printed, "with the reason, or the word is as silent as false was").toMatch(
      /no branch|namespace/,
    );
  });

  it("maps ready and none to done, blocked to blocked", () => {
    for (const [to, state] of [
      ["ready", "done"],
      ["none", "done"],
      ["done", "done"],
      ["blocked", "blocked"],
      // An issue sent back to be reshaped is not a finished one, and `needs-shaping` is a
      // ledger state of its own: a row saying `done` would lose the distinction for every
      // reader of the ledger and of status.md.
      ["needs-shaping", "needs-shaping"],
    ] as const) {
      const { root } = setup();
      const f = fake(root);
      const r = rollback(9, { to, reason: "r" }, deps(root, f.exec));
      expect(r, `--to ${to}`).toMatchObject({ kind: "done", ledgerState: state });
      expect(loadLedger(root, "host/ada").issues["9"]!.state, `--to ${to}`).toBe(state);
    }
  });

  // A stage of the live orchestrator instance is a process still editing that worktree;
  // removing it under a running agent is how a run loses work it had already done.
  it("refuses a stage of the live instance, naming it and the way out", () => {
    const mine = setup({ stage: stage("orc-live"), session: "orc-live" });
    const f = fake(mine.root);
    const r = rollback(9, { to: "blocked", reason: "x" }, deps(mine.root, f.exec));
    expect(r).toMatchObject({ kind: "refused", code: 1 });
    expect(r.kind === "refused" && r.refused).toMatch(
      /stage implement is running in orchestrator instance orc-live/,
    );
    expect(r.kind === "refused" && r.refused).toMatch(/autoclaude drain/);
    expect(removals(f.calls)).toEqual([]);
    expect(f.calls.some((c) => c.includes(" issue "))).toBe(false);
  });

  // A stage of an instance that is gone blocks nothing: that is the state a rollback is most
  // often needed in. Gone means another instance id, or the same one with a stale heartbeat.
  it("lets a stage of a dead instance be rolled back", () => {
    const other = setup({ stage: stage("orc-yesterday"), session: "orc-live" });
    expect(
      rollback(9, { to: "blocked", reason: "x" }, deps(other.root, fake(other.root).exec)),
    ).toMatchObject({
      kind: "done",
      code: 0,
    });
    const stale = setup({ stage: stage("orc-live"), session: "orc-live", heartbeatAge: 600 });
    expect(
      rollback(9, { to: "blocked", reason: "x" }, deps(stale.root, fake(stale.root).exec)),
    ).toMatchObject({
      kind: "done",
      code: 0,
    });
    const none = setup({ stage: stage("orc-live") });
    expect(
      rollback(9, { to: "ready", reason: "x" }, deps(none.root, fake(none.root).exec)),
    ).toMatchObject({
      kind: "done",
    });
  });

  // A run that died before it archived anything has no `runs/<issue>` — but the ledger
  // step's own line and the note create one, so a destination resolved before them was
  // null and left that archive behind: a "complete" rollback whose issue still had a live
  // events log, holding nothing but its own rollback.
  it("archives the run the rollback's own lines created, so it never leaves a live events log behind", () => {
    const { root } = setup({ runs: false });
    const f = fake(root);
    const r = rollback(9, { to: "ready", reason: "nothing was built" }, deps(root, f.exec));
    const moved = join(stateDir(root), "runs-old", `9-${TODAY}`);
    expect(r).toMatchObject({ kind: "done", runsMovedTo: moved });
    expect(existsSync(join(stateDir(root), "runs", "9"))).toBe(false);
    const log = readFileSync(join(moved, "events.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("#9 - rollback to=ready keep=- reason=nothing was built");
    expect(log[1]).toContain(
      "state code-reviewing -> done: rollback to=ready keep=- reason=nothing was built",
    );
  });

  // The reason is folded and capped by the same function the events log applies, so the
  // ledger event, the release comment, the printed commands and the log line carry one
  // text. Before that the ledger event kept the full 400 characters while the log line
  // was cut at 300, against the code's own claim that the two carry "the one line"
  //.
  it("folds a long reason once, so the ledger event and the log line say the same thing", () => {
    const { root } = setup();
    const f = fake(root);
    const r = rollback(9, { to: "blocked", reason: "x".repeat(400) }, deps(root, f.exec));
    expect(r).toMatchObject({ kind: "done" });
    const events = loadLedger(root, "host/ada").events.filter((e) => e.issue === 9);
    const note = events[events.length - 1]!.note ?? "";
    expect(note.length, "capped like every other note").toBe(300);
    const log = readFileSync(join(stateDir(root), "runs-old", `9-${TODAY}`, "events.log"), "utf8");
    // The rollback's own line, not the transition line in front of it: both mention the
    // note, and only this one is the note.
    const line = log.split("\n").find((l) => l.includes(" - rollback to=")) ?? "";
    expect(line).toBe(`${now.toISOString()} #9 - ${note}`);
  });

  // The archive of an earlier rollback of the same issue on the same day is the only copy
  // of what that run reported.
  it("suffixes the archive when the same issue was rolled back earlier today", () => {
    const { root } = setup();
    mkdirSync(join(stateDir(root), "runs-old", `9-${TODAY}`), { recursive: true });
    const f = fake(root);
    const r = rollback(9, { to: "blocked", reason: "again" }, deps(root, f.exec));
    expect(r).toMatchObject({
      kind: "done",
      runsMovedTo: join(stateDir(root), "runs-old", `9-${TODAY}-2`),
    });
    expect(readFileSync(join(stateDir(root), "runs-old", `9-${TODAY}-2`, "events.log"), "utf8")).toContain("earlier"); // prettier-ignore
  });

  it("prints the remaining commands when the removal fails after the release", () => {
    const { root } = setup();
    const f = fake(root, {
      "git -c core.quotePath=false worktree remove": { status: 1 },
    });
    const r = rollback(
      9,
      // Both quote characters and a newline in the reason: the printed lines exist to be
      // copied into a shell, and the operator's own punctuation must not end the quoting
      // halfway. Single quotes are literal in both shells, and double quotes are not — a
      // reason naming `$branch` or `$(…)` would be expanded on paste.
      //
      // The escape inside them is bash's, `'\''`, because these lines are bash: the last
      // one is `mkdir -p … ; mv …`, and `mkdir -p` is a parameter error in PowerShell.
      // `''` is one apostrophe in PowerShell only; in Git Bash `'isn''t'` is three
      // concatenated tokens and prints `isnt`, so the reason a human pasted differed from
      // the one the command had recorded — the disagreement `foldNote`/`rollbackNote` were
      // added to prevent. No literal works in both shells, so the printed block says
      // which one it is quoted for.
      { to: "ready", reason: 'the "plan" isn\'t it\n  $wrong', keepBranchAs: "wip/9-rescued" },
      deps(root, f.exec),
    );
    expect(r).toMatchObject({ kind: "incomplete", code: 1, released: true });
    const remaining = r.kind === "incomplete" ? r.remaining : [];
    const note = `rollback to=ready keep=wip/9-rescued reason=the "plan" isn'\\''t it $wrong`;
    expect(remaining).toEqual([
      // One command, and it finishes the job: the branch deletion the rollback used to
      // do in a step of its own now lives in `removeWorktree`, so the command named here
      // deletes the local and the remote branch even when the registration is already
      // gone — which is also what the orchestrator's own teardown calls
      //.
      "autoclaude worktree remove 9 --remote",
      // The note before the ledger step, in the printed route as in the scripted one.
      `autoclaude note 9 '${note}'`,
      `autoclaude ledger set 9 done --pr none --stage none --note '${note}'`,
      // `runs-old/` is created by the step itself, so the line that replaces it has to
      // create it too: on a first-ever rollback a bare `mv` fails with ENOENT, and that
      // is the one line a human is handed.
      `mkdir -p '${join(stateDir(root), "runs-old")}' ; mv '${join(stateDir(root), "runs", "9")}' '${join(stateDir(root), "runs-old", `9-${TODAY}`)}'`,
    ]);
    // The step that failed is named, and the copy that had already succeeded is not
    // repeated.
    expect(r.kind === "incomplete" && r.failure).toMatch(/worktree/);
    // The copy, named by its own destination: `git branch -D agent/9-x` is part of the
    // removal line above and belongs there, `git branch wip/9-rescued agent/9-x` is the
    // step that already ran.
    expect(remaining.some((c) => c.includes(`git branch wip/9-rescued`))).toBe(false);
    // Nothing after the failure ran: the ledger still holds the run, so a second attempt
    // after the cause is fixed is the same command again.
    const e = loadLedger(root, "host/ada").issues["9"]!;
    expect(e.state).toBe("code-reviewing");
    expect(e.pr).toBe(77);
    // One command per line, under a heading that says where to run them — and which
    // shell they are quoted for, since no single literal is right in both.
    const printed = renderRemaining(remaining, root);
    expect(printed.split("\n").slice(1)).toEqual(remaining);
    expect(printed.split("\n")[0]).toContain(root);
    expect(printed.split("\n")[0], "the quoting is bash's, so the heading says so").toMatch(
      /bash/i,
    );
    expect(renderReleaseFailed(remaining, root)).toMatch(/bash/i);
  });

  /**
   * The same label on the refusals, which print the same quoting without a block heading.
   *
   * `quoted()` is bash's `'\''` and no literal is right in both shells: in Git Bash
   * `'isn''t'` prints `isnt`, so a reason pasted from a message that does not say which
   * shell it is for is not the reason the command recorded. The two block printers say so
   * and these four did not — and a refusal is the more likely of the two to be pasted,
   * because it is what an operator meets before anything has happened
   *.
   */
  it("says which shell the quoting is for in every refusal that prints a command", () => {
    const noWorktree = {
      "git -c core.quotePath=false worktree list --porcelain": {
        stdout: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      },
    };
    const refusalOf = (what: string, run: () => ReturnType<typeof rollback>): string => {
      const r = run();
      expect(r, what).toMatchObject({ kind: "refused", code: 1 });
      return r.kind === "refused" ? r.refused : "";
    };
    const cases: Array<[string, () => ReturnType<typeof rollback>]> = [
      // The row whose branch is outside the namespace: two commands, both quoted.
      [
        "a branch outside the namespace",
        () => {
          const { root } = setup({ branch: "develop", worktree: "" });
          return rollback(
            9,
            { to: "blocked", reason: "isn't it" },
            deps(root, fake(root, noWorktree).exec),
          );
        },
      ],
      // And the copy whose source is only on origin, whose remedy is the remote cut.
      [
        "a keep-branch-as source that does not resolve",
        () => {
          const { root } = setup();
          const f = fake(root, { "git rev-parse": { status: 1, stdout: "" } });
          return rollback(
            9,
            { to: "ready", reason: "isn't it", keepBranchAs: "wip/9-rescued" },
            deps(root, f.exec),
          );
        },
      ],
    ];
    for (const [what, run] of cases) {
      const refused = refusalOf(what, run);
      expect(refused, `${what}: the message prints a bash-quoted value`).toContain("'");
      expect(refused, `${what}: and has to say which shell that quoting is for`).toMatch(/bash/i);
    }
  });
});

/**
 * The verb returns its exit code and never calls process.exit(): main() sets process.exitCode
 * and falls through, so a warning still queued (a lost status.md rename reports itself through
 * process.emitWarning) is printed.
 */
describe("the rollback verb's exit", () => {
  const source = readFileSync("src/cli/rollback.ts", "utf8");

  it("never ends the process itself", () => {
    expect(source, "process.exit() drops a warning that is already queued").not.toMatch(
      /^\s*process\.exit\(/m,
    );
  });

  it("exits 0 with the JSON on stdout, 1 with the refusal on stderr, 64 for a bad command line", async () => {
    const { root } = setup();
    cpSync(join(MINIMAL, ".autoclaude", "config.json"), join(root, ".autoclaude", "config.json"));
    const f = fake(root);
    const env = {
      ...envFor(root, { exec: f.exec }),
      forge: () => new Forge("acme/widgets", f.exec),
    };
    const ok = capture();
    expect(await rollbackVerb(["9", "--to", "blocked", "--reason", "x"], ok.io, root, env)).toBe(0);
    expect(JSON.parse(ok.text())).toMatchObject({
      issue: 9,
      to: "blocked",
      ledgerState: "blocked",
    });
    const again = capture();
    // The run is finished (blocked) now: the engine's remedy `autoclaude rollback 9` clears
    // what is left without releasing it a second time.
    const comments = () => f.calls.filter((c) => c.includes(" issue comment")).length;
    expect(comments()).toBe(1);
    expect(await rollbackVerb(["9"], again.io, root, env)).toBe(0);
    expect(comments()).toBe(1);
    const bad = capture();
    expect(await rollbackVerb(["9", "--to", "blocked"], bad.io, root, env)).toBe(64);
    expect(bad.errText()).toMatch(/usage: autoclaude rollback/);
    const inWorktree = setup();
    cpSync(
      join(MINIMAL, ".autoclaude", "config.json"),
      join(inWorktree.root, ".autoclaude", "config.json"),
    );
    const g = fake(inWorktree.root);
    const refused = capture();
    expect(
      await rollbackVerb(["9", "--to", "blocked", "--reason", "x"], refused.io, g.worktree, {
        ...envFor(inWorktree.root, { exec: g.exec }),
        forge: () => new Forge("acme/widgets", g.exec),
      }),
    ).toBe(1);
    expect(refused.errText()).toMatch(/^refused: this is running inside/);
  });
});

describe("parseRollbackArgs", () => {
  it("takes the issue, the target, the reason and the optional branch name", () => {
    expect(
      parseRollbackArgs(["9", "--to", "blocked", "--reason", "wrong", "--keep-branch-as", "wip/9"]),
    ).toEqual({ issue: 9, to: "blocked", reason: "wrong", keepBranchAs: "wip/9" });
    expect(parseRollbackArgs(["9", "--to", "none", "--reason", "wrong"])).toEqual({
      issue: 9,
      to: "none",
      reason: "wrong",
      keepBranchAs: null,
    });
  });

  // The unknown-option scan cannot see this: both spellings are known flags. And it sits
  // on the one command in the tree whose next step is destructive —
  // `autoclaude rollback 9 --to blocked --reason x --to ready`, an operator editing a recalled
  // line, released as blocked and deleted the branches with the typed `ready` silently
  // dropped.
  it("refuses a flag given twice rather than taking the first one", () => {
    expect(() =>
      parseRollbackArgs(["9", "--to", "blocked", "--reason", "x", "--to", "ready"]),
    ).toThrow(/--to was given more than once/);
    expect(() =>
      parseRollbackArgs(["9", "--to", "blocked", "--reason", "x", "--reason", "y"]),
    ).toThrow(/--reason was given more than once/);
  });

  it("takes an issue alone, to clear its leftovers", () => {
    expect(parseRollbackArgs(["9"])).toEqual({
      issue: 9,
      to: null,
      reason: "",
      keepBranchAs: null,
    });
  });

  it("refuses a missing issue, an unknown target, an empty reason, a flag as a value and an unknown option", () => {
    expect(() => parseRollbackArgs(["--to", "blocked", "--reason", "x"])).toThrow(/issue/);
    expect(() => parseRollbackArgs(["9", "--to", "Blocked", "--reason", "x"])).toThrow(/--to/);
    expect(() => parseRollbackArgs(["9", "--to", "blocked"])).toThrow(/--reason/);
    expect(() => parseRollbackArgs(["9", "--reason", "x"])).toThrow(/needs --to/);
    expect(() => parseRollbackArgs(["9", "--to", "--reason", "x"])).toThrow(/needs a value/);
    expect(() => parseRollbackArgs(["9", "--to", "blocked", "--reason", "x", "--force"])).toThrow(
      /unknown option/,
    );
  });
});
