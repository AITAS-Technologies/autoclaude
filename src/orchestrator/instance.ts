/**
 * One orchestrator instance per project, and the recovery of what a dead one left behind.
 *
 * `instance.json` (`{ instance, pid, startedAt, heartbeatAt }` under `.autoclaude/state/`, the
 * format `recordedInstance` reads) is the lock: it names the process that owns the project, by
 * pid and process start time, and says when it last proved it was alive. A second orchestrator
 * refuses for as long as that process is alive, however old its heartbeat (R68): a synchronous
 * git call or a bootstrap can stall the heartbeat of a process that is still working, and two
 * live instances fight over the ledger. It takes the file over once the process is gone, or the
 * pid now belongs to another process. The write is a temp file and a rename, so a reader never
 * sees half a file.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../engine/ledger/lock.js";
import { renameWithRetry, withLedgerLock, type Ledger } from "../engine/ledger/ledger.js";
import { killTree, processStartTime } from "../platform/kill.js";

export const HEARTBEAT_MS = 30_000;
export const STALE_HEARTBEAT_MS = 120_000;
/** POSIX start times have second precision and can shift after a clock step (ruling R19). */
export const POSIX_START_TOLERANCE_MS = 2_000;

export interface InstanceFile {
  instance: string;
  pid: number;
  /** The process start time `processStartTime` reported; null in a file written before it was kept. */
  startedAt: string | null;
  heartbeatAt: string;
}

export interface InstanceDeps {
  now: () => Date;
  pid: number;
  /** The start time of the process with this pid, or null when there is none. */
  startTime: (pid: number) => string | null;
  platform: NodeJS.Platform;
  heartbeatMs: number;
  newId: () => string;
  /** Called once when the heartbeat finds another instance in the file. */
  onLost: () => void;
}

const defaults = (): InstanceDeps => ({
  now: () => new Date(),
  pid: process.pid,
  startTime: processStartTime,
  platform: process.platform,
  heartbeatMs: HEARTBEAT_MS,
  newId: () => randomUUID(),
  onLost: () => {},
});

const instancePath = (root: string): string => join(root, STATE_DIR, "instance.json");

