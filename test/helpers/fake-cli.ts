import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeCliOptions {
  /** Printed to stdout verbatim. */
  stdout?: string;
  /** Printed to stderr (an update notice, say). */
  stderr?: string;
  sleepMs?: number;
  exitCode?: number;
}

export interface Recorded {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

const SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.301 (Claude Code)"); process.exit(0); }
const o = JSON.parse(fs.readFileSync(path.join(dir, "options.json"), "utf8"));
fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
if (o.stderr) process.stderr.write(o.stderr);
if (o.stdout) process.stdout.write(o.stdout);
const finish = () => process.exit(o.exitCode || 0);
if (o.sleepMs) setTimeout(finish, o.sleepMs); else finish();
`;

/**
 * Writes a fake `claude` into `dir` (a node script, a POSIX launcher, and on Windows a
 * `.cmd` shim) that records argv, cwd and env to `record.json` and prints the given
 * output. Put `bin` first on PATH to have `claude` resolve to it. `dir` may contain spaces.
 */
export function writeFakeCli(
  dir: string,
  opts: FakeCliOptions,
): { bin: string; recordFile: string; read(): Recorded } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fake-claude.cjs"), SCRIPT);
  writeFileSync(join(dir, "options.json"), JSON.stringify(opts));
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "claude.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`,
    );
  } else {
    const sh = join(dir, "claude");
    writeFileSync(
      sh,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.cjs" "$@"\n`,
    );
    chmodSync(sh, 0o755);
  }
  const recordFile = join(dir, "record.json");
  return {
    bin: dir,
    recordFile,
    read: () => JSON.parse(readFileSync(recordFile, "utf8")) as Recorded,
  };
}
