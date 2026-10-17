/**
 * The hook's git call has a limit of its own (F8). The hook entry's watchdog is a timer, and a
 * timer cannot fire during a synchronous `git`; a call that outlived Claude Code's hook timeout
 * would be read as "allow". `runSync` is wrapped, not replaced: one case answers its call itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { DEFAULT_DEPS, guardVerb, HOOK_GIT_TIMEOUT_MS, hookRoot } from "../../src/cli/guard.js";
import { loadProjectConfig } from "../../src/config/load.js";
import * as spawn from "../../src/platform/spawn.js";

vi.mock("../../src/platform/spawn.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/spawn.js")>();
  return { ...real, runSync: vi.fn(real.runSync) };
});
const runSync = vi.mocked(spawn.runSync);
afterEach(() => {
  runSync.mockClear();
});

const REPO = resolve(import.meta.dirname, "../..");
const ARGS = ["--runtime", "claude", "--worktree", REPO];
const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } });

describe("the hook's git call", () => {
  it("runs with a 15 s limit, and the guard's own root lookup is that one", () => {
    expect(HOOK_GIT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_DEPS.root).toBe(hookRoot);
    expect(hookRoot(REPO)).toBeTruthy();
    expect(runSync.mock.calls[0]?.[0]).toBe("git");
    expect(runSync.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 15_000 });
  });

  it("fails closed when git does not answer in time: exit 2, and the limit is named", async () => {
    runSync.mockImplementationOnce(() => ({
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => void err.push(s) };
    const deps = { stdin: async () => payload, root: hookRoot, load: loadProjectConfig };
    expect(await guardVerb(ARGS, io, deps)).toBe(2);
    expect(err.join("")).toMatch(
      /autoclaude guard: git rev-parse --git-common-dir timed out after 15 s/,
    );
    // The positive control: the same command, git answering, is allowed.
    const ok: string[] = [];
    const fixture = join(REPO, "test/fixtures/projects/minimal");
    const allowed = await guardVerb(
      ARGS,
      { out: () => {}, err: (s: string) => void ok.push(s) },
      { ...deps, root: () => fixture },
    );
    expect(allowed, ok.join("")).toBe(0);
  });
});
