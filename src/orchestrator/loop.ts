/**
 * The run loop: tick, then sleep until the earlier of the tick's next wake time and any stage's
 * exit, and tick again — until the tick says stop (draining with nothing running), or a signal.
 *
 * Shutdown has two steps, because a stage can run for an hour. The first signal (`signal`)
 * stops taking work: no further tick, the loop waits for what runs to finish. The second
 * (`opts.force`) kills every process the loop's stages started, review children included, and
 * returns. Whatever a stage left unconsumed is decided by the next start (the stage record
 * outlives its process; recovery and the tick's late-report rows read it).
 *
 * No ledger lock is held here: the tick takes it for short bodies only.
 */
import type { TickCtx } from "./actions.js";
import { tick, type TickSummary } from "./tick.js";

export interface LoopOptions {
  /** The second signal: kill the children and return. */
  force?: AbortSignal;
  /** Replaces `tick` (tests). */
  tick?: (ctx: TickCtx) => Promise<TickSummary>;
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
  const stages = ctx.stages;
  const onForce = () => void stages.stopAll();
  force.addEventListener("abort", onForce, { once: true });
  try {
    while (!signal.aborted && !force.aborted) {
      const mark = stages.settledCount;
      let wakeMs: number;
      try {
        const summary = await run(ctx);
        if (summary.stop) return;
        wakeMs = summary.nextWakeMs;
      } catch (error) {
        log(`tick failed, trying again: ${(error as Error).message}`);
        wakeMs = opts.errorRetryMs ?? ERROR_RETRY_MS;
      }
      await sleepUntil(wakeMs, stages.next(mark), [signal, force]);
    }
    // Shut down: take nothing more; let the running stages finish unless forced.
    while (stages.running().length > 0 && !force.aborted) {
      await sleepUntil(MAX_SLEEP_MS, stages.next(stages.settledCount), [force]);
    }
  } finally {
    force.removeEventListener("abort", onForce);
    // Nothing the loop started outlives it: a stage still running here is killed with every
    // review child it owns (they are detached on POSIX and would not die with us).
    await stages.stopAll();
  }
}
