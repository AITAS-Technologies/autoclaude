/**
 * Ask the command guard about many commands in one process.
 *
 * stdin:  { "config": <GuardConfig>, "commands": ["...", ...] }
 * stdout: [{ "command": "...", "reason": "<why it was refused>" | null, "threw": "<message>" | null }, ...]
 *
 * `threw` is separate from `reason` on purpose. Rendered as
 * `reason: "the guard itself failed: …"`, a throw is truthy — so a tokeniser change that
 * made a whole family of respellings throw would leave every one of those rows green on an
 * exception string, and the suite could not tell a refusal from a crash.
 *
 * Why this exists: `core.test.ts` checks several hundred command shapes. Spawning a
 * process per shape is slow enough to starve the test worker; the decision is pure, so it
 * needs one process, not several hundred. Run as plain `node` through
 * test/helpers/ts-register.mjs, it also decides every row outside the test runner's own
 * module transform, the way the compiled guard runs. The hook's own contract — exit 2,
 * fail-closed on bad input — is tested on `claudeHook` directly.
 */

import { readFileSync } from "node:fs";
import { refusalFor } from "../../../src/engine/guard/core.js";

const { config, commands } = JSON.parse(readFileSync(0, "utf8"));
const out = commands.map((command) => {
  try {
    return { command, reason: refusalFor(command, config), threw: null };
  } catch (error) {
    return { command, reason: null, threw: String((error && error.message) || error) };
  }
});
process.stdout.write(JSON.stringify(out));
