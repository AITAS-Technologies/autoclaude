/**
 * R70: every engine git and gh call has a limit (600 s and 120 s unless the call names one) and
 * runs with credential prompts off, wherever it is spawned; one that outlives its limit is an
 * error that names the command and the limit. `runSync` is wrapped, not replaced: each case
 * either reads the options it was handed or answers one call itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, realExec } from "../../src/forge/github.js";
import { repoRoot } from "../../src/engine/root.js";
import * as spawn from "../../src/platform/spawn.js";

vi.mock("../../src/platform/spawn.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/spawn.js")>();
  return { ...real, runSync: vi.fn(real.runSync) };
});
const runSync = vi.mocked(spawn.runSync);

afterEach(() => {
  runSync.mockClear();
});

const timedOut = (): spawn.RunResult => ({
  status: null,
  signal: "SIGTERM",
  stdout: "",
  stderr: "",
  timedOut: true,
});

describe("the engine's git and gh calls", () => {
  it("give git 600 s and gh 120 s, with credential prompts off", () => {
    realExec("git", ["--version"]);
    realExec("gh", ["--version"]);
    const [gitCall, ghCall] = runSync.mock.calls;
    expect(gitCall?.[2]).toMatchObject({ timeoutMs: 600_000 });
    expect(ghCall?.[2]).toMatchObject({ timeoutMs: 120_000 });
    for (const call of [gitCall, ghCall])
      expect(call?.[2]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  });

  it("let a call site name its own limit", () => {
    realExec("git", ["--version"], { timeoutMs: 5_000 });
    expect(runSync.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5_000 });
  });

  it("reach the child with the two variables set, whatever the parent had", () => {
    const before = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "1";
    try {
      const r = realExec(process.execPath, [
        "-e",
        "process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT} ${process.env.GCM_INTERACTIVE}`)",
      ]);
      expect(r.stdout).toBe("0 never");
    } finally {
      if (before === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = before;
    }
  });

  it("turn a call that outlives its limit into an error naming the command and the limit", () => {
    // A real child that sleeps past a short limit: killed, no exit code, the limit named.
    const slow = realExec(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      timeoutMs: 300,
    });
    expect(slow).toMatchObject({ status: null, timedOut: true });
    expect(slow.stderr).toMatch(/^timed out after 300 ms/);
    // Through the throwing wrapper, at the default limit of a git call.
    runSync.mockImplementationOnce(timedOut);
    expect(() => git(["fetch", "origin", "develop"])).toThrow(
      "git -c core.quotePath=false fetch origin develop timed out after 600 s",
    );
  });

  it("include the root lookup, which takes a limit of its own and names it on a timeout", () => {
    repoRoot(process.cwd(), { timeoutMs: 15_000 });
    expect(runSync.mock.calls[0]?.[0]).toBe("git");
    expect(runSync.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 15_000,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }),
    });
    repoRoot(process.cwd());
    expect(runSync.mock.calls[1]?.[2]).toMatchObject({ timeoutMs: 600_000 });
    runSync.mockImplementationOnce(timedOut);
    expect(() => repoRoot(process.cwd(), { timeoutMs: 15_000 })).toThrow(
      /git rev-parse --git-common-dir timed out after 15 s/,
    );
  });
});
