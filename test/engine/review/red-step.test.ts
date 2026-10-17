import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { toPosix } from "../../../src/platform/paths.js";
import {
  baseFailureIsTheChange,
  redStepExitCode,
  runRedStep,
  runResultFromExitCode,
  runResultFromJUnit,
  selectFiles,
  specifiersFor,
  verdict,
  type RunResult,
} from "../../../src/engine/review/red-step.js";

// The red step: prove that the tests a diff adds fail on the integration base and pass on
// the head. Which files are tests, how they run and how the result is read come from the
// `redStep` config (design § 8.3), not from a built-in runner.
describe("selectFiles", () => {
  const changed = [
    "test/unit/parser/lexer.test.js",
    "test/integration/isolation.test.js",
    "src/widgets/queries.test.js",
    "src/widgets/Panel.test.jsx",
    "src/widgets/Panel.jsx",
    "src/parser/lexer.js",
    "test/mocks/lexer.js",
    "test/setup.js",
    "test/unit/fixtures/reports/sample.md",
    "docs/x.md",
  ];
  const redStep = {
    testFiles: ["test/**/*.test.js", "src/**/*.test.js", "src/**/*.test.jsx"],
    supportFiles: ["test/**"],
    exclude: ["test/integration/**"],
  };
  // § 8.3: the globs come from the config; a file the runner does not collect used to
  // read as a red base.
  it("runs what redStep.testFiles collects minus exclude, and nothing else", () => {
    expect(selectFiles(changed, redStep).files).toEqual([
      "test/unit/parser/lexer.test.js",
      "src/widgets/queries.test.js",
      "src/widgets/Panel.test.jsx",
    ]);
  });
  // The mocks and fixtures the tests import are copied into the base, or the base fails
  // to load a suite for a reason that has nothing to do with the change.
  it("copies the support files the diff touches, never an excluded one", () => {
    expect(selectFiles(changed, redStep).support).toEqual([
      "test/mocks/lexer.js",
      "test/setup.js",
      "test/unit/fixtures/reports/sample.md",
    ]);
  });
  it("lists everything else as skipped", () => {
    expect(selectFiles(changed, redStep).skipped).toEqual([
      "test/integration/isolation.test.js",
      "src/widgets/Panel.jsx",
      "src/parser/lexer.js",
      "docs/x.md",
    ]);
  });
});

const run = (over: Partial<RunResult>): RunResult => {
  const r = {
    ran: true,
    total: 2,
    testsFailed: 0,
    suitesFailed: 0,
    success: true,
    status: 0,
    output: "",
    ...over,
  };
  return { ...r, failed: r.testsFailed + r.suitesFailed };
};
const red = run({ total: 2, testsFailed: 2, success: false, status: 1 });

describe("runResultFromJUnit", () => {
  const report = (attrs: string, body = "") => `<testsuite ${attrs}>${body}</testsuite>`;
  it("reads the report's counts", () => {
    const r = runResultFromJUnit(
      report('tests="3" failures="1"', '<testcase name="a"><failure/></testcase>'),
      "",
      1,
    );
    expect(r).toMatchObject({
      ran: true,
      total: 3,
      testsFailed: 1,
      failed: 1,
      success: false,
      status: 1,
    });
  });
  // An errored test and a suite that never loaded are not evidence about the change; only
  // an assertion that ran and failed is a red test.
  it("counts errors and suites that failed to load apart from failed tests", () => {
    const r = runResultFromJUnit(
      report('tests="2" errors="1"', '<testcase name="a"><error/></testcase><error message="x"/>'),
      "",
      1,
    );
    expect(r).toMatchObject({
      total: 2,
      testsFailed: 0,
      suitesFailed: 2,
      failed: 2,
      success: false,
    });
  });
  it("says it did not run when there is no report", () => {
    expect(runResultFromJUnit("", "Error: Cannot find module 'x'", 1).ran).toBe(false);
    expect(runResultFromJUnit("not a report", "", null).ran).toBe(false);
  });
});

// § 8.3: with `result: "exit-code"` only the exit code counts.
describe("runResultFromExitCode", () => {
  it("scores a zero exit as green and a non-zero exit as a failure it cannot attribute", () => {
    expect(runResultFromExitCode("ok", 0)).toMatchObject({ ran: true, success: true, failed: 0 });
    expect(runResultFromExitCode("boom", 1)).toMatchObject({
      ran: true,
      success: false,
      testsFailed: 0,
      suitesFailed: 1,
    });
    expect(runResultFromExitCode("", null).ran).toBe(false);
  });
  it("gives could-not-run for a base failure that names nothing this change adds", () => {
    const base = runResultFromExitCode("exit 1", 1);
    expect(verdict(base, runResultFromExitCode("", 0), []).kind).toBe("could-not-run");
  });
});

