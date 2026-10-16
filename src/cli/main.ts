#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export type Verb = (args: string[], io: Io) => Promise<number>;

// Later tasks register their verbs here, one module per verb in src/cli/<verb>.ts.
export const VERBS: Record<string, Verb> = {};

const USAGE =
  "usage: autoclaude <verb> [options]\n\nverbs: (none yet)\n\n  --version  print the version\n  --help     print this text\n";

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

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
