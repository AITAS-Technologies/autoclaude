import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { machineStateDir, samePath, toPosix } from "../../src/platform/paths.js";

const base = mkdtempSync(join(tmpdir(), "paths-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("samePath", () => {
  it.skipIf(process.platform === "linux")(
    "compares case-insensitively on win32 and darwin (Linux file systems are case-sensitive)",
    () => {
      const d = join(base, "MixedCase");
      mkdirSync(d);
      expect(samePath(d, join(base, "mixedcase"))).toBe(true);
      expect(samePath(d, join(base, "MIXEDCASE"))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "treats directories differing only in case as different (linux only)",
    () => {
      mkdirSync(join(base, "Dir"));
      mkdirSync(join(base, "dir"));
      expect(samePath(join(base, "Dir"), join(base, "dir"))).toBe(false);
      expect(samePath(join(base, "Dir"), join(base, "Dir", "..", "Dir"))).toBe(true);
    },
  );

  it("matches the same existing path", () => {
    const d = join(base, "Same");
    mkdirSync(d);
    expect(samePath(d, d)).toBe(true);
  });
});

describe("toPosix", () => {
  it("turns backslashes into slashes", () => {
    expect(toPosix("C:\\a\\b/c")).toBe("C:/a/b/c");
  });
});

describe("machineStateDir", () => {
  it("per platform", () => {
    expect(machineStateDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\H")).toBe(
      join("C:\\L", "autoclaude"),
    );
    expect(machineStateDir({}, "linux", "/h")).toBe(join("/h", ".local/state", "autoclaude"));
    expect(machineStateDir({ XDG_STATE_HOME: "/x" }, "linux", "/h")).toBe(join("/x", "autoclaude"));
    expect(machineStateDir({}, "darwin", "/h")).toBe(
      join("/h", "Library/Application Support", "autoclaude"),
    );
  });
});
