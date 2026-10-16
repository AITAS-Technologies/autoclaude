import { describe, it, expect } from "vitest";
import { claudeHook } from "../../../src/engine/guard/hook-claude.js";
import type { GuardConfig } from "../../../src/engine/guard/core.js";

const cfg: GuardConfig = {
  forbiddenPaths: ["tools/engine/**", ".autoclaude/config.json", ".github/workflows/**"],
  fenceAllow: [],
  worktree: "/work/tree",
  platform: "linux",
};

/** The payload Claude Code's PreToolUse hook receives for a Bash call. */
const payload = (command: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "a command" },
    ...extra,
  });

const hook = (command: string, c: GuardConfig = cfg) => claudeHook(payload(command), c);

/**
 * A PreToolUse hook blocks on exit 2 and only on exit 2, so every path that is not a proven
 * allow must end there. The process around this function — reading stdin, exiting with its
 * code — is the `autoclaude guard` verb's.
 */
describe("claudeHook", () => {
  // The refusal is a config-derived one on purpose: a refusal answered from a hard-coded
  // list would pin the wiring but not that the hook hands the decision the config it was
  // given. The source used a push to a protected branch; a stage pushes nothing now
  // (design C5), so a forbidden path from the config takes its place.
  it("exits 2 and says why, for a command the decision refuses from the config", () => {
    const r = hook("git rm tools/engine/x.ts");
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/forbidden path/);
    expect(hook("git rm tools/engine/x.ts", { ...cfg, forbiddenPaths: [] }).exit).toBe(0);
  });

  // Changed from the source, whose half config lacked branch names and labels: the guard's
  // config is now `GuardConfig` (forbidden paths, fence prefixes, worktree), the "project
  // config" of design § 7.5's guard, so the half config lacks one of those instead.
  it("refuses git when the config is an object but not a config", () => {
    const half = { fenceAllow: [] } as unknown as GuardConfig;
    const r = hook("git push origin trunk", half);
    expect(r.exit, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/missing forbiddenPaths/);
    expect(hook("gh issue view 1", half).exit).toBe(2);
    // And a command that needs no config still runs.
    expect(hook("npm test", half).exit).toBe(0);
  });

  it("exits 0 and says nothing, for a command the decision allows", () => {
    expect(hook("git status --short")).toEqual({ exit: 0, stderr: "" });
    expect(hook("autoclaude note 7 'tests red a.test.ts'")).toEqual({ exit: 0, stderr: "" });
  });

  it("names itself and the reason on one line, which Claude shows the model", () => {
    const r = hook("gh issue view 3");
    expect(r.stderr).toMatch(/^autoclaude guard: .*engine prefetches/);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  // The source's hook was a file that loaded its decision module at run time, and a copy
  // without that module ended in exit 1, which a hook reads as "allow". Here the decision is
  // a function call; what can still go wrong is the call itself throwing.
  it("exits 2 when the decision itself throws", () => {
    const hostile = new Proxy({} as GuardConfig, {
      get() {
        throw new Error("config exploded");
      },
    });
    const r = hook("git status", hostile);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/the guard itself failed \(config exploded\)/);
  });

  it("exits 2 even when the thrown value cannot be printed", () => {
    const unprintable = {
      toString() {
        throw new Error("no");
      },
    };
    const hostile = new Proxy({} as GuardConfig, {
      get() {
        throw unprintable;
      },
    });
    expect(hook("git status", hostile).exit).toBe(2);
  });
});

