import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killTree, parsePsStartLine, processStartTime } from "../../src/platform/kill.js";
import { spawnSupervised } from "../../src/platform/spawn.js";

describe("processStartTime", () => {
  it("is stable across calls and null for a missing process", () => {
    const a = processStartTime(process.pid);
    expect(a).not.toBeNull();
    expect(processStartTime(process.pid)).toBe(a);
    expect(a).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(processStartTime(2 ** 22 + 12345)).toBeNull();
  });
});

describe("killTree", () => {
  it("kills a running process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kill-"));
    try {
      const h = spawnSupervised(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        stdoutFile: join(dir, "o"),
        stderrFile: join(dir, "e"),
      });
      expect(processStartTime(h.pid)).not.toBeNull();
      await killTree(h.pid);
      const r = await h.done;
      expect(r.status === 0).toBe(false);
      expect(processStartTime(h.pid)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw for a process that does not exist", async () => {
    await expect(killTree(2 ** 22 + 12345)).resolves.toBeUndefined();
  });
});

describe("killTree pid guard", () => {
  it("ignores pid 0, 1 and garbage without signalling anything", async () => {
    const orig = process.kill;
    const calls: unknown[] = [];
    process.kill = ((...a: unknown[]) => {
      calls.push(a);
      return true;
    }) as typeof process.kill;
    try {
      for (const pid of [0, 1, -5, 1.5, NaN]) await killTree(pid);
    } finally {
      process.kill = orig;
    }
    expect(calls).toEqual([]);
    expect(processStartTime(process.pid)).not.toBeNull();
  });
});

describe("parsePsStartLine", () => {
  it("parses a live process and treats zombies and empty output as dead", () => {
    expect(parsePsStartLine("Ss   Mon Oct 16 12:34:56 2026\n")).toMatch(/^2026-10-1[56]T/);
    expect(parsePsStartLine("Z+   Mon Oct 16 12:34:56 2026")).toBeNull();
    expect(parsePsStartLine("")).toBeNull();
  });
});
