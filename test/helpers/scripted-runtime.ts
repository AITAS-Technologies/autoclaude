import { basename } from "node:path";
import type { RuntimeAdapter, StageRequest, StageResult } from "../../src/runtimes/types.js";

/**
 * A runtime for the engine-driven reviews: one scripted answer per process role.
 *
 * The role is the run directory's name without its trailing `-<k>`, for example
 * `code-review-angle-bugs`, `code-review-scorer`, `code-review-recheck-2` or
 * `plan-review-finder`. The handler gets the role and the request and returns the structured
 * answer (or a full result override); the runtime records every request, the highest number
 * of processes alive at once and the read-only flag of each.
 */
export interface Scripted {
  /** Structured answer, or a partial result (`{ exit: "failed" }`). */
  (role: string, req: StageRequest, attempt: number): unknown | Partial<StageResult>;
}

export interface ScriptedRuntime extends RuntimeAdapter {
  requests: Array<{ role: string; req: StageRequest; attempt: number }>;
  maxConcurrent: number;
}

const isResult = (v: unknown): v is Partial<StageResult> & { __result: true } =>
  typeof v === "object" && v !== null && (v as { __result?: boolean }).__result === true;

/** Wrap a partial result so the runtime does not read it as a structured answer. */
export const asResult = (r: Partial<StageResult>): Partial<StageResult> & { __result: true } => ({
  ...r,
  __result: true,
});

export function scriptedRuntime(
  script: Scripted,
  opts: { delayMs?: number } = {},
): ScriptedRuntime {
  const attempts = new Map<string, number>();
  let alive = 0;
  const rt: ScriptedRuntime = {
    name: "claude",
    requests: [],
    maxConcurrent: 0,
    available: async () => ({ ok: true, version: "0.0.0" }),
    start(req) {
      const role = basename(req.runDir).replace(/-\d+$/, "");
      const attempt = (attempts.get(role) ?? 0) + 1;
      attempts.set(role, attempt);
      rt.requests.push({ role, req, attempt });
      alive += 1;
      rt.maxConcurrent = Math.max(rt.maxConcurrent, alive);
      const startedAt = new Date().toISOString();
      const done = new Promise<StageResult>((resolve) => {
        setTimeout(() => {
          alive -= 1;
          const answer = script(role, req, attempt);
          const base: StageResult = {
            exit: "ok",
            resultText: "",
            stdoutFile: "",
            stderrFile: "",
            pid: process.pid,
            startedAt,
          };
          if (isResult(answer)) {
            const { __result: _unused, ...rest } = answer;
            resolve({ ...base, ...rest });
          } else {
            resolve({ ...base, structured: answer });
          }
        }, opts.delayMs ?? 1);
      });
      return { pid: process.pid, startedAt, done, kill: async () => {} };
    },
  };
  return rt;
}
