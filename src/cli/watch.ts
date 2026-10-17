import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { flag, issueArg } from "./args.js";
import { loadLedger, recentNotes, type Ledger } from "../engine/ledger/ledger.js";
import { STATE_DIR } from "../engine/ledger/lock.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude watch [--issue <n>] [--interval <seconds>] [--once]";
/** The tail shown per issue on screen; status.md's own "Running" section carries 8. */
const TAIL_LINES = 20;
const DEFAULT_INTERVAL_SECONDS = 5;
/** Clears the scrollback and homes the cursor, so the previous frame never lingers under the new one. */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * Which issues to show. `explicit` bypasses the ledger entirely, even for an issue it has
 * never heard of; otherwise every entry with a live stage, newest first.
 */
export function pickIssues(ledger: Ledger, explicit?: number): number[] {
  if (explicit !== undefined) return [explicit];
  return Object.values(ledger.issues)
    .flatMap((entry) =>
      entry.stage ? [{ issue: entry.issue, startedAt: entry.stage.startedAt }] : [],
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map((e) => e.issue);
}

export interface IssueTail {
  issue: number;
  /** The log's last lines, oldest first; empty when the issue has no log yet. */
  lines: string[];
}

/** The screen for one refresh, from already-read file contents: no file system access here. */
export function renderWatch(params: {
  statusMd: string | null;
  tails: IssueTail[];
  now: Date;
}): string {
  const { statusMd, tails, now } = params;
  const lines: string[] = [
    `refreshed ${now.toISOString()}`,
    "",
    statusMd ?? "no status.md yet",
    "",
  ];
  for (const tail of tails) {
    lines.push(`## #${tail.issue}`, ...(tail.lines.length ? tail.lines : ["no events yet"]), "");
  }
  return lines.join("\n");
}

export interface WatchDeps {
  /** Waits between frames; replaced by tests. */
  sleep: (ms: number, stop: AbortSignal) => Promise<void>;
  /** Ends the watch; the process's SIGINT/SIGTERM by default. */
  stop?: AbortSignal;
}

const realSleep = (ms: number, stop: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    stop.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });

/**
 * `autoclaude watch`: the terminal watcher for a run. Clears the screen every few seconds
 * and prints `status.md` plus the tail of each running issue's log. Reads files only: never
 * `gh`, never the ledger lock, so a watcher can never make a stage wait.
 */
export async function watchVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps: Partial<WatchDeps> = {},
): Promise<number> {
  let explicit: number | undefined;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--issue" || a === "--interval") i++;
      else if (a !== "--once") throw new Error(`unknown argument: ${a}`);
    }
    const token = flag(args, "--issue");
    if (token !== undefined) explicit = issueArg(token, "--issue");
    const interval = flag(args, "--interval");
    if (interval !== undefined) {
      intervalSeconds = Number(interval);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0)
        throw new Error(`--interval must be a positive number of seconds, got "${interval}"`);
    }
  } catch (e) {
    return usageError(io, USAGE, messageOf(e));
  }
  const once = args.includes("--once");

  let root: string;
  try {
    root = env.root(cwd);
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
  const frame = (): void => {
    const ledger = loadLedger(root);
    const file = join(root, STATE_DIR, "status.md");
    const statusMd = existsSync(file) ? readFileSync(file, "utf8") : null;
    const tails = pickIssues(ledger, explicit).map((issue) => ({
      issue,
      lines: recentNotes(root, issue, TAIL_LINES),
    }));
    io.out(CLEAR_SCREEN);
    io.out(`${renderWatch({ statusMd, tails, now: env.now() })}\n`);
  };

  try {
    frame();
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
  if (once) return 0;

  const controller = new AbortController();
  const stop = deps.stop ?? controller.signal;
  const onSignal = () => controller.abort();
  if (deps.stop === undefined) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    const sleep = deps.sleep ?? realSleep;
    while (!stop.aborted) {
      await sleep(intervalSeconds * 1000, stop);
      if (stop.aborted) break;
      // A later frame must not end the watcher: status.md and ledger.json are written by
      // rename, and a read that lands mid-rename is a transient the next frame forgets.
      try {
        frame();
      } catch (e) {
        io.err(`watch: ${messageOf(e)}\n`);
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}
