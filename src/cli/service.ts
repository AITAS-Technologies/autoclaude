import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "../config/load.js";
import { repoRoot } from "../engine/root.js";
import * as linux from "../platform/autostart/linux.js";
import * as macos from "../platform/autostart/macos.js";
import * as windows from "../platform/autostart/windows.js";
import type { ServiceOpts } from "../platform/autostart/windows.js";
import type { RunResult } from "../platform/spawn.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude service install|uninstall|status\n";
const SUBCOMMANDS = ["install", "uninstall", "status"];

/**
 * One service per project: `autoclaude-` and the first ten hex characters of the SHA-256 of the
 * project's real path. Where the file system folds case (Windows, macOS) the path is lower-cased
 * first, so two spellings of one directory share a service.
 */
export function serviceName(projectRoot: string): string {
  const real = realpathSync.native(projectRoot);
  const folds = process.platform === "win32" || process.platform === "darwin";
  const key = folds ? real.toLowerCase() : real;
  return `autoclaude-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

export interface ServiceDeps {
  root: (cwd: string) => string;
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  /** The installing shell's environment: PATH and HOME go into the definition. */
  env: NodeJS.ProcessEnv;
  node: string;
  /** Absolute path of `dist/cli/main.js`. */
  main: string;
}

function realDeps(): ServiceDeps {
  return {
    root: repoRoot,
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    env: process.env,
    node: process.execPath,
    // This module is dist/cli/service.js next to main.js once compiled.
    main: fileURLToPath(new URL("./main.js", import.meta.url)),
  };
}

function report(r: RunResult, io: Io): number {
  if (r.status === 0) {
    if (r.stdout !== "") io.out(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    return 0;
  }
  const text = r.stderr.trim() || r.stdout.trim() || `exited with ${r.status ?? r.signal}`;
  io.err(`${text}\n`);
  return 1;
}

function installOf(d: ServiceDeps, o: ServiceOpts): RunResult {
  if (d.platform === "win32") return windows.install(o);
  if (d.platform === "darwin") return macos.install(o, d.home, d.uid);
  return linux.install(o, d.home);
}

function uninstallOf(d: ServiceDeps, name: string): RunResult {
  if (d.platform === "win32") return windows.uninstall(name);
  if (d.platform === "darwin") return macos.uninstall(name, d.home, d.uid);
  return linux.uninstall(name, d.home);
}

function statusOf(d: ServiceDeps, name: string): RunResult {
  if (d.platform === "win32") return windows.status(name);
  if (d.platform === "darwin") return macos.status(name, d.uid);
  return linux.status(name);
}

/**
 * `autoclaude service install|uninstall|status`: registers `autoclaude run` for this project
 * with the OS (Task Scheduler, a launchd user agent, a systemd user unit) so it starts at logon
 * and restarts on failure. Exit 0 ok, 1 the OS tool or the config failed, 64 usage.
 */
export async function serviceVerb(
  args: string[],
  io: Io,
  cwd: string,
  overrides: Partial<ServiceDeps> = {},
): Promise<number> {
  const sub = args[0];
  if (args.length !== 1 || sub === undefined || !SUBCOMMANDS.includes(sub)) {
    io.err(USAGE);
    return 64;
  }
  const d = { ...realDeps(), ...overrides };
  try {
    const root = d.root(cwd);
    const name = serviceName(root);
    if (sub === "status") return report(statusOf(d, name), io);
    if (sub === "uninstall") return report(uninstallOf(d, name), io);

    // A service that would start `run` against a broken config only fails in a loop.
    loadProjectConfig(root);
    const opts: ServiceOpts = {
      name,
      node: d.node,
      main: d.main,
      projectRoot: root,
      env: { PATH: d.env.PATH, HOME: d.env.HOME },
      user:
        d.env.USERDOMAIN && d.env.USERNAME ? `${d.env.USERDOMAIN}\\${d.env.USERNAME}` : undefined,
    };
    const code = report(installOf(d, opts), io);
    if (code === 0) {
      io.out(`installed ${name}\n`);
      if (d.platform !== "win32" && d.platform !== "darwin")
        io.out(
          "to keep it running while you are logged out, run once: loginctl enable-linger $USER\n",
        );
    }
    return code;
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 1;
  }
}
