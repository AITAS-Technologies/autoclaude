import type { Effort, ProjectConfig, Runtime } from "../config/types.js";

/** One pipeline stage to run as a headless child process (design 7.6). */
export interface StageRequest {
  cwd: string;
  promptFile: string;
  dispatchFile: string;
  runDir: string;
  model: string;
  effort: Effort;
  schema?: object;
  timeoutMs: number;
  maxTurns: number;
  projectRoot: string;
}

export interface StageResult {
  exit: "ok" | "failed" | "timeout" | "limit" | "refused";
  limitResetsAt?: string;
  structured?: unknown;
  resultText: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  stdoutFile: string;
  stderrFile: string;
  pid: number;
  startedAt: string;
  errorClass?: "auth" | "quota" | "config" | "network" | "unknown";
  /**
   * Tool calls the CLI refused (a permission denial or a hook block; Phase 0 found them
   * indistinguishable). Not a failed process: the stage is `ok` and the caller records them.
   */
  permissionDenials?: unknown[];
}

export interface RuntimeAdapter {
  name: Runtime;
  available(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  start(
    req: StageRequest,
    cfg: ProjectConfig,
  ): { pid: number; startedAt: string; done: Promise<StageResult>; kill(): Promise<void> };
}
