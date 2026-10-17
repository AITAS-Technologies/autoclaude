import { closeSync, openSync } from "node:fs";
import crossSpawn from "cross-spawn";
import { killTree, processStartTime } from "./kill.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DETACH = process.platform !== "win32";

/**
 * The limits of the engine's own git and gh calls (R70). Every one is synchronous, so one that
 * hangs (a half-open connection after a sleep, a credential manager waiting for a click) would
 * otherwise freeze the event loop: no tick, no stage timer, no heartbeat. A call site that needs
 * another limit passes its own.
 */
export const GIT_TIMEOUT_MS = 600_000;
export const GH_TIMEOUT_MS = 120_000;

/** `120 s`, or `250 ms` for a limit below a second. */
export const limitText = (ms: number): string =>
  ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;

/**
 * The environment of every engine git and gh call: `base` with credential prompts turned off,
 * so a credential problem fails at once and reaches a note or a blocked reason instead of
 * waiting for someone at a terminal. Names compare case-insensitively on Windows.
 */
export function nonInteractive(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const set: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  const env: NodeJS.ProcessEnv = {};
  const fold = (k: string) => (process.platform === "win32" ? k.toUpperCase() : k);
  const ours = new Set(Object.keys(set).map(fold));
  for (const [k, v] of Object.entries(base)) if (!ours.has(fold(k))) env[k] = v;
  return { ...env, ...set };
}

/**
 * Synchronous run through cross-spawn (never a shell for argv; `.cmd` shims are quoted
 * for cmd.exe by cross-spawn). `timeoutMs` uses the synchronous spawn's own timeout,
 * which kills only the direct child: on Windows a grandchild can survive. Use `run`
 * wherever a timed command may spawn children.
 */
export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const r = crossSpawn.sync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeoutMs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error && !timedOut ? String(r.error.message) : ""),
    timedOut,
  };
}

/** Async run; on timeout the whole process tree is killed and `timedOut` is true. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = crossSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: DETACH,
      windowsHide: true,
    });
    const finish = (status: number | null, signal: NodeJS.Signals | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extra,
        timedOut,
      });
    };
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
    if (opts.timeoutMs !== undefined && child.pid !== undefined) {
      const pid = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        void killTree(pid).then(() => {
          // Pipes may be held open by a survivor; do not wait for them forever.
          setTimeout(() => finish(null, "SIGKILL"), 2000).unref();
        });
      }, opts.timeoutMs);
    }
  });
}

/**
 * Starts a supervised process whose stdout/stderr stream to files (stages can write
 * megabytes). `startedAt` is the process start time as `processStartTime` reports it
 * (falls back to now), so it can be compared for equality after a reboot.
 */
export function spawnSupervised(
  cmd: string,
  args: string[],
  opts: RunOptions & { stdoutFile: string; stderrFile: string },
): { pid: number; startedAt: string; done: Promise<RunResult>; kill(): Promise<void> } {
  const outFd = openSync(opts.stdoutFile, "w");
  let errFd: number;
  try {
    errFd = openSync(opts.stderrFile, "w");
  } catch (e) {
    closeSync(outFd);
    throw e;
  }
  let child;
  try {
    child = crossSpawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", outFd, errFd],
      detached: DETACH,
      windowsHide: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  if (child.pid === undefined) {
    // The spawn error is emitted on the next tick; swallow it so it is not uncaught.
    child.on("error", () => {});
    throw new Error(`Failed to start ${cmd}`);
  }
  const pid = child.pid;
  if (opts.input !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input);
  }
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (status: number | null, signal: NodeJS.Signals | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout: "", stderr: extra, timedOut });
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
  });
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void killTree(pid);
    }, opts.timeoutMs);
  }
  const startedAt = processStartTime(pid) ?? new Date().toISOString();
  return { pid, startedAt, done, kill: () => killTree(pid) };
}
