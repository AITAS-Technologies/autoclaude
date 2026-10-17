import { describe, expect, it } from "vitest";
import { fakeGh } from "../helpers/fake-gh.js";

function forge() {
  const gh = fakeGh({
    repo: "acme/widgets",
    labels: ["ready"],
    remote: "unused",
    now: () => new Date("2026-03-03T10:00:00Z"),
  });
  for (const n of [1, 2, 3])
    gh.addIssue({ number: n, title: `t${n}`, body: "", labels: ["ready"] });
  return gh;
}
const run = (gh: ReturnType<typeof forge>, ...args: string[]) =>
  gh.exec("gh", ["-R", "acme/widgets", ...args]);

describe("the fake forge refuses what gh refuses", () => {
  it("an unknown --json field fails and is recorded", () => {
    const gh = forge();
    const r = run(gh, "issue", "view", "1", "--json", "number,titel");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Unknown JSON field: "titel"');
    expect(gh.unexpected).toHaveLength(1);
    expect(run(gh, "pr", "list", "--json", "number,headRefNme").status).not.toBe(0);
  });

  it("a known field the state cannot answer fails, a known one it can answer succeeds", () => {
    const gh = forge();
    expect(run(gh, "issue", "view", "1", "--json", "number,title").status).toBe(0);
    const r = run(gh, "issue", "view", "1", "--json", "reactionGroups");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot answer");
  });

  it("a list flag the fake does not interpret fails; --limit is applied", () => {
    const gh = forge();
    for (const flag of [
      ["--search", "x"],
      ["--author", "a"],
      ["--assignee", "a"],
    ])
      expect(
        run(gh, "issue", "list", "--label", "ready", ...flag, "--json", "number").status,
      ).not.toBe(0);
    expect(run(gh, "pr", "list", "--head", "b", "--json", "number").status).not.toBe(0);
    const r = run(gh, "issue", "list", "--label", "ready", "--limit", "2", "--json", "number");
    expect(JSON.parse(r.stdout)).toEqual([{ number: 1 }, { number: 2 }]);
  });
});
