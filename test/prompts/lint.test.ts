import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";
const all = fileURLToPath(new URL("../../prompts/", import.meta.url));

function walk(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
}

const FORBIDDEN = [
  "Agent tool",
  "subagent_type",
  "run_in_background",
  "EnterWorktree",
  "TaskStop",
  "TaskOutput",
  "ScheduleWakeup",
  "SendMessage",
  "Skill tool",
  "node_modules/tsx",
  "scripts/autodev",
  "npx tsx",
  ".autodev/",
  "git fetch",
  "git push",
];

// Prompts that write report blocks; JSON-emitting prompts are covered by the
// prompt coverage test.
const REPORT_PROMPTS: Record<string, string> = {
  "plan.md": "AUTODEV-PLAN",
  "implement.md": "AUTODEV-REPORT",
};

const promptFiles = walk(all);

describe("prompt lint", () => {
  it("scans the prompts directory (empty or absent is fine)", () => {
    expect(Array.isArray(promptFiles)).toBe(true);
  });

  for (const file of promptFiles) {
    const text = readFileSync(file, "utf8");
    it(`${file} has no forbidden constructs`, () => {
      for (const bad of FORBIDDEN) expect(text, bad).not.toContain(bad);
      // "gh " is the forge CLI; match it as a word so "through " is not flagged.
      expect(text, "gh ").not.toMatch(/(^|[^A-Za-z0-9])gh /);
    });
  }

  for (const [name, marker] of Object.entries(REPORT_PROMPTS)) {
    const file = join(all, name);
    it.skipIf(!existsSync(file))(`${name} names ${marker} and {{reportFile}}`, () => {
      const text = readFileSync(file, "utf8");
      expect(text).toContain(marker);
      expect(text).toContain("{{reportFile}}");
    });
  }
});
