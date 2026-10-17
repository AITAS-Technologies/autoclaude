import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { doctorVerb } from "../../src/cli/doctor.js";
import { initVerb } from "../../src/cli/init.js";
import { VERBS, type Verb } from "../../src/cli/main.js";
import { loadProjectConfig } from "../../src/config/load.js";
import type { ProjectConfig } from "../../src/config/types.js";
import { Forge } from "../../src/forge/github.js";
import { capture, cleanupTemps, envFor, routed, tempRepo, type Route } from "../helpers/cli-env.js";

afterAll(cleanupTemps);

/** Every label the configuration names, computed here and not by the code under test. */
function labelsOf(cfg: ProjectConfig): string[] {
  return [
    cfg.queue.ready,
    cfg.labels.working,
    cfg.labels.blocked,
    cfg.labels.needsShaping,
    ...Array.from({ length: cfg.caps.fixRounds }, (_, i) => `${cfg.labels.fixRound}${i + 1}`),
    ...Array.from(
      { length: cfg.caps.reviewRetries },
      (_, i) => `${cfg.labels.reviewRetry}${i + 1}`,
    ),
    ...cfg.humanApproval.map((h) => h.label),
    ...cfg.labelRules.flatMap((r) => [r.label, ...(r.suppressedBy ? [r.suppressedBy] : [])]),
  ];
}

interface Rig {
  root: string;
  calls: string[];
  run(over?: Parameters<typeof rigRun>[1]): Promise<{ code: number; lines: string[]; err: string }>;
}

interface RunOpts {
  scopes?: string;
  authFails?: boolean;
  labels?: (all: string[]) => string[];
  remoteHasBranch?: boolean;
  claude?: string | null;
  gitVersion?: string;
  platform?: NodeJS.Platform;
  bash?: () => string;
  envVars?: NodeJS.ProcessEnv;
  extra?: Route[];
}

async function rigRun(root: string, o: RunOpts = {}, calls: string[] = []) {
  const cfgNow = (() => {
    try {
      return loadProjectConfig(root);
    } catch {
      return null;
    }
  })();
  const all = cfgNow ? labelsOf(cfgNow) : [];
  const routes: Route[] = [
    ...(o.extra ?? []),
    (cmd, args) => {
      if (cmd === "gh" && args[0] === "auth")
        return o.authFails
          ? { status: 1, stderr: "You are not logged into any GitHub hosts." }
          : {
              stdout: `github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token scopes: ${o.scopes ?? "'gist', 'read:org', 'repo'"}\n`,
            };
      if (cmd === "gh" && args.includes("label") && args.includes("list"))
        return {
          stdout: JSON.stringify((o.labels ? o.labels(all) : all).map((name) => ({ name }))),
        };
      if (cmd === "git" && args.includes("ls-remote"))
        return o.remoteHasBranch === false
          ? { stdout: "" }
          : { stdout: "abc123\trefs/heads/develop\n" };
      if (cmd === "claude") {
        if (o.claude === null) return { status: null, stderr: "spawn claude ENOENT" };
        return { stdout: `${o.claude ?? "2.1.301"} (Claude Code)\n` };
      }
      if (cmd === "git" && args[0] === "--version" && o.gitVersion)
        return { stdout: `git version ${o.gitVersion}\n` };
      return undefined;
    },
  ];
  const exec = routed(routes, calls);
  const c = capture();
  const env = envFor(root, {
    exec,
    forge: () => new Forge("acme/widgets", exec),
    env: o.envVars ?? {},
    platform: o.platform ?? process.platform,
    bash: o.bash ?? (() => "/usr/bin/bash"),
  });
  const code = await doctorVerb([], c.io, root, env);
  return {
    code,
    lines: c
      .text()
      .split("\n")
      .filter((l) => l !== ""),
    err: c.errText(),
  };
}

async function healthyRepo(): Promise<string> {
  const root = tempRepo();
  await initVerb([], capture().io, root, envFor(root));
  writeFileSync(join(root, "CLAUDE.md"), "# instructions\n");
  return root;
}

const line = (lines: string[], check: string) => lines.find((l) => l.split(" ")[1] === check);

