import { runGates, type GateResult } from "../adapters/gates.js";
import { loadProjectConfig } from "../config/load.js";
import type { ProjectConfig } from "../config/types.js";
import { repoRoot } from "../engine/root.js";
import { flag } from "./args.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude gates [--fix] [--only a,b] [--files <file>...]\n";
const OUTPUT_LINES = 200;

export interface GatesDeps {
  root: (cwd: string) => string;
  load: (projectRoot: string) => ProjectConfig;
}

/**
 * `--files` takes the rest of argv as the file list (so it comes last); without it the
 * files are the branch's changed files. The configuration is read from the main checkout,
 * never the worktree's copy, so a stage cannot change the gates it is judged by.
 */
export async function gatesVerb(
  args: string[],
  io: Io,
  cwd: string,
  deps: GatesDeps = { root: repoRoot, load: loadProjectConfig },
): Promise<number> {
  let fix = false;
  let only: string[] | undefined;
  let files: string[] | undefined;
  try {
    const filesAt = args.indexOf("--files");
    const own = filesAt < 0 ? args : args.slice(0, filesAt);
    if (filesAt >= 0) files = args.slice(filesAt + 1);
    for (let i = 0; i < own.length; i++) {
      const a = own[i]!;
      if (a === "--only")
        i++; // its value is validated by flag() below
      else if (a !== "--fix") throw new Error(`unknown argument: ${a}`);
    }
    fix = own.includes("--fix");
    const onlyValue = flag(own, "--only");
    if (onlyValue !== undefined) only = onlyValue.split(",").filter((s) => s !== "");
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}`);
    return 64;
  }

  let cfg: ProjectConfig;
  try {
    cfg = deps.load(deps.root(cwd));
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  const unknown = only?.find((n) => !cfg.gates.some((g) => g.name === n));
  if (unknown !== undefined) {
    io.err(`unknown gate: ${unknown}\n${USAGE}`);
    return 64;
  }

  let results: GateResult[];
  try {
    results = await runGates(cfg, cwd, { fix, only, files });
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
  let failed = false;
  for (const r of results) {
    io.out(`${r.status} ${r.name} (${r.durationMs} ms)\n`);
    if (r.status === "fail") {
      failed = true;
      const lines = r.output.replace(/\r?\n$/, "").split(/\r?\n/);
      io.out(`${lines.slice(-OUTPUT_LINES).join("\n")}\n`);
    }
  }
  return failed ? 1 : 0;
}
