import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runSync } from "../../src/platform/spawn.js";
import { stageEnv } from "../../src/runtimes/stage-env.js";

const temps: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const WIN = process.platform === "win32";
/** Case-insensitive lookup on win32 (a plain object spread loses Windows' env semantics). */
const get = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) =>
    WIN ? k.toLowerCase() === name.toLowerCase() : k === name,
  );
  return key === undefined ? undefined : env[key];
};

describe("stageEnv", () => {
  it("removes forge tokens and points gh at an empty config", () => {
    const scratch = tmp("ac-stage-");
    const base: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      GH_ENTERPRISE_TOKEN: "t3",
      GITHUB_ENTERPRISE_TOKEN: "t4",
      SSH_AUTH_SOCK: "/tmp/agent",
      GIT_ASKPASS: "a",
      SSH_ASKPASS: "b",
      GIT_SSH: "c",
      GIT_SSH_COMMAND: "d",
      CDPATH: "/x",
      BASH_ENV: "/y",
      ENV: "/z",
      KEEP_ME: "1",
    };
    const env = stageEnv(base, { scratchDir: scratch });
    for (const n of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "CDPATH",
      "BASH_ENV",
      "ENV",
    ]) {
      expect(get(env, n), n).toBeUndefined();
    }
    expect(env.KEEP_ME).toBe("1");
    expect(env.GH_CONFIG_DIR).toBe(join(scratch, "gh"));
    expect(existsSync(join(scratch, "gh"))).toBe(true);
    expect(readdirSync(join(scratch, "gh"))).toEqual([]);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.AUTOCLAUDE_STAGE).toBe("1");
    expect(base.GH_TOKEN).toBe("t1");
  });

  it.skipIf(!WIN)("matches removals case-insensitively on win32", () => {
    const scratch = tmp("ac-stage-");
    const env = stageEnv(
      {
        Gh_Config_Dir: "/real/gh",
        Gh_Token: "x",
        Path: "p",
        Cdpath: "c",
        Claudecode: "1",
        Git_Config_Parameters: "'a.b=c'",
      },
      { scratchDir: scratch },
    );
    expect(env.Path).toBe("p");
    const ghKeys = Object.keys(env).filter((k) => k.toLowerCase() === "gh_config_dir");
    expect(ghKeys).toHaveLength(1);
    expect(env[ghKeys[0]!]).toBe(join(scratch, "gh"));
    expect(get(env, "GH_TOKEN")).toBeUndefined();
    expect(get(env, "CDPATH")).toBeUndefined();
    expect(get(env, "CLAUDECODE")).toBeUndefined();
    expect(
      Object.keys(env).filter((k) => k.toLowerCase() === "git_config_parameters"),
    ).toHaveLength(1);
    expect(get(env, "GIT_CONFIG_PARAMETERS")).toMatch(/^'a\.b=c' 'credential\.helper='/);
  });

  it("removes parent Claude Code session variables but keeps auth and config", () => {
    const env = stageEnv(
      {
        CLAUDECODE: "1",
        CLAUDE_PID: "1",
        CLAUDE_EFFORT: "high",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_EXECPATH: "/x",
        CLAUDE_AGENT_SDK_VERSION: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_MESSAGING_SOCKET: "m",
        CLAUDE_CODE_CHILD_FOO: "c",
        CLAUDE_CODE_OAUTH_TOKEN: "keep",
        CLAUDE_CONFIG_DIR: "keep",
        CLAUDE_CODE_GIT_BASH_PATH: "keep",
        ANTHROPIC_API_KEY: "keep",
      },
      { scratchDir: tmp("ac-stage-") },
    );
    for (const n of [
      "CLAUDECODE",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_CHILD_FOO",
    ]) {
      expect(get(env, n), n).toBeUndefined();
    }
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep");
    expect(env.CLAUDE_CONFIG_DIR).toBe("keep");
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe("keep");
    expect(env.ANTHROPIC_API_KEY).toBe("keep");
  });

  it("keeps pre-existing GIT_CONFIG_* entries and appends after them", () => {
    const env = stageEnv(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Someone",
        GIT_CONFIG_PARAMETERS: "'core.pager=cat'",
      },
      { scratchDir: tmp("ac-stage-") },
    );
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_0).toBe("Someone");
    expect(
      [1, 2, 3].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
    ).toEqual([
      ["credential.helper", ""],
      ["protocol.allow", "never"],
      ["protocol.file.allow", "always"],
    ]);
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      "'core.pager=cat' 'credential.helper=' 'protocol.allow=never' 'protocol.file.allow=always'",
    );
  });

  it("starts the config count at zero without existing entries", () => {
    const env = stageEnv({}, { scratchDir: tmp("ac-stage-") });
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_PARAMETERS).toBe(
      "'credential.helper=' 'protocol.allow=never' 'protocol.file.allow=always'",
    );
  });
});

describe("stageEnv against real git and gh", () => {
  const probe = (url: string, env: NodeJS.ProcessEnv) =>
    runSync("git", ["ls-remote", url], {
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 30_000,
    });

  it.each([
    ["https", "https://127.0.0.1:9/x.git"],
    ["ssh", "ssh://git@127.0.0.1:9/x.git"],
  ])(
    "refuses the %s transport in a stage, while the normal environment only fails to connect",
    (name, url) => {
      const stage = probe(url, stageEnv(process.env, { scratchDir: tmp("ac-stage-") }));
      expect(stage.status).not.toBe(0);
      expect(stage.stderr).toMatch(new RegExp(`transport '${name}' not allowed`));
      // positive control: without the closer git tries to connect (and fails for that reason)
      const control = probe(url, process.env);
      expect(control.status).not.toBe(0);
      expect(control.stderr).not.toMatch(/not allowed/);
    },
  );

  it("resets the credential helper list", () => {
    const scratch = tmp("ac-stage-");
    const r = runSync("git", ["config", "--get-all", "credential.helper"], {
      cwd: scratch,
      env: stageEnv(process.env, { scratchDir: scratch }),
    });
    const lines = r.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    expect(r.status).toBe(0);
    expect(lines.at(-1)).toBe("");
  });

  it("still allows a push to a local file:// bare remote (documented)", () => {
    const dir = tmp("ac-stage-");
    const bare = join(dir, "remote.git");
    const work = join(dir, "work");
    const g = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
      const r = runSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, env },
      );
      expect(r.status, r.stderr).toBe(0);
    };
    g(["init", "--bare", bare], dir);
    g(["init", work], dir);
    writeFileSync(join(work, "f.txt"), "x\n");
    g(["add", "f.txt"], work);
    g(["commit", "-m", "init"], work);
    g(["remote", "add", "origin", pathToFileURL(bare).href], work);
    g(
      ["push", "origin", "HEAD"],
      work,
      stageEnv(process.env, { scratchDir: join(dir, "scratch") }),
    );
  });

  const ghMissing = runSync("gh", ["--version"]).status !== 0;
  it.skipIf(ghMissing)("leaves gh logged out (skipped where gh is not on PATH)", () => {
    const r = runSync("gh", ["auth", "status"], {
      env: stageEnv(process.env, { scratchDir: tmp("ac-stage-") }),
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/not logged in/i);
  });
});
