import { prArg } from "./args.js";
import { canMerge, renderVerdict } from "../engine/merge/can-merge.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude can-merge <pr> [--json]";

type Verdict = ReturnType<typeof canMerge>;

export interface CanMergeVerbDeps {
  canMerge: (n: number) => Verdict;
}

/** `autoclaude can-merge <pr> [--json]`: exit 0 when the merge is allowed, 1 when refused or on any failure. */
export async function canMergeVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps?: CanMergeVerbDeps,
): Promise<number> {
  const unknown = args.slice(1).find((a) => a !== "--json");
  if (unknown !== undefined) return usageError(io, USAGE, `unknown argument: ${unknown}`);
  let n: number;
  try {
    n = prArg(args[0], USAGE);
  } catch (e) {
    return usageError(io, USAGE, messageOf(e));
  }
  try {
    let verdict: Verdict;
    if (deps) verdict = deps.canMerge(n);
    else {
      const root = env.root(cwd);
      const cfg = env.config(root);
      verdict = canMerge(n, { forge: env.forge(cfg, root), exec: env.exec, root, cfg });
    }
    io.out(
      `${args.includes("--json") ? JSON.stringify(verdict, null, 2) : renderVerdict(n, verdict)}\n`,
    );
    return verdict.allowed ? 0 : 1;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
