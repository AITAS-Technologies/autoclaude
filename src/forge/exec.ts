import { runSync } from "../platform/spawn.js";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => ExecResult;

/**
 * Built on `runSync` (cross-spawn): no shell for argv, and `.cmd`/`.bat` shims resolve on
 * Windows, which a plain shell-less `spawnSync` refuses.
 */
export const realExec: Exec = (cmd, args, opts = {}) => {
  const r = runSync(cmd, args, { cwd: opts.cwd, input: opts.input });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
