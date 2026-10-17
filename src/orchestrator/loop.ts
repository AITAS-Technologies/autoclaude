/**
 * The run loop: tick, then sleep until the earlier of the tick's next wake time and any stage's
 * exit, and tick again — until the tick says stop (draining with nothing running), or a signal.
 *
 * Shutdown has two steps, because a stage can run for an hour. The first signal (`signal`)
 * stops taking work: the loop keeps ticking so what finishes is settled, but `noNewWork` is
 * asked before every dispatch, in-flight ticks included, and the loop returns once nothing
 * runs. The second (`opts.force`) kills every process the loop's stages started, review
 * children included, and returns. A finished outcome whose follow-up would dispatch stays
 * unconsumed; the next start decides it (the stage record outlives its process; the tick's
 * late-report rows read it).
 *
 * Losing the instance (`opts.lost`: the heartbeat found another instance in `instance.json`)
 * does not drain (R68). The ledger is the other instance's now, and every tick of this one
 * would reconcile that instance's live stages into `resume-needed`: the loop stops at once,
 * with no further tick, kills its stages, and the tick in flight acts on nothing more.
 *
 * No ledger lock is held here: the tick takes it for short bodies only.
 */
import type { TickCtx } from "./actions.js";
import { tick, type TickOptions, type TickSummary } from "./tick.js";

export interface LoopOptions {
  /** The second signal: kill the children and return. */
  force?: AbortSignal;
  /** The instance was taken over: no further tick, the children killed, nothing more written. */
  lost?: AbortSignal;
  /** Replaces `tick` (tests). */
  tick?: (ctx: TickCtx, opts: TickOptions) => Promise<TickSummary>;
  /** Where a failed tick is reported. */
  log?: (message: string) => void;
  /** How long to wait after a failed tick (gh down, a truncated listing) before the next. */
  errorRetryMs?: number;
}

/** The longest and shortest sleeps; setTimeout cannot hold more than 2^31 - 1 ms. */
const MAX_SLEEP_MS = 2 ** 31 - 1;
const MIN_SLEEP_MS = 100;
const ERROR_RETRY_MS = 60_000;

/** Resolves on the timer, on `until`, or when any abort signal fires; cleans up after itself. */
function sleepUntil(ms: number, until: Promise<void>, aborts: AbortSignal[]): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(finish, Math.min(Math.max(ms, MIN_SLEEP_MS), MAX_SLEEP_MS));
    function finish(): void {
      clearTimeout(timer);
      for (const s of aborts) s.removeEventListener("abort", finish);
      done();
    }
    for (const s of aborts) {
      if (s.aborted) return finish();
      s.addEventListener("abort", finish, { once: true });
    }
    void until.then(finish);
  });
}

export async function runLoop(
  ctx: TickCtx,
  signal: AbortSignal,
  opts: LoopOptions = {},
): Promise<void> {
  const run = opts.tick ?? tick;
  const log = opts.log ?? (() => {});
  const force = opts.force ?? new AbortController().signal;
  const lost = opts.lost ?? new AbortController().signal;
  const stages = ctx.stages;
  const onForce = () => void stages.stopAll();
  force.addEventListener("abort", onForce, { once: true });
  lost.addEventListener("abort", onForce, { once: true });
  // One exit waiter per mark, not one per idle iteration: the registry keeps every waiter it
  // is handed until the next stage settles.
  let waiter: { mark: number; until: Promise<void> } | null = null;
  const exitAfter = (mark: number): Promise<void> => {
    if (waiter === null || waiter.mark !== mark) waiter = { mark, until: stages.next(mark) };
    return waiter.until;
  };
  /** Shutting down: the first signal, or a second one. */
  const stopping = () => signal.aborted || force.aborted;
  const done = () => stopping() && stages.running().length === 0;
  try {
    while (!force.aborted && !lost.aborted) {
      const mark = stages.settledCount;
      let wakeMs: number;
      try {
        // After the first signal the tick still runs, to settle what finishes, but starts nothing.
        const summary = await run(ctx, { noNewWork: stopping, halt: () => lost.aborted });
        if (summary.stop || lost.aborted) return;
        wakeMs = summary.nextWakeMs;
      } catch (error) {
        if (lost.aborted) return;
        log(`tick failed, trying again: ${(error as Error).message}`);
        wakeMs = opts.errorRetryMs ?? ERROR_RETRY_MS;
      }
      if (done()) return;
      const aborts = signal.aborted ? [force, lost] : [signal, force, lost];
      await sleepUntil(wakeMs, exitAfter(mark), aborts);
    }
  } finally {
    force.removeEventListener("abort", onForce);
    lost.removeEventListener("abort", onForce);
    // Nothing the loop started outlives it: a stage still running here is killed with every
    // review child it owns (they are detached on POSIX and would not die with us).
    await stages.stopAll();
  }
}