describe("verdict", () => {
  it("is proven when the head is green and the base fails", () => {
    expect(verdict(red, run({})).kind).toBe("proven");
  });
  // The head's exit code and `success` are read, not only its failure count: a head with
  // one unimportable file must not pass as green.
  it("refuses a head that is not green by any of the three signals", () => {
    expect(verdict(red, run({ testsFailed: 1, success: false, status: 1 })).kind).toBe(
      "not-proven",
    );
    expect(verdict(red, run({ success: false })).kind).toBe("not-proven");
    expect(verdict(red, run({ status: 1 })).kind).toBe("not-proven");
    expect(verdict(red, run({ total: 2, suitesFailed: 1, success: false, status: 1 })).kind).toBe(
      "not-proven",
    );
  });
  it("is a finding when every test passes on the base too", () => {
    expect(verdict(run({}), run({}))).toMatchObject({ kind: "not-proven" });
  });
  it("cannot run when a side produced no report or the head collected nothing", () => {
    expect(verdict(red, run({ ran: false, total: 0 })).kind).toBe("could-not-run");
    expect(verdict(red, run({ total: 0 })).kind).toBe("could-not-run");
    expect(verdict(run({ ran: false, total: 0 }), run({})).kind).toBe("could-not-run");
  });
  // A base that collects nothing is the ordinary red step for a new module, and an
  // infrastructure failure otherwise. The base's own error decides, and with no added
  // path to name it is not certified.
  it("reads a base that cannot load the suite by its reason", () => {
    const cannotLoad = run({
      total: 0,
      suitesFailed: 1,
      success: false,
      status: 1,
      output: "Error: Cannot find module './parser/lexer'",
    });
    expect(verdict(cannotLoad, run({}), ["src/parser/lexer.js"]).kind).toBe("proven");
    expect(verdict(cannotLoad, run({}), ["src/unrelated/thing.js"]).kind).toBe("could-not-run");
    expect(verdict(cannotLoad, run({}), []).kind).toBe("could-not-run");
  });
});

describe("specifiersFor and baseFailureIsTheChange", () => {
  // § 8.3: the source's alias spelling is gone with the runner; the rest is unchanged.
  it("offers the spellings an import would use", () => {
    expect(specifiersFor("src/parser/lexer.js")).toEqual([
      "src/parser/lexer.js",
      "src/parser/lexer",
      "parser/lexer",
    ]);
  });
  it("matches a Windows path in the output against a posix specifier", () => {
    expect(
      baseFailureIsTheChange("Failed to load C:\\repo\\src\\widgets\\Panel.jsx", [
        "src/widgets/Panel.jsx",
      ]),
    ).toBe(true);
    expect(baseFailureIsTheChange("Cannot find module 'left-pad'", ["src/a/b.js"])).toBe(false);
  });
});

// A base where one suite loaded and another did not: the trigger is routine, the head
// adds a dependency, the base gets no install of its own, and one file cannot resolve it.
describe("a base where one suite loaded and another did not", () => {
  const head = run({});
  const base = run({
    total: 2,
    suitesFailed: 1,
    success: false,
    status: 1,
    output: "Error: Cannot find module 'left-pad'",
  });
  it("is not proven when the load failure names nothing this change adds", () => {
    expect(verdict(base, head, ["src/widgets/Panel.jsx"])).toMatchObject({
      kind: "could-not-run",
    });
  });
  it("is proven when it does", () => {
    const ours = run({ ...base, output: "Error: Cannot find module './parser/lexer'" });
    expect(verdict(ours, head, ["src/parser/lexer.js"]).kind).toBe("proven");
  });
  it("is proven from a real assertion failure whatever the suites did", () => {
    expect(verdict(run({ ...base, testsFailed: 1 }), head, []).kind).toBe("proven");
  });
});

describe("redStepExitCode", () => {
  it("keeps the source meanings: 0 proven, 2 not proven, 3 no test files, 1 could not run", () => {
    expect(redStepExitCode({ kind: "proven", reason: "" })).toBe(0);
    expect(redStepExitCode({ kind: "not-proven", reason: "" })).toBe(2);
    expect(redStepExitCode({ kind: "no-test-files" })).toBe(3);
    expect(redStepExitCode({ kind: "could-not-run", reason: "" })).toBe(1);
  });
});

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const JUNIT_RUN = "node --test --test-reporter=junit --test-reporter-destination={report} {files}";

function config(
  root: string,
  over: Partial<{
    run: string;
    result: "junit" | "exit-code";
    install: { when: string; run: string };
  }> = {},
) {
  return {
    redStep: {
      testFiles: ["test/**/*.test.js"],
      supportFiles: ["test/helpers/**"],
      exclude: [],
      run: JUNIT_RUN,
      result: "junit" as const,
      ...over,
    },
    worktrees: { root, copy: [] },
  };
}

