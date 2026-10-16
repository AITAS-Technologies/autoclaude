/**
 * The red step of the code review: prove that the tests a diff adds or changes fail
 * against the integration base and pass on the head.
 *
 * Which files are tests, which are support files, how the tests run and how their result
 * is read all come from the `redStep` config (design § 8.3), so the step works for any
 * stack: `testFiles` minus `exclude` are run, `supportFiles` are copied into the base
 * worktree because the head's tests import them, `run` gets `{files}` and `{report}`, and
 * `result` says whether a JUnit report or only the exit code carries the outcome.
 *
 * Exit codes of the `autoclaude red-step` verb (`redStepExitCode`):
 *   0  proven: the head ran the tests green, the base did not
 *   2  not proven: the tests pass on the base too, or fail on the head (a finding)
 *   3  the diff adds or changes no test file the config collects
 *   1  the step itself could not run
 *
 * The verdict reads per-test outcomes, never the exit code alone (with `result: "junit"`),
 * and it counts suites that failed to load as well as failed tests: a run where one file
 * passes and another fails to import reports no failed test, which an earlier version
 * scored as a green head.
 *
 * The one case that stays a judgement: a base that collects no tests at all. For a new
 * module that is the ordinary red step, because the import the new test makes does not
 * exist on the base yet; for a stale dependency tree it is an infrastructure failure.
 * They are told apart by the reason: the base's output has to name something this change
 * adds. If it does not, the step reports "could not run" rather than certify a run in
 * which no assertion was ever made.
 *
 * Where the base worktree lives: under `worktrees.root`, never linked. A worktree inside
 * the repository finds the main directory's dependencies by resolution; `install` runs
 * in it only when the file it names differs between base and head. It is always removed
 * afterwards, also on an error or a timeout.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseJUnit } from "../../adapters/junit.js";
import { changedFiles } from "../../adapters/changed-files.js";
import { matchesAny } from "../../config/globs.js";
import type { ProjectConfig } from "../../config/types.js";
import { realExec, type Exec } from "../../forge/exec.js";
import { git } from "../../forge/github.js";
import { toPosix } from "../../platform/paths.js";
import { runShell, shQuote } from "../../platform/shell.js";
import { repoRoot } from "../root.js";
import type { Verdict } from "./red-step-verdict.js";

export type { Verdict } from "./red-step-verdict.js";

/** A test run that outlives this is killed (tree and all) and counts as not having run. */
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export interface RedStepFiles {
  files: string[];
  support: string[];
  skipped: string[];
}

/**
 * Splits the changed files by the config: tests to run (`testFiles` minus `exclude`),
 * support files to copy into the base (`supportFiles`, minus tests and `exclude`), and the
 * rest, reported as skipped. Input order is kept.
 */
export function selectFiles(
  changed: string[],
  redStep: Pick<ProjectConfig["redStep"], "testFiles" | "supportFiles" | "exclude">,
): RedStepFiles {
  const files: string[] = [];
  const support: string[] = [];
  const skipped: string[] = [];
  for (const f of changed) {
    if (matchesAny(f, redStep.exclude)) skipped.push(f);
    else if (matchesAny(f, redStep.testFiles)) files.push(f);
    else if (matchesAny(f, redStep.supportFiles)) support.push(f);
    else skipped.push(f);
  }
  return { files, support, skipped };
}

export interface RunResult {
  /** the runner produced a result at all; false on a spawn failure, a timeout or a missing report */
  ran: boolean;
  total: number;
  /** Assertions that ran and failed. This, and only this, is a red test. */
  testsFailed: number;
  /** Suites that never got that far: an import threw, the config broke. Not evidence about the change. */
  suitesFailed: number;
  /** The two together, for judging whether the head is green. */
  failed: number;
  success: boolean;
  status: number | null;
  output: string;
}

function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(-n) : s;
}

const notRun = (status: number | null, output: string): RunResult => ({
  ran: false,
  total: 0,
  testsFailed: 0,
  suitesFailed: 0,
  failed: 0,
  success: false,
  status,
  output,
});

/** A run scored from its JUnit report; no report, or one without a single test or error, did not run. */
export function runResultFromJUnit(text: string, stdout: string, status: number | null): RunResult {
  const output = tail(stdout);
  const c = parseJUnit(text);
  if (c.total === 0 && c.failed === 0 && c.errored === 0 && c.suitesFailed === 0) {
    return notRun(status, output);
  }
  const testsFailed = c.failed;
  // Errored tests and suites that failed to load are alike not evidence about the change.
  const suitesFailed = c.errored + c.suitesFailed;
  return {
    ran: true,
    total: c.total,
    testsFailed,
    suitesFailed,
    // Both, always, for the head: a suite that fails to import reports no failed test.
    failed: testsFailed + suitesFailed,
    success: status === 0 && testsFailed + suitesFailed === 0,
    status,
    output,
  };
}

