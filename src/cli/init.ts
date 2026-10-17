import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labelsOf } from "./labels.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude init [--create-labels]";

/** The packaged templates, next to `dist/` (and next to `src/` when run from a checkout). */
const TEMPLATES = fileURLToPath(new URL("../../templates/project/", import.meta.url));
const FILES = ["config.json", "project.md", "invariants.md"];

/** What the project's .gitignore must name: the state, the worktrees and the developer's own config. */
export const IGNORE_LINES = [
  ".autoclaude/state/",
  ".autoclaude/worktrees/",
  ".autoclaude/config.local.json",
];

/** Appends the missing lines, in the file's own line ending; returns the lines it added. */
function ensureIgnored(root: string): string[] {
  const path = join(root, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/^﻿/, "") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return [];
  const head = text === "" || text.endsWith("\n") ? text : text + eol;
  writeFileSync(path, head + missing.join(eol) + eol);
  return missing;
}

/**
 * `autoclaude init [--create-labels]`: writes `.autoclaude/` from the templates (never over
 * a file that exists), adds the three ignore lines, and with `--create-labels` creates the
 * labels the configuration names that the repository lacks. Idempotent.
 */
export async function initVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  const unknown = args.find((a) => a !== "--create-labels");
  if (unknown !== undefined) return usageError(io, USAGE, `unknown argument: ${unknown}`);
  let root: string;
  try {
    root = env.root(cwd);
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
  const dir = join(root, ".autoclaude");
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const target = join(dir, f);
    if (existsSync(target)) {
      io.out(`kept .autoclaude/${f}\n`);
      continue;
    }
    writeFileSync(target, readFileSync(join(TEMPLATES, f), "utf8"));
    io.out(`wrote .autoclaude/${f}\n`);
  }
  const added = ensureIgnored(root);
  io.out(added.length ? `added to .gitignore: ${added.join(", ")}\n` : "kept .gitignore\n");

  if (!args.includes("--create-labels")) return 0;
  try {
    const cfg = env.config(root);
    const forge = env.forge(cfg, root);
    const have = new Set(forge.listLabels());
    for (const name of labelsOf(cfg)) {
      if (have.has(name)) continue;
      forge.createLabel(name, { description: "autoclaude" });
      have.add(name);
      io.out(`created label ${name}\n`);
    }
  } catch (e) {
    io.err(`--create-labels: ${messageOf(e)}\n`);
    return 1;
  }
  return 0;
}
