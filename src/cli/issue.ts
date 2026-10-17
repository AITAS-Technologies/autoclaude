import { issueArg } from "./args.js";
import { repoRoot } from "../engine/root.js";
import { loadLedger, TERMINAL } from "../engine/ledger/ledger.js";
import { engineDeps, takeIssue, type TickCtx } from "../orchestrator/actions.js";
import { acquireInstance, recoverOrphans } from "../orchestrator/instance.js";
import { runLoop } from "../orchestrator/loop.js";
import { tick as realTick } from "../orchestrator/tick.js";
import { messageOf, usageError } from "./common.js";
import type { Io } from "./main.js";
import { lostExit, realContext, type RunDeps } from "./run.js";

const USAGE = "usage: autoclaude issue <n> [--replace]";

export interface IssueDeps extends RunDeps {
  take: typeof takeIssue;
  tick: typeof realTick;
}

const realDeps: IssueDeps = {
  root: repoRoot,
  context: realContext,
  signals: process,
  take: takeIssue,
  tick: realTick,
};

/** Where an attended run is done: the pull request is open (or further along). */
const DONE = new Set(["pr-open", "fixing-ci", "mergeable", "merged", "done"]);
/** States a human has to look at; the run ends there too, with exit 1. */
const HUMAN = new Set(["blocked", "needs-shaping", "closed", "resume-needed"]);

/**
 * `autoclaude issue <n> [--replace]`: one issue, attended, from claim to an open pull request.
 *
 * It is the orchestrator's own tick, driven for as long as this issue needs it, so there is
 * one pipeline and not two: it takes the project's instance (and refuses while an
 * orchestrator runs), claims the issue (unless the ledger already holds it), and ticks until
 * the issue reaches `pr-open` (exit 0) or a state a human must look at (exit 1). Step 4 is
 * held off through the situation the tick sees, so it claims nothing else. Ctrl-C stops
 * taking work; a second one kills the stage.
 */
export async function issueVerb(
  args: string[],
  io: Io,
  cwd: string,
  deps: IssueDeps = realDeps,
): Promise<number> {
  let n: number;
  try {
    const unknown = args.slice(1).find((a) => a !== "--replace");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    n = issueArg(args[0], USAGE);
  } catch (e) {
    return usageError(io, USAGE, messageOf(e));
  }
  const replace = args.includes("--replace");

  const first = new AbortController();
  const second = new AbortController();
  const lost = new AbortController();
  const onSignal = () => (first.signal.aborted ? second.abort() : first.abort());
  deps.signals.on("SIGINT", onSignal);
  deps.signals.on("SIGTERM", onSignal);

  let handle: ReturnType<typeof acquireInstance> | null = null;
  let ctx: TickCtx | null = null;
  try {
    const root = deps.root(cwd);
    try {
      // Taken over all the same: stop at once, never drain into the other instance's ledger (R68).
      handle = acquireInstance(root, { ...deps.instance, onLost: () => lost.abort() });
    } catch (e) {
      io.err(
        `${messageOf(e)}\nstop it first (autoclaude drain, then wait for autoclaude status to show nothing running), then run this again\n`,
      );
      return 1;
    }
    ctx = deps.context(root, handle.instance);
    const live = ctx;
    second.signal.addEventListener("abort", () => void live.stages.stopAll(), { once: true });
    lost.signal.addEventListener("abort", () => void live.stages.stopAll(), { once: true });

    // An attended run is about this one issue: the situation the tick reads offers an empty
    // queue and a closed gate (Step 4 claims nothing), and only this issue's entry, cleanup
    // and stalled rows, so the tick neither publishes, fixes nor waits for any other issue.
    const base = engineDeps(live).situation;
    live.deps = {
      ...live.deps,
      situation: (c) => {
        const s = base(c);
        return {
          ...s,
          issues: s.issues.filter((i) => i.issue === n),
          cleanup: s.cleanup.filter((i) => i.issue === n),
          stalled: s.stalled.filter((i) => i.issue === n),
          queue: [],
          newWork: {
            ...s.newWork,
            allowed: false,
            reasons: [...s.newWork.reasons, `attended run of #${n}`],
          },
        };
      },
    };

    const view = live.forge.viewIssue(n);
    if (view.state !== "OPEN") {
      io.err(`issue #${n} is closed\n`);
      return 1;
    }
    const killed = await recoverOrphans(root, loadLedger(root));
    if (killed.length > 0)
      io.err(`killed orphaned stages of: ${killed.map((k) => `#${k}`).join(", ")}\n`);

    const existing = loadLedger(root).issues[String(n)];
    if (existing === undefined || TERMINAL.has(existing.state) || existing.state === "merged") {
      const taken = await deps.take(live, { number: n, title: view.title }, replace);
      for (const line of taken.lines) io.out(`#${n}: ${line}\n`);
      if (!taken.won) return 1;
    } else {
      io.out(`#${n}: continuing from ${existing.state}\n`);
    }

    const state = () => loadLedger(root).issues[String(n)]?.state ?? null;
    await runLoop(live, first.signal, {
      force: second.signal,
      lost: lost.signal,
      log: (m) => io.err(`${m}\n`),
      tick: async (c, o) => {
        const summary = await deps.tick(c, o);
        for (const line of summary.changed) io.out(`${line}\n`);
        const now = state();
        const finished = now === null || DONE.has(now) || HUMAN.has(now);
        if (finished) first.abort();
        return { ...summary, stop: finished && summary.running.length === 0 };
      },
    });

    if (lost.signal.aborted) return lostExit(io);
    const entry = loadLedger(root).issues[String(n)];
    const final = entry?.state ?? null;
    io.out(
      `#${n}: ${final ?? "no longer in the ledger"}${entry?.lastError ? ` (${entry.lastError})` : ""}\n`,
    );
    return final !== null && DONE.has(final) ? 0 : 1;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  } finally {
    deps.signals.off("SIGINT", onSignal);
    deps.signals.off("SIGTERM", onSignal);
    await ctx?.stages.stopAll();
    handle?.release();
  }
}