/**
 * With `result: "exit-code"` nothing says which test failed. A zero exit is a green run of
 * an unknown number of tests (scored as one); any other exit is a failure that cannot be
 * attributed to an assertion, so it counts as a suite that did not load, and `verdict`
 * then asks whether the output names something the change adds.
 */
export function runResultFromExitCode(stdout: string, status: number | null): RunResult {
  const output = tail(stdout);
  if (status === null) return notRun(status, output);
  const ok = status === 0;
  return {
    ran: true,
    total: 1,
    testsFailed: 0,
    suitesFailed: ok ? 0 : 1,
    failed: ok ? 0 : 1,
    success: ok,
    status,
    output,
  };
}

/**
 * Candidate module specifiers for a path the change adds, in the spellings an import
 * would use: the path itself, without its extension, and the last two segments. Used only
 * to read a base load failure.
 */
export function specifiersFor(path: string): string[] {
  const noExt = path.replace(/\.[^./]+$/, "");
  const parts = noExt.split("/");
  const out = [path, noExt, parts.slice(-2).join("/")];
  return [...new Set(out.filter((s) => s.length > 3))];
}

/** Does the base's failure name something this change adds? Then it is the change, not the setup. */
export function baseFailureIsTheChange(output: string, addedPaths: string[]): boolean {
  const hay = output.replace(/\\/g, "/");
  return addedPaths.some((p) => specifiersFor(p).some((s) => hay.includes(s)));
}

export function verdict(base: RunResult, head: RunResult, addedPaths: string[] = []): Verdict {
  if (!head.ran) return { kind: "could-not-run", reason: "the head produced no test report" };
  if (head.total === 0 && head.suitesFailed === 0)
    return { kind: "could-not-run", reason: "the head collected no tests" };
  // Every signal the reporter gives, not just the count: a suite that failed to import
  // reports zero failed tests, and the exit code is the last word.
  if (!head.success || head.failed > 0 || head.status !== 0) {
    return {
      kind: "not-proven",
      reason: `the head is not green (${head.failed} failure(s), exit ${head.status})`,
    };
  }
  if (!base.ran) return { kind: "could-not-run", reason: "the base produced no test report" };
  // An assertion that ran and failed is the red step, whatever else the run did.
  if (base.testsFailed > 0)
    return { kind: "proven", reason: `${base.testsFailed} test(s) fail on the base` };
  // A suite that never loaded is not evidence about the change until its reason says so,
  // and this is reached whether or not a sibling file collected: keying it on
  // `total === 0` made the guard dead for every run where one file did.
  if (base.suitesFailed > 0) {
    return baseFailureIsTheChange(base.output, addedPaths)
      ? { kind: "proven", reason: "the base cannot load the suite: it lacks what this change adds" }
      : {
          kind: "could-not-run",
          reason:
            "the base cannot load a suite, and its error names nothing this change adds; read the base output before reading anything into it",
        };
  }
  if (base.total === 0) return { kind: "could-not-run", reason: "the base collected no tests" };
  return { kind: "not-proven", reason: "every test passes on the base too" };
}

/** The exit code of `autoclaude red-step`; the verb itself lives in `src/cli`. */
export function redStepExitCode(v: Verdict | { kind: "no-test-files" }): 0 | 1 | 2 | 3 {
  switch (v.kind) {
    case "proven":
      return 0;
    case "not-proven":
      return 2;
    case "no-test-files":
      return 3;
    default:
      return 1;
  }
}

export interface RedStepResult {
  verdict: Verdict | { kind: "no-test-files" };
  reason: string;
  base?: RunResult;
  head?: RunResult;
  files?: string[];
  support?: string[];
  skipped?: string[];
}

type RedStepConfig = Pick<ProjectConfig, "redStep" | "worktrees">;

