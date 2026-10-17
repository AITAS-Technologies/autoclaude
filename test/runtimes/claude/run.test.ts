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
import { delimiter, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../../src/config/load.js";
import {
  claudeAdapter,
  resolveClaude,
  TESTED_CLAUDE_MAJORS,
} from "../../../src/runtimes/claude/run.js";
import { runtimeFor } from "../../../src/runtimes/registry.js";
import type { StageRequest } from "../../../src/runtimes/types.js";
import { writeFakeCli } from "../../helpers/fake-cli.js";

const MINIMAL = resolve(import.meta.dirname, "../../fixtures/projects/minimal");
const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, `../../fixtures/runtime/claude/${name}.json`), "utf8");

const temps: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const savedPath = process.env[pathKey];
const savedToken = process.env.GH_TOKEN;
afterEach(() => {
  process.env[pathKey] = savedPath;
  if (savedToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedToken;
});

const cfg = loadProjectConfig(MINIMAL);

function setup(opts: Parameters<typeof writeFakeCli>[1], extraFiles: string[] = []) {
  const base = tmp("ac run ");
  const fake = writeFakeCli(join(base, "fake bin"), opts);
  process.env[pathKey] = `${fake.bin}${delimiter}${savedPath ?? ""}`;
  const projectRoot = join(base, "project");
  const cwd = join(base, "Jürgen Müller", "work tree");
  const runDir = join(base, "run");
  for (const d of [projectRoot, cwd, runDir]) mkdirSync(d, { recursive: true });
  for (const f of extraFiles) writeFileSync(join(projectRoot, f), "x\n");
  const req: StageRequest = {
    cwd,
    promptFile: join(runDir, "prompt.md"),
    dispatchFile: join(runDir, "dispatch.json"),
    runDir,
    model: "claude-sonnet-5-5",
    effort: "high",
    timeoutMs: 60_000,
    maxTurns: 7,
    projectRoot,
  };
  return { fake, req, cwd, runDir };
}

describe("claude stage runner", () => {
  it("runs a stage whose cwd has a space and umlaut", async () => {
    const { fake, req, cwd } = setup({ stdout: fixture("ok") });
    const h = claudeAdapter.start(req, cfg);
    const r = await h.done;
    expect(r.exit).toBe("ok");
    expect(r.pid).toBe(h.pid);
    expect(r.startedAt).toBe(h.startedAt);
    expect(realpathSync.native(fake.read().cwd)).toBe(realpathSync.native(cwd));
    expect(readFileSync(r.stdoutFile, "utf8")).toContain('"type":"result"');
  });

  it("passes the confirmed flags and the fixed prompt", async () => {
    const { fake, req, runDir } = setup({ stdout: fixture("structured") }, ["CLAUDE.md"]);
    req.schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const r = await claudeAdapter.start(req, cfg).done;
    expect(r.structured).toEqual({ ok: true });
    const { argv } = fake.read();
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe(
      `Read CLAUDE.md at the project root first; it holds this project's instructions. Your instructions are in ${req.promptFile}. Read that file completely, then follow it to the end. Your input data is in ${req.dispatchFile}.`,
    );
    const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    expect(at("--output-format")).toBe("json");
    expect(at("--model")).toBe("claude-sonnet-5-5");
    expect(at("--effort")).toBe("high");
    expect(at("--settings")).toBe(join(runDir, "settings.json"));
    // R43: the flag and its empty value, as two argv elements.
    expect(argv.indexOf("--setting-sources")).toBeGreaterThan(-1);
    expect(at("--setting-sources")).toBe("");
    expect(at("--permission-mode")).toBe("dontAsk");
    expect(existsSync(at("--mcp-config")!)).toBe(true);
    expect(argv).toContain("--strict-mcp-config");
    expect(at("--max-turns")).toBe("7");
    expect(JSON.parse(at("--json-schema")!)).toEqual(req.schema);
    const settings = JSON.parse(readFileSync(join(runDir, "settings.json"), "utf8"));
    expect(settings.permissions.defaultMode).toBe("dontAsk");
  });

  it("omits --json-schema without a schema", async () => {
    const { fake, req } = setup({ stdout: fixture("ok") });
    await claudeAdapter.start(req, cfg).done;
    expect(fake.read().argv).not.toContain("--json-schema");
  });

  it("passes the sanitised environment", async () => {
    process.env.GH_TOKEN = "secret";
    const { fake, req } = setup({ stdout: fixture("ok") });
    await claudeAdapter.start(req, cfg).done;
    const keys = Object.keys(fake.read().env).map((k) => k.toUpperCase());
    expect(keys).not.toContain("GH_TOKEN");
    expect(keys).toContain("GIT_CONFIG_COUNT");
  });

  it("parses the result despite stderr noise", async () => {
    const { req } = setup({ stdout: fixture("ok"), stderr: "Update available: 2.9.9\n" });
    const r = await claudeAdapter.start(req, cfg).done;
    expect(r.exit).toBe("ok");
    expect(readFileSync(r.stderrFile, "utf8")).toContain("Update available");
  });

  it("reports a logged-out CLI as failed with errorClass auth", async () => {
    const { req } = setup({
      stdout: '{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}\n',
      exitCode: 1,
    });
    const r = await claudeAdapter.start(req, cfg).done;
    expect(r.exit).toBe("failed");
    expect(r.errorClass).toBe("auth");
  });

  it("kills the process tree on timeout", async () => {
    const { req } = setup({ stdout: fixture("ok"), sleepMs: 60_000 });
    req.timeoutMs = 1000;
    const t0 = Date.now();
    const r = await claudeAdapter.start(req, cfg).done;
    expect(r.exit).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(30_000);
    let alive = true;
    try {
      process.kill(r.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 40_000);

  it("points a project that has only AGENTS.md at it", async () => {
    const { fake, req } = setup({ stdout: fixture("ok") }, ["AGENTS.md"]);
    await claudeAdapter.start(req, cfg).done;
    expect(fake.read().argv[1]).toMatch(
      /^Read AGENTS\.md at the project root first; it holds this project's instructions\. Your instructions are in /,
    );
  });

  // R67: `--setting-sources ""` keeps Claude Code from loading CLAUDE.md itself, so the stage is
  // pointed at it, and it wins over AGENTS.md.
  it("does not point at AGENTS.md when CLAUDE.md exists too: it points at CLAUDE.md", async () => {
    const { fake, req } = setup({ stdout: fixture("ok") }, ["AGENTS.md", "CLAUDE.md"]);
    await claudeAdapter.start(req, cfg).done;
    expect(fake.read().argv[1]).toMatch(
      /^Read CLAUDE\.md at the project root first; it holds this project's instructions\. Your instructions are in /,
    );
  });

  it("points at no file when the project has neither", async () => {
    const { fake, req } = setup({ stdout: fixture("ok") });
    await claudeAdapter.start(req, cfg).done;
    expect(fake.read().argv[1]).toMatch(/^Your instructions are in /);
  });

  it("reports the version through available()", async () => {
    setup({ stdout: "" });
    const a = await claudeAdapter.available();
    expect(a).toEqual({ ok: true, version: "2.1.301" });
    expect(TESTED_CLAUDE_MAJORS).toContain(Number(a.version!.split(".")[0]));
  });
});

describe("resolveClaude", () => {
  it("prefers the native binary next to an npm shim on Windows", () => {
    const dir = tmp("ac shim ");
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
    const native = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "claude.exe"), "");
    expect(resolveClaude({ PATH: dir }, "win32")).toBe(join(native, "claude.exe"));
  });

  it("falls back to the shim when there is no native binary", () => {
    const dir = tmp("ac shim ");
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
    expect(resolveClaude({ PATH: dir }, "win32")).toBe(join(dir, "claude.cmd"));
  });

  it("falls back to the bare name when claude is not on PATH", () => {
    expect(resolveClaude({ PATH: tmp("ac empty ") }, "linux")).toBe("claude");
  });
});

describe("runtimeFor", () => {
  it("returns the claude adapter", () => {
    expect(runtimeFor("claude").name).toBe("claude");
  });
  it("refuses codex", () => {
    expect(() => runtimeFor("codex")).toThrow("codex runtime is not available before phase 3");
  });
});
