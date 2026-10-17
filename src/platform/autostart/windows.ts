import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync, type RunResult } from "../spawn.js";

export interface ServiceOpts {
  /** `autoclaude-<hash>`, from `serviceName`. */
  name: string;
  /** `process.execPath` of the installing node. */
  node: string;
  /** Absolute path of `dist/cli/main.js`. */
  main: string;
  projectRoot: string;
  /** The installing shell's environment, for the platforms whose service manager starts bare. */
  env?: { PATH?: string; HOME?: string };
  /** `DOMAIN\user` the task belongs to (Windows only). */
  user?: string;
}

/** The five XML entities, so a path holding `&`, `<` or a quote cannot break out of a value. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The Task Scheduler definition: at logon of the user, `node main.js run` in the project root,
 * restarted after a failure every 5 minutes up to 3 times, no time limit, one instance.
 *
 * It runs with an InteractiveToken, that is in the logged-on user's session with their own
 * environment, so (unlike launchd and systemd) no PATH has to be injected here. The action has
 * no way to redirect output to a file; the orchestrator's records live in `.autoclaude/state/`
 * and Task Scheduler keeps the last result, which `autoclaude service status` shows.
 */
export function taskXml(o: ServiceOpts): string {
  const user = o.user === undefined ? "" : `\n      <UserId>${xmlEscape(o.user)}</UserId>`;
  const principalUser = o.user === undefined ? "" : `\n      <UserId>${xmlEscape(o.user)}</UserId>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`autoclaude orchestrator for ${o.projectRoot}`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${user}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalUser}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT5M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(o.node)}</Command>
      <Arguments>${xmlEscape(`"${o.main}" run`)}</Arguments>
      <WorkingDirectory>${xmlEscape(o.projectRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** The bytes to write: UTF-16 LE with a BOM, matching the declaration `taskXml` makes. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

export function install(o: ServiceOpts): RunResult {
  const dir = join(o.projectRoot, ".autoclaude", "state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "service.xml");
  writeFileSync(file, encodeTaskXml(taskXml(o)));
  return runSync("schtasks", ["/Create", "/XML", file, "/TN", o.name, "/F"]);
}

export function uninstall(name: string, projectRoot: string): RunResult {
  const r = runSync("schtasks", ["/Delete", "/TN", name, "/F"]);
  rmSync(join(projectRoot, ".autoclaude", "state", "service.xml"), { force: true });
  if (r.status === 0) return r;
  // A task that does not exist is already uninstalled. The message is localised, so ask
  // instead of matching it: a failing query means there is no such task.
  return runSync("schtasks", ["/Query", "/TN", name]).status === 0 ? r : { ...r, status: 0 };
}

/** `/V /FO LIST` adds the last run time and last result to the plain query. */
export function status(name: string): RunResult {
  return runSync("schtasks", ["/Query", "/TN", name, "/V", "/FO", "LIST"]);
}
