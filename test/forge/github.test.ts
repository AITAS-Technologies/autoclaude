import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { realExec, type Exec } from "../../src/forge/exec.js";
import { Forge, gh, git, parseRepo, resolveRepo, type RollupNode } from "../../src/forge/github.js";

/** Records every call and answers from a table keyed by the joined args. */
function fake(answers: Record<string, string>, status = 0) {
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  const exec: Exec = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    inputs.push(opts?.input);
    const key = args.join(" ");
    const hit = Object.keys(answers).find((k) => key.startsWith(k));
    return {
      status: hit === undefined ? 1 : status,
      stdout: hit === undefined ? "" : (answers[hit] ?? ""),
      stderr: hit === undefined ? "no answer for: " + key : "",
    };
  };
  return { exec, calls, inputs };
}

const REPO = "o/r";

function fixture(name: string): RollupNode[] {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/forge/${name}.json`, import.meta.url), "utf8"),
  ) as RollupNode[];
}

describe("gh()", () => {
  it("parses JSON and throws on a non-zero exit with the stderr", () => {
    const ok = fake({ "issue view 5": '{"number":5}' });
    expect(gh<{ number: number }>(["issue", "view", "5"], ok.exec).number).toBe(5);
    const bad = fake({});
    expect(() => gh(["issue", "view", "6"], bad.exec)).toThrow(/no answer for/);
  });
});

describe("the wrappers compose the right command lines", () => {
  it("lists issues by label with the fields the ledger needs", () => {
    const f = fake({ "-R o/r issue list": "[]" });
    new Forge(REPO, f.exec).listIssues("agent-working", "all");
    expect(f.calls[0]).toEqual([
      "gh",
      "-R",
      REPO,
      "issue",
      "list",
      "--label",
      "agent-working",
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,labels,assignees,updatedAt,comments",
    ]);
  });

  it("leaves the comments out when asked, and fills the field with an empty list", () => {
    const f = fake({
      "-R o/r issue list":
        '[{"number":1,"title":"t","state":"OPEN","labels":[],"assignees":[],"updatedAt":""}]',
    });
    const issues = new Forge(REPO, f.exec).listIssues("agent-ready", "open", {
      comments: false,
    });
    expect(f.calls[0]!.at(-1)).toBe("number,title,state,labels,assignees,updatedAt");
    expect(issues[0]!.comments).toEqual([]);
  });

  it("adds and removes labels in one call", () => {
    const f = fake({ "-R o/r issue edit": "" });
    const forge = new Forge(REPO, f.exec);
    forge.editLabels(7, { add: ["agent-blocked"], remove: ["agent-working", "agent-ready"] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toEqual([
      "gh",
      "-R",
      REPO,
      "issue",
      "edit",
      "7",
      "--add-label",
      "agent-blocked",
      "--remove-label",
      "agent-working,agent-ready",
    ]);
    forge.editLabels(7, {});
    expect(f.calls).toHaveLength(1);
  });

  it("reads the pull request number out of the URL gh pr create prints", () => {
    const f = fake({ "-R o/r pr create": "https://github.com/o/r/pull/131\n" });
    const pr = new Forge(REPO, f.exec).createPr({
      base: "develop",
      head: "agent/126-x",
      title: "t",
      body: "b",
    });
    expect(pr).toEqual({ number: 131, url: "https://github.com/o/r/pull/131" });
    expect(f.calls[0]).toContain("--body-file");
    expect(f.calls[0]).toContain("-");
    expect(f.inputs[0]).toBe("b");
  });

  it("asks a pull request for everything can-merge and the ledger read", () => {
    const f = fake({ "-R o/r pr view 131": '{"number":131,"state":"OPEN"}' });
    expect(new Forge(REPO, f.exec).viewPr(131).state).toBe("OPEN");
    expect(f.calls[0]!.join(" ")).toContain("statusCheckRollup");
  });

  it("sends bodies through stdin, never through argv", () => {
    const f = fake({ "-R o/r": "" });
    const hostile = "Fix login & logout --replace $(rm -rf ~) `id`";
    const forge = new Forge(REPO, f.exec);
    forge.commentIssue(3, hostile);
    forge.editPrBody(4, hostile);
    forge.commentPr(5, hostile);
    expect(f.inputs).toEqual([hostile, hostile, hostile]);
    expect(f.calls.flat()).not.toContain(hostile);
    expect(f.calls[2]).toEqual(["gh", "-R", REPO, "pr", "comment", "5", "--body-file", "-"]);
  });

  it("reads a branch's newest runs and a run's failed steps, with -R", () => {
    const f = fake({ "-R o/r run list": '[{"databaseId":9}]', "-R o/r run view 9": "log\n" });
    const forge = new Forge(REPO, f.exec);
    expect(forge.listRuns("agent/42-fix-it")[0]?.databaseId).toBe(9);
    expect(forge.runFailedLog(9)).toBe("log\n");
    expect(f.calls).toEqual([
      [
        "gh",
        "-R",
        REPO,
        "run",
        "list",
        "--branch",
        "agent/42-fix-it",
        "--limit",
        "20",
        "--json",
        "databaseId,conclusion,status,url,headSha,workflowName",
      ],
      ["gh", "-R", REPO, "run", "view", "9", "--log-failed"],
    ]);
  });
});

describe("explicit repository", () => {
  it("passes -R owner/repo on every gh call", () => {
    const f = fake({
      "-R o/r issue view": '{"number":1}',
      "-R o/r issue list": "[]",
      "-R o/r issue edit": "",
      "-R o/r pr edit": "",
      "-R o/r issue comment": "",
      "-R o/r pr view": '{"number":1}',
      "-R o/r pr list": "[]",
      "-R o/r pr create": "https://github.com/o/r/pull/9\n",
    });
    const forge = new Forge(REPO, f.exec);
    forge.viewIssue(1);
    forge.listIssues("l", "open");
    forge.editLabels(1, { add: ["a"] });
    forge.editPrLabels(1, { add: ["a"] });
    forge.commentIssue(1, "b");
    forge.editPrBody(1, "b");
    forge.viewPr(1);
    forge.listPrs("open");
    forge.createPr({ base: "b", head: "h", title: "t", body: "x" });
    expect(f.calls).toHaveLength(9);
    for (const argv of f.calls) {
      expect(argv[0]).toBe("gh");
      expect(argv).toContain("-R");
      expect(argv[argv.indexOf("-R") + 1]).toBe(REPO);
    }
  });
});

describe("complete listings", () => {
  const items = (n: number) =>
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        number: i + 1,
        title: "t",
        state: "OPEN",
        labels: [],
        assignees: [],
        updatedAt: "",
      })),
    );

  it("lists more than 100 issues", () => {
    const f = fake({ "-R o/r issue list": items(250) });
    const issues = new Forge(REPO, f.exec).listIssues("l", "open");
    const argv = f.calls[0]!;
    expect(argv[argv.indexOf("--limit") + 1]).toBe("1000");
    expect(issues).toHaveLength(250);
  });

  it("refuses a listing that hits its limit instead of truncating", () => {
    const f = fake({ "-R o/r issue list": items(1000), "-R o/r pr list": items(1000) });
    const forge = new Forge(REPO, f.exec);
    expect(() => forge.listIssues("l", "open")).toThrow(/more than 1000/);
    expect(() => forge.listPrs("open")).toThrow(/more than 1000/);
  });
});

describe("repository resolution", () => {
  it("resolves owner/repo from https and ssh remote URLs", () => {
    for (const url of [
      "https://github.com/o/r.git",
      "https://github.com/o/r",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r",
    ]) {
      expect(parseRepo(url)).toBe("o/r");
    }
  });

  it("names the remote and the URL when the URL is unusable", () => {
    const f = fake({ "-c core.quotePath=false remote get-url up": "not a url\n" });
    expect(() => resolveRepo("up", "/work", f.exec)).toThrow(/up.*not a url/);
  });

  it("asks git for the named remote, not origin", () => {
    const f = fake({ "-c core.quotePath=false remote get-url up": "git@github.com:o/r.git\n" });
    expect(resolveRepo("up", "/work", f.exec)).toBe("o/r");
    expect(f.calls[0]).toEqual(["git", "-c", "core.quotePath=false", "remote", "get-url", "up"]);
  });
});

describe("git()", () => {
  it("runs git with unquoted paths and the given cwd", () => {
    let seen: string | undefined;
    const exec: Exec = (_c, _a, opts) => {
      seen = opts?.cwd;
      return { status: 0, stdout: "ok", stderr: "" };
    };
    expect(git(["status"], exec, "/w")).toBe("ok");
    expect(seen).toBe("/w");
  });
});

describe("realExec", () => {
  it("runs a real command without a shell and reports a missing one as a failure", () => {
    const ok = realExec("node", ["-e", "process.stdout.write('hi')"]);
    expect(ok).toMatchObject({ status: 0, stdout: "hi" });
    const missing = realExec("autoclaude-no-such-binary", []);
    expect(missing.status).not.toBe(0);
  });
});

describe("rollup fixtures", () => {
  it("keep the two node shapes: check runs and legacy status contexts", () => {
    const green = fixture("rollup-gates-green");
    expect(green.filter((n) => n.name).length).toBeGreaterThan(0);
    expect(green.filter((n) => n.context).length).toBe(1);
    const legacy = fixture("rollup-legacy-only");
    expect(legacy.some((n) => n.state === "SUCCESS" && n.context)).toBe(true);
  });

  it("flow through viewPr unchanged", () => {
    const rollup = fixture("rollup-gates-green");
    const f = fake({
      "-R o/r pr view 2": JSON.stringify({ number: 2, statusCheckRollup: rollup }),
    });
    expect(new Forge(REPO, f.exec).viewPr(2).statusCheckRollup).toEqual(rollup);
  });
});