describe("claudeHook fails closed", () => {
  it("fails closed on input it cannot read", () => {
    expect(claudeHook("not json", cfg).exit).toBe(2);
  });

  it.each([
    ["an empty stdin", ""],
    ["a truncated payload", payload("git status").slice(0, 40)],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON number", "42"],
    ["a JSON string", '"git status"'],
  ])("blocks %s", (_what, stdin) => {
    const r = claudeHook(stdin, cfg);
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/^autoclaude guard: /);
  });

  it("blocks when the payload has no command string", () => {
    expect(claudeHook('{"tool_name":"Bash","tool_input":{}}', cfg).exit).toBe(2);
    expect(claudeHook('{"tool_name":"Bash"}', cfg).exit).toBe(2);
    expect(claudeHook('{"tool_name":"Bash","tool_input":null}', cfg).exit).toBe(2);
    expect(claudeHook(payload(42), cfg).exit).toBe(2);
    expect(claudeHook(payload(["git", "status"]), cfg).exit).toBe(2);
    expect(claudeHook(payload(null), cfg).stderr).toMatch(/no command string/);
  });

  it("blocks a stdin that is not a string at all", () => {
    expect(claudeHook(undefined as unknown as string, cfg).exit).toBe(2);
    expect(claudeHook(Buffer.from(payload("git status")) as unknown as string, cfg).exit).toBe(2);
  });

  it("blocks every command when it is handed no config", () => {
    for (const c of ["git push origin agent/1-x", "gh issue view 1", "npm test"])
      expect(hook(c, null as unknown as GuardConfig).exit, c).toBe(2);
  });

  // Changed from the source, which read its config from a file and refused git and gh when
  // it could not, while a command that needs no config still ran. Design § 7.5: the hook is
  // `autoclaude guard --runtime <r>`, which reads the config and fails closed itself; a
  // config with nothing in it is what reaches this function in that case.
  it("blocks git and gh when the config carries nothing, and lets through what needs none", () => {
    const empty = {} as unknown as GuardConfig;
    expect(hook("git push origin agent/1-x", empty).exit).toBe(2);
    expect(hook("gh issue view 1", empty).exit).toBe(2);
    expect(hook("npm test", empty).exit).toBe(0);
    expect(hook("autoclaude note 5 x", empty).exit).toBe(0);
  });

  // Defect 5: the guard reads POSIX shell, and the source's hook decided whatever tool it
  // was attached to. A PowerShell command parsed as POSIX is decided about text the shell
  // that runs it reads differently, so a payload for any other tool is refused, not read.
  it("decides Bash payloads only", () => {
    const ps = claudeHook(payload("git status", { tool_name: "PowerShell" }), cfg);
    expect(ps.exit).toBe(2);
    expect(ps.stderr).toMatch(/Bash/);
    expect(claudeHook(payload("git status", { tool_name: undefined }), cfg).exit).toBe(2);
    expect(claudeHook(payload("git status", { tool_name: "bash" }), cfg).exit).toBe(2);
  });

  // Global constraint: every parser accepts CRLF and a leading UTF-8 BOM.
  it("reads a payload with a leading BOM and CRLF line ends", () => {
    const crlf = JSON.stringify(JSON.parse(payload("git status")), null, 2).replace(/\n/g, "\r\n");
    expect(claudeHook("\uFEFF" + crlf, cfg)).toEqual({ exit: 0, stderr: "" });
    expect(claudeHook("\uFEFF" + payload("gh pr list"), cfg).exit).toBe(2);
  });

  // Claude Code's Bash tool keeps its directory between calls, and the payload says where
  // that is: a relative path is placed from there, not from the worktree's root.
  it("places the command from the payload's cwd", () => {
    const inTools = { cwd: "/work/tree/tools" };
    expect(claudeHook(payload("echo x > engine/x.ts", inTools), cfg).exit).toBe(2);
    expect(claudeHook(payload("echo x > engine/x.ts"), cfg).exit).toBe(0);
    expect(claudeHook(payload("git status", inTools), cfg).exit).toBe(0);
    expect(claudeHook(payload("git status", { cwd: "/elsewhere" }), cfg).exit).toBe(2);
    const bad = claudeHook(payload("npm test", { cwd: 7 }), cfg);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toMatch(/cwd is not a path/);
  });
});