describe("autoclaude doctor", () => {
  it("is a registered verb", () => {
    expect(VERBS.doctor).toBeTypeOf("function");
  });

  it("reports a healthy project as ok on every line and exits 0", async () => {
    const root = await healthyRepo();
    const r = await rigRun(root);
    expect(r.lines.filter((l) => !/^(ok|warn|fail) \S+ — .+/.test(l))).toEqual([]);
    expect(
      r.lines.filter((l) => l.startsWith("fail")),
      r.lines.join("\n"),
    ).toEqual([]);
    expect(r.code).toBe(0);
    for (const check of [
      "config",
      "git",
      "gh-auth",
      "labels",
      "integration-branch",
      "claude",
      "ignore-state",
      "ignore-worktrees",
      "ignore-local",
      "instructions",
    ])
      expect(line(r.lines, check), `${check}\n${r.lines.join("\n")}`).toMatch(/^ok /);
  });

  it("reports a label missing on GitHub as fail, names it, and exits 1", async () => {
    const root = await healthyRepo();
    const r = await rigRun(root, {
      labels: (all) => all.filter((l) => l !== "agent-ready" && l !== "agent-fix-2"),
    });
    const l = line(r.lines, "labels")!;
    expect(l).toMatch(/^fail labels — /);
    expect(l).toContain("agent-ready");
    expect(l).toContain("agent-fix-2");
    expect(l).not.toContain("agent-blocked");
    // The remedy is an autoclaude command, never a source script.
    expect(l).toContain("autoclaude init --create-labels");
    expect(r.code).toBe(1);
  });

  it("checks the labels of humanApproval and labelRules too", async () => {
    const root = await healthyRepo();
    const path = join(root, ".autoclaude", "config.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.humanApproval = [{ paths: ["db/**"], label: "needs-human-ok" }];
    doc.labelRules = [{ when: ["src/ui/**"], label: "review:ui", suppressedBy: "review:skip-ui" }];
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const r = await rigRun(root, {
      labels: (all) => all.filter((l) => !["needs-human-ok", "review:skip-ui"].includes(l)),
    });
    const l = line(r.lines, "labels")!;
    expect(l).toContain("needs-human-ok");
    expect(l).toContain("review:skip-ui");
    expect(l).not.toContain("review:ui,");
  });

  it("fails when gh is not logged in, and warns when the token can delete repositories", async () => {
    const root = await healthyRepo();
    const out = await rigRun(root, { authFails: true });
    expect(line(out.lines, "gh-auth")).toMatch(/^fail gh-auth — /);
    expect(out.code).toBe(1);
    const scopes = await rigRun(root, { scopes: "'delete_repo', 'repo'" });
    expect(line(scopes.lines, "gh-scopes")).toMatch(/^warn gh-scopes — .*delete_repo/);
    expect(scopes.code).toBe(0);
    const fine = await rigRun(root);
    expect(line(fine.lines, "gh-scopes")).toMatch(/^ok gh-scopes — /);
  });

  it("fails when the integration branch is not on the remote", async () => {
    const root = await healthyRepo();
    const r = await rigRun(root, { remoteHasBranch: false });
    expect(line(r.lines, "integration-branch")).toMatch(/^fail integration-branch — .*main/);
    expect(r.code).toBe(1);
  });

  it("fails without a remote that is a GitHub repository", async () => {
    const root = await healthyRepo();
    const bad = tempRepo({ remote: "https://example.com/not-github" });
    await initVerb([], capture().io, bad, envFor(bad));
    const r = await rigRun(bad);
    expect(line(r.lines, "git")).toMatch(/^fail git — /);
    expect(r.code).toBe(1);
    expect(root).not.toBe(bad);
  });

  it("checks the claude major: ok when tested, warn when not, fail when absent", async () => {
    const root = await healthyRepo();
    expect(line((await rigRun(root, { claude: "2.1.301" })).lines, "claude")).toMatch(
      /^ok claude — .*2\.1\.301/,
    );
    const newer = await rigRun(root, { claude: "3.0.1" });
    expect(line(newer.lines, "claude")).toMatch(/^warn claude — .*3\.0\.1.*untested/i);
    expect(newer.code).toBe(0);
    const none = await rigRun(root, { claude: null });
    expect(line(none.lines, "claude")).toMatch(/^fail claude — /);
    expect(none.code).toBe(1);
  });

  it("warns about --effort max only when a configured stage uses it", async () => {
    const root = await healthyRepo();
    expect(line((await rigRun(root)).lines, "effort-max")).toBeUndefined();
    const path = join(root, ".autoclaude", "config.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.stages.plan.effort = "max";
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const r = await rigRun(root);
    expect(line(r.lines, "effort-max")).toMatch(/^warn effort-max — .*plan.*unverified/i);
    expect(r.code).toBe(0);
  });

  it("warns when ANTHROPIC_API_KEY is set, because stages would bill the API", async () => {
    const root = await healthyRepo();
    expect(line((await rigRun(root)).lines, "api-key")).toBeUndefined();
    const r = await rigRun(root, { envVars: { ANTHROPIC_API_KEY: "sk-test-not-real" } });
    expect(line(r.lines, "api-key")).toMatch(/^warn api-key — .*subscription/i);
    expect(r.lines.join("\n")).not.toContain("sk-test-not-real");
    expect(r.code).toBe(0);
  });

  it("reports git's version and warns below 2.31", async () => {
    const root = await healthyRepo();
    const old = await rigRun(root, { gitVersion: "2.30.2.windows.1" });
    expect(line(old.lines, "git-version")).toMatch(
      /^warn git-version — 2\.30\.2.*GIT_CONFIG_COUNT.*GIT_CONFIG_PARAMETERS/,
    );
    expect(old.code).toBe(0);
    const ok = await rigRun(root, { gitVersion: "2.43.0.windows.1" });
    expect(line(ok.lines, "git-version")).toMatch(/^ok git-version — 2\.43\.0/);
  });

  it("looks for Git Bash on Windows only", async () => {
    const root = await healthyRepo();
    const win = await rigRun(root, {
      platform: "win32",
      bash: () => {
        throw new Error("Git Bash not found.");
      },
    });
    expect(line(win.lines, "git-bash")).toMatch(/^fail git-bash — Git Bash not found/);
    expect(win.code).toBe(1);
    const found = await rigRun(root, {
      platform: "win32",
      bash: () => "C:/Program Files/Git/bin/bash.exe",
    });
    expect(line(found.lines, "git-bash")).toMatch(/^ok git-bash — C:\/Program Files/);
    expect(line((await rigRun(root, { platform: "linux" })).lines, "git-bash")).toBeUndefined();
  });

  it("fails when the state, the worktrees or the local config are not ignored", async () => {
    const root = tempRepo();
    await initVerb([], capture().io, root, envFor(root));
    writeFileSync(join(root, "CLAUDE.md"), "x\n");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const r = await rigRun(root);
    for (const check of ["ignore-state", "ignore-worktrees", "ignore-local"]) {
      expect(line(r.lines, check), check).toMatch(/^fail /);
      expect(line(r.lines, check)).toContain("autoclaude init");
    }
    expect(r.code).toBe(1);
  });

  it("follows a custom worktrees.root when it checks the ignore", async () => {
    const root = tempRepo();
    await initVerb([], capture().io, root, envFor(root));
    writeFileSync(join(root, "CLAUDE.md"), "x\n");
    const path = join(root, ".autoclaude", "config.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.worktrees = { root: ".trees", copy: [] };
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const r = await rigRun(root);
    expect(line(r.lines, "ignore-worktrees")).toMatch(/^fail .*\.trees/);
  });

  it("warns, and does not fail, when the project has neither CLAUDE.md nor AGENTS.md", async () => {
    const root = tempRepo();
    await initVerb([], capture().io, root, envFor(root));
    const r = await rigRun(root);
    expect(line(r.lines, "instructions")).toMatch(/^warn instructions — .*CLAUDE\.md.*AGENTS\.md/);
    expect(r.lines.filter((l) => l.startsWith("fail"))).toEqual([]);
    expect(r.code).toBe(0);
    writeFileSync(join(root, "AGENTS.md"), "x\n");
    expect(line((await rigRun(root)).lines, "instructions")).toMatch(/^ok /);
  });

  it("fails on a config that does not load, names the problem and still runs the rest", async () => {
    const root = await healthyRepo();
    writeFileSync(
      join(root, ".autoclaude", "config.json"),
      '{ "autoclaude": ">=0.1.0", "nonsense": 1 }',
    );
    const r = await rigRun(root);
    expect(line(r.lines, "config")).toMatch(/^fail config — .*nonsense/);
    expect(line(r.lines, "gh-auth")).toMatch(/^ok /);
    expect(r.code).toBe(1);
  });

  it("prints lines in the documented shape only, one per check, and exits 64 on arguments", async () => {
    const root = await healthyRepo();
    const c = capture();
    expect(await doctorVerb(["--now"], c.io, root, envFor(root))).toBe(64);
    expect(c.errText()).toMatch(/usage: autoclaude doctor/);
    const r = await rigRun(root, { gitVersion: "2.30.0", scopes: "'delete_repo'" });
    for (const l of r.lines) expect(l).toMatch(/^(ok|warn|fail) [a-z0-9-]+ — .+$/);
  });

  it("remedies name autoclaude commands only", async () => {
    const root = tempRepo();
    const r = await rigRun(root, { authFails: true, remoteHasBranch: false });
    const text = r.lines.join("\n");
    expect(text).not.toMatch(/npm run|tsx|scripts\/|agent:/);
  });

  it("is a verb of the table", () => {
    const verb: Verb = VERBS.doctor!;
    expect(verb).toBeTypeOf("function");
  });
});
