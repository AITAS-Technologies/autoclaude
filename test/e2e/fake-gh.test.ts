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
    expect(run(gh, "pr", "list", "--base", "b", "--json", "number").status).not.toBe(0);
    expect(run(gh, "pr", "list", "--state", "merged", "--json", "number").status).not.toBe(0);
    const r = run(gh, "issue", "list", "--label", "ready", "--limit", "2", "--json", "number");
    expect(JSON.parse(r.stdout)).toEqual([{ number: 1 }, { number: 2 }]);
  });

  // R71: the engine asks for one branch's pull requests of every state; `--head` is exact.
  it("serves pr list --head as an exact match over every state", () => {
    const gh = forge();
    gh.prs.push(
      ...[
        { number: 1, head: "agent/1-x", state: "MERGED" as const },
        { number: 2, head: "agent/1-x", state: "OPEN" as const },
        { number: 3, head: "agent/1-xy", state: "CLOSED" as const },
      ].map((p) => ({
        ...p,
        title: "",
        body: "",
        base: "develop",
        labels: [],
        url: "",
        createdAt: "",
        updatedAt: "",
        statusCheckRollup: [],
        comments: [],
      })),
    );
    const numbers = (...args: string[]): number[] => {
      const out = run(gh, "pr", "list", ...args, "--json", "number").stdout;
      return (JSON.parse(out) as Array<{ number: number }>).map((p) => p.number);
    };
    expect(numbers("--head", "agent/1-x", "--state", "all")).toEqual([1, 2]);
    expect(numbers("--head", "agent/1-x")).toEqual([2]);
    expect(numbers("--state", "all")).toEqual([1, 2, 3]);
    expect(gh.unexpected).toEqual([]);
  });
});
