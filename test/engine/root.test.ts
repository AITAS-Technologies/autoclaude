import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../../src/engine/root.js";

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const created: string[] = [];
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

// The orchestrator may run inside a worktree, but the ledger, the config and the agent worktrees belong to the
// main working directory. Every script therefore asks git for the root instead of
// trusting process.cwd().
describe("repoRoot", () => {
  it("returns the main working directory from the main directory and from a worktree", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude root-")));
    created.push(tmp);
    const main = join(tmp, "main");
    sh(tmp, "init", "-b", "develop", main);
    sh(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
    const wt = join(tmp, "wt");
    sh(main, "worktree", "add", wt, "-b", "side");
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const real = (p: string) => realpathSync.native(p);
    expect(norm(real(repoRoot(main)))).toBe(norm(real(main)));
    expect(norm(real(repoRoot(wt)))).toBe(norm(real(main)));
  }, 30_000);

  // A removed cwd or a missing git comes back from spawnSync as `error` with no
  // streams; the message must be this one, not a TypeError.
  it("names the problem when git cannot be asked", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "autoclaude root-")));
    created.push(tmp);
    expect(() => repoRoot(join(tmp, "does-not-exist"))).toThrow(/not inside a git repository/);
    expect(() => repoRoot(tmp)).toThrow(/not inside a git repository/);
  });
});
