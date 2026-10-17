import { loadProjectConfig } from "../config/load.js";
import { appendNoteBestEffort, loadLedger } from "../engine/ledger/ledger.js";
import { repoRoot } from "../engine/root.js";
import { Forge, realExec, resolveRepo } from "../forge/github.js";
import { StageRegistry, type TickCtx } from "../orchestrator/actions.js";
import { acquireInstance, recoverOrphans } from "../orchestrator/instance.js";
import { runLoop } from "../orchestrator/loop.js";
import { tick } from "../orchestrator/tick.js";
import { runtimeFor } from "../runtimes/registry.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude run [--once]\n";

export interface RunDeps {
  root: (cwd: string) => string;
  /** The context the orchestrator runs with, for a root and the instance it holds. */
  context: (root: string, instance: string) => TickCtx;
  /** Where the termination signals come from. */
  signals: NodeJS.Process;
}

function realContext(root: string, instance: string): TickCtx {
  const cfg = loadProjectConfig(root);
  return {
    root,
    cfg,
    forge: new Forge(resolveRepo(cfg.forge.remote, root), realExec),
    exec: realExec,
    instance,
    now: () => new Date(),
    runtimes: runtimeFor,
    notes: (issue, text) => {
      try {
        appendNoteBestEffort(root, issue, text, null, new Date());
      } catch {
        /* a note is never worth a crash */
      }
    },
    stages: new StageRegistry(),
  };
}

/**
 * `autoclaude run [--once]`: the long-running orchestrator the autostart service starts.
 * Takes the project's instance, kills what a crashed predecessor orphaned, then ticks until
 * draining or a signal. `--once` runs one tick and exits (0, or 1 when the tick failed); a
 * stage it dispatched is stopped on the way out and picked up by the next run as interrupted.
 */
export async function runVerb(
  args: string[],
  io: Io,
  cwd: string,
  deps: RunDeps = { root: repoRoot, context: realContext, signals: process },
): Promise<number> {
  const unknown = args.filter((a) => a !== "--once");
  if (unknown.length > 0) {
    io.err(`unknown argument: ${unknown[0]}\n${USAGE}`);
    return 64;
  }
  const once = args.includes("--once");

  let handle: ReturnType<typeof acquireInstance> | null = null;
  try {
    const root = deps.root(cwd);
    handle = acquireInstance(root);
    const ctx = deps.context(root, handle.instance);
    const killed = await recoverOrphans(root, loadLedger(root));
    if (killed.length > 0)
      io.err(`killed orphaned stages of: ${killed.map((n) => `#${n}`).join(", ")}\n`);

    if (once) {
      try {
        const summary = await tick(ctx);
        for (const line of summary.changed) io.out(`${line}\n`);
        return 0;
      } finally {
        await ctx.stages.stopAll();
      }
    }

    const first = new AbortController();
    const second = new AbortController();
    const onSignal = () => (first.signal.aborted ? second.abort() : first.abort());
    deps.signals.on("SIGINT", onSignal);
    deps.signals.on("SIGTERM", onSignal);
    try {
      await runLoop(ctx, first.signal, {
        force: second.signal,
        log: (m) => io.err(`${m}\n`),
      });
    } finally {
      deps.signals.off("SIGINT", onSignal);
      deps.signals.off("SIGTERM", onSignal);
    }
    return 0;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  } finally {
    handle?.release();
  }
}
