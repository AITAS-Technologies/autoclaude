import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadProjectConfig } from "../../../src/config/load.js";
import { matchesAny } from "../../../src/config/globs.js";
import type { ProjectConfig } from "../../../src/config/types.js";
import {
  autoclaudeBinCommand,
  claudePathRule,
  claudeSettings,
  hookCommand,
  mcpConfigFor,
} from "../../../src/runtimes/claude/fence.js";

const MINIMAL = resolve(import.meta.dirname, "../../fixtures/projects/minimal");
const BIN = '"/opt/node/bin/node" "/opt/ac/dist/cli/hook-entry.js"';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function config(edit?: (c: ProjectConfig) => void): ProjectConfig {
  const cfg = loadProjectConfig(MINIMAL);
  cfg.forbiddenPaths = [".github/workflows/**", ".autoclaude/config.json"];
  cfg.fence = { allow: ["npx dbtool migration new"] };
  edit?.(cfg);
  return cfg;
}

type Settings = {
  permissions: { defaultMode: string; allow: string[]; deny: string[] };
  hooks: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
  };
};
const settings = (wt: string, cfg = config(), bin = BIN) =>
  claudeSettings(cfg, wt, bin, "linux") as Settings;

describe("claudePathRule", () => {
  it("spells a Windows path MSYS style, lowercase drive, forward slashes", () => {
    expect(claudePathRule("C:\\Users\\Jürgen Müller\\My Projects\\app", "win32")).toBe(
      "//c/Users/Jürgen Müller/My Projects/app",
    );
    expect(claudePathRule("D:/work/a b", "win32")).toBe("//d/work/a b");
    expect(claudePathRule("C:\\work\\", "win32")).toBe("//c/work");
  });
  it("spells a POSIX path as // plus the path without its leading slash", () => {
    expect(claudePathRule("/home/u/x", "linux")).toBe("//home/u/x");
    expect(claudePathRule("/Users/jürgen/My Projects/app/", "darwin")).toBe(
      "//Users/jürgen/My Projects/app",
    );
  });
  it("refuses a path it cannot place absolutely", () => {
    expect(() => claudePathRule("work/tree", "linux")).toThrow(/absolute/);
    expect(() => claudePathRule("work\\tree", "win32")).toThrow(/absolute/);
    expect(() => claudePathRule("\\\\server\\share\\x", "win32")).toThrow(/absolute/);
  });
});