/** Runs the configured command in `cwd` with `{files}` and `{report}` filled in. */
async function runTests(cfg: RedStepConfig, cwd: string, files: string[]): Promise<RunResult> {
  const report = join(tmpdir(), `autoclaude-red-${randomBytes(4).toString("hex")}.xml`);
  // split/join, not replace: a quoted path may contain `$&` or `$'`, which replace expands.
  const command = cfg.redStep.run
    .split("{files}")
    .join(files.map(shQuote).join(" "))
    .split("{report}")
    .join(shQuote(toPosix(report)));
  try {
    const r = await runShell(`exec 2>&1; ${command}`, { cwd, timeoutMs: RUN_TIMEOUT_MS });
    const out = r.stdout + r.stderr;
    if (r.timedOut) return notRun(r.status, tail(`timed out after ${RUN_TIMEOUT_MS} ms\n${out}`));
    if (cfg.redStep.result === "exit-code") return runResultFromExitCode(out, r.status);
    const text = existsSync(report) ? readFileSync(report, "utf8") : "";
    return runResultFromJUnit(text, out, r.status);
  } finally {
    rmSync(report, { force: true });
  }
}

/** Do base and head hold different content in `path`? A file on neither side is the same. */
function differsBetween(exec: Exec, worktree: string, base: string, path: string): boolean {
  const onBase = exec("git", ["rev-parse", "--verify", "--quiet", `${base}:${path}`], {
    cwd: worktree,
  });
  const baseId = onBase.status === 0 ? onBase.stdout.trim() : "";
  let headId = "";
  if (existsSync(join(worktree, path))) {
    const onHead = exec("git", ["hash-object", "--", path], { cwd: worktree });
    headId = onHead.status === 0 ? onHead.stdout.trim() : "";
  }
  return baseId !== headId;
}

function removeWorktree(exec: Exec, worktree: string, baseWt: string): void {
  // The verdict is already computed; a directory that will not go must not turn a proven
  // red step into a failure. Retry, then say so.
  try {
    exec("git", ["worktree", "remove", "--force", baseWt], { cwd: worktree });
    if (existsSync(baseWt)) {
      rmSync(baseWt, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    exec("git", ["worktree", "prune"], { cwd: worktree });
  } catch (error) {
    console.error(`red step: could not remove ${baseWt}: ${String(error)}`);
  }
}

/**
 * Proves a change: its new or changed tests fail on `base` and pass on the head, which is
 * `worktree`. Never throws for a test run that fails; git failing to answer does throw.
 */
export async function runRedStep(
  cfg: RedStepConfig,
  worktree: string,
  base: string,
  exec: Exec = realExec,
): Promise<RedStepResult> {
  const changed = changedFiles(worktree, base, exec);
  const { files, support, skipped } = selectFiles(changed, cfg.redStep);
  if (files.length === 0) {
    const named = skipped.length > 0 ? `; not test files, skipped: ${skipped.join(", ")}` : "";
    return {
      verdict: { kind: "no-test-files" },
      reason: `no test files among ${changed.length} path(s)${named}`,
      files,
      support,
      skipped,
    };
  }
  // Added files, for reading a base that cannot load the suite: a missing import that this
  // change introduces is the red step; anything else is a broken base. The test files and
  // the support files are excluded, because a runner names the test file in every load
  // error, so leaving them in would let any base-side breakage look like the change.
  const copied = new Set([...files, ...support]);
  const addedPaths = changed.filter(
    (f) =>
      !copied.has(f) &&
      exec("git", ["cat-file", "-e", `${base}:${f}`], { cwd: worktree }).status !== 0,
  );

  const root = repoRoot(worktree);
  const baseWt = join(resolve(root, cfg.worktrees.root), `red-${randomBytes(4).toString("hex")}`);
  try {
    git(["worktree", "add", "--detach", "--quiet", baseWt, base], exec, worktree);

    // The head's tests and the support files they import, copied over the base. A file the
    // base does not have is created; one it has is replaced by the head's version.
    for (const f of [...files, ...support]) {
      mkdirSync(dirname(join(baseWt, f)), { recursive: true });
      cpSync(join(worktree, f), join(baseWt, f));
    }

    const install = cfg.redStep.install;
    if (install !== undefined && differsBetween(exec, worktree, base, install.when)) {
      const r = await runShell(`exec 2>&1; ${install.run}`, {
        cwd: baseWt,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      if (r.status !== 0) {
        const reason = `the install in the base worktree failed (exit ${r.status}): ${tail(r.stdout + r.stderr, 1000)}`;
        return {
          verdict: { kind: "could-not-run", reason },
          reason,
          files,
          support,
          skipped,
        };
      }
    }

    const onBase = await runTests(cfg, baseWt, files);
    const onHead = await runTests(cfg, worktree, files);
    const v = verdict(onBase, onHead, addedPaths);
    return {
      verdict: v,
      reason: v.reason,
      base: onBase,
      head: onHead,
      files,
      support,
      skipped,
    };
  } finally {
    removeWorktree(exec, worktree, baseWt);
  }
}
