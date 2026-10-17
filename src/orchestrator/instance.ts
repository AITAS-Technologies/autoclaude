/**
 * One orchestrator instance per project, and the recovery of what a dead one left behind.
 *
 * `instance.json` (`{ instance, pid, heartbeatAt }` under `.autoclaude/state/`, the format
 * `recordedInstance` reads) is the lock: it names the process that owns the project and says
 * when it last proved it was alive. A second orchestrator refuses while the first is alive;
 * it takes the file over when the pid is gone or the heartbeat is older than two minutes (a
 * laptop that slept, a process that hangs). The write is a temp file and a rename, so a reader
 * never sees half a file.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../engine/ledger/lock.js";
import { renameWithRetry, type Ledger } from "../engine/ledger/ledger.js";
import { killTree, processStartTime } from "../platform/kill.js";

export const HEARTBEAT_MS = 30_000;
export const STALE_HEARTBEAT_MS = 120_000;
/** POSIX start times have second precision and can shift after a clock step (ruling R19). */
export const POSIX_START_TOLERANCE_MS = 2_000;

export interface InstanceFile {
  instance: string;
  pid: number;
  heartbeatAt: string;
}

export interface InstanceDeps {
  now: () => Date;
  pid: number;
  /** Is a process with this pid alive? */
  alive: (pid: number) => boolean;
  heartbeatMs: number;
  newId: () => string;
}

const defaults = (): InstanceDeps => ({
  now: () => new Date(),
  pid: process.pid,
  alive: (pid) => processStartTime(pid) !== null,
  heartbeatMs: HEARTBEAT_MS,
  newId: () => randomUUID(),
});

const instancePath = (root: string): string => join(root, STATE_DIR, "instance.json");

function readInstance(root: string): InstanceFile | null {
  try {
    const text = readFileSync(instancePath(root), "utf8").replace(/^﻿/, "");
    const v = JSON.parse(text) as Partial<InstanceFile>;
    if (typeof v.instance !== "string" || typeof v.pid !== "number") return null;
    return { instance: v.instance, pid: v.pid, heartbeatAt: String(v.heartbeatAt ?? "") };
  } catch {
    return null;
  }
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
 * Take the project's instance. Throws "already running" while another live process holds it
 * with a heartbeat younger than 120 s. `release()` stops the heartbeat and removes the file if
 * it is still ours.
 */
export function acquireInstance(
  root: string,
  overrides: Partial<InstanceDeps> = {},
): { instance: string; release(): void } {
  const d = { ...defaults(), ...overrides };
  const held = readInstance(root);
  if (held !== null) {
    const beat = Date.parse(held.heartbeatAt);
    const fresh = Number.isFinite(beat) && d.now().getTime() - beat <= STALE_HEARTBEAT_MS;
    if (fresh && d.alive(held.pid)) {
      throw new Error(
        `autoclaude is already running for this project (pid ${held.pid}, instance ${held.instance}, heartbeat ${held.heartbeatAt})`,
      );
    }
  }
  const instance = d.newId();
  const beatNow = () =>
    writeInstance(root, { instance, pid: d.pid, heartbeatAt: d.now().toISOString() }, d.pid);
  beatNow();
  // Two processes that took over the same dead file at once: the later rename wins, and the
  // earlier one finds another id here and gives up.
  if (readInstance(root)?.instance !== instance) {
    throw new Error("autoclaude is already running for this project (lost the race for it)");
  }

  let timer: NodeJS.Timeout | null = setInterval(() => {
    try {
      // Never resurrect a file another instance took over.
      const now = readInstance(root);
      if (now === null || now.instance === instance) beatNow();
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
