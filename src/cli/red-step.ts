import { fetchBase } from "../engine/rebased.js";
import { redStepExitCode, runRedStep, type RedStepResult } from "../engine/review/red-step.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude red-step [--json]";

export interface RedStepVerbDeps {
  runRedStep: typeof runRedStep;
}

const LABEL: Record<string, string> = {
  proven: "PROVEN",
  "not-proven": "NOT PROVEN",
  "no-test-files": "NO TEST FILES",
};

/**
 * `autoclaude red-step [--json]`, run in a stage's worktree: do the change's new tests fail on
 * the integration branch and pass here? Exit 0 proven, 2 not proven, 3 no test files, 1 could
 * not run (design § 14, ruling R8).
 */
export async function redStepVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps: RedStepVerbDeps = { runRedStep },
): Promise<number> {
  const unknown = args.find((a) => a !== "--json");
  if (unknown !== undefined) return usageError(io, USAGE, `unknown argument: ${unknown}`);
  try {
    const root = env.root(cwd);
    const cfg = env.config(root);
    const where = { remote: cfg.forge.remote, integration: cfg.branches.integration };
    fetchBase(where, env.exec, cwd);
    const base = `${where.remote}/${where.integration}`;
    const result: RedStepResult = await deps.runRedStep(cfg, cwd, base, env.exec);
    if (args.includes("--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const kind = result.verdict.kind;
      io.out(`red step: ${LABEL[kind] ?? "COULD NOT RUN"} (${result.reason})\n`);
      if (result.skipped?.length)
        io.out(`  not test files, skipped: ${result.skipped.join(", ")}\n`);
      if (result.support?.length)
        io.out(`  support files copied to the base: ${result.support.join(", ")}\n`);
    }
    return redStepExitCode(result.verdict);
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
