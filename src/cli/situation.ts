import { loadLedger, machineId } from "../engine/ledger/ledger.js";
import { computeSituation } from "../engine/situation.js";
import { liveInstance, readInstance } from "../orchestrator/instance.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude situation [--read-only] [--full] [--pretty]";
const FLAGS = ["--read-only", "--full", "--pretty"];

/**
 * `autoclaude situation`: what the next tick sees, as one JSON line (`--pretty` indents it).
 * Without `--read-only` it reconciles and saves the ledger, as the tick does; with it nothing
 * is written. The recorded orchestrator instance is passed as live when its heartbeat is
 * fresh (at most 120 s), else none, and the output says which. `--full` gives every ledger
 * field of each issue instead of the compact set.
 */
export async function situationVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  const unknown = args.find((a) => !FLAGS.includes(a));
  if (unknown !== undefined) return usageError(io, USAGE, `unknown argument: ${unknown}`);
  try {
    const root = env.root(cwd);
    const cfg = env.config(root);
    const now = env.now();
    const live = liveInstance(root, now)?.instance ?? null;
    const situation = computeSituation(root, cfg, {
      forge: env.forge(cfg, root),
      exec: env.exec,
      now,
      liveInstance: live,
      readOnly: args.includes("--read-only"),
    });
    if (args.includes("--full")) {
      const entries = loadLedger(root).issues;
      situation.issues = situation.issues.map(
        (i) => ({ ...entries[String(i.issue)], ...i }) as typeof i,
      );
    }
    const out = {
      now: now.toISOString(),
      machine: machineId(),
      orchestrator: { recorded: readInstance(root)?.instance ?? null, live },
      ...situation,
    };
    io.out(`${JSON.stringify(out, null, args.includes("--pretty") ? 2 : 0)}\n`);
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
