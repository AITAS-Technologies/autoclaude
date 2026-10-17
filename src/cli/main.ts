#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { benchVerb } from "./bench.js";
import { canMergeVerb } from "./can-merge.js";
import { drainVerb, pauseVerb, resumeVerb } from "./control.js";
import { doctorVerb } from "./doctor.js";
import {
  checkRebasedVerb,
  claimVerb,
  decisionVerb,
  ledgerVerb,
  postReviewVerb,
  publishVerb,
  releaseVerb,
  reportsVerb,
  worktreeVerb,
} from "./engine.js";
import { gatesVerb } from "./gates.js";
import { guardVerb } from "./guard.js";
import { initVerb } from "./init.js";
import { issueVerb } from "./issue.js";
import { noteVerb } from "./note.js";
import { redStepVerb } from "./red-step.js";
import { reviewVerb } from "./review.js";
import { rollbackVerb } from "./rollback.js";
import { runVerb } from "./run.js";
import { serviceVerb } from "./service.js";
import { situationVerb } from "./situation.js";
import { statusVerb } from "./status.js";
import { triageVerb } from "./triage.js";
import { watchVerb } from "./watch.js";

export interface Io {
  out(s: string): void;
  err(s: string): void;
}

export type Verb = (args: string[], io: Io) => Promise<number>;

// Later tasks register their verbs here, one module per verb in src/cli/<verb>.ts.
export const VERBS: Record<string, Verb> = {
  init: (args, io) => initVerb(args, io, process.cwd()),
  doctor: (args, io) => doctorVerb(args, io, process.cwd()),
  status: (args, io) => statusVerb(args, io, process.cwd()),
  watch: (args, io) => watchVerb(args, io, process.cwd()),
  situation: (args, io) => situationVerb(args, io, process.cwd()),
  pause: (args, io) => pauseVerb(args, io, process.cwd()),
  drain: (args, io) => drainVerb(args, io, process.cwd()),
  resume: (args, io) => resumeVerb(args, io, process.cwd()),
  triage: (args, io) => triageVerb(args, io, process.cwd()),
  issue: (args, io) => issueVerb(args, io, process.cwd()),
  review: (args, io) => reviewVerb(args, io, process.cwd()),
  "can-merge": (args, io) => canMergeVerb(args, io, process.cwd()),
  rollback: (args, io) => rollbackVerb(args, io, process.cwd()),
  bench: (args, io) => benchVerb(args, io, process.cwd()),
  note: (args, io) => noteVerb(args, io, process.cwd()),
  "red-step": (args, io) => redStepVerb(args, io, process.cwd()),
  decision: (args, io) => decisionVerb(args, io, process.cwd()),
  reports: (args, io) => reportsVerb(args, io, process.cwd()),
  publish: (args, io) => publishVerb(args, io, process.cwd()),
  "post-review": (args, io) => postReviewVerb(args, io, process.cwd()),
  "check-rebased": (args, io) => checkRebasedVerb(args, io, process.cwd()),
  ledger: (args, io) => ledgerVerb(args, io, process.cwd()),
  claim: (args, io) => claimVerb(args, io, process.cwd()),
  release: (args, io) => releaseVerb(args, io, process.cwd()),
  worktree: (args, io) => worktreeVerb(args, io, process.cwd()),
  gates: (args, io) => gatesVerb(args, io, process.cwd()),
  guard: (args, io) => guardVerb(args, io),
  run: (args, io) => runVerb(args, io, process.cwd()),
  service: (args, io) => serviceVerb(args, io, process.cwd()),
};

const USAGE = `usage: autoclaude <verb> [options]

set up and check:
  init           write .autoclaude/ and the ignore lines [--create-labels]
  doctor         check the configuration, labels, logins and tools

run:
  run            the orchestrator: tick until drained or stopped [--once]
  service        autostart at logon: install, uninstall or status
  issue <n>      one issue, attended, from claim to pull request
  triage         triage now [--issue <n>]
  review --pr <n>  the code review on an open pull request

see and control:
  status         the ledger and the gates of every open pull request
  watch          follow a run in the terminal
  situation      what the next tick sees, as JSON
  pause | drain | resume   the control files
  can-merge <pr> the merge verdict
  rollback <issue> [--to ... --reason ...]   release a run and clear its worktree and branches
  bench          measure a code-review report against expected findings

used by stages and by hand:
  gates          run the project quality gates
  note <issue> <text>   record a milestone
  red-step       prove the change's tests fail on the integration branch
  guard          the PreToolUse hook of a stage (pending call on stdin)
  decision, reports, publish, post-review, check-rebased, ledger, claim, release, worktree
                 the engine's own steps, one by one

  --version      print the version
  --help         print this text
`;

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
