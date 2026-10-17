import { flag, issueArg } from "./args.js";
import { repoRoot } from "../engine/root.js";
import { triageIssue, type TickCtx } from "../orchestrator/actions.js";
import { messageOf, usageError } from "./common.js";
import type { Io } from "./main.js";
import { realContext } from "./run.js";

const USAGE = "usage: autoclaude triage [--issue <n>]";

export interface TriageDeps {
  root: (cwd: string) => string;
  context: (root: string, instance: string) => TickCtx;
  triage: typeof triageIssue;
}

const realDeps: TriageDeps = { root: repoRoot, context: realContext, triage: triageIssue };

/** Decisions that are an answer; `failed` and `limit` are not. */
const FAILING = new Set(["failed", "limit"]);

/**
 * `autoclaude triage [--issue <n>]`: triage now. With `--issue`, that issue; without, the open
 * issues that carry the configured opt-in label (`triage.optInLabel`) and are neither ready,
 * working, blocked nor waiting to be shaped. Closed and human-assigned issues are filtered out
 * by the triage itself, which records a note for each skipped one. Exit 1 when any triage
 * failed or hit a usage limit.
 */
export async function triageVerb(
  args: string[],
  io: Io,
  cwd: string,
  deps: TriageDeps = realDeps,
): Promise<number> {
  let only: number | undefined;
  try {
    const unknown = args.find((a, i) => a !== "--issue" && args[i - 1] !== "--issue");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    const token = flag(args, "--issue");
    if (token !== undefined) only = issueArg(token, "--issue");
  } catch (e) {
    return usageError(io, USAGE, messageOf(e));
  }
  try {
    const root = deps.root(cwd);
    const ctx = deps.context(root, `triage-${process.pid}`);
    let numbers: number[];
    if (only !== undefined) numbers = [only];
    else {
      const label = ctx.cfg.triage?.optInLabel;
      if (label === undefined)
        return usageError(
          io,
          USAGE,
          "no issue given and triage.optInLabel is not set in the configuration: name the issue with --issue <n>",
        );
      const skip = new Set([
        ctx.cfg.queue.ready,
        ctx.cfg.labels.working,
        ctx.cfg.labels.blocked,
        ctx.cfg.labels.needsShaping,
      ]);
      numbers = ctx.forge
        .listIssues(label, "open", { comments: false })
        .filter((i) => !i.labels.some((l) => skip.has(l.name)))
        .map((i) => i.number);
      if (numbers.length === 0) io.out("nothing to triage\n");
    }
    let failed = false;
    for (const n of numbers) {
      const r = await deps.triage(ctx, n);
      io.out(`#${n}: ${r.decision} — ${r.reason}\n`);
      if (FAILING.has(r.decision)) failed = true;
    }
    return failed ? 1 : 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
