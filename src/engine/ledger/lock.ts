/**
 * The ledger's directory lock: one writer at a time.
 *
 * The ledger has two writers by design, the background loop and whoever runs the CLI
 * from a terminal, and a read-change-write with no lock lets the second writer save its
 * stale snapshot over the first one's transition. The lock is a directory, because
 * `mkdir` is atomic everywhere.
 *
 * A stale lock is taken over by renaming it to a unique name first, not by removing it:
 * `rename` is the atomic compare-and-swap here, so of two processes that see the same
 * stale lock exactly one succeeds, and the loser cannot delete the winner's fresh lock.
 * Only after the rename succeeds is the old directory removed.
 *
 * Two entry points share one protocol (same directory, same owner token): the
 * synchronous `withLedgerLock` for the CLI, which has nothing else to do while it
 * waits, and `withLedgerLockAsync` for the orchestrator, whose event loop must keep
 * running (heartbeats, child processes) while another process holds the lock.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `<root>/.autoclaude/state`, where the ledger, its lock, status and control files live. */
export const STATE_DIR = join(".autoclaude", "state");

/** A lock older than this belongs to a process that died holding it. */
const LOCK_STALE_MS = 30_000;
/** Longer than the stale age, so a lock left by a killed process is taken over rather than waited out. */
const LOCK_WAIT_MS = 45_000;
/** How long between two attempts while the lock is held. */
const POLL_MS = 25;
/** Windows returns these when an acquire overlaps another process's release; all mean "try again". */
export const RETRY_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

/** Blocks the thread. Only the synchronous paths use it; the async lock never does. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleepAsync = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

interface Held {
  lock: string;
  owner: string;
  token: string;
}

function newHeld(root: string): Held {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "ledger.lock");
  return {
    lock,
    owner: join(lock, "owner"),
    // Written into the lock and checked again on release: a holder whose lock was taken
    // over as stale must not delete its successor's fresh lock on the way out.
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

/**
 * Locks this process holds right now, by lock directory. The directory lock excludes
 * other processes; inside one process it is not enough. A synchronous caller blocks the
 * event loop while it waits, so a sync caller that meets this process's own async holder
 * could never see it finish, and after the staleness age would take the lock over as
 * "stale" and run both critical sections at once. So a sync caller fails at once instead
 * of waiting on itself, and async callers queue behind each other in `queues`.
 */
const heldHere = new Set<string>();
const queues = new Map<string, Promise<unknown>>();

type Attempt = "acquired" | "again" | { age: number; readable: boolean };

/** One try at taking the lock. `again` means a stale lock was cleared: retry at once. */
function attempt(h: Held): Attempt {
  try {
    mkdirSync(h.lock);
    writeFileSync(h.owner, h.token);
    return "acquired";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!RETRY_CODES.has(code)) throw error;
    let age = 0;
    let readable = true;
    try {
      age = Date.now() - statSync(h.lock).mtimeMs;
    } catch {
      // Released between the two calls, or unreadable. Either way this is not a free
      // retry: the caller falls through to its deadline and its sleep, because retrying
      // at once turned a permanent stat failure into an untimed busy loop.
      readable = false;
    }
    if (readable && age > LOCK_STALE_MS) {
      const taken = `${h.lock}.taken-${process.pid}-${Date.now()}`;
      try {
        renameSync(h.lock, taken);
        rmSync(taken, { recursive: true, force: true });
      } catch {
        // Another process took it over first; compete for the fresh lock normally.
      }
      return "again";
    }
    return { age, readable };
  }
}

function busy(h: Held, state: { age: number; readable: boolean }): Error {
  return new Error(
    `the ledger is locked by another process (${h.lock}, ${state.readable ? `${Math.round(state.age / 1000)} s old` : "age unreadable"}); retry, or remove that directory if the process is gone`,
  );
}

function release(h: Held): void {
  // Only if it is still ours. Between acquiring and releasing, a slow `gh` call or a
  // suspended laptop can push us past LOCK_STALE_MS and let another process take the
  // lock over; removing it then would delete that process's lock, not ours.
  let mine = false;
  try {
    mine = readFileSync(h.owner, "utf8") === h.token;
  } catch {
    mine = false;
  }
  // The write has committed by now, so a failure to let go must not be reported as a
  // failure to write: retry a transient EPERM, then leave the lock to the staleness rule
  // rather than throwing out of the `finally`.
  if (mine) {
    try {
      rmSync(h.lock, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch (error) {
      process.emitWarning(
        `the ledger lock could not be released (${h.lock}): ${String(error)}; it will be taken over as stale in ${LOCK_STALE_MS / 1000} s`,
      );
    }
  }
}

export function withLedgerLock<T>(root: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  const h = newHeld(root);
  if (heldHere.has(h.lock)) {
    throw new Error(
      `ledger lock already held by this process (${h.lock}); a synchronous caller cannot wait for its own process's holder, so it must not run inside or beside a withLedgerLockAsync section`,
    );
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = attempt(h);
    if (got === "acquired") break;
    if (got === "again") continue;
    if (Date.now() > deadline) throw busy(h, got);
    sleepSync(POLL_MS);
  }
  heldHere.add(h.lock);
  try {
    return fn();
  } finally {
    heldHere.delete(h.lock);
    release(h);
  }
}

/**
 * `withLedgerLock` for callers that must not block the event loop while they wait:
 * the same directory, the same owner token and staleness rule, polling with `setTimeout`.
 * `fn` may be asynchronous; the lock is held until its promise settles.
 */
export async function withLedgerLockAsync<T>(
  root: string,
  fn: () => Promise<T> | T,
  waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
  const h = newHeld(root);
  // In-process callers go one after the other before anyone polls the directory.
  const before = queues.get(h.lock) ?? Promise.resolve();
  const run = before.then(async () => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const got = attempt(h);
      if (got === "acquired") break;
      if (got === "again") continue;
      if (Date.now() > deadline) throw busy(h, got);
      await sleepAsync(POLL_MS);
    }
    heldHere.add(h.lock);
    try {
      return await fn();
    } finally {
      heldHere.delete(h.lock);
      release(h);
    }
  });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(h.lock, settled);
  void settled.then(() => {
    if (queues.get(h.lock) === settled) queues.delete(h.lock);
  });
  return run;
}
