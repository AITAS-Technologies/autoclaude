import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VERBS } from "../../src/cli/main.js";
import { initVerb } from "../../src/cli/init.js";
import { loadProjectConfig } from "../../src/config/load.js";
import { parseInvariants } from "../../src/engine/review/invariants.js";
import { Forge } from "../../src/forge/github.js";
import { capture, cleanupTemps, envFor, git, routed, tempRepo } from "../helpers/cli-env.js";

afterAll(cleanupTemps);

const IGNORES = [".autoclaude/state/", ".autoclaude/worktrees/", ".autoclaude/config.local.json"];
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const lines = (path: string) => readFileSync(path, "utf8").split(/\r?\n/);

describe("autoclaude init", () => {
  it("is a registered verb", () => {
    expect(VERBS.init).toBeTypeOf("function");
  });

  it("writes the three templates and the three ignore lines into a fresh repository", async () => {
    const root = tempRepo();
    const c = capture();
    expect(await initVerb([], c.io, root, envFor(root))).toBe(0);
    for (const f of ["config.json", "project.md", "invariants.md"])
      expect(existsSync(join(root, ".autoclaude", f)), f).toBe(true);
    const ignore = lines(join(root, ".gitignore"));
    for (const l of IGNORES)
      expect(
        ignore.filter((x) => x === l),
        l,
      ).toHaveLength(1);
    // Nothing else is ignored by it: the file says what the three lines say.
    expect(ignore.filter((x) => x.trim() !== "")).toEqual(IGNORES);
    // And git agrees that the state, the worktrees and the local file are ignored.
    for (const p of [
      ".autoclaude/state/ledger.json",
      ".autoclaude/worktrees/agent+1-x/a.ts",
      ".autoclaude/config.local.json",
    ])
      expect(() => git(root, "check-ignore", "-q", p), p).not.toThrow();
  });

  it("ships a config that loads, with the criteria angle, and generic project files", async () => {
    const root = tempRepo();
    await initVerb([], capture().io, root, envFor(root));
    const cfg = loadProjectConfig(root);
    // R57: validation requires the criteria angle.
    expect(cfg.codeReview.angles).toContain("criteria");
    expect(cfg.forge.remote).toBe("origin");
    // The invariants template is a valid, empty rule table.
    expect(
      parseInvariants(readFileSync(join(root, ".autoclaude", "invariants.md"), "utf8")),
    ).toEqual([]);
    // The project notes carry the six optional headings as comments, so none applies until written.
    const notes = readFileSync(join(root, ".autoclaude", "project.md"), "utf8");
    for (const h of [
      "Schema changes",
      "Test doubles",
      "High-stakes areas",
      "Localisation",
      "Commit conventions",
      "Bootstrap traps",
    ])
      expect(notes, h).toContain(h);
    expect(notes).not.toMatch(/^## /m);
  });

  it("is idempotent: a second run changes nothing and says so", async () => {
    const root = tempRepo();
    await initVerb([], capture().io, root, envFor(root));
    const before = [
      ".autoclaude/config.json",
      ".autoclaude/project.md",
      ".autoclaude/invariants.md",
      ".gitignore",
    ].map((f) => sha(join(root, f)));
    const c = capture();
    expect(await initVerb([], c.io, root, envFor(root))).toBe(0);
    const after = [
      ".autoclaude/config.json",
      ".autoclaude/project.md",
      ".autoclaude/invariants.md",
      ".gitignore",
    ].map((f) => sha(join(root, f)));
    expect(after).toEqual(before);
    expect(c.text()).toMatch(/kept .*config\.json/);
    expect(lines(join(root, ".gitignore")).filter((l) => l === ".autoclaude/state/")).toHaveLength(
      1,
    );
  });

  it("never overwrites a file the project already has, and keeps its .gitignore", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.autoclaude/state/\n");
    writeFileSync(join(root, "CLAUDE.md"), "# instructions\n");
    await initVerb([], capture().io, root, envFor(root));
    writeFileSync(join(root, ".autoclaude", "project.md"), "# mine\n");
    await initVerb([], capture().io, root, envFor(root));
    expect(readFileSync(join(root, ".autoclaude", "project.md"), "utf8")).toBe("# mine\n");
    const ignore = lines(join(root, ".gitignore"));
    expect(ignore[0]).toBe("node_modules/");
    expect(ignore.filter((l) => l === ".autoclaude/state/")).toHaveLength(1);
    expect(ignore).toContain(".autoclaude/worktrees/");
    expect(ignore).toContain(".autoclaude/config.local.json");
  });

  it("keeps CRLF line endings of an existing .gitignore", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".gitignore"), "node_modules/\r\n");
    await initVerb([], capture().io, root, envFor(root));
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    expect(text).toBe(`node_modules/\r\n${IGNORES.join("\r\n")}\r\n`);
  });

  it("creates no label without --create-labels, and never calls gh", async () => {
    const root = tempRepo();
    const calls: string[] = [];
    const exec = routed(
      [(cmd) => (cmd === "gh" ? { status: 1, stderr: "gh must not run" } : undefined)],
      calls,
    );
    expect(await initVerb([], capture().io, root, envFor(root, { exec }))).toBe(0);
    expect(calls.some((c) => c.startsWith("gh "))).toBe(false);
  });

  it("--create-labels creates only the missing labels, through the Forge, with -R", async () => {
    const root = tempRepo();
    const calls: string[] = [];
    const exec = routed(
      [
        (cmd, args) => {
          if (cmd !== "gh") return undefined;
          const a = args.join(" ");
          if (a.includes("label list"))
            return { stdout: JSON.stringify([{ name: "agent-ready" }, { name: "agent-working" }]) };
          return {};
        },
      ],
      calls,
    );
    const c = capture();
    const env = envFor(root, { exec, forge: () => new Forge("acme/widgets", exec) });
    expect(await initVerb(["--create-labels"], c.io, root, env)).toBe(0);
    const created = calls.filter((x) => x.startsWith("gh -R acme/widgets label create "));
    const names = created.map((x) => x.split(" ")[5]);
    expect(names).toContain("agent-blocked");
    expect(names).toContain("needs-shaping");
    expect(names).toContain("agent-fix-1");
    expect(names).toContain("agent-retry-1");
    expect(names).not.toContain("agent-ready");
    expect(names).not.toContain("agent-working");
    // The listing is made once, with -R.
    expect(calls.filter((x) => x.includes("label list"))).toHaveLength(1);
    expect(calls.every((x) => !x.startsWith("gh ") || x.startsWith("gh -R acme/widgets "))).toBe(
      true,
    );
    expect(c.text()).toMatch(/created label agent-blocked/);
  });

  it("--create-labels run twice creates nothing the second time", async () => {
    const root = tempRepo();
    const have = new Set<string>(["agent-ready"]);
    const calls: string[] = [];
    const exec = routed(
      [
        (cmd, args) => {
          if (cmd !== "gh") return undefined;
          if (args.includes("list"))
            return { stdout: JSON.stringify([...have].map((name) => ({ name }))) };
          if (args.includes("create")) have.add(args[args.indexOf("create") + 1]!);
          return {};
        },
      ],
      calls,
    );
    const env = envFor(root, { exec });
    await initVerb(["--create-labels"], capture().io, root, env);
    const first = calls.filter((x) => x.includes("label create")).length;
    expect(first).toBeGreaterThan(0);
    await initVerb(["--create-labels"], capture().io, root, env);
    expect(calls.filter((x) => x.includes("label create")).length).toBe(first);
  });

  it("exits 1 when --create-labels cannot reach GitHub, after writing the files", async () => {
    const root = tempRepo();
    const exec = routed([
      (cmd) => (cmd === "gh" ? { status: 1, stderr: "not logged in" } : undefined),
    ]);
    const c = capture();
    expect(await initVerb(["--create-labels"], c.io, root, envFor(root, { exec }))).toBe(1);
    expect(existsSync(join(root, ".autoclaude", "config.json"))).toBe(true);
    expect(c.errText()).toMatch(/not logged in/);
  });

  it("exits 64 on an unknown argument and 1 outside a repository", async () => {
    const root = tempRepo();
    const c = capture();
    expect(await initVerb(["--frobnicate"], c.io, root, envFor(root))).toBe(64);
    expect(c.errText()).toMatch(/usage: autoclaude init/);
    const bad = capture();
    const env = envFor(root, {
      root: () => {
        throw new Error("not inside a git repository (/x)");
      },
    });
    expect(await initVerb([], bad.io, root, env)).toBe(1);
    expect(bad.errText()).toMatch(/not inside a git repository/);
  });
});
