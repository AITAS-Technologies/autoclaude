import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runGates } from "../../src/adapters/gates.js";
import { gatesVerb } from "../../src/cli/gates.js";
import { main } from "../../src/cli/main.js";
import type { Gate, ProjectConfig } from "../../src/config/types.js";

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude gates-")));
  created.push(d);
  return d;
}

function cfgOf(gates: Gate[]): ProjectConfig {
  return {
    forge: { remote: "up" },
    branches: { integration: "main" },
    gates,
  } as unknown as ProjectConfig;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const ARGV = `node -e "console.log(JSON.stringify(process.argv.slice(1)))"`;

describe("runGates", () => {
  it("substitutes {files} with quoted changed files", async () => {
    const dir = tmp();
    const names = ["a b.ts", "it's.ts", "$HOME.ts", 'q"d.ts', "`id`.ts"];
    const [r] = await runGates(cfgOf([{ name: "show", check: `${ARGV} {files}` }]), dir, {
      fix: false,
      files: names,
    });
    expect(r?.status).toBe("pass");
    expect(JSON.parse(r!.output.trim())).toEqual(names);
  });

  it("skips a gate whose when matches nothing", async () => {
    const dir = tmp();
    const res = await runGates(cfgOf([{ name: "db", check: "exit 1", when: ["db/**"] }]), dir, {
      fix: false,
      files: ["src/x.ts"],
    });
    expect(res.map((r) => r.status)).toEqual(["skipped"]);
  });

  it("runs a gate whose when matches a changed file", async () => {
    const dir = tmp();
    const res = await runGates(cfgOf([{ name: "src", check: "echo ran", when: ["src/**"] }]), dir, {
      fix: false,
      files: ["src/x.ts"],
    });
    expect(res[0]?.status).toBe("pass");
    expect(res[0]?.output).toContain("ran");
  });

  it("skips a {files} gate when there are no files, but runs one without {files}", async () => {
    const dir = tmp();
    const res = await runGates(
      cfgOf([
        { name: "fmt", check: `${ARGV} {files}` },
        { name: "types", check: "echo ok" },
      ]),
      dir,
      { fix: false, files: [] },
    );
    expect(res.map((r) => r.status)).toEqual(["skipped", "pass"]);
  });

  it("stops at the first failing gate", async () => {
    const dir = tmp();
    const res = await runGates(
      cfgOf([
        { name: "bad", check: "echo nope; exit 3" },
        { name: "good", check: "echo ok" },
      ]),
      dir,
      { fix: false, files: [] },
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ name: "bad", status: "fail" });
    expect(res[0]?.output).toContain("nope");
    expect(res[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("combines stdout and stderr", async () => {
    const dir = tmp();
    const [r] = await runGates(
      cfgOf([{ name: "both", check: "echo out; echo err 1>&2; exit 1" }]),
      dir,
      { fix: false, files: [] },
    );
    expect(r?.output).toMatch(/out[\s\S]*err/);
  });

  it("runs fix before check with --fix, and not without it", async () => {
    const dir = tmp();
    const gate: Gate = { name: "fmt", fix: "touch marker", check: "test -f marker" };
    const without = await runGates(cfgOf([gate]), dir, { fix: false, files: [] });
    expect(without[0]?.status).toBe("fail");
    expect(existsSync(join(dir, "marker"))).toBe(false);
    const withFix = await runGates(cfgOf([gate]), dir, { fix: true, files: [] });
    expect(withFix[0]?.status).toBe("pass");
  });

  it("runs commands with the worktree as cwd, even when the path has a space", async () => {
    const dir = join(tmp(), "My Projekte Müller");
    mkdirSync(dir);
    const [r] = await runGates(cfgOf([{ name: "w", check: "touch here" }]), dir, {
      fix: false,
      files: [],
    });
    expect(r?.status).toBe("pass");
    expect(existsSync(join(dir, "here"))).toBe(true);
  });

  it("restricts to --only names in config order", async () => {
    const dir = tmp();
    const res = await runGates(
      cfgOf([
        { name: "a", check: "echo a" },
        { name: "b", check: "echo b" },
        { name: "c", check: "echo c" },
      ]),
      dir,
      { fix: false, files: [], only: ["c", "a"] },
    );
    expect(res.map((r) => r.name)).toEqual(["a", "c"]);
  });

  it("takes the changed files from git when none are given", async () => {
    const dir = tmp();
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "core.autocrlf", "false");
    writeFileSync(join(dir, "base.txt"), "b\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base");
    git(dir, "update-ref", "refs/remotes/up/main", "HEAD");
    writeFileSync(join(dir, "new file.ts"), "x\n");
    const [r] = await runGates(cfgOf([{ name: "show", check: `${ARGV} {files}` }]), dir, {
      fix: false,
    });
    expect(JSON.parse(r!.output.trim())).toEqual(["new file.ts"]);
  }, 30_000);
});

describe("autoclaude gates", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it("is registered as a verb and rejects an unknown flag with 64", async () => {
    const t = io();
    expect(await main(["gates", "--bogus"], t.io)).toBe(64);
    expect(t.err.join("")).toMatch(/usage: autoclaude gates/);
  });

  it("rejects --only naming an unknown gate with 64", async () => {
    const dir = tmp();
    const t = io();
    const code = await gatesVerb(["--only", "nope"], t.io, dir, {
      load: () => cfgOf([{ name: "a", check: "echo a" }]),
      root: () => dir,
    });
    expect(code).toBe(64);
    expect(t.err.join("")).toMatch(/unknown gate: nope/);
  });

  it("prints one line per gate and exits 0 when all pass or are skipped", async () => {
    const dir = tmp();
    const t = io();
    const code = await gatesVerb(["--files", "src/x.ts", "docs/a b.md"], t.io, dir, {
      load: () =>
        cfgOf([
          { name: "one", check: `${ARGV} {files}` },
          { name: "two", check: "exit 1", when: ["db/**"] },
        ]),
      root: () => dir,
    });
    expect(code).toBe(0);
    const lines = t.out.join("").split("\n").filter(Boolean);
    expect(lines[0]).toMatch(/^pass one \(\d+ ms\)$/);
    expect(lines.at(-1)).toMatch(/^skipped two \(\d+ ms\)$/);
  });

  it("exits 1 on a failure and prints the failing output after its line", async () => {
    const dir = tmp();
    const t = io();
    const code = await gatesVerb(["--files", "x.ts"], t.io, dir, {
      load: () => cfgOf([{ name: "bad", check: "echo boom; exit 2" }]),
      root: () => dir,
    });
    expect(code).toBe(1);
    expect(t.out.join("")).toMatch(/^fail bad \(\d+ ms\)\nboom/);
  });

  it("limits a failing gate's output to the last 200 lines", async () => {
    const dir = tmp();
    const t = io();
    await gatesVerb(["--files", "x.ts"], t.io, dir, {
      load: () =>
        cfgOf([
          {
            name: "loud",
            check: `node -e "for(let i=1;i<=500;i++)console.log('L'+i)"; exit 1`,
          },
        ]),
      root: () => dir,
    });
    const lines = t.out.join("").split("\n");
    expect(lines).toContain("L500");
    expect(lines).toContain("L301");
    expect(lines).not.toContain("L300");
  });

  it("loads the configuration from the main checkout, not the worktree", async () => {
    const root = tmp();
    const mainDir = join(root, "main");
    git(root, "init", "-b", "main", mainDir);
    git(mainDir, "config", "user.email", "t@t");
    git(mainDir, "config", "user.name", "t");
    git(mainDir, "config", "core.autocrlf", "false");
    writeFileSync(join(mainDir, "base.txt"), "b\n");
    git(mainDir, "add", "-A");
    git(mainDir, "commit", "-m", "base");
    git(mainDir, "update-ref", "refs/remotes/up/develop", "HEAD");
    const wt = join(root, "wt");
    git(mainDir, "worktree", "add", wt, "-b", "work");
    const base = {
      ...JSON.parse(readFileSync("test/fixtures/projects/minimal/.autoclaude/config.json", "utf8")),
      forge: { remote: "up" },
    };
    for (const [dir, name] of [
      [mainDir, "real"],
      [wt, "decoy"],
    ] as const) {
      mkdirSync(join(dir, ".autoclaude"), { recursive: true });
      const cfg = { ...base, gates: [{ name, check: `echo ${name}` }] };
      writeFileSync(join(dir, ".autoclaude", "config.json"), JSON.stringify(cfg));
    }
    const t = io();
    const code = await gatesVerb([], t.io, wt);
    expect(t.err.join("")).toBe("");
    expect(code).toBe(0);
    expect(t.out.join("")).toMatch(/pass real /);
    expect(t.out.join("")).not.toMatch(/decoy/);
  }, 60_000);

  it("--fix runs the fix first", async () => {
    const dir = tmp();
    const t = io();
    const gates = [{ name: "fmt", fix: "touch marker", check: "test -f marker" }];
    const deps = { load: () => cfgOf(gates), root: () => dir };
    expect(await gatesVerb(["--files", "x.ts"], t.io, dir, deps)).toBe(1);
    expect(await gatesVerb(["--fix", "--files", "x.ts"], t.io, dir, deps)).toBe(0);
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("");
  });
});