/** A repo whose `base` branch has a wrong `add`, and whose head fixes it and adds a test. */
function repo(withTest = true): { dir: string; worktrees: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude red ")));
  const worktrees = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude red-wt ")));
  created.push(dir, worktrees);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "add.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(dir, "package.json"), '{"name":"t","version":"1.0.0"}\n');
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  git(dir, "branch", "base");
  writeFileSync(join(dir, "src", "add.js"), "module.exports = (a, b) => a + b;\n");
  if (withTest) {
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test", "add.test.js"),
      `const test = require("node:test");
const assert = require("node:assert");
const add = require("../src/add");
test("adds", () => assert.strictEqual(add(2, 3), 5));
`,
    );
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "fix");
  return { dir, worktrees };
}

const worktreeCount = (dir: string) =>
  git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length;

describe("runRedStep", () => {
  it("proves a change end to end with node --test", async () => {
    const { dir, worktrees } = repo();
    const r = await runRedStep(config(worktrees), dir, "base");
    expect(r.verdict.kind).toBe("proven");
    expect(r.base?.testsFailed).toBe(1);
    expect(r.head?.success).toBe(true);
    // The base worktree is gone, from disk and from git's list.
    expect(worktreeCount(dir)).toBe(1);
    expect(readdirSync(worktrees)).toEqual([]);
  }, 60_000);

  it("reads only the exit code with result: exit-code", async () => {
    const { dir, worktrees } = repo();
    const cfg = config(worktrees, { run: "node --test {files}", result: "exit-code" });
    const r = await runRedStep(cfg, dir, "base");
    // The base failure cannot be attributed to an assertion, so the step does not certify it.
    expect(r.verdict.kind).toBe("could-not-run");
    expect(r.head?.success).toBe(true);
  }, 60_000);

  it("reports no-test-files when the diff adds no test", async () => {
    const { dir, worktrees } = repo(false);
    const r = await runRedStep(config(worktrees), dir, "base");
    expect(r.verdict.kind).toBe("no-test-files");
    expect(r.reason).toContain("src/add.js");
    expect(worktreeCount(dir)).toBe(1);
  }, 60_000);

  it("removes the base worktree when the run fails", async () => {
    const { dir, worktrees } = repo();
    const r = await runRedStep(config(worktrees, { run: "exit 7" }), dir, "base");
    expect(r.verdict.kind).toBe("could-not-run");
    expect(worktreeCount(dir)).toBe(1);
    expect(existsSync(worktrees) && readdirSync(worktrees)).toEqual([]);
  }, 60_000);

  it("runs install only when the file named by install.when differs between base and head", async () => {
    const { dir, worktrees } = repo();
    // package.json is identical on both sides: no install, so the failing command never runs.
    const same = config(worktrees, { install: { when: "package.json", run: "exit 9" } });
    expect((await runRedStep(same, dir, "base")).verdict.kind).toBe("proven");
    // src/add.js differs: the install runs in the base worktree and its failure is reported.
    const differs = config(worktrees, { install: { when: "src/add.js", run: "exit 9" } });
    const r = await runRedStep(differs, dir, "base");
    expect(r.verdict.kind).toBe("could-not-run");
    expect(r.reason).toMatch(/install/);
    expect(worktreeCount(dir)).toBe(1);
  }, 90_000);

  // R69: the install and both test runs execute what a stage wrote, so they get the stage
  // environment (no forge token, the stage marker) and a scratch directory that is gone after.
  it("runs the install and the tests in the stage environment", async () => {
    const { dir, worktrees } = repo();
    const probeDir = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude red-env ")));
    created.push(probeDir);
    const probe = `"${toPosix(join(probeDir, "env.txt"))}"`;
    const line = (what: string) =>
      `echo "${what} \${GH_TOKEN:-none} \${AUTOCLAUDE_STAGE:-none} \${GH_CONFIG_DIR:-none}" >> ${probe}`;
    const cfg = config(worktrees, {
      run: `${line("test")}; ${JUNIT_RUN}`,
      install: { when: "src/add.js", run: line("install") },
    });
    const before = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "engine-token";
    let r;
    try {
      r = await runRedStep(cfg, dir, "base");
    } finally {
      if (before === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before;
    }
    expect(r.verdict.kind).toBe("proven");
    const seen = readFileSync(join(probeDir, "env.txt"), "utf8").trim().split(/\r?\n/);
    expect(seen.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual([
      "install none 1",
      "test none 1",
      "test none 1",
    ]);
    const scratch = seen[0]!.split(" ").slice(3).join(" ");
    expect(scratch).not.toBe("none");
    expect(existsSync(scratch), "the scratch directory is removed afterwards").toBe(false);
  }, 90_000);
});
