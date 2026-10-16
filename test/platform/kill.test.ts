import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killTree, processStartTime } from "../../src/platform/kill.js";
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
