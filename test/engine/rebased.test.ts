import { describe, it, expect } from "vitest";
import {
  checkRebased,
  decideHook,
  fetchBase,
  hookDecision,
  isPrCreate,
  isRebasedOnto,
} from "../../src/engine/rebased.js";
import type { Exec } from "../../src/forge/exec.js";

describe("isRebasedOnto", () => {
  it("is true when the base tip is an ancestor of head", () => {
    const run = () => ({ status: 0 });
    expect(isRebasedOnto("upstream/main", "HEAD", run)).toBe(true);
  });

  it("is false when git merge-base --is-ancestor exits 1", () => {
    const run = () => ({ status: 1 });
    expect(isRebasedOnto("upstream/main", "HEAD", run)).toBe(false);
  });

  it("passes the expected arguments to git", () => {
    let seen: string[] = [];
    const run = (args: string[]) => {
      seen = args;
      return { status: 0 };
    };
    isRebasedOnto("upstream/main", "abc123", run);
    expect(seen).toEqual(["merge-base", "--is-ancestor", "upstream/main", "abc123"]);
  });
});

describe("decideHook", () => {
  it("ignores commands that are not gh pr create", () => {
    expect(decideHook("git status", false)).toEqual({ block: false });
    expect(decideHook("gh pr view 31", false)).toEqual({ block: false });
  });

  it("blocks gh pr create on a stale branch", () => {
    const d = decideHook("gh pr create --base main --title x", false);
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/rebase/i);
  });

  it("allows gh pr create on a rebased branch", () => {
    expect(decideHook("gh pr create --base main", true)).toEqual({ block: false });
  });

  it("catches the command even with leading whitespace or a subshell prefix", () => {
    expect(decideHook("  cd x && gh pr create", false).block).toBe(true);
  });

  // The case that got through. A Bash tool call carries a whole script, and the
  // skills in this repository teach exactly this shape in the implement stage prompt.
  // With the separator class limited to ; & | and no multiline flag, nothing in a
  // newline-separated block anchored a match, so the guard permitted it. The old
  // suite passed only because "&&\n" happens to put an ampersand before the newline.
  // Two generations of this table were green over an open gate, because both listed
  // shapes the current pattern already caught. The separator-class versions leaked
  // every shape where an ordinary word or a quote stands before `gh`, and the table
  // contained none of them. The bottom group is that lesson written down.
  it.each([
    ["a bare newline", "git push -u upstream HEAD\ngh pr create --fill --base main"],
    ["an indented continuation", "git push\n    gh pr create --fill"],
    ["a command substitution", "URL=$(gh pr create --fill)"],
    ["a subshell", "(gh pr create --fill)"],
    ["a semicolon", "git push; gh pr create"],
    ["a pipe", "true | gh pr create"],
    ["several blank lines", "git push\n\n\ngh pr create"],
    ["an environment prefix", "GH_TOKEN=xxx gh pr create --fill"],
    ["a then branch", "if git push; then gh pr create; fi"],
    ["a quoted -c argument", 'bash -c "gh pr create --fill"'],
    ["a wrapper command", "sudo gh pr create"],
    ["another wrapper", "time gh pr create --fill"],
    ["an xargs pipeline", "echo x | xargs -I{} gh pr create --title {}"],
    ["a trailing backslash continuation", "git push \\\n  && gh pr create"],
  ])("blocks %s on a stale branch", (_name, command) => {
    expect(decideHook(command, false).block).toBe(true);
  });

  it("still ignores commands that only look similar", () => {
    for (const command of [
      "gh pr createx",
      "gh pr list",
      "ghost pr create",
      "git push && gh pr view",
    ]) {
      expect(decideHook(command, false), command).toEqual({ block: false });
    }
  });
});

// Added with the port: the remote is the project's, never a literal, so the remedy names
// the configured remote and branch (design section 8.2, `forge.remote`).
describe("the remedy names the project's remote", () => {
  it("names the configured remote and integration branch", () => {
    const d = decideHook("gh pr create", false, { remote: "upstream", integration: "trunk" });
    expect(d.reason).toContain("git fetch upstream trunk && git rebase upstream/trunk");
    expect(d.reason).not.toContain("origin");
  });

  it("names placeholders, not a remote of its own, when it is not told one", () => {
    const d = decideHook("gh pr create", false);
    expect(d.reason).toContain("<remote>/<integration>");
    expect(d.reason).not.toContain("origin");
  });
});

