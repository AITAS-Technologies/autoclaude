/**
 * Running one stage (triage, plan or implement) for one issue.
 *
 * The engine does everything around the child: it fetches, bootstraps the worktree once,
 * reads the issue, renders the prompt and the dispatch file, starts the runtime, writes the
 * stage record into the ledger the moment the child has a pid, and turns what comes back
 * into a `StageOutcome` for the decision table. A stage process gets no forge credential
 * (`stageEnv`, applied by the runtime) and this module writes nothing to GitHub.
 *
 * Everything before the spawn runs in the normal environment; only the child gets the
 * scrubbed one. Callers must not hold the ledger lock: the record is written with
 * `updateLedger`, which is not re-entrant.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig, Runtime, StageSpec } from "../config/types.js";
import { runDir as issueRunsDir, updateLedger, type LedgerEntry } from "../engine/ledger/ledger.js";
import { reportPath } from "../engine/review/reports.js";
import type { Exec, Forge } from "../forge/github.js";
import { processStartTime } from "../platform/kill.js";
import { runShell } from "../platform/shell.js";
import { writeDispatch, type Dispatch } from "../prompts/dispatch.js";
import { renderPrompt } from "../prompts/render.js";
import type { RuntimeAdapter, StageRequest, StageResult } from "../runtimes/types.js";
import { prefetchIssue } from "./prefetch.js";
import { TriageSchema } from "./review/schemas.js";

export interface OrchestratorCtx {
  root: string;
  cfg: ProjectConfig;
  forge: Forge;
  exec: Exec;
  instance: string;
  now(): Date;
  runtimes: (name: Runtime) => RuntimeAdapter;
  notes(issue: number, text: string): void;
}

/**
 * - `report`: for plan and implement the report file's text (BOM and CRLF normalised); for
 *   triage the stage's structured answer as JSON text (triage writes no file).
 * - `no-report`: the child wrote nothing usable, or the engine could not get as far as the
 *   spawn (fetch or bootstrap failed, `start()` threw); a note says which.
 * - `limit`: the runtime hit its usage limit; no counter is touched.
 */
export type StageOutcome =
  | { kind: "report"; text: string; result: StageResult }
  | { kind: "no-report"; result: StageResult }
  | { kind: "limit"; resetsAt: string; result: StageResult };

type Extra = {
  findingsMarkdown?: string;
  carriedMarkdown?: string;
  gateLog?: string;
  escalated?: boolean;
};

const ENGINE_RULES = fileURLToPath(new URL("../../catalogue/rules.md", import.meta.url));
const BOOTSTRAP_MARKER = join(".autoclaude", "state", "bootstrapped");
const PLANS_DIR = join(".autoclaude", "state", "plans");

const clean = (text: string): string => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");