describe("claudeSettings", () => {
  const wt = "/home/u/work tree";

  it("is dontAsk and limits edits and writes to the worktree", () => {
    const s = settings(wt);
    expect(s.permissions.defaultMode).toBe("dontAsk");
    for (const a of [
      "Read",
      "Grep",
      "Glob",
      "Edit(//home/u/work tree/**)",
      "Write(//home/u/work tree/**)",
    ])
      expect(s.permissions.allow).toContain(a);
    expect(s.permissions.allow).not.toContain("Edit");
    expect(s.permissions.allow).not.toContain("Write");
  });

  it("readOnly: no Edit or Write allow rule, both denied, no tree-changing git or engine verb", () => {
    const s = claudeSettings(config(), wt, BIN, "linux", { readOnly: true }) as Settings;
    const { allow, deny } = s.permissions;
    expect(allow.filter((a) => /^(Edit|Write)\b/.test(a))).toEqual([]);
    expect(deny).toEqual(expect.arrayContaining(["Edit", "Write"]));
    for (const verb of ["git commit", "git add", "git checkout", "git rebase", "autoclaude gates"])
      expect(allow.some((a) => a.startsWith(`Bash(${verb}`))).toBe(false);
    expect(allow).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Bash(git status)"]));
    expect(s.hooks.PreToolUse[0]!.matcher).toBe("Bash");
    // The default is unchanged.
    expect(settings(wt).permissions.allow).toContain("Bash(git commit)");
  });

  it("readOnly: drops the project's fence.allow prefixes", () => {
    const s = claudeSettings(config(), wt, BIN, "linux", { readOnly: true }) as Settings;
    expect(s.permissions.allow.some((a) => a.includes("dbtool"))).toBe(false);
    expect(settings(wt).permissions.allow.some((a) => a.includes("dbtool"))).toBe(true);
  });

  it("keeps state/reports and state/plans writable under forbiddenPaths .autoclaude/**", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoclaude-fence-"));
    tmpDirs.push(dir);
    for (const d of [".autoclaude/state/reports", ".autoclaude/state/runs", ".autoclaude/extra"])
      mkdirSync(join(dir, d), { recursive: true });
    const cfg = config((c) => {
      c.forbiddenPaths = [".autoclaude/**"];
    });
    const s = claudeSettings(cfg, dir, BIN) as Settings;
    const rule = claudePathRule(dir);
    const denied = (rel: string, tool: string): boolean =>
      s.permissions.deny
        .filter((d) => d.startsWith(`${tool}(${rule}/`))
        .map((d) => d.slice(`${tool}(${rule}/`.length, -1))
        .some((glob) => matchesAny(rel, [glob]));
    for (const tool of ["Edit", "Write"]) {
      expect(denied(".autoclaude/state/reports/plan.md", tool)).toBe(false);
      expect(denied(".autoclaude/state/plans/7.md", tool)).toBe(false);
      expect(denied(".autoclaude/config.json", tool)).toBe(true);
      expect(denied(".autoclaude/state/ledger.json", tool)).toBe(true);
      expect(denied(".autoclaude/state/runs/7/x.json", tool)).toBe(true);
      expect(denied(".autoclaude/extra/y.md", tool)).toBe(true);
    }
    // Other forbidden globs are unchanged.
    expect(
      settings(
        wt,
        config((c) => (c.forbiddenPaths = [".github/**"])),
      ).permissions.deny,
    ).toContain("Edit(//home/u/work tree/.github/**)");
  });

  it("uses the Phase 0 spelling for a Windows worktree", () => {
    const s = claudeSettings(
      config(),
      "C:\\Users\\Jürgen Müller\\My Projects\\app",
      BIN,
      "win32",
    ) as Settings;
    expect(s.permissions.allow).toContain("Edit(//c/Users/Jürgen Müller/My Projects/app/**)");
    expect(s.permissions.deny).toContain(
      "Edit(//c/Users/Jürgen Müller/My Projects/app/.github/workflows/**)",
    );
  });

  it("allows the local git verbs, the engine's own verbs and the shell verbs", () => {
    const a = settings(wt).permissions.allow;
    for (const r of [
      "Bash(git status *)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git blame *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git rebase *)",
      "Bash(git checkout *)",
      "Bash(git switch *)",
      "Bash(git restore *)",
      "Bash(git rev-parse *)",
      "Bash(git ls-files *)",
      "Bash(git merge-base *)",
      "Bash(git worktree list *)",
      "Bash(git branch --show-current)",
      "Bash(git stash list *)",
      "Bash(autoclaude note *)",
      "Bash(autoclaude gates *)",
      "Bash(ls *)",
      "Bash(pwd)",
      "Bash(wc *)",
      "Bash(echo *)",
    ])
      expect(a, r).toContain(r);
    for (const r of ["Bash(git push *)", "Bash(git fetch *)", "Bash(git merge *)", "Bash(gh *)"])
      expect(a, r).not.toContain(r);
  });

  it("allows none of cd, find, sort and uniq (R42)", () => {
    const a = settings(wt).permissions.allow;
    for (const v of ["cd", "find", "sort", "uniq"])
      expect(
        a.filter((r) => r.startsWith(`Bash(${v}`)),
        v,
      ).toEqual([]);
  });

  it.each(["proj*", "a?b", "d[1]", "Jürgen (old)", "x{a,b}"])(
    "refuses a worktree path with rule syntax: %s",
    (dir) => {
      expect(() => settings(`/home/u/${dir}/wt`)).toThrow(/permission-rule syntax/);
    },
  );

  it("hardens: no writes under .claude, more secret directories, literal forbidden paths", () => {
    const d = settings(
      wt,
      config((c) => (c.forbiddenPaths = ["infra", "ci/*.yml"])),
    ).permissions.deny;
    for (const r of [
      "Edit(//home/u/work tree/.claude/**)",
      "Write(//home/u/work tree/.claude/**)",
      "Read(~/.aws/**)",
      "Edit(~/.config/gh/**)",
      "Write(~/.gnupg/**)",
      "Read(~/.config/gcloud/**)",
      "Read(~/.kube/**)",
      "Read(~/.azure/**)",
      "Read(~/.docker/**)",
      "Edit(//home/u/work tree/infra)",
      "Edit(//home/u/work tree/infra/**)",
      "Edit(//home/u/work tree/ci/*.yml)",
    ])
      expect(d, r).toContain(r);
    expect(d).not.toContain("Edit(//home/u/work tree/ci/*.yml/**)");
  });

  it("gives the hook a timeout above the guard's watchdog", () => {
    expect(settings(wt).hooks.PreToolUse[0]!.hooks[0]).toMatchObject({ timeout: 30 });
  });

  it("adds the project's fence.allow prefixes, exactly, with the space before the star", () => {
    const a = settings(wt).permissions.allow;
    expect(a).toContain("Bash(npx dbtool migration new *)");
    // The rule is a prefix followed by a space: it cannot match `npx dbtool migration newx`.
    expect(a).not.toContain("Bash(npx dbtool migration new*)");
    expect(a).not.toContain("Bash(npx dbtool migration new)");
    const none = settings(
      wt,
      config((c) => (c.fence = { allow: [] })),
    ).permissions.allow;
    expect(none.some((r) => r.includes("dbtool"))).toBe(false);
  });

  it("denies edits to every forbidden path and to .env and credential files", () => {
    const d = settings(wt).permissions.deny;
    for (const r of [
      "Edit(//home/u/work tree/.github/workflows/**)",
      "Edit(//home/u/work tree/.autoclaude/config.json)",
      "Write(//home/u/work tree/.github/workflows/**)",
      "Edit(//**/.env*)",
      "Read(//**/.env*)",
      "Edit(//**/.git-credentials)",
      "Read(//**/.git-credentials)",
    ])
      expect(d, r).toContain(r);
  });

  it("denies the tools and commands that read, fetch or spawn around the fence", () => {
    const d = settings(wt).permissions.deny;
    for (const r of [
      "PowerShell",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
      "Agent",
      "Bash(cat *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(grep *)",
      "Bash(sed *)",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(claude *)",
    ])
      expect(d, r).toContain(r);
    // Denying a verb the allow list grants would make the allow entry dead.
    const allowed = settings(wt).permissions.allow;
    expect(allowed.filter((r) => d.includes(r))).toEqual([]);
  });

  it("hooks Bash only and denies the PowerShell tool", () => {
    const s = settings(wt);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]!.matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0]!.hooks).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.type).toBe("command");
    expect(s.permissions.deny).toContain("PowerShell");
  });

  it("points the hook at the autoclaude binary with quoted paths", () => {
    const cmd = settings("/home/a b/wt").hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(cmd).toBe(`${BIN} guard --runtime claude --worktree "/home/a b/wt" || exit 2`);
  });

  it("never mentions ~/.claude or the user's own settings", () => {
    expect(JSON.stringify(settings(wt))).not.toMatch(/~\/\.claude/);
  });
});

