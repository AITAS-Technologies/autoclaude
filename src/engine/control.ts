/**
 * Pause, drain, resume: files, not conversation, so they work while the orchestrator is
 * mid-run or unresponsive (design, section 11).
 *
 * The two files exclude each other: `pause` removes DRAINING and `drain` removes
 * PAUSED, so the state is one of running, paused, draining and never an undefined
 * pair. Status and situation readers go through `controlState`, from here, so the paths
 * are spelled once.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./ledger/lock.js";

export function controlPaths(root: string): { paused: string; draining: string } {
  const dir = join(root, STATE_DIR);
  return { paused: join(dir, "PAUSED"), draining: join(dir, "DRAINING") };
}

export function controlState(root: string): { paused: boolean; draining: boolean } {
  const p = controlPaths(root);
  return { paused: existsSync(p.paused), draining: existsSync(p.draining) };
}

export function control(
  root: string,
  cmd: string,
  now: Date = new Date(),
): { paused: boolean; draining: boolean } {
  const p = controlPaths(root);
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  switch (cmd) {
    case "pause":
      writeFileSync(p.paused, `${now.toISOString()}\n`);
      rmSync(p.draining, { force: true });
      break;
    case "drain":
      writeFileSync(p.draining, `${now.toISOString()}\n`);
      rmSync(p.paused, { force: true });
      break;
    case "resume":
      rmSync(p.paused, { force: true });
      rmSync(p.draining, { force: true });
      break;
    case "show":
      break;
    default:
      throw new Error("Usage: pause|drain|resume|show");
  }
  return controlState(root);
}