describe("isPrCreate", () => {
  it("is the one test the hook and its decision share", () => {
    expect(isPrCreate("  cd x && gh pr create")).toBe(true);
    expect(isPrCreate("gh pr list")).toBe(false);
  });
});

/** Answers by command prefix and records every call with its working directory. */
function fake(answers: Record<string, number> = {}) {
  const calls: string[] = [];
  const exec: Exec = (cmd, args, opts) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(opts?.cwd ? `${line} @${opts.cwd}` : line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    return { status: key === undefined ? 0 : (answers[key] ?? 0), stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const cfg = {
  forge: { remote: "upstream" },
  branches: { integration: "trunk", production: "main" },
};

describe("fetchBase and checkRebased", () => {
  it("fetches the configured remote and tests HEAD against it", () => {
    const f = fake();
    expect(checkRebased(cfg, f.exec)).toEqual({ rebased: true, base: "upstream/trunk" });
    expect(f.calls).toEqual([
      "git fetch upstream trunk --quiet",
      "git merge-base --is-ancestor upstream/trunk HEAD",
    ]);
  });

  it("reports a stale branch as not rebased", () => {
    const f = fake({ "git merge-base": 1 });
    expect(checkRebased(cfg, f.exec).rebased).toBe(false);
  });

  it("throws when the fetch fails, because an unverifiable branch is not a current one", () => {
    const f = fake({ "git fetch": 128 });
    expect(() => checkRebased(cfg, f.exec)).toThrow(/Cannot tell whether/);
    expect(f.calls).toEqual(["git fetch upstream trunk --quiet"]);
    expect(() => fetchBase({ remote: "upstream", integration: "trunk" }, f.exec)).toThrow(
      /git fetch upstream trunk failed \(exit 128\)/,
    );
  });
});

/**
 * The hook's every unproven path blocks (exit 2), because a PreToolUse hook blocks on
 * exit 2 and only on exit 2: a gate whose failure mode is "permit" is not a gate.
 */
describe("hookDecision", () => {
  const payload = (command: unknown) => JSON.stringify({ tool_input: { command } });
  const deps = (f: ReturnType<typeof fake>) => ({
    projectRoot: ".",
    exec: f.exec,
    loadConfig: () => cfg,
  });

  it("lets a command that is not gh pr create through without a fetch", () => {
    const f = fake();
    expect(hookDecision(payload("git status"), deps(f))).toEqual({ block: false });
    expect(f.calls).toEqual([]);
  });

  it("blocks gh pr create on a stale branch and names the remedy", () => {
    const f = fake({ "git merge-base": 1 });
    const d = hookDecision(payload("gh pr create --fill"), deps(f));
    expect(d.block).toBe(true);
    expect(d.reason).toContain("git rebase upstream/trunk");
  });

  it("allows gh pr create on a rebased branch", () => {
    expect(hookDecision(payload("gh pr create"), deps(fake()))).toEqual({ block: false });
  });

  it("blocks a payload it matched but cannot read", () => {
    for (const bad of ["not json", JSON.stringify({ foo: 1 }), payload(42), payload(undefined)]) {
      const d = hookDecision(bad, deps(fake()));
      expect(d.block, bad).toBe(true);
    }
  });

  it("blocks when the check itself cannot run", () => {
    const failedFetch = hookDecision(payload("gh pr create"), deps(fake({ "git fetch": 1 })));
    expect(failedFetch.block).toBe(true);
    expect(failedFetch.reason).toMatch(/could not run/);
    const noConfig = hookDecision(payload("gh pr create"), {
      projectRoot: ".",
      exec: fake().exec,
      loadConfig: () => {
        throw new Error("config.json: invalid JSON");
      },
    });
    expect(noConfig.block).toBe(true);
    expect(noConfig.reason).toContain("invalid JSON");
  });

  it("reads a payload that starts with a byte order mark", () => {
    const d = hookDecision("\uFEFF" + payload("git status"), deps(fake()));
    expect(d).toEqual({ block: false });
  });
});
