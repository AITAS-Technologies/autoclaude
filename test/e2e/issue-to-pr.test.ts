/**
 * The parity proof: one issue labelled `agent-ready` goes through the real engine (claim,
 * worktree, plan, plan review, implement, the red step, the engine-driven code review, publish)
 * until the ledger shows `pr-open`. The edges are fake: a fake forge stands in for GitHub and a
 * scripted runtime for Claude. Everything between them is the production code: `tick`, the
 * stage runner, the reviews, the red step (`node --test`, run for real on the base and the
 * head), publish, and real `git` against a real bare remote.
 *
 * No real `claude`, `gh` or network. It runs unchanged on every operating system: the project
 * lives under a path with a space, and the bare remote under another.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../src/config/load.js";
import { appendNoteBestEffort, loadLedger } from "../../src/engine/ledger/ledger.js";
import { Forge, realExec, type Exec } from "../../src/forge/github.js";
import { StageRegistry, type TickCtx } from "../../src/orchestrator/actions.js";
import { tick } from "../../src/orchestrator/tick.js";
import { childEnv } from "../helpers/child-env.js";
import { fakeGh } from "../helpers/fake-gh.js";
import { asResult, scriptedRuntime } from "../helpers/scripted-runtime.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE = join(REPO_ROOT, "test/fixtures/e2e/project");

const REPO = "acme/widgets";
const ISSUE = 42;
const TITLE = "Fix add so it sums its operands";
const BRANCH = "agent/42-fix-add-so-it-sums-its-operands";
const CRITERIA = ["add(2, 3) returns 5", "add(-1, 1) returns 0"];
const SKIP_MARKER = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

/** The bounds: ticks, wall time and the wait for one stage to finish. */
const MAX_TICKS = 40;
const SCENARIO_MS = 45_000;
const STAGE_WAIT_MS = 15_000;

const FIXED_ADD = "module.exports = function add(a, b) {\n  return a + b;\n};\n";
const ADD_TEST = `const test = require("node:test");
const assert = require("node:assert");
const add = require("../src/add");

test("add sums two numbers", () => {
  assert.strictEqual(add(2, 3), 5);
});

test("add handles a negative operand", () => {
  assert.strictEqual(add(-1, 1), 0);
});
`;

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: childEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
  return r.stdout.trim();
};

const bare = (remote: string, ...args: string[]): string =>
  git(remote, "--git-dir", remote, ...args);

/**
 * The files (not the directories) under a directory, relative, sorted. Windows creates an empty
 * `AppDataRoaming` for any process that asks for the profile; an empty directory is not a write.
 */
const listing = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort()
    : [];

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** `then`, in order: each pattern matches a line after the one before it. */
function inOrder(lines: string[], patterns: RegExp[]): number[] {
  const at: number[] = [];
  let from = 0;
  for (const p of patterns) {
    const i = lines.findIndex((l, k) => k >= from && p.test(l));
    expect(i, `no line matching ${p} after line ${from}`).toBeGreaterThanOrEqual(0);
    at.push(i);
    from = i + 1;
  }
  return at;
}

