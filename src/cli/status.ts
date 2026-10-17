import { existsSync } from "node:fs";
import { normalizeRollup, requiredCheckProblems, type Outcome } from "../engine/merge/can-merge.js";
import { controlState } from "../engine/control.js";
import { loadLedger } from "../engine/ledger/ledger.js";
import { profileAt } from "../engine/profile.js";
import { readInstance, STALE_HEARTBEAT_MS } from "../orchestrator/instance.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude status";

/** One word per pull request, by the same rule `can-merge` applies to its required checks. */
export function gatesLine(
  rollup: Array<{ name: string; outcome: Outcome }>,
  required: string[],
): string {
  if (!rollup.length) return "no gates reported";
  const problems = requiredCheckProblems(rollup, required);
  if (!problems.length) return "all green";
  const failed = problems.filter((p) => p.endsWith(": fail"));
  if (failed.length) return `red: ${failed.map((p) => p.split(":")[0]).join(", ")}`;
  return `waiting: ${problems.join(", ")}`;
}

function clock(iso: string | undefined): string {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime())
    ? "?"
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * `autoclaude status`: the ledger and a live look at every open pull request's gates. Reads
 * the ledger, never asks the orchestrator, so it works while the orchestrator runs, sleeps or
 * died at three in the morning. The recorded instance is shown with its liveness (a heartbeat
 * of at most 120 s), and a stage of any other instance reads as gone.
 */
export async function statusVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  if (args.length > 0) return usageError(io, USAGE, `unknown argument: ${args[0]}`);
  try {
    const root = env.root(cwd);
    const cfg = env.config(root);
    const now = env.now();
    const ledger = loadLedger(root);
    const control = controlState(root);
    const profile = profileAt(now, cfg);
    const recorded = readInstance(root);
    let live: string | null = null;
    let instanceText = "instance none recorded";
    if (recorded !== null) {
      const age = Math.round((now.getTime() - Date.parse(recorded.heartbeatAt)) / 1000);
      if (Number.isFinite(age) && age * 1000 <= STALE_HEARTBEAT_MS) {
        live = recorded.instance;
        instanceText = `instance ${recorded.instance} (live, heartbeat ${age} s ago)`;
      } else {
        instanceText = `instance ${recorded.instance} (not live: heartbeat ${Number.isFinite(age) ? `${age} s old` : "unreadable"})`;
      }
    }
    const forge = env.forge(cfg, root);
    const gates = (pr: number): string => {
      try {
        return gatesLine(normalizeRollup(forge.viewPr(pr).statusCheckRollup), cfg.requiredChecks);
      } catch (error) {
        return `gh failed: ${messageOf(error).slice(0, 60)}`;
      }
    };

    io.out(
      `autoclaude status - ${now.toLocaleString()}  (${instanceText}; profile ${profile.name}, concurrency ${profile.concurrency})\n\n`,
    );
    io.out(
      "ISSUE  STATE          PR    GATES                 ATTEMPTS (impl/fix/retry)  STAGE                 SINCE\n",
    );
    for (const e of Object.values(ledger.issues).sort((a, b) => a.issue - b.issue)) {
      const g =
        e.pr && ["pr-open", "fixing-ci", "mergeable", "merged"].includes(e.state)
          ? gates(e.pr)
          : "-";
      let stage = "-";
      if (e.stage) {
        stage = `${e.stage.stage}/${e.stage.mode}`;
        if (e.stage.instance !== live) stage += " (instance gone)";
      } else if (e.limitedStage) {
        stage = `limited: ${e.limitedStage}`;
      }
      const a = e.attempts ?? { implement: 0, fix: 0, reviewRetry: 0 };
      io.out(
        `#${String(e.issue).padEnd(5)} ${e.state.padEnd(14)} ${String(e.pr ?? "-").padEnd(5)} ${g.padEnd(21)} ${`${a.implement ?? 0}/${a.fix ?? 0}/${a.reviewRetry ?? 0}`.padEnd(26)} ${stage.padEnd(21)} ${clock(e.claimedAt)}\n`,
      );
      // Only the bad news is printed: a directory that is there needs no line.
      if (e.worktree && !existsSync(e.worktree)) io.out(`       worktree gone: ${e.worktree}\n`);
      if (e.lastError) io.out(`       reason: ${e.lastError}\n`);
      if (e.limitedStage && ledger.limitedUntil)
        io.out(`       ${e.limitedStage} resumes after ${ledger.limitedUntil}\n`);
      else if (e.limitedStage)
        io.out(
          `       ${e.limitedStage} was interrupted by a usage limit; it resumes on the next tick\n`,
        );
    }
    io.out("\n");
    for (const f of ledger.foreign)
      io.out(
        `FOREIGN #${f.issue} claimed by ${f.machine} at ${f.at ?? "?"}${f.stale ? "  (stale, may be taken over)" : ""}\n`,
      );
    io.out("SPEND   not measured in this version\n");
    io.out(
      `LIMITS  ${ledger.limitedUntil ? `limited until ${ledger.limitedUntil}` : "none recorded"}\n`,
    );
    io.out(
      `CONTROL ${control.paused ? "PAUSED" : control.draining ? "DRAINING" : "running"}${control.paused && control.draining ? " (both files present; run autoclaude resume)" : ""}\n`,
    );
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