export function readInstance(root: string): InstanceFile | null {
  try {
    const text = readFileSync(instancePath(root), "utf8").replace(/^﻿/, "");
    const v = JSON.parse(text) as Partial<InstanceFile>;
    if (typeof v.instance !== "string" || typeof v.pid !== "number") return null;
    return {
      instance: v.instance,
      pid: v.pid,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : null,
      heartbeatAt: String(v.heartbeatAt ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * The orchestrator instance that is alive now: the one in `instance.json` when its heartbeat
 * is at most 120 s old, else null. `status` and `situation` pass it as the live instance, so a
 * stage of any other instance reads as dead. The pid is not probed: a reader that only looks
 * (and may run on a machine where the pid is not visible) trusts the heartbeat, which a live
 * orchestrator renews every 30 s.
 */
export function liveInstance(
  root: string,
  now: Date = new Date(),
): { instance: string; pid: number; heartbeatAt: string; ageMs: number } | null {
  const held = readInstance(root);
  if (held === null) return null;
  const beat = Date.parse(held.heartbeatAt);
  if (!Number.isFinite(beat)) return null;
  const ageMs = now.getTime() - beat;
  return ageMs <= STALE_HEARTBEAT_MS ? { ...held, ageMs } : null;
}

function writeInstance(root: string, file: InstanceFile, pid: number): void {
  const path = instancePath(root);
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  const tmp = `${path}.${pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
    renameWithRetry(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Is the process `held` names still the one that wrote it? By pid and start time, the identity
 * orphan recovery uses (R19), never by the heartbeat alone. A file from before the start time was
 * kept falls back to the old reading: a live pid with a fresh heartbeat.
 */
function holderAlive(held: InstanceFile, d: InstanceDeps): boolean {
  const actual = d.startTime(held.pid);
  if (held.startedAt !== null) return sameProcess(held.startedAt, actual, d.platform);
  const beat = Date.parse(held.heartbeatAt);
  const fresh = Number.isFinite(beat) && d.now().getTime() - beat <= STALE_HEARTBEAT_MS;
  return fresh && actual !== null;
}

/**
 * Take the project's instance. Throws "already running", naming the pid and how to stop it,
 * while the process that holds it is alive (R68). `release()` stops the heartbeat and removes
 * the file if it is still ours.
 */
export function acquireInstance(
  root: string,
  overrides: Partial<InstanceDeps> = {},
): { instance: string; release(): void } {
  const d = { ...defaults(), ...overrides };
  const instance = d.newId();
  const startedAt = d.startTime(d.pid);
  const beatNow = () =>
    writeInstance(
      root,
      { instance, pid: d.pid, startedAt, heartbeatAt: d.now().toISOString() },
      d.pid,
    );
  // Read-check-write under the ledger lock: of two processes that both saw a dead or absent
  // holder, the second one reads the first one's file and refuses. The body is short (one
  // liveness probe, one rename).
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  withLedgerLock(root, () => {
    const held = readInstance(root);
    if (held !== null && holderAlive(held, d)) {
      const stop = d.platform === "win32" ? `taskkill /PID ${held.pid}` : `kill ${held.pid}`;
      throw new Error(
        `autoclaude is already running for this project as pid ${held.pid} (instance ${held.instance}, last heartbeat ${held.heartbeatAt}). Stop it first: \`autoclaude drain\` lets it finish its stages and exit, or end the process (Ctrl-C in its terminal, or \`${stop}\`)`,
      );
    }
    beatNow();
  });

  let timer: NodeJS.Timeout | null = setInterval(() => {
    try {
      const now = readInstance(root);
      if (now !== null && now.instance !== instance) {
        // Another instance took the project over (this process slept past 120 s): never
        // write over it, and tell the loop to stop taking work.
        if (timer !== null) clearInterval(timer);
        timer = null;
        d.onLost();
        return;
      }
      beatNow();
    } catch {
      /* a failed beat is retried at the next one; the file ages out only after 120 s */
    }
  }, d.heartbeatMs);
  timer.unref();

  return {
    instance,
    release() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      try {
        if (readInstance(root)?.instance === instance) unlinkSync(instancePath(root));
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Is `actual` (the start time of the process now holding a pid) the start time recorded for
 * the stage? Windows values are exact; POSIX values have second precision and can shift by a
 * second after a clock step, so they match within 2 s. A missing value never matches.
 */
export function sameProcess(
  recorded: string | null,
  actual: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (recorded === null || actual === null) return false;
  if (recorded === actual) return true;
  if (platform === "win32") return false;
  const a = Date.parse(recorded);
  const b = Date.parse(actual);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= POSIX_START_TOLERANCE_MS;
}

export interface RecoverDeps {
  startTime: (pid: number) => string | null;
  kill: (pid: number) => Promise<void>;
  platform: NodeJS.Platform;
  /** The instance that is running now; stages of any other are orphans. Default: the ledger's. */
  own: string | null;
}

/**
 * Kill the stage processes a crash, a sleep or a reboot orphaned: for every stage recorded by
 * another instance, the pid is killed (with its tree) only when it is alive and its start time
 * proves it is the process the stage started — a reused pid is left alone. A record whose
 * process is already gone stays: the reconcile turns its entry into `resume-needed`, and the
 * tick decides a report it left behind. Returns the issues whose process was killed.
 */
export async function recoverOrphans(
  _root: string,
  ledger: Ledger,
  overrides: Partial<RecoverDeps> = {},
): Promise<number[]> {
  const d: RecoverDeps = {
    startTime: processStartTime,
    kill: killTree,
    platform: process.platform,
    own: ledger.instance,
    ...overrides,
  };
  const killed: number[] = [];
  for (const entry of Object.values(ledger.issues)) {
    const stage = entry.stage;
    if (stage === null || stage.instance === d.own) continue;
    if (stage.pid === null || stage.pid === process.pid) continue;
    const actual = d.startTime(stage.pid);
    if (!sameProcess(stage.processStartedAt, actual, d.platform)) continue;
    await d.kill(stage.pid);
    killed.push(entry.issue);
  }
  return killed;
}