describe("hookCommand", () => {
  it("quotes a worktree with a space and a non-ASCII name, with forward slashes", () => {
    const cmd = hookCommand(BIN, "C:\\Users\\Jürgen Müller\\My Projects\\app", "win32");
    expect(cmd).toBe(
      `${BIN} guard --runtime claude --worktree "C:/Users/Jürgen Müller/My Projects/app" || exit 2`,
    );
  });
  it("escapes what a double-quoted POSIX string would still interpret", () => {
    const cmd = hookCommand(BIN, '/home/u/$(rm -rf ~)/`id`/"q"', "linux");
    expect(cmd).toContain('--worktree "/home/u/\\$(rm -rf ~)/\\`id\\`/\\"q\\""');
  });
  it("ends with || exit 2", () => {
    expect(hookCommand(BIN, "/w", "linux")).toMatch(/ \|\| exit 2$/);
  });
});

describe("autoclaudeBinCommand", () => {
  it("quotes node and the hook entry, with forward slashes", () => {
    expect(
      autoclaudeBinCommand(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\ac dir\\dist\\cli\\hook-entry.js",
        "win32",
      ),
    ).toBe('"C:/Program Files/nodejs/node.exe" "C:/ac dir/dist/cli/hook-entry.js"');
  });
  it("defaults to this process's node and the hook entry beside the CLI", () => {
    const cmd = autoclaudeBinCommand();
    expect(cmd).toContain("hook-entry.js");
    expect(cmd).not.toContain("\\");
  });
});

describe("mcpConfigFor", () => {
  it("returns the project's own file when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-mcp-"));
    tmpDirs.push(root);
    mkdirSync(join(root, ".autoclaude"));
    const own = join(root, ".autoclaude", "mcp.claude.json");
    writeFileSync(own, '{"mcpServers":{"x":{}}}');
    expect(mcpConfigFor(root)).toBe(own);
  });
  it("writes an empty server list under state/ otherwise", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-mcp-"));
    tmpDirs.push(root);
    const p = mcpConfigFor(root);
    expect(p).toBe(join(root, ".autoclaude", "state", "mcp.empty.json"));
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ mcpServers: {} });
    expect(mcpConfigFor(root)).toBe(p);
  });
});
