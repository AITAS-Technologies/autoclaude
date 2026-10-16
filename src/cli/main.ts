#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { gatesVerb } from "./gates.js";
import { guardVerb } from "./guard.js";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export type Verb = (args: string[], io: Io) => Promise<number>;

// Later tasks register their verbs here, one module per verb in src/cli/<verb>.ts.
export const VERBS: Record<string, Verb> = {
  gates: (args, io) => gatesVerb(args, io, process.cwd()),
  guard: (args, io) => guardVerb(args, io),
};

const USAGE =
  "usage: autoclaude <verb> [options]\n\nverbs:\n  gates      run the project quality gates\n  guard      the PreToolUse hook of a stage (pending call on stdin)\n\n  --version  print the version\n  --help     print this text\n";

const defaultIo: Io = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    io.err(USAGE);
    return 64;
  }
  if (verb === "--version" || verb === "-v") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (verb === "--help" || verb === "-h") {
    io.out(USAGE);
    return 0;
  }
  const handler = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (handler === undefined) {
    io.err(`unknown verb: ${verb}\n${USAGE}`);
    return 64;
  }
  return handler(rest, io);
}

/** A path as a comparison key: absolute, normalised, and case-folded where the file system folds. */
const keyOf = (p: string): string => {
  const abs = resolve(p);
  return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs;
};

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // A path that cannot be resolved (permissions, a removed link) must not turn the
    // process into a silent no-op; fall back to comparing the spellings.
    return keyOf(entry) === keyOf(self);
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
