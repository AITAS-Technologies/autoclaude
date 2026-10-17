/**
 * Ctrl-C for a verb that runs stage processes outside the orchestrator loop (`review --pr`,
 * `triage`): the processes its runtimes start are tracked, and the first SIGINT/SIGTERM kills
 * them (a POSIX stage child is detached and would otherwise outlive this process) and refuses
 * to start more; the run then ends as interrupted. Handlers are removed again by `dispose`.
 */
import type { TickCtx } from "../orchestrator/actions.js";
import type { RuntimeAdapter } from "../runtimes/types.js";

export interface Interruptible {
  /** The context to hand the work: its runtimes are tracked. */
  ctx: TickCtx;
  interrupted(): boolean;
  /** Removes the handlers, kills what is still alive and stops the context's registry. */
  dispose(): Promise<void>;
}

export function interruptible(ctx: TickCtx, signals: NodeJS.Process): Interruptible {
  const procs = new Set<{ kill(): Promise<void> }>();
  let stopped = false;
  const killAll = async () => {
    await Promise.all([...procs].map((p) => p.kill().catch(() => {})));
  };
  const onSignal = () => {
    stopped = true;
    void killAll();
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  const tracked = (adapter: RuntimeAdapter): RuntimeAdapter => ({
    name: adapter.name,
    available: () => adapter.available(),
    start(req, cfg) {
      if (stopped) throw new Error("interrupted: no further process is started");
      const proc = adapter.start(req, cfg);
      procs.add(proc);
      const forget = () => procs.delete(proc);
      proc.done.then(forget, forget);
      return proc;
    },
  });
  return {
    ctx: { ...ctx, runtimes: (name) => tracked(ctx.runtimes(name)) },
    interrupted: () => stopped,
    async dispose() {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      await killAll();
      await ctx.stages.stopAll();
    },
  };
}
