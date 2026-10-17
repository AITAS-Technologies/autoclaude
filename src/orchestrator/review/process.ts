/**
 * One review process: an angle, a scorer, a criteria re-check or the plan review's finder.
 *
 * Each is a read-only stage process in the worktree (G1's `readOnly` fence), with its schema
 * handed to the runtime and its answer read from `StageResult.structured`. A process fails when
 * it does not exit `ok` or when its answer does not validate; `runWithRetry` runs it once more.
 * Nothing here holds the ledger lock and nothing writes to the forge.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StageSpec } from "../../config/types.js";
import { escapeRegExp } from "../../engine/review/rules.js";
import { runDir as issueRunsDir } from "../../engine/ledger/ledger.js";
import { writeDispatch, type Dispatch } from "../../prompts/dispatch.js";
import { renderPrompt } from "../../prompts/render.js";
import type { StageRequest } from "../../runtimes/types.js";
import type { OrchestratorCtx } from "../stage.js";
import { validate } from "./schemas.js";

const ENGINE_RULES = fileURLToPath(new URL("../../../catalogue/rules.md", import.meta.url));

function readOptional(file: string): string {
  try {
    return readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

export function projectFacts(root: string): Dispatch["projectFacts"] {
  return {
    projectMd: readOptional(join(root, ".autoclaude", "project.md")),
    invariantsMd: readOptional(join(root, ".autoclaude", "invariants.md")),
    engineRulesMd: readOptional(ENGINE_RULES),
  };
}

/** `<runs>/<issue>/<role>-<k>`, `k` = 1 + the directories this role already has. */
function nextRunDir(root: string, issue: number, role: string): string {
  const base = issueRunsDir(root, issue);
  let existing = 0;
  if (existsSync(base)) {
    const same = new RegExp(`^${escapeRegExp(role)}-\\d+$`);
    existing = readdirSync(base, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && same.test(d.name),
    ).length;
  }
  return join(base, `${role}-${existing + 1}`);
}

export interface ProcessSpec {
  issue: number;
  worktree: string;
  /** Names the run directory; the tests and a human read it. */
  role: string;
  promptName: string;
  promptVars: Record<string, string>;
  dispatch: Dispatch;
  spec: StageSpec;
  schema: object;
}

export type ProcessOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export async function runReviewProcess<T>(
  ctx: OrchestratorCtx,
  p: ProcessSpec,
  check: (value: unknown) => string | null = () => null,
): Promise<ProcessOutcome<T>> {
  const { cfg } = ctx;
  let req: StageRequest;
  let proc: ReturnType<ReturnType<OrchestratorCtx["runtimes"]>["start"]>;
  try {
    const adapter = ctx.runtimes(p.spec.runtime);
    const runDir = nextRunDir(ctx.root, p.issue, p.role);
    mkdirSync(runDir, { recursive: true });
    const dispatchFile = writeDispatch(runDir, p.dispatch);
    const promptFile = join(runDir, "prompt.md");
    writeFileSync(promptFile, renderPrompt(p.promptName, { ...p.promptVars, dispatchFile }));
    req = {
      cwd: p.worktree,
      promptFile,
      dispatchFile,
      runDir,
      model: p.spec.model,
      effort: p.spec.effort,
      schema: p.schema,
      timeoutMs: cfg.caps.wallClockMinutesPerStage * 60_000,
      maxTurns: cfg.caps.maxTurnsPerStage,
      projectRoot: ctx.root,
      readOnly: true,
    };
    proc = adapter.start(req, cfg);
  } catch (error) {
    return { ok: false, reason: `${p.role}: did not start: ${String(error)}` };
  }
  let result;
  try {
    result = await proc.done;
  } catch (error) {
    return { ok: false, reason: `${p.role}: the process failed: ${String(error)}` };
  }
  for (const denial of result.permissionDenials ?? []) {
    ctx.notes(p.issue, `${p.role}: permission denied: ${JSON.stringify(denial).slice(0, 400)}`);
  }
  if (result.exit !== "ok")
    return {
      ok: false,
      reason: `${p.role}: ${result.exit}${result.resultText ? ` (${result.resultText.slice(0, 200)})` : ""}`,
    };
  const invalid = validate(p.schema, result.structured) ?? check(result.structured);
  if (invalid) return { ok: false, reason: `${p.role}: the answer is not valid: ${invalid}` };
  return { ok: true, value: result.structured as T };
}

/** Runs once, and once more on failure; notes the first failure. */
export async function runWithRetry<T>(
  ctx: OrchestratorCtx,
  p: ProcessSpec,
  check?: (value: unknown) => string | null,
): Promise<ProcessOutcome<T>> {
  const first = await runReviewProcess<T>(ctx, p, check);
  if (first.ok) return first;
  ctx.notes(p.issue, `${first.reason}; retrying once`);
  const second = await runReviewProcess<T>(ctx, p, check);
  if (!second.ok) ctx.notes(p.issue, `${second.reason}; giving up`);
  return second;
}

/** `fn` over `items`, at most `limit` at once; results in item order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface Numbered {
  id: number;
  rule: string;
  file: string;
  line: number | null;
  evidence: string;
  message: string;
}

/** The candidates as the scorer prompts read them: numbered, nothing of the finder's reasoning. */
export function findingsMarkdown(items: Numbered[]): string {
  return items
    .map((c) =>
      [
        `### Candidate ${c.id}`,
        `- id: ${c.id}`,
        `- rule: ${c.rule}`,
        `- file: ${JSON.stringify(c.file)}`,
        `- line: ${c.line === null || c.line <= 0 ? "none" : c.line}`,
        `- evidence: ${JSON.stringify(c.evidence)}`,
        `- message: ${JSON.stringify(c.message)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** A scorer's answer must score every candidate exactly once. */
export function checkScores(ids: number[]): (value: unknown) => string | null {
  return (value) => {
    const scores = (value as { scores: Array<{ id: number }> }).scores;
    const seen = new Set<number>();
    for (const s of scores) {
      if (!ids.includes(s.id)) return `scores names id ${s.id}, which is not a candidate`;
      if (seen.has(s.id)) return `scores names id ${s.id} twice`;
      seen.add(s.id);
    }
    const missing = ids.filter((i) => !seen.has(i));
    return missing.length > 0 ? `scores leaves out id ${missing.join(", ")}` : null;
  };
}
