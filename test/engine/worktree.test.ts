import { afterAll, describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createWorktree,
  namesFor,
  parseCreateArgs,
  parseWorktrees,
  removeWorktree,
  slugify,
} from "../../src/engine/worktree.js";
import { notIssueBranch } from "../../src/engine/branch-names.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { git, realExec, type Exec } from "../../src/forge/github.js";
import { samePath, toPosix } from "../../src/platform/paths.js";
import { childEnv } from "../helpers/child-env.js";

const cfg = {
  branches: { integration: "develop", production: "main" },
  forge: { remote: "origin" },
  branchPrefix: "agent/",
  worktrees: { root: ".autoclaude/worktrees", copy: [".env.local"] },
} as unknown as ProjectConfig;

function withRoot(root: string, copy: string[] = cfg.worktrees.copy): ProjectConfig {
  return { ...cfg, worktrees: { root, copy } } as ProjectConfig;
}

describe("slugify", () => {
  it("transliterates umlauts and ß, lowercases, hyphenates, and cuts at 40 without a trailing dash", () => {
    expect(
      slugify("Generated document file names drop umlauts (Ä to A) and break ß into a hyphen"),
    ).toBe("generated-document-file-names-drop-umlau");
    expect(slugify("Ärger mit Größe")).toBe("aerger-mit-groesse");
    expect(slugify("widgetSync never reads the Widget's body — step 1 of 3")).toBe(
      "widgetsync-never-reads-the-widget-s-body",
    );
    expect(slugify("---")).toBe("issue");
  });

  it("only ever yields lowercase ASCII letters, digits and single hyphens", () => {
    const slug = slugify("Fix login & logout --replace $(rm -rf ~) `id` ; | > \n\t\u0000");
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

// Changed from the source test on purpose: the worktree directory now sits under the
// configured `worktrees.root` (design § 8.2, port notes: worktree root from config) and
// the result is absolute.
describe("namesFor", () => {
  it("puts the issue number first so the mapping survives without the ledger", () => {
    const names = namesFor(126, "Umlauts in file names", cfg, "/proj");
    expect(names.branch).toBe("agent/126-umlauts-in-file-names");
    expect(toPosix(names.worktree)).toMatch(
      /\/proj\/\.autoclaude\/worktrees\/agent\+126-umlauts-in-file-names$/,
    );
  });

  it("uses an absolute worktree root as it is and a relative one against the project root", () => {
    const abs = join(tmpdir(), "elsewhere root");
    expect(toPosix(namesFor(3, "x", withRoot(abs), "/proj").worktree)).toBe(
      toPosix(join(abs, "agent+3-x")),
    );
    expect(toPosix(namesFor(3, "x", withRoot("wt"), "/proj").worktree)).toMatch(
      /\/proj\/wt\/agent\+3-x$/,
    );
  });
});

describe("parseWorktrees", () => {
  it("reads the porcelain list git prints on Windows and elsewhere", () => {
    const porcelain =
      "worktree C:/work/app\nHEAD abc\nbranch refs/heads/develop\n\nworktree C:/work/app/.autoclaude/worktrees/agent+56-widget\nHEAD def\nbranch refs/heads/agent/56-widget\n\nworktree /tmp/detached\nHEAD 123\ndetached\n";
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "C:/work/app", branch: "develop" },
      { path: "C:/work/app/.autoclaude/worktrees/agent+56-widget", branch: "agent/56-widget" },
      { path: "/tmp/detached", branch: null },
    ]);
  });
});

describe("create and remove, against a real temporary repository", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  function sh(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: childEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A work repository with a bare remote called origin; identity is local, CI has none. */
  function repo(prefix: string): { tmp: string; origin: string; root: string } {
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(tmp);
    const origin = join(tmp, "origin.git");
    const root = join(tmp, "work");
    sh(tmp, "init", "--bare", "-b", "develop", origin);
    sh(tmp, "init", "-b", "develop", root);
    sh(root, "config", "user.email", "t@example.test");
    sh(root, "config", "user.name", "t");
    sh(root, "config", "core.autocrlf", "false");
    sh(root, "commit", "--allow-empty", "-m", "init");
    sh(root, "remote", "add", "origin", origin);
    sh(root, "push", "-u", "origin", "develop");
    return { tmp, origin, root };
  }

  function make(
    root: string,
    issue: number,
    title: string,
    extra: { replace?: boolean; pushedSha?: string; cfg?: ProjectConfig } = {},
  ) {
    return createWorktree(
      issue,
      title,
      { replace: extra.replace ?? false, pushedSha: extra.pushedSha, root },
      extra.cfg ?? cfg,
      realExec,
    );
  }

  const wtDir = (root: string, name: string) => join(root, ".autoclaude", "worktrees", name);

  it("cuts the branch from origin/<integration>, copies the configured files, and removes cleanly", () => {
    const { root } = repo("autoclaude-wt-");
    writeFileSync(join(root, ".env.local"), "SECRET=1\n");

    const made = make(root, 7, "A title");
    expect(made.branch).toBe("agent/7-a-title");
    expect(made.copied).toEqual([".env.local"]);
    expect(made.missing).toEqual([]);
    expect(existsSync(join(wtDir(root, "agent+7-a-title"), ".env.local"))).toBe(true);
    expect(
      existsSync(join(wtDir(root, "agent+7-a-title"), ".autoclaude", "state", "reports")),
    ).toBe(true);
    expect(sh(root, "branch", "--list", "agent/7-a-title")).toContain("agent/7-a-title");

    removeWorktree(root, 7, cfg, { deleteRemote: false });
    expect(existsSync(wtDir(root, "agent+7-a-title"))).toBe(false);
    expect(sh(root, "branch", "--list", "agent/7-a-title")).toBe("");

    // A branch left behind without its worktree is named in the error, and --replace
    // discards it the way it would discard the worktree.
    sh(root, "branch", "agent/7-a-title", "origin/develop");
    expect(() => make(root, 7, "A title")).toThrow(/already exists without a worktree/);
    const again = make(root, 7, "A title", { replace: true });
    expect(again.branch).toBe("agent/7-a-title");
    removeWorktree(root, 7, cfg, { deleteRemote: false });
    // A dozen git processes on Windows: well over the 5 s default under load.
  }, 60_000);

  it("skips a configured copy file that does not exist and reports it, instead of failing", () => {
    const { root } = repo("autoclaude-wt-copy-");
    mkdirSync(join(root, "conf"));
    writeFileSync(join(root, "conf", "local.json"), "{}\n");
    const made = make(root, 4, "Copy list", {
      cfg: withRoot(".autoclaude/worktrees", ["conf/local.json", "absent.env"]),
    });
    expect(made.copied).toEqual(["conf/local.json"]);
    expect(made.missing).toEqual([
      { entry: "absent.env", reason: "the project root has no such file" },
    ]);
    expect(existsSync(join(wtDir(root, "agent+4-copy-list"), "conf", "local.json"))).toBe(true);
    removeWorktree(root, 4, cfg, { deleteRemote: false });
  }, 60_000);

  // F1: `cpSync` of a directory killed the process on Windows with Node 24 (0xC0000409) when
  // the source path held a non-ASCII character, and copied nothing when only the destination
  // did. This runs on every CI OS, Windows included, with both paths non-ASCII.
  it("copies a directory entry under a non-ASCII project root into a non-ASCII worktree root", () => {
    const { root } = repo("autoclaude-wt-Jürgen-");
    mkdirSync(join(root, "conf", "nested"), { recursive: true });
    writeFileSync(join(root, "conf", "a.json"), "{}\n");
    writeFileSync(join(root, "conf", "nested", "b.txt"), "b\n");
    const local = withRoot("wt Müller", ["conf"]);
    const made = make(root, 6, "Directory copy", { cfg: local });
    const into = join(root, "wt Müller", "agent+6-directory-copy");
    expect(made.copied).toEqual(["conf"]);
    expect(made.missing).toEqual([]);
    expect(readFileSync(join(into, "conf", "a.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(into, "conf", "nested", "b.txt"), "utf8")).toBe("b\n");
    removeWorktree(root, 6, local, { deleteRemote: false });
  }, 60_000);

  // F1 / C4: a link is never followed. One to outside the project would carry that file in.
  it("skips a symbolic link, as an entry and inside a directory entry, and says why", (t) => {
    const { tmp, root } = repo("autoclaude-wt-link-");
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "s\n");
    mkdirSync(join(root, "conf"));
    writeFileSync(join(root, "conf", "a.json"), "{}\n");
    // A junction on Windows: it needs no privilege there, and lstat reports it as a link.
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(outside, join(root, "linked"), type);
      symlinkSync(outside, join(root, "conf", "inner"), type);
    } catch {
      t.skip();
    }
    const local = withRoot(".autoclaude/worktrees", ["linked", "conf"]);
    const made = make(root, 3, "Links", { cfg: local });
    expect(made.copied).toEqual(["conf"]);
    expect(made.missing).toEqual([
      { entry: "linked", reason: "linked is a symbolic link, and links are not followed" },
      { entry: "conf", reason: "conf/inner is a symbolic link, and links are not followed" },
    ]);
    const into = wtDir(root, "agent+3-links");
    expect(existsSync(join(into, "linked"))).toBe(false);
    expect(existsSync(join(into, "conf", "inner"))).toBe(false);
    expect(existsSync(join(into, "conf", "a.json"))).toBe(true);
    removeWorktree(root, 3, local, { deleteRemote: false });
  }, 60_000);

  // F1: a copy that fails is a failed creation, undone like a failed `worktree add`.
  it("fails the creation when a copy fails, and leaves no worktree or branch behind", () => {
    const { root } = repo("autoclaude-wt-copyfail-");
    // The integration branch has a file `conf`; the main checkout has a directory there now,
    // so copying it into the fresh worktree meets the checked-out file.
    writeFileSync(join(root, "conf"), "a file\n");
    sh(root, "add", "conf");
    sh(root, "commit", "-m", "conf file");
    sh(root, "push", "origin", "develop");
    rmSync(join(root, "conf"));
    mkdirSync(join(root, "conf"));
    writeFileSync(join(root, "conf", "a.json"), "{}\n");
    const local = withRoot(".autoclaude/worktrees", ["conf"]);
    expect(() => make(root, 2, "Copy fails", { cfg: local })).toThrow(
      /worktrees\.copy: copying conf into .* failed/,
    );
    expect(existsSync(wtDir(root, "agent+2-copy-fails"))).toBe(false);
    expect(sh(root, "branch", "--list", "agent/2-copy-fails")).toBe("");
  }, 60_000);

  // New: a root with a space and a non-ASCII character (design § 13, plan Review Focus 1).
  it("creates a worktree under a root with a space and umlaut", () => {
    const { root } = repo("autoclaude-wt-umlaut-");
    const made = make(root, 5, "Space and umlaut", { cfg: withRoot("wt Müller", []) });
    expect(existsSync(join(root, "wt Müller", "agent+5-space-and-umlaut"))).toBe(true);
    expect(samePath(made.worktree, join(root, "wt Müller", "agent+5-space-and-umlaut"))).toBe(true);
    expect(sh(made.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/5-space-and-umlaut");
    removeWorktree(root, 5, withRoot("wt Müller", []), { deleteRemote: false });
    expect(existsSync(join(root, "wt Müller", "agent+5-space-and-umlaut"))).toBe(false);
  }, 60_000);

  it("treats a title containing --replace as text", () => {
    const { root } = repo("autoclaude-wt-title-");
    const r = make(root, 7, "Fix login & logout --replace $(x)");
    expect(r.branch).toMatch(/^agent\/7-fix-login-logout-replace-x/);
    // It did not arm the replacement of anything, and nothing was run from the title.
    expect(existsSync(r.worktree)).toBe(true);
    expect(() => make(root, 7, "Fix login & logout --replace $(x)")).toThrow(
      /already has a worktree/,
    );
    removeWorktree(root, 7, cfg, { deleteRemote: false });
  }, 60_000);

  // Defect 1 (design § 10, defect 1): a recreated worktree used to be cut from the integration branch, so the
  // already pushed commits were missing and the publish lease check failed afterwards.
  it("recreates a pushed issue's worktree on its remote branch", () => {
    const { root } = repo("autoclaude-wt-pushed-");
    const first = make(root, 12, "Pushed work");
    sh(first.worktree, "config", "user.email", "t@example.test");
    sh(first.worktree, "config", "user.name", "t");
    writeFileSync(join(first.worktree, "work.txt"), "work\n");
    sh(first.worktree, "add", "work.txt");
    sh(first.worktree, "commit", "-m", "work");
    const C = sh(first.worktree, "rev-parse", "HEAD");
    sh(first.worktree, "push", "origin", first.branch);
    removeWorktree(root, 12, cfg, { deleteRemote: false });
    expect(existsSync(first.worktree)).toBe(false);
    expect(sh(root, "branch", "--list", first.branch)).toBe("");

    const second = make(root, 12, "Pushed work", { replace: true, pushedSha: C });
    expect(second.branch).toBe(first.branch);
    expect(git(["rev-parse", "HEAD"], realExec, second.worktree).trim()).toBe(C);
    expect(sh(second.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(first.branch);
    expect(second.notes).toEqual([]);
    removeWorktree(root, 12, cfg, { deleteRemote: false });
  }, 60_000);

  it("falls back to the integration branch, and says so, when the pushed branch is not on the remote", () => {
    const { root } = repo("autoclaude-wt-fallback-");
    const develop = sh(root, "rev-parse", "HEAD");
    const r = make(root, 13, "Never pushed", { pushedSha: "a".repeat(40) });
    expect(git(["rev-parse", "HEAD"], realExec, r.worktree).trim()).toBe(develop);
    expect(r.notes.join("\n")).toMatch(/agent\/13-never-pushed.*not on origin/);
    removeWorktree(root, 13, cfg, { deleteRemote: false });
  }, 60_000);

  /**
   * The state a hand rollback leaves behind: the directory is gone, its registration is
   * not. `git worktree prune` drops the registration, and a teardown that returned there
   * left the branch on the remote, where the next attempt pushes the same name and the
   * publish lease refuses a remote head the new worktree never had. The branches come
   * from the issue rather than from the caller, which is the only namespace this deletes in.
   */
  it("deletes the local and the remote branch when the directory was removed by hand", () => {
    const { root } = repo("autoclaude-wt-stale-");
    make(root, 8, "B title");
    sh(root, "push", "origin", "agent/8-b-title");
    expect(sh(root, "ls-remote", "--heads", "origin", "agent/8-b-title")).toContain(
      "agent/8-b-title",
    );
    // By hand, the way a human tidies up a worktree: the registration survives it.
    rmSync(wtDir(root, "agent+8-b-title"), { recursive: true, force: true });

    removeWorktree(root, 8, cfg, { deleteRemote: true });
    expect(sh(root, "branch", "--list", "agent/8-b-title")).toBe("");
    expect(sh(root, "ls-remote", "--heads", "origin", "agent/8-b-title")).toBe("");
    // Idempotent: a second teardown of the same issue finds nothing and says nothing.
    expect(() => removeWorktree(root, 8, cfg, { deleteRemote: true })).not.toThrow();
  }, 60_000);

  /**
   * The remote branch when the local one is already gone. The deletion set must not depend
   * on a local branch still being there: a push that fails after the local delete would
   * otherwise leave a re-run iterating an empty set and the branch on the remote.
   */
  it("deletes a remote branch of the issue whose local counterpart is already gone", () => {
    const { root } = repo("autoclaude-wt-remote-");
    make(root, 9, "C title");
    sh(root, "push", "origin", "agent/9-c-title");
    removeWorktree(root, 9, cfg, { deleteRemote: false });
    expect(sh(root, "branch", "--list", "agent/9-c-title")).toBe("");
    expect(sh(root, "ls-remote", "--heads", "origin", "agent/9-c-title")).toContain(
      "agent/9-c-title",
    );

    removeWorktree(root, 9, cfg, { deleteRemote: true });
    expect(sh(root, "ls-remote", "--heads", "origin", "agent/9-c-title")).toBe("");
    // And once more, against a remote that no longer has it.
    expect(() => removeWorktree(root, 9, cfg, { deleteRemote: true })).not.toThrow();
  }, 60_000);

  /**
   * An unreachable remote must not cost the local half of the teardown. The remote
   * namespace is asked through the throwing `git()` on purpose, but only after the local
   * `branch -D` loop, so a network blip leaves the retry only the remote side to do.
   */
  it("deletes the local branches even when the remote cannot be reached, and says the remote side is not done", () => {
    const { tmp, root } = repo("autoclaude-wt-offline-");
    make(root, 11, "D title");
    // A path that is not a repository fails `ls-remote` locally, with no network.
    sh(root, "remote", "set-url", "origin", join(tmp, "gone.git"));

    expect(() => removeWorktree(root, 11, cfg, { deleteRemote: true })).toThrow(
      /origin could not be asked/,
    );
    expect(existsSync(wtDir(root, "agent+11-d-title"))).toBe(false);
    expect(sh(root, "branch", "--list", "agent/11-*")).toBe("");
  }, 60_000);
});

/**
 * The last clause of `notIssueBranch`, which asks git whether the name is a ref at all.
 * A process that could not be started has no exit code, and must not be reported as
 * git's verdict on the name: the refusal is what an operator then goes and corrects.
 */
describe("notIssueBranch's check-ref-format clause", () => {
  it("says git could not be run when the process never started, rather than blaming the name", () => {
    const exec: Exec = () => ({ status: null, stdout: "", stderr: "Error: spawnSync git ENOENT" });
    const refused = notIssueBranch("agent/9-x", 9, cfg, exec);
    expect(refused, "fail closed: an unchecked name must not pass").not.toBeNull();
    expect(refused).toMatch(/could not be run/);
    expect(refused, "with what went wrong, or there is nothing to act on").toContain("ENOENT");
    expect(refused, "and it must not report this as git's verdict on the name").not.toMatch(
      /git refuses/,
    );
  });

  it("still reports git's own refusal as git's", () => {
    const exec: Exec = () => ({ status: 128, stdout: "", stderr: "" });
    expect(notIssueBranch("agent/9-x", 9, cfg, exec)).toMatch(/git refuses/);
  });

  // The positive control, without which both assertions above would pass on a clause that
  // refuses everything.
  it("passes a branch of the issue that git accepts", () => {
    const exec: Exec = () => ({ status: 0, stdout: "", stderr: "" });
    expect(notIssueBranch("agent/9-x", 9, cfg, exec)).toBeNull();
  });
});

/**
 * The two things `removeWorktree` decides from what git prints, driven with a fake exec
 * because neither state can be staged with a real repository cheaply: a branch checked
 * out in a second worktree needs a human's `git worktree add`, and a directory whose
 * branch was switched by hand needs the switch.
 */
describe("removeWorktree, against what git prints", () => {
  /**
   * A fake git: one porcelain listing, one branch listing, one remote namespace,
   * everything else empty. The branch listing is keyed on the spelling *with* its flags,
   * because those are part of what is under test: a key of `branch --list` alone would
   * answer the call whatever flags it carried.
   */
  function fakeGit(opts: {
    porcelain: string;
    branchList: string;
    remote?: string[];
    remoteName?: string;
  }) {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      if (line.includes("worktree list --porcelain"))
        return { status: 0, stdout: opts.porcelain, stderr: "" };
      if (line.includes("branch --no-color --no-column --list"))
        return { status: 0, stdout: opts.branchList, stderr: "" };
      if (line.includes(`ls-remote --heads ${opts.remoteName ?? "origin"}`))
        return {
          status: 0,
          stdout: (opts.remote ?? []).map((b) => `bbb\trefs/heads/${b}\n`).join(""),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  /** Every `console.error` line one call printed, with the spy always restored. */
  function reportOf(run: () => void): string {
    const said: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      said.push(a.join(" "));
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return said.join("\n");
  }

  /**
   * `git branch --list "agent/9-*"` prints `+ agent/9-x` for a branch checked out in
   * another worktree. Stripping the marker and keeping the name ran `git branch -D` on it,
   * which git refuses; through the throwing wrapper that kills a rollback after the
   * release and a `--replace` create. Left alone and said out loud.
   */
  it("leaves a branch checked out in another worktree alone and reports it", () => {
    const f = fakeGit({
      porcelain: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      branchList: "+ agent/9-x\n  agent/9-y\n",
    });
    const said = reportOf(() => removeWorktree("/root", 9, cfg, { deleteRemote: false }, f.exec));
    expect(f.calls.filter((c) => c.includes("branch -D"))).toEqual([
      "git -c core.quotePath=false branch -D agent/9-y",
    ]);
    expect(said).toContain("agent/9-x");
    expect(said).toMatch(/worktree/);
  });

  /**
   * The remote half of that skip: a branch kept locally keeps its copy on the remote too,
   * or the next publish finds no remote head to lease for a branch still on disk.
   */
  it("keeps the remote copy of a branch it left alone locally, and names both halves", () => {
    const f = fakeGit({
      porcelain: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      branchList: "+ agent/9-x\n  agent/9-y\n",
      remote: ["agent/9-x", "agent/9-y"],
    });
    const said = reportOf(() => removeWorktree("/root", 9, cfg, { deleteRemote: true }, f.exec));
    expect(f.calls.filter((c) => c.includes("branch -D"))).toEqual([
      "git -c core.quotePath=false branch -D agent/9-y",
    ]);
    expect(
      f.calls.filter((c) => c.includes("push origin --delete")),
      "the branch kept locally must keep its remote copy too",
    ).toEqual(["git push origin --delete agent/9-y"]);
    expect(said).toContain("agent/9-x");
    expect(said, "the remote half is reported as well, or it is a silent leftover").toMatch(
      /origin/,
    );
  });

  /**
   * The registration's own branch is subject to the same skip: after `worktree remove
   * --force` it is unmarked in the normal case, but a removal git reported as done while
   * the checkout survived must not end in a `branch -D` git refuses.
   */
  it("applies the same skip to the registration's own branch", () => {
    const f = fakeGit({
      porcelain:
        "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n\nworktree /root/.autoclaude/worktrees/agent+9-x\nHEAD bbb\nbranch refs/heads/agent/9-x\n",
      branchList: "+ agent/9-x\n",
      remote: ["agent/9-x"],
    });
    const said = reportOf(() => removeWorktree("/root", 9, cfg, { deleteRemote: true }, f.exec));
    expect(f.calls.filter((c) => c.includes("branch -D"))).toEqual([]);
    expect(f.calls.filter((c) => c.includes("push origin --delete"))).toEqual([]);
    expect(said).toContain("agent/9-x");
  });

  /**
   * The listing is parsed by hand, so the two ways git decorates it are turned off:
   * `color.branch` and `column.branch` come from the operator's own config and would feed
   * escape sequences or several names per line into the deletion loop.
   */
  it("asks for the namespace with colour and columns turned off", () => {
    const f = fakeGit({
      porcelain: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      branchList: "  agent/9-y\n",
    });
    removeWorktree("/root", 9, cfg, { deleteRemote: false }, f.exec);
    expect(f.calls.filter((c) => /branch\b.*--list/.test(c))).toEqual([
      "git -c core.quotePath=false branch --no-color --no-column --list agent/9-*",
    ]);
  });

  /**
   * The registration guard asks the issue's own prefix, not the configured one: a
   * directory `agent+9-foo` switched by hand to `agent/91-bar` must not be deleted by
   * issue 9's teardown, branch and all.
   */
  it("refuses a registration whose branch belongs to another issue", () => {
    const f = fakeGit({
      porcelain:
        "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n\nworktree /root/.autoclaude/worktrees/agent+9-foo\nHEAD bbb\nbranch refs/heads/agent/91-bar\n",
      branchList: "",
    });
    expect(() => removeWorktree("/root", 9, cfg, { deleteRemote: false }, f.exec)).toThrow(
      /agent\/91-bar/,
    );
    expect(f.calls.filter((c) => /worktree remove|branch -D|push origin --delete/.test(c))).toEqual(
      [],
    );
  });

  it("asks and deletes on the configured remote's name, never the literal origin", () => {
    const f = fakeGit({
      porcelain: "worktree /main\nHEAD aaa\nbranch refs/heads/develop\n",
      branchList: "",
      remote: ["agent/9-z"],
      remoteName: "upstream",
    });
    const upstream = { ...cfg, forge: { remote: "upstream" } } as ProjectConfig;
    removeWorktree("/root", 9, upstream, { deleteRemote: true }, f.exec);
    expect(f.calls).toContain("git -c core.quotePath=false ls-remote --heads upstream agent/9-*");
    expect(f.calls).toContain("git push upstream --delete agent/9-z");
    expect(f.calls.some((c) => /\borigin\b/.test(c))).toBe(false);
  });
});

/**
 * Module boundaries. The ledger imports the branch-name helpers from `branch-names.ts`,
 * so this module must not import the ledger back, and must not carry a second copy of
 * those helpers.
 */
// Changed from the source test on purpose: the branch-name helpers moved to
// `branch-names.ts` and the CLI parsers to `cli/args.ts` (port map, worktree.ts row).
describe("worktree.ts's imports", () => {
  const source = readFileSync("src/engine/worktree.ts", "utf8");

  it("does not import from the ledger, which depends on the same helpers", () => {
    expect(source).not.toMatch(/from "\.\/ledger/);
  });

  it("reuses branch-names.ts instead of spelling the helpers again", () => {
    expect(source).toMatch(/from "\.\/branch-names\.js"/);
    expect(source).not.toMatch(/function (worktreeDirPrefix|branchPrefixFor|notIssueBranch)/);
  });

  it("takes the shared regex escape from review/rules.ts, which imports a leaf only", () => {
    expect(source, "one copy of the character class").not.toMatch(/function escapeRegExp/);
    expect(source).toMatch(/from "\.\/review\/rules\.js"/);
    const rules = readFileSync("src/engine/review/rules.ts", "utf8");
    const imports = (rules.match(/from "\.\/([a-z-]+)\.js"/g) ?? []).sort();
    expect(imports, "rules.ts must keep importing leaves only").toEqual(['from "./invariants.js"']);
  });
});

// The issue title is GitHub-controlled text. Read from the same word list as the options,
// a title containing "--replace" armed the removal of an earlier attempt's worktree and
// branch: the title now follows `--`, verbatim.
describe("parseCreateArgs", () => {
  it("takes the options before -- and the title after it, verbatim", () => {
    expect(parseCreateArgs(["--", "Support", "--replace", "in", "titles"])).toEqual({
      title: "Support --replace in titles",
      replace: false,
    });
    expect(parseCreateArgs(["--replace", "--", "a", "title"])).toEqual({
      title: "a title",
      replace: true,
    });
  });
  it("refuses a call without the separator, an unknown option, or an empty title", () => {
    expect(() => parseCreateArgs(["some", "title"])).toThrow(/follows "--"/);
    expect(() => parseCreateArgs(["--force", "--", "t"])).toThrow(/unknown option/);
    expect(() => parseCreateArgs(["--"])).toThrow(/empty/);
  });
});
