/**
 * The process Claude Code's PreToolUse hook starts: `node hook-entry.js guard --runtime
 * claude --worktree <path>`.
 *
 * Unconditional on purpose. `main.ts` runs only when it recognises itself as the entry
 * point, and a path spelling it cannot match (a copy, a link, another case, an 8.3 name)
 * made it exit 0 with no output, which a hook reads as "allow". This file has no such
 * check: whatever its path, it asks the guard and exits with the answer, 2 on any failure.
 * A failure to start or import never reaches this code; the hook line's `|| exit 2` covers
 * that (see `hookCommand`).
 */
import { guardVerb } from "./guard.js";

const err = (s: string): void => void process.stderr.write(s);

function fail(reason: unknown): never {
  try {
    err(`autoclaude guard: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  } catch {
    // the exit code still blocks
  }
  process.exit(2);
}

/**
 * A guard that hangs (stdin never closes, git stalls inside repoRoot) must block: Claude
 * Code treats a hook timeout as non-blocking, so this fires first (the generated settings
 * give the hook a longer `timeout`). Design § 7.5: a timeout is a refusal.
 */
export const WATCHDOG_MS = 20_000;
setTimeout(
  () => fail(`the guard did not answer within ${WATCHDOG_MS / 1000} s`),
  WATCHDOG_MS,
).unref();

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const [verb, ...rest] = process.argv.slice(2);
if (verb !== "guard") fail(`expected the verb "guard", got "${verb ?? ""}"`);
const code = await guardVerb(rest, { out: () => {}, err });
process.exitCode = code === 0 ? 0 : 2;
