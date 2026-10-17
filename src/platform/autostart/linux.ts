import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSync, type RunResult } from "../spawn.js";
import { logFile } from "./macos.js";
import type { ServiceOpts } from "./windows.js";

/** systemd reads `%x` as a specifier everywhere; a literal percent sign is written twice. */
const pct = (v: string): string => v.replace(/%/g, "%%");

/** A double-quoted systemd word: backslash and quote escaped, specifiers doubled. */
const quoted = (v: string): string => `"${pct(v.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))}"`;

/** `$` starts a variable in ExecStart only, where a literal one is written twice. */
const execArg = (v: string): string => quoted(v).replace(/\$/g, "$$$$");

function plain(v: string, what: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error(`${what} contains a line break or NUL byte`);
  return v;
}

/**
 * The systemd user unit: `node main.js run` in the project root, restarted on failure.
 * User units start with a minimal PATH, so the installing shell's PATH (and HOME) are written
 * as `Environment=` lines; without them `claude`, `gh` and `git` would not be found.
 */
export function systemdUnit(o: ServiceOpts): string {
  const env = Object.entries(o.env ?? {})
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => `Environment=${quoted(`${k}=${plain(v, k)}`)}`);
  const log = pct(plain(logFile(o.projectRoot), "the project path"));
  return [
    "[Unit]",
    `Description=autoclaude orchestrator (${pct(plain(o.name, "the name"))})`,
    "",
    "[Service]",
    `ExecStart=${[o.node, o.main, "run"].map((a) => execArg(plain(a, "a path"))).join(" ")}`,
    `WorkingDirectory=${pct(plain(o.projectRoot, "the project path"))}`,
    "Restart=on-failure",
    "RestartSec=30",
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    ...env,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export const unitPath = (home: string, name: string): string =>
  join(home, ".config", "systemd", "user", `${name}.service`);

const ctl = (...args: string[]): RunResult => runSync("systemctl", ["--user", ...args]);

export function install(o: ServiceOpts, home: string): RunResult {
  const file = unitPath(home, o.name);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(join(o.projectRoot, ".autoclaude", "state"), { recursive: true });
  writeFileSync(file, systemdUnit(o), "utf8");
  const reload = ctl("daemon-reload");
  if (reload.status !== 0) return reload;
  return ctl("enable", "--now", `${o.name}.service`);
}

export function uninstall(name: string, home: string): RunResult {
  const r = ctl("disable", "--now", `${name}.service`);
  // The unit goes whatever disable said, so a retry never meets a half-removed service.
  rmSync(unitPath(home, name), { force: true });
  const reload = ctl("daemon-reload");
  const missing = /not loaded|not found|does not exist|no such file|could not be found/i;
  if (r.status !== 0 && !missing.test(`${r.stderr}\n${r.stdout}`)) return r;
  return reload;
}

export function status(name: string): RunResult {
  return ctl("status", `${name}.service`);
}