function readOptional(file: string): string {
  try {
    return clean(readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

const tail = (text: string, max = 600): string => {
  const t = text.trim();
  return t.length > max ? `...${t.slice(-max)}` : t;
};

function specFor(
  cfg: ProjectConfig,
  stage: "triage" | "plan" | "implement",
  extra: Extra,
): StageSpec {
  if (stage === "implement" && extra.escalated && cfg.stages.implement.escalated)
    return cfg.stages.implement.escalated;
  return cfg.stages[stage];
}

/** `k` = 1 + the number of run directories this stage already has for the issue. */
function nextRunDir(root: string, issue: number, stage: string): string {
  const base = issueRunsDir(root, issue);
  let existing = 0;
  if (existsSync(base))
    existing = readdirSync(base, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && new RegExp(`^${stage}-\\d+$`).test(d.name),
    ).length;
  return join(base, `${stage}-${existing + 1}`);
}

function failedResult(ctx: OrchestratorCtx, text: string): StageResult {
  return {
    exit: "failed",
    resultText: text,
    stdoutFile: "",
    stderrFile: "",
    pid: 0,
    startedAt: ctx.now().toISOString(),
  };
}

export async function runStage(
  ctx: OrchestratorCtx,
  entry: LedgerEntry,
  stage: "triage" | "plan" | "implement",
  mode: Dispatch["mode"],
  extra: Extra = {},
): Promise<StageOutcome> {
  const { cfg, root } = ctx;
  const issue = entry.issue;
  const stopped = (text: string): StageOutcome => {
    ctx.notes(issue, text);
    return { kind: "no-report", result: failedResult(ctx, text) };
  };

  const triage = stage === "triage";
  const worktree = triage ? root : entry.worktree;
  if (!worktree) return stopped(`${stage}: the ledger entry has no worktree`);
  const spec = specFor(cfg, stage, extra);
  const integrationRef = `${cfg.forge.remote}/${cfg.branches.integration}`;
  const wallClockMs = cfg.caps.wallClockMinutesPerStage * 60_000;

  let req: StageRequest;
  let adapter: RuntimeAdapter;
  try {
    adapter = ctx.runtimes(spec.runtime);

    if (!triage) {
      // The engine fetches; a stage never does. A stage on a stale base is worse than no stage.
      const f = ctx.exec("git", ["fetch", cfg.forge.remote, cfg.branches.integration], {
        cwd: worktree,
      });
      if (f.status !== 0)
        return stopped(
          `${stage}: git fetch ${cfg.forge.remote} ${cfg.branches.integration} failed (exit ${f.status}): ${tail(f.stderr)}`,
        );
      const marker = join(worktree, BOOTSTRAP_MARKER);
      if (cfg.bootstrap && !existsSync(marker)) {
        const b = await runShell(cfg.bootstrap, { cwd: worktree, timeoutMs: wallClockMs });
        if (b.status !== 0 || b.timedOut)
          return stopped(
            `${stage}: bootstrap ${b.timedOut ? "timed out" : `failed (exit ${b.status})`}: ${tail(`${b.stderr}\n${b.stdout}`)}`,
          );
        mkdirSync(join(worktree, ".autoclaude", "state"), { recursive: true });
        writeFileSync(marker, `${ctx.now().toISOString()}\n`);
      }
    }

    const runDir = nextRunDir(root, issue, stage);
    mkdirSync(runDir, { recursive: true });
    const reportFile = triage
      ? join(runDir, "triage-report.md")
      : join(worktree, reportPath(stage));
    const planFile = join(worktree, PLANS_DIR, `${issue}.md`);
    if (!triage) {
      // The stage's fence denies mkdir, so its directories exist before it starts.
      mkdirSync(join(worktree, ".autoclaude", "state", "reports"), { recursive: true });
      mkdirSync(join(worktree, PLANS_DIR), { recursive: true });
      // A report left by an earlier run must never be read as this run's; a resumed stage
      // may have finished before the caller crashed, and its report is kept.
      if (mode !== "resume") rmSync(reportFile, { force: true });
    }

    const dispatch: Dispatch = {
      issue: prefetchIssue(ctx.forge, issue),
      mode,
      worktree,
      integrationRef,
      reportFile,
      planFile,
      ...(extra.findingsMarkdown !== undefined && { findingsMarkdown: extra.findingsMarkdown }),
      ...(extra.carriedMarkdown !== undefined && { carriedMarkdown: extra.carriedMarkdown }),
      ...(extra.gateLog !== undefined && { gateLog: extra.gateLog }),
      projectFacts: {
        projectMd: readOptional(join(root, ".autoclaude", "project.md")),
        invariantsMd: readOptional(join(root, ".autoclaude", "invariants.md")),
        engineRulesMd: readOptional(ENGINE_RULES),
      },
    };
    const dispatchFile = writeDispatch(runDir, dispatch);
    const promptFile = join(runDir, "prompt.md");
    writeFileSync(
      promptFile,
      renderPrompt(stage, {
        issue: String(issue),
        worktree,
        mode,
        dispatchFile,
        integrationRef,
        planFile,
        reportFile,
      }),
    );

    req = {
      cwd: worktree,
      promptFile,
      dispatchFile,
      runDir,
      model: spec.model,
      effort: spec.effort,
      timeoutMs: wallClockMs,
      maxTurns: cfg.caps.maxTurnsPerStage,
      projectRoot: root,
      ...(triage && { schema: TriageSchema, readOnly: true }),
    };
  } catch (error) {
    return stopped(`${stage}: could not prepare the stage: ${String(error)}`);
  }

  let proc: ReturnType<RuntimeAdapter["start"]>;
  try {
    proc = adapter.start(req, cfg);
  } catch (error) {
    return stopped(`${stage}: the stage did not start: ${String(error)}`);
  }

  // Quiet rejection if we kill the child before awaiting `done`.
  proc.done.catch(() => {});
  const killAndStop = async (why: string): Promise<StageOutcome> => {
    // A child nobody recorded is one nobody can recognise after a crash: do not leave it running.
    await proc.kill().catch(() => {});
    return stopped(`${stage}: ${why}`);
  };

  // Triage has no ledger stage (the stage record's names are the pipeline stages). The record
  // stays after the child exits: it says "this stage ran", and the caller that consumes the
  // outcome (G3) clears it, so a crash in between reads as a finished stage, not a stalled one.
  if (!triage) {
    if (!Number.isInteger(proc.pid) || proc.pid <= 0)
      return killAndStop(`the runtime returned no usable pid (${String(proc.pid)})`);
    try {
      const processStartedAt = processStartTime(proc.pid);
      const written = updateLedger(
        root,
        (ledger) => {
          const e = ledger.issues[String(issue)];
          if (!e) return false;
          e.stage = {
            stage: stage as "plan" | "implement",
            mode,
            pid: proc.pid,
            instance: ctx.instance,
            startedAt: proc.startedAt,
            processStartedAt,
          };
          return true;
        },
        ctx.now(),
      );
      if (!written)
        return killAndStop(`the ledger has no entry for #${issue} to record the stage in`);
    } catch (error) {
      return killAndStop(`the stage record could not be written: ${String(error)}`);
    }
  }

  let result: StageResult;
  try {
    result = await proc.done;
  } catch (error) {
    result = failedResult(ctx, String(error));
    ctx.notes(issue, `${stage}: the stage process failed: ${String(error)}`);
  }

  for (const denial of result.permissionDenials ?? []) {
    ctx.notes(issue, `${stage}: permission denied: ${tail(JSON.stringify(denial), 400)}`);
  }

  if (result.exit === "limit") {
    return {
      kind: "limit",
      resetsAt: result.limitResetsAt ?? new Date(ctx.now().getTime() + 3_600_000).toISOString(),
      result,
    };
  }
  if (triage) {
    return result.structured === undefined || result.structured === null
      ? { kind: "no-report", result }
      : { kind: "report", text: JSON.stringify(result.structured), result };
  }
  const text = readOptional(join(worktree, reportPath(stage)));
  return text.trim() === "" ? { kind: "no-report", result } : { kind: "report", text, result };
}
