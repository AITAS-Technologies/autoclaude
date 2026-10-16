import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { changedFiles } from "../../src/adapters/changed-files.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

/** A repo whose "up/main" ref is the first commit; the worktree is the repo itself. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude changed-")));
  created.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  writeFileSync(join(dir, "gone.txt"), "gone\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  git(dir, "update-ref", "refs/remotes/up/main", "HEAD");
  return dir;
}

describe("changedFiles", () => {
  it("lists committed, uncommitted and untracked files once, without the extension filter", () => {
    const dir = repo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "work");
    writeFileSync(join(dir, "keep.txt"), "changed\n"); // uncommitted edit
    writeFileSync(join(dir, "notes.bin"), "x\n"); // untracked, unusual extension
    writeFileSync(join(dir, "Makefile"), "all:\n"); // untracked, no extension at all
    expect(changedFiles(dir, "up/main").sort()).toEqual(
      ["Makefile", "keep.txt", "notes.bin", "src/a.ts"].sort(),
    );
  }, 30_000);

  it("drops deleted files and prints non-ASCII names unquoted", () => {
    const dir = repo();
    rmSync(join(dir, "gone.txt"));
    writeFileSync(join(dir, "grüße.ts"), "x\n");
    git(dir, "add", "grüße.ts");
    expect(changedFiles(dir, "up/main")).toEqual(["grüße.ts"]);
  }, 30_000);

  it("compares against the merge base, not the tip of the base ref", () => {
    const dir = repo();
    git(dir, "checkout", "-b", "side");
    writeFileSync(join(dir, "side.txt"), "s\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "side");
    git(dir, "checkout", "main");
    writeFileSync(join(dir, "other.txt"), "o\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "moved on");
    git(dir, "update-ref", "refs/remotes/up/main", "HEAD");
    git(dir, "checkout", "side");
    expect(changedFiles(dir, "up/main")).toEqual(["side.txt"]);
  }, 30_000);

  it("throws instead of reporting a clean result when the base is unknown", () => {
    const dir = repo();
    expect(() => changedFiles(dir, "up/missing")).toThrow(/merge-base/);
  }, 30_000);

  it("works from a path with a space and a non-ASCII character", () => {
    const dir = repo();
    const sub = join(dir, "My Projekte Müller");
    mkdirSync(sub);
    writeFileSync(join(sub, "x.ts"), "x\n");
    expect(changedFiles(dir, "up/main")).toEqual(["My Projekte Müller/x.ts"]);
  }, 30_000);

  it("returns root-relative paths when called from a subdirectory", () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "keep.txt"), "changed\n");
    writeFileSync(join(dir, "sub", "new.ts"), "n\n");
    expect(changedFiles(join(dir, "sub"), "up/main").sort()).toEqual(["keep.txt", "sub/new.ts"]);
  }, 30_000);
});
