import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const MARKERS = [
  /coveniq/i,
  /supabase/i,
  /privacy.?guard/i,
  /\btenant\b/i,
  /vercel/i,
  /next typegen/i,
  /from ["']@\//,
  ...(process.env.AUTOCLAUDE_EXTRA_MARKERS ?? "")
    .split(",")
    .filter(Boolean)
    .map((m) => new RegExp(m, "i")),
];
// AUTOCLAUDE_EXTRA_MARKERS: identifiers a maintainer wants to keep out (project refs, hostnames) without naming them here

it("no tracked file outside docs/specs and docs/plans names a consumer project", () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter(
      (f) =>
        !f.startsWith("docs/specs/") &&
        !f.startsWith("docs/plans/") &&
        f !== "test/repo/no-consumer-content.test.ts",
    );
  const hits = files.flatMap((f) =>
    MARKERS.filter((m) => m.test(readFileSync(f, "utf8"))).map((m) => `${f}: ${m}`),
  );
  expect(hits).toEqual([]);
});
