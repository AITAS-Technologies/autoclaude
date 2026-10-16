import { changedFiles } from "./changed-files.js";
import { matchesAny } from "../config/globs.js";
import type { ProjectConfig } from "../config/types.js";
import { runShell, shQuote } from "../platform/shell.js";

export interface GateResult {
  name: string;
  status: "pass" | "fail" | "skipped";
  output: string;
  durationMs: number;
}

const PLACEHOLDER = "{files}";

async function exec(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  // `exec 2>&1` first, so stdout and stderr share one pipe and keep their order.
  const r = await runShell(`exec 2>&1; ${command}`, { cwd });
  const output = r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "");
  return { ok: r.status === 0, output };
}

/**
 * Runs the project gates in config order inside `worktree` and stops at the first
 * failure. `{files}` becomes the space-joined, shell-quoted changed files (`opts.files`
 * when given, else `changedFiles` against `<remote>/<integration>`). A gate whose `when`
 * matches no changed file, or whose command takes `{files}` while there are none, is
 * skipped. With `fix`, a gate's `fix` command runs before its `check`.
 */
export async function runGates(
  cfg: Pick<ProjectConfig, "gates" | "forge" | "branches">,
  worktree: string,
  opts: { fix: boolean; only?: string[]; files?: string[] },
): Promise<GateResult[]> {
  const gates = cfg.gates.filter((g) => opts.only === undefined || opts.only.includes(g.name));
  const files =
    opts.files ?? changedFiles(worktree, `${cfg.forge.remote}/${cfg.branches.integration}`);
  const quoted = files.map(shQuote).join(" ");
  // split/join, not replace: a quoted path may contain `$&` or `$'`, which replace expands.
  const substitute = (cmd: string): string => cmd.split(PLACEHOLDER).join(quoted);

  const results: GateResult[] = [];
  for (const gate of gates) {
    const started = Date.now();
    const done = (status: GateResult["status"], output: string): GateResult => ({
      name: gate.name,
      status,
      output,
      durationMs: Date.now() - started,
    });
    const when = gate.when;
    if (when !== undefined && !files.some((f) => matchesAny(f, when))) {
      results.push(done("skipped", "no changed file matches this gate's `when`"));
      continue;
    }
    const takesFiles = gate.check.includes(PLACEHOLDER) || gate.fix?.includes(PLACEHOLDER);
    if (takesFiles && files.length === 0) {
      results.push(done("skipped", "no changed files to check"));
      continue;
    }
    let output = "";
    if (opts.fix && gate.fix !== undefined) {
      const fixed = await exec(substitute(gate.fix), worktree);
      output += fixed.output;
      if (!fixed.ok) {
        results.push(done("fail", output));
        break;
      }
    }
    const checked = await exec(substitute(gate.check), worktree);
    output += checked.output;
    results.push(done(checked.ok ? "pass" : "fail", output));
    if (!checked.ok) break;
  }
  return results;
}