describe("end to end: an issue to a pull request, a fake forge and a fake runtime", () => {
  it("takes an agent-ready issue through the real engine to pr-open", async () => {
    // --- the sandbox: everything the run writes lands under one temporary directory --------
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "autoclaude e2e ")));
    temps.push(base);
    const home = join(base, "home");
    const scratch = join(base, "scratch tmp");
    mkdirSync(home, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    const root = join(base, "My Projects", "app");
    const remote = join(base, "remote store", "origin.git").replaceAll("\\", "/");

    // The red step puts its JUnit report in os.tmpdir(); a home directory is where a stray
    // `~/.something` would go. Both are redirected into the sandbox, and the real checkout is
    // compared before and after, so a write anywhere else shows. git's own variables are
    // dropped like the other harnesses do (a hook's GIT_DIR would point git at this checkout).
    const saved = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])
      delete process.env[k];
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
    });
    const checkout = () => {
      const r = spawnSync("git", ["--no-optional-locks", "status", "--porcelain"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: childEnv(),
      });
      return r.status === 0 ? r.stdout : null;
    };
    const checkoutBefore = checkout();

    const started = Date.now();
    let dump = () => {};
    try {
      // --- the project: the fixture, a git repository, a bare remote ------------------------
      mkdirSync(root, { recursive: true });
      cpSync(FIXTURE, root, { recursive: true });
      mkdirSync(join(base, "remote store"), { recursive: true });
      git(base, "init", "--bare", "-q", "-b", "develop", remote);
      git(root, "init", "-q", "-b", "develop");
      git(root, "config", "user.email", "e2e@example.com");
      git(root, "config", "user.name", "E2E");
      git(root, "config", "core.autocrlf", "false");
      git(root, "config", "commit.gpgsign", "false");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "Initial project");
      git(root, "branch", "main");
      git(root, "remote", "add", "origin", remote);
      git(root, "push", "-q", "origin", "develop", "main");
      const baseSha = git(root, "rev-parse", "HEAD");
      const cfg = loadProjectConfig(root);

      // --- the edges: a fake forge, a scripted runtime -------------------------------------
      // A clock that starts inside the day profile and moves with real time, so the queue's
      // schedule gate does not depend on when CI runs.
      const t0 = Date.parse("2026-03-03T10:00:00Z");
      const wall = Date.now();
      const now = () => new Date(t0 + (Date.now() - wall));

      const forge = fakeGh({
        repo: REPO,
        remote,
        now,
        labels: [cfg.queue.ready, cfg.labels.working, cfg.labels.blocked, cfg.labels.needsShaping],
      });
      forge.addIssue({
        number: ISSUE,
        title: TITLE,
        body: `add() subtracts.\n\n## Acceptance criteria\n${CRITERIA.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`,
        labels: [cfg.queue.ready],
      });

      // Anything but git (real) and gh (the fake) is a bug in the scenario: no real claude.
      const disallowed: string[] = [];
      const exec: Exec = (cmd, args, o) => {
        if (cmd === "gh") return forge.exec(cmd, args, o);
        if (cmd === "git") return realExec(cmd, args, o);
        disallowed.push(`${cmd} ${args.join(" ")}`);
        return { status: 127, stdout: "", stderr: `${cmd}: not available in this test` };
      };

      const records: Array<{ stage: string; pid: number | null; instance: string }> = [];
      const unscripted: string[] = [];
      const failures: string[] = [];
      const runtime = scriptedRuntime((role, req) => {
        try {
          switch (role) {
            case "plan": {
              // A stage's record is in the ledger while its child runs.
              const rec = loadLedger(root).issues[String(ISSUE)]?.stage;
              if (rec) records.push({ stage: rec.stage, pid: rec.pid, instance: rec.instance });
              const planFile = join(req.cwd, ".autoclaude/state/plans", `${ISSUE}.md`);
              mkdirSync(join(req.cwd, ".autoclaude/state/plans"), { recursive: true });
              writeFileSync(
                planFile,
                `# Plan for #${ISSUE}\n\n1. Fix \`add\` in src/add.js.\n2. Add test/add.test.js.\n`,
              );
              writeFileSync(
                join(req.cwd, ".autoclaude/state/reports/plan.md"),
                [
                  "AUTODEV-PLAN",
                  `issue: ${ISSUE}`,
                  "status: planned",
                  "reason:",
                  "db-migration-required: no",
                  `plan-file: .autoclaude/state/plans/${ISSUE}.md`,
                  "AUTODEV-PLAN-END",
                  "",
                ].join("\n"),
              );
              return {};
            }
            case "implement": {
              const rec = loadLedger(root).issues[String(ISSUE)]?.stage;
              if (rec) records.push({ stage: rec.stage, pid: rec.pid, instance: rec.instance });
              // The failing-then-passing test and the fix, as one real commit in the worktree.
              mkdirSync(join(req.cwd, "test"), { recursive: true });
              writeFileSync(join(req.cwd, "src/add.js"), FIXED_ADD);
              writeFileSync(join(req.cwd, "test/add.test.js"), ADD_TEST);
              git(req.cwd, "add", "src/add.js", "test/add.test.js");
              git(req.cwd, "commit", "-q", "-m", "Fix add so it sums its operands");
              const sha = git(req.cwd, "rev-parse", "HEAD");
              writeFileSync(
                join(req.cwd, ".autoclaude/state/reports/implement.md"),
                [
                  "AUTODEV-REPORT",
                  `issue: ${ISSUE}`,
                  "status: done",
                  "reason:",
                  "db-migration-required: no",
                  `commit: ${sha}`,
                  "criteria:",
                  ...CRITERIA.map((c, i) => `  ${i + 1}. met — ${c}`),
                  "tests-added: test/add.test.js",
                  "observed-not-done:",
                  "  - nothing",
                  "AUTODEV-REPORT-END",
                  "",
                ].join("\n"),
              );
              return {};
            }
            case "plan-review-finder":
              return { candidates: [], uncertain: [] };
            case "plan-review-scorer":
            case "code-review-scorer":
              return { scores: [] };
            case "code-review-angle-criteria":
              return {
                candidates: [],
                uncertain: [],
                criteria: CRITERIA.map((_, i) => ({
                  n: i + 1,
                  met: true,
                  where: i === 0 ? "src/add.js:3" : "test/add.test.js:11",
                })),
              };
            default:
              if (role.startsWith("code-review-angle-")) return { candidates: [], uncertain: [] };
              unscripted.push(role);
              return asResult({ exit: "failed", resultText: `unscripted role ${role}` });
          }
        } catch (error) {
          failures.push(`${role}: ${String(error)}`);
          return asResult({ exit: "failed", resultText: String(error) });
        }
      });

      const ctx: TickCtx = {
        root,
        cfg,
        forge: new Forge(REPO, exec),
        exec,
        instance: "inst-e2e",
        now,
        runtimes: () => runtime,
        notes: (issue, text) => appendNoteBestEffort(root, issue, text, null, now()),
        stages: new StageRegistry(),
      };

      const eventsLog = join(root, ".autoclaude/state/runs", String(ISSUE), "events.log");
      const readEvents = () => (existsSync(eventsLog) ? readFileSync(eventsLog, "utf8") : "");
      const stateOf = () => loadLedger(root).issues[String(ISSUE)]?.state;

      // On any failure below, not only a stuck loop, the evidence goes to stderr.
      dump = () =>
        console.error(
          `e2e failed in state ${stateOf()}.
events.log:
${readEvents()}
` +
            `unexpected gh: ${forge.unexpected.join(" | ")}
scripted failures: ${failures.join(" | ")}
` +
            `unscripted roles: ${unscripted.join(" | ")}
disallowed: ${disallowed.join(" | ")}`,
        );

      // --- the run: tick until the ledger shows pr-open, bounded ---------------------------
      let ticks = 0;
      {
        while (stateOf() !== "pr-open") {
          expect(
            ticks,
            `no pull request after ${MAX_TICKS} ticks (state ${stateOf()})`,
          ).toBeLessThan(MAX_TICKS);
          expect(Date.now() - started, "the scenario ran past its time budget").toBeLessThan(
            SCENARIO_MS,
          );
          ticks++;
          const mark = ctx.stages.settledCount;
          await tick(ctx);
          if (stateOf() === "pr-open") break;
          // Wait for the next stage to finish (a tick with nothing running never would).
          let timer: NodeJS.Timeout | undefined;
          const woke = await Promise.race([
            ctx.stages.next(mark).then(() => true),
            new Promise<boolean>((done) => {
              timer = setTimeout(() => done(false), STAGE_WAIT_MS);
            }),
          ]);
          clearTimeout(timer);
          expect(woke, `no stage finished within ${STAGE_WAIT_MS} ms (state ${stateOf()})`).toBe(
            true,
          );
        }
      }

      // --- the ledger ----------------------------------------------------------------------
      const ledger = loadLedger(root);
      const entry = ledger.issues[String(ISSUE)]!;
      expect(entry.state).toBe("pr-open");
      expect(entry.pr).toBe(1);
      expect(entry.branch).toBe(BRANCH);
      expect(entry.stage, "the record of a consumed stage is gone").toBeNull();
      const path = ledger.events.filter((e) => e.issue === ISSUE).map((e) => e.to);
      let from = 0;
      for (const state of [
        "claimed",
        "planning",
        "plan-reviewing",
        "implementing",
        "code-reviewing",
        "pr-open",
      ] as const) {
        const i = path.indexOf(state, from);
        expect(i, `the ledger never reached ${state}: ${path.join(" > ")}`).toBeGreaterThanOrEqual(
          0,
        );
        from = i + 1;
      }

      // The stage records carried the owning process and instance while the stages ran.
      expect(records.map((r) => r.stage)).toEqual(["plan", "implement"]);
      for (const r of records) {
        expect(Number.isInteger(r.pid) && r.pid! > 0, `${r.stage}: pid ${r.pid}`).toBe(true);
        expect(r.instance).toBe("inst-e2e");
      }

      // --- the bare remote -----------------------------------------------------------------
      const pushed = bare(remote, "rev-parse", `refs/heads/${BRANCH}`);
      expect(pushed).toBe(entry.pushedSha);
      expect(pushed).not.toBe(baseSha);
      expect(bare(remote, "log", "-1", "--format=%s", `refs/heads/${BRANCH}`)).toBe(
        "Fix add so it sums its operands",
      );
      expect(bare(remote, "show", `refs/heads/${BRANCH}:test/add.test.js`)).toContain(
        "add sums two numbers",
      );
      expect(bare(remote, "show", `refs/heads/${BRANCH}:src/add.js`)).toContain("a + b");
      // The integration branch is untouched: nothing here merges.
      expect(bare(remote, "rev-parse", "refs/heads/develop")).toBe(baseSha);

      // --- the fake forge ------------------------------------------------------------------
      expect(forge.prs).toHaveLength(1);
      const pr = forge.prs[0]!;
      expect(pr).toMatchObject({ number: 1, state: "OPEN", base: "develop", head: BRANCH });
      expect(pr.title).toBe("Fix add so it sums its operands (#42)");
      expect(pr.body).toContain(`Closes #${ISSUE}`);
      for (const c of CRITERIA) expect(pr.body).toContain(`- [x] ${c}`);
      expect(pr.body).toContain("Red step: `proven`");
      expect(pr.body).toContain("No findings remained after the code review.");
      expect(pr.body).toContain(cfg.messages.footer);

      const issue = forge.issues.get(ISSUE)!;
      expect(issue.labels).toContain(cfg.labels.working);
      expect(issue.labels).not.toContain(cfg.labels.blocked);
      expect(issue.labels).not.toContain(cfg.labels.needsShaping);

      // No text the engine wrote to GitHub carries a CI skip marker.
      const written = [
        pr.title,
        pr.body,
        ...issue.comments.map((c) => c.body),
        ...pr.comments.map((c) => c.body),
      ];
      for (const text of written) expect(text).not.toMatch(SKIP_MARKER);
      // Exactly one claim comment, and nothing that says the issue was released.
      expect(issue.comments.filter((c) => c.body.includes("autodev-claim"))).toHaveLength(1);
      expect(issue.comments.filter((c) => c.body.includes("autodev-release"))).toHaveLength(0);

      // Every gh call named the repository; the fake served every one of them.
      expect(forge.calls.length).toBeGreaterThan(0);
      expect(forge.violations, "gh calls without -R").toEqual([]);
      expect(forge.unexpected, "gh calls the fake forge does not serve").toEqual([]);
      expect(disallowed, "commands other than git and gh").toEqual([]);
      for (const args of forge.calls) expect(args.slice(0, 2)).toEqual(["-R", REPO]);
      expect(
        forge.calls.filter((a) => a.includes("pr") && a.includes("merge")),
        "Phase 1 never merges",
      ).toEqual([]);

      // --- the events log: the dispatches, in order ----------------------------------------
      const lines = readEvents().split("\n").filter(Boolean);
      inOrder(lines, [
        / #42 \S+ dispatch plan model=/,
        / #42 \S+ dispatch plan-review model=/,
        / #42 \S+ dispatch implement model=/,
        / #42 \S+ dispatch code-review model=/,
      ]);
      expect(lines.filter((l) => / dispatch /.test(l))).toHaveLength(4);
      expect(lines.some((l) => l.includes("red-step proven"))).toBe(true);

      // --- the runtime: what ran, and how ---------------------------------------------------
      expect(unscripted, "roles nobody scripted").toEqual([]);
      expect(failures, "errors inside the scripted runtime").toEqual([]);
      const roles = runtime.requests.map((r) => r.role);
      expect(roles.slice(0, 4)).toEqual([
        "plan",
        "plan-review-finder",
        "implement",
        expect.any(String),
      ]);
      for (const r of runtime.requests) {
        const reader = r.role !== "plan" && r.role !== "implement";
        expect(!!r.req.readOnly, `${r.role} read-only`).toBe(reader);
      }
      expect(roles.filter((r) => r.startsWith("code-review-angle-")).sort()).toEqual(
        cfg.codeReview.angles.map((a) => `code-review-angle-${a}`).sort(),
      );

      // --- nothing outside the sandbox ------------------------------------------------------
      expect(listing(home), "the run wrote into the home directory").toEqual([]);
      expect(
        listing(scratch),
        "the run left files in the temporary directory (the red step's report)",
      ).toEqual([]);
      expect(checkout(), "the repository under test was written to").toBe(checkoutBefore);
      // The red step removed its base worktree.
      expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
      expect(ctx.stages.running()).toEqual([]);
    } catch (error) {
      dump();
      throw error;
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }, 60_000);
});
