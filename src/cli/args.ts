/**
 * The two argument rules every CLI verb here shares — the value after a flag, and a
 * whole positive number — in a module that imports nothing, so no importer of it can
 * close a cycle. The number rule has two callers, which differ only in the noun they
 * refuse a token with.
 */

/**
 * The value after a flag, refusing another flag as that value. `set 7 claimed
 * --worktree --title "Fix it"` recorded `worktree = "--title"`, which is truthy and
 * passed every downstream check, so the implement report was archived under a path that
 * does not exist and the reviewer's isolation quietly stopped happening.
 *
 * A flag given twice is refused rather than resolved by position. No unknown-option scan
 * can catch it — both spellings are known — and taking the first silently drops the
 * second: `rollback 9 --to blocked --reason x --to ready`, an operator editing a
 * recalled line, released as blocked and deleted the branches with the typed `ready`
 * gone. This is the one parser all the verbs share.
 */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (args.lastIndexOf(name) !== i) {
    throw new Error(`${name} was given more than once; give it once, with the value you mean`);
  }
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value, got "${value ?? ""}"`);
  }
  return value;
}

/**
 * A whole positive number a verb was handed, or a throw naming the token it got.
 *
 * Decimal digits and nothing else, because `Number` accepts more than a decimal integer:
 * `0x10` is 16 and `1e2` is 100, both whole and positive, so the work would be done under
 * a number nobody typed and every later command would look for it under the one they did.
 * `+5` and ` 5` are refused with them: these tokens are keys — the ledger is keyed on the
 * issue, GitHub on the pull request — and a token that is not its own number is a typo
 * worth naming. Zero is refused because `set 0 claimed` wrote an entry "0" and every
 * command after it warned about `runs/0/events.log`.
 *
 * "Its own number" is the rule `String(n) === token` states and the digit test alone did
 * not: `007` passed as 7, so the ledger was keyed `"7"` while every later command carried
 * the token that was typed, and a digit string past the safe integer is rounded by `Number`
 * — `9007199254740993` becomes ...992 — which is the same mismatch under a number nobody
 * could have meant. `Number.isSafeInteger` names that boundary.
 *
 * `what` is the only difference between the two callers below, so they cannot drift apart
 * on what a number is and neither can claim the other's noun: the noun is what tells an
 * operator which of the two numbers they mistyped.
 */
function positiveInteger(token: string | undefined, usage: string, what: string): number {
  const text = token ?? "";
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== text) {
    throw new Error(`${usage}: "${text}" is not ${what}`);
  }
  return n;
}

/** The issue number a verb was handed, or a throw naming the token it got. */
export function issueArg(token: string | undefined, usage: string): number {
  return positiveInteger(token, usage, "an issue number");
}

/**
 * The pull request number a verb was handed, or a throw naming the token it got.
 *
 * A bare `Number.isInteger` would take `0x10` as pull request 16 and ask GitHub about a
 * number nobody typed; this is the same rule as `issueArg`, with its own noun.
 */
export function prArg(token: string | undefined, usage: string): number {
  return positiveInteger(token, usage, "a pull request number");
}
