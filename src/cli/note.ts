import { ledgerCli } from "../engine/ledger/ledger.js";
import { isArgumentError, messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude note <issue> <text...>";

/**
 * `autoclaude note <issue> '<text>'`: the verb stages call for a milestone. Appends a ledger
 * note under the lock; never touches the network (the configuration is not even read).
 */
export async function noteVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  if (args.length < 2 || args.slice(1).join(" ").trim() === "") return usageError(io, USAGE);
  try {
    const root = env.root(cwd);
    io.out(`${JSON.stringify(ledgerCli(["note", ...args], root, env.now()))}\n`);
    return 0;
  } catch (e) {
    if (isArgumentError(e)) return usageError(io, USAGE, messageOf(e));
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
