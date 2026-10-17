import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { runSync, type RunResult } from "../spawn.js";
import { xmlEscape, type ServiceOpts } from "./windows.js";

const s = (v: string): string => `<string>${xmlEscape(v)}</string>`;

/** Where the service's stdout and stderr are appended. */
export const logFile = (projectRoot: string): string =>
  posix.join(projectRoot, ".autoclaude", "state", "service.log");

/**
 * The launchd user agent: `node main.js run` in the project root at load, restarted only
 * after an unsuccessful exit. launchd starts agents with a minimal PATH, so the installing
 * shell's PATH (and HOME) are written into the definition; without them `claude`, `gh` and
 * `git` would not be found.
 */
export function launchdPlist(o: ServiceOpts): string {
  const env = Object.entries(o.env ?? {}).filter(
    (e): e is [string, string] => e[1] !== undefined && e[1] !== "",
  );
  const envBlock =
    env.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    ${s(v)}`).join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(o.name)}
  <key>ProgramArguments</key>
  <array>
    ${s(o.node)}
    ${s(o.main)}
    ${s("run")}
  </array>
  <key>WorkingDirectory</key>
  ${s(o.projectRoot)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  ${s(logFile(o.projectRoot))}
  <key>StandardErrorPath</key>
  ${s(logFile(o.projectRoot))}
${envBlock}</dict>
</plist>
`;
}

export const plistPath = (home: string, name: string): string =>
  join(home, "Library", "LaunchAgents", `${name}.plist`);

export function install(o: ServiceOpts, home: string, uid: number): RunResult {
  const file = plistPath(home, o.name);
  mkdirSync(dirname(file), { recursive: true });
  // The log's directory must exist before launchd opens the file.
  mkdirSync(join(o.projectRoot, ".autoclaude", "state"), { recursive: true });
  writeFileSync(file, launchdPlist(o), "utf8");
  // A reinstall replaces a loaded agent; bootstrap alone fails on one that is already there.
  runSync("launchctl", ["bootout", `gui/${uid}/${o.name}`]);
  return runSync("launchctl", ["bootstrap", `gui/${uid}`, file]);
}

export function uninstall(name: string, home: string, uid: number): RunResult {
  const r = runSync("launchctl", ["bootout", `gui/${uid}/${name}`]);
  if (r.status === 0) rmSync(plistPath(home, name), { force: true });
  return r;
}

export function status(name: string, uid: number): RunResult {
  return runSync("launchctl", ["print", `gui/${uid}/${name}`]);
}
