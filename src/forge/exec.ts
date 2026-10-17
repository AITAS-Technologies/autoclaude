import {
  GH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  limitText,
  nonInteractive,
  runSync,
} from "../platform/spawn.js";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The call outlived its limit and was killed; `stderr` names the limit. */
  timedOut?: boolean;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; timeoutMs?: number },
) => ExecResult;

/** The limit a call gets when its site names none: every engine git and gh call has one (R70). */
const LIMITS: Readonly<Record<string, number>> = { git: GIT_TIMEOUT_MS, gh: GH_TIMEOUT_MS };

/**
 * Built on `runSync` (cross-spawn): no shell for argv, and `.cmd`/`.bat` shims resolve on
 * Windows, which a plain shell-less `spawnSync` refuses.
 *
 * git and gh run with a limit (600 s and 120 s unless the call names one) and with credential
 * prompts off (`nonInteractive`). A call that outlives its limit is killed and comes back as a
 * failure with no exit code whose `stderr` says so, which every caller already treats as an
 * error.
 */
export const realExec: Exec = (cmd, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? LIMITS[cmd];
  const r = runSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: nonInteractive(),
    timeoutMs,
  });
  if (r.timedOut && timeoutMs !== undefined) {
    const partial = r.stderr.trim();
    return {
      status: null,
      stdout: r.stdout,
      stderr: `timed out after ${limitText(timeoutMs)}${partial ? `: ${partial}` : ""}`,
      timedOut: true,
    };
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
