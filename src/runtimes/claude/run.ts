import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ProjectConfig } from "../../config/types.js";
import { runSync, spawnSupervised } from "../../platform/spawn.js";
import { stageEnv } from "../stage-env.js";
import type { RuntimeAdapter, StageRequest, StageResult } from "../types.js";
import { autoclaudeBinCommand, claudeSettings, mcpConfigFor } from "./fence.js";
import { parseClaudeResult } from "./result.js";

/** Majors of the CLI that Phase 0 (spike S4) ran against: 2.1.289. */
export const TESTED_CLAUDE_MAJORS: readonly number[] = [2];

/** Files the runner writes in `runDir`. */
export const SETTINGS_FILE = "settings.json";
export const STDOUT_FILE = "stdout.json";
export const STDERR_FILE = "stderr.txt";

/** The fixed prompt argument; the file paths are the only variable parts. */
export function promptArgument(req: StageRequest): string {
  const hasAgents = existsSync(join(req.projectRoot, "AGENTS.md"));
  const hasClaude = existsSync(join(req.projectRoot, "CLAUDE.md"));
  const prefix =
    hasAgents && !hasClaude
      ? "Read AGENTS.md at the project root first; it holds this project's instructions. "
      : "";
  return `${prefix}Your instructions are in ${req.promptFile}. Read that file completely, then follow it to the end. Your input data is in ${req.dispatchFile}.`;
}

export function claudeArgs(req: StageRequest, mcpConfig: string): string[] {
  const args = [
    "-p",
    promptArgument(req),
    "--output-format",
    "json",
    "--model",
    req.model,
    "--effort",
    req.effort,
    "--settings",
    join(req.runDir, SETTINGS_FILE),
    // R43: an empty source list, so the developer's user settings and the worktree's own
    // `.claude/settings*.json` do not merge into the stage's permissions.
    "--setting-sources",
    "",
    "--permission-mode",
    "dontAsk",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--max-turns",
    String(req.maxTurns),
  ];
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
  return args;
}

/** Finds `name` on the PATH of `env` (PATHEXT on Windows); the first hit wins. */
function which(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const dirs = (key ? (env[key] ?? "") : "").split(delimiter).filter(Boolean);
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * What to spawn for `claude`. Behind an npm `.cmd` shim on Windows the native binary sits at
 * `node_modules/@anthropic-ai/claude-code/bin/claude.exe` next to the shim; spawning it makes
 * the recorded pid the CLI itself (G4's orphan check relies on that) and keeps JSON arguments
 * away from cmd.exe. Any other layout falls back to what `claude` resolves to (cross-spawn
 * quotes a `.cmd` safely).
 */
export function resolveClaude(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const found = which(env, "claude", platform);
  if (!found) return "claude";
  if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    const native = join(
      dirname(found),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    if (existsSync(native)) return native;
  }
  return found;
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

export const claudeAdapter: RuntimeAdapter = {
  name: "claude",

  async available() {
    const r = runSync(resolveClaude(), ["--version"], { timeoutMs: 20_000 });
    if (r.status !== 0) {
      return { ok: false, reason: (r.stderr || "claude did not run").trim() };
    }
    const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
    return version ? { ok: true, version } : { ok: true };
  },

  start(req: StageRequest, cfg: ProjectConfig) {
    writeFileSync(
      join(req.runDir, SETTINGS_FILE),
      JSON.stringify(claudeSettings(cfg, req.cwd, autoclaudeBinCommand())),
    );
    const env = stageEnv(process.env, { scratchDir: req.runDir });
    const stdoutFile = join(req.runDir, STDOUT_FILE);
    const stderrFile = join(req.runDir, STDERR_FILE);
    const proc = spawnSupervised(
      resolveClaude(env),
      claudeArgs(req, mcpConfigFor(req.projectRoot)),
      { cwd: req.cwd, env, input: "", timeoutMs: req.timeoutMs, stdoutFile, stderrFile },
    );
    const done = proc.done.then((r): StageResult => {
      const base = { stdoutFile, stderrFile, pid: proc.pid, startedAt: proc.startedAt };
      if (r.timedOut) {
        return {
          ...base,
          exit: "timeout",
          resultText: `stage timed out after ${req.timeoutMs} ms`,
        };
      }
      const stderr = readText(stderrFile) || r.stderr;
      const parsed = parseClaudeResult(readText(stdoutFile), r.status, {
        stderr,
        timeZone: cfg.schedule.timezone,
      });
      return { ...base, ...parsed };
    });
    return { pid: proc.pid, startedAt: proc.startedAt, done, kill: proc.kill };
  },
};
