import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, VERBS, type Io } from "../../src/cli/main.js";
import { serviceName, serviceVerb, type ServiceDeps } from "../../src/cli/service.js";
import { systemdUnit } from "../../src/platform/autostart/linux.js";
import { launchdPlist } from "../../src/platform/autostart/macos.js";
import { encodeTaskXml, taskXml } from "../../src/platform/autostart/windows.js";

const MINIMAL = resolve(import.meta.dirname, "../fixtures/projects/minimal");
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
const mk = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(d);
  return d;
};

describe("serviceName", () => {
  it("is autoclaude- plus ten hex characters, one per project", () => {
    const a = mk("ac-svc-a-");
    const b = mk("ac-svc-b-");
    expect(serviceName(a)).toMatch(/^autoclaude-[0-9a-f]{10}$/);
    expect(serviceName(a)).not.toBe(serviceName(b));
    expect(serviceName(a)).toBe(serviceName(a));
  });

  it("gives two spellings of one directory one name", () => {
    const a = mk("ac-svc-c-");
    mkdirSync(join(a, "sub"));
    expect(serviceName(join(a, "sub", ".."))).toBe(serviceName(a));
  });

  it.skipIf(process.platform === "linux")(
    "ignores the case of the spelling where the file system does (Windows, macOS)",
    () => {
      const a = mk("ac-svc-d-");
      expect(serviceName(a.toUpperCase())).toBe(serviceName(a.toLowerCase()));
    },
  );
});

const WIN_ROOT = "C:\\Users\\Jürgen Müller\\My Projects\\app & <co> 50%";
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_MAIN =
  "C:\\Users\\Jürgen Müller\\AppData\\npm\\node_modules\\autoclaude\\dist\\cli\\main.js";
const POSIX_ROOT = '/Users/jürgen/My Projects/app & "q" 50%$HOME\\x';
const POSIX_NODE = "/opt/homebrew/bin/node";
const POSIX_MAIN = "/opt/homebrew/lib/node_modules/autoclaude/dist/cli/main.js";
const ENTITY_FREE = /&(?!amp;|lt;|gt;|quot;|apos;)/;

describe("taskXml", () => {
  const xml = taskXml({
    name: "autoclaude-0123456789",
    node: WIN_NODE,
    main: WIN_MAIN,
    projectRoot: WIN_ROOT,
    user: "WORK\\Jürgen",
  });

  it("starts at logon, in the user's session, restarting on failure every 5 minutes up to 3 times", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  it("runs node with the main file and run, in the project root", () => {
    expect(xml).toContain("<Command>C:\\Program Files\\nodejs\\node.exe</Command>");
    expect(xml).toContain(
      "<Arguments>&quot;C:\\Users\\Jürgen Müller\\AppData\\npm\\node_modules\\autoclaude\\dist\\cli\\main.js&quot; run</Arguments>",
    );
    expect(xml).toContain(
      "<WorkingDirectory>C:\\Users\\Jürgen Müller\\My Projects\\app &amp; &lt;co&gt; 50%</WorkingDirectory>",
    );
    expect(xml).toContain("<UserId>WORK\\Jürgen</UserId>");
  });

  it("holds no raw ampersand or angle bracket inside a value", () => {
    expect(xml).not.toMatch(ENTITY_FREE);
    expect(xml).not.toContain("app & <co>");
  });

  it("is written as UTF-16 LE with a BOM and a declaration that says so", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    const bytes = encodeTaskXml(xml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(xml);
    expect(bytes.subarray(2).toString("utf16le")).toContain("Jürgen Müller");
  });
});

describe("launchdPlist", () => {
  const plist = launchdPlist({
    name: "autoclaude-0123456789",
    node: POSIX_NODE,
    main: POSIX_MAIN,
    projectRoot: POSIX_ROOT,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/a&b", HOME: "/Users/jürgen" },
  });

  it("runs at load and restarts only after an unsuccessful exit", () => {
    expect(plist).toContain("<key>Label</key>\n  <string>autoclaude-0123456789</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });

  it("lists the argv, the working directory and the log with every special character escaped", () => {
    expect(plist).toContain(`<string>${POSIX_NODE}</string>`);
    expect(plist).toContain(`<string>${POSIX_MAIN}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(
      "<key>WorkingDirectory</key>\n  <string>/Users/jürgen/My Projects/app &amp; &quot;q&quot; 50%$HOME\\x</string>",
    );
    expect(plist).toContain(
      "<string>/Users/jürgen/My Projects/app &amp; &quot;q&quot; 50%$HOME\\x/.autoclaude/state/service.log</string>",
    );
    expect(plist).not.toMatch(ENTITY_FREE);
  });

  it("injects the installing shell's PATH and HOME", () => {
    expect(plist).toMatch(
      /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/a&amp;b<\/string>/,
    );
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/jürgen</string>");
  });

  it("has no environment block when there is no environment", () => {
    const bare = launchdPlist({ name: "n", node: POSIX_NODE, main: POSIX_MAIN, projectRoot: "/p" });
    expect(bare).not.toContain("EnvironmentVariables");
  });
});

describe("systemdUnit", () => {
  const unit = systemdUnit({
    name: "autoclaude-0123456789",
    node: POSIX_NODE,
    main: POSIX_MAIN,
    projectRoot: POSIX_ROOT,
    env: { PATH: "/home/j/.npm/bin:/usr/bin:100%", HOME: "/home/jürgen" },
  });
  const line = (key: string): string => unit.split("\n").find((l) => l.startsWith(key)) ?? "";

  it("restarts on failure and installs into default.target", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("quotes every ExecStart argument", () => {
    expect(line("ExecStart=")).toBe(`ExecStart="${POSIX_NODE}" "${POSIX_MAIN}" "run"`);
  });

  it("doubles % in the working directory and the log path", () => {
    expect(line("WorkingDirectory=")).toBe(
      'WorkingDirectory=/Users/jürgen/My Projects/app & "q" 50%%$HOME\\x',
    );
    expect(line("StandardOutput=")).toBe(
      'StandardOutput=append:/Users/jürgen/My Projects/app & "q" 50%%$HOME\\x/.autoclaude/state/service.log',
    );
  });

  it("escapes backslash and quote and doubles % and $ inside an ExecStart argument", () => {
    const u = systemdUnit({
      name: "n",
      node: "/opt/no de/node",
      main: '/m/a "b" 5%/c\\d $x/main.js',
      projectRoot: "/p",
    });
    expect(u).toContain('ExecStart="/opt/no de/node" "/m/a \\"b\\" 5%%/c\\\\d $$x/main.js" "run"');
  });

  it("injects PATH and HOME as quoted Environment lines with % doubled", () => {
    expect(unit).toContain('Environment="PATH=/home/j/.npm/bin:/usr/bin:100%%"');
    expect(unit).toContain('Environment="HOME=/home/jürgen"');
  });
});

// ------------------------------------------------------------ the verb, with fake OS tools

let fakeDir: string;
let callLog: string;
let savedPath: string | undefined;

function writeFakes(): void {
  fakeDir = mk("ac-svc-fake-");
  callLog = join(fakeDir, "calls.jsonl");
  writeFileSync(
    join(fakeDir, "rec.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "const [tool, ...argv] = process.argv.slice(2);",
      'appendFileSync(process.env.AC_FAKE_LOG, JSON.stringify({ tool, argv }) + "\\n");',
      "const failOn = (process.env.AC_FAKE_FAIL_ON ?? '').split(',');",
      "const hit = argv.some((a) => failOn.includes(`${tool}:${a}`));",
      "if (process.env.AC_FAKE_FAIL === tool || hit) {",
      "  process.stderr.write(`${process.env.AC_FAKE_MSG ?? `${tool} exploded`}\\n`);",
      "  process.exit(5);",
      "}",
      "process.stdout.write(`${tool} ok\\n`);",
    ].join("\n"),
  );
  for (const tool of ["schtasks", "launchctl", "systemctl"]) {
    if (process.platform === "win32") {
      writeFileSync(
        join(fakeDir, `${tool}.cmd`),
        `@echo off\r\nnode "%~dp0rec.mjs" ${tool} %*\r\n`,
      );
    } else {
      writeFileSync(
        join(fakeDir, tool),
        `#!/bin/sh\nexec node "$(dirname "$0")/rec.mjs" ${tool} "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
}

const calls = (): { tool: string; argv: string[] }[] =>
  existsSync(callLog)
    ? readFileSync(callLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { tool: string; argv: string[] })
    : [];

beforeEach(() => {
  writeFakes();
  savedPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${process.platform === "win32" ? ";" : ":"}${savedPath}`;
  process.env.AC_FAKE_LOG = callLog;
  delete process.env.AC_FAKE_FAIL;
  delete process.env.AC_FAKE_FAIL_ON;
  delete process.env.AC_FAKE_MSG;
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.AC_FAKE_LOG;
  delete process.env.AC_FAKE_FAIL;
  delete process.env.AC_FAKE_FAIL_ON;
  delete process.env.AC_FAKE_MSG;
});

function project(): string {
  const root = join(mk("ac-svc-proj-"), "Jürgen Müller", "My Projects", "app");
  mkdirSync(root, { recursive: true });
  // Copied file by file: cpSync of a directory silently copies nothing into a path with an umlaut.
  mkdirSync(join(root, ".autoclaude"));
  copyFileSync(
    join(MINIMAL, ".autoclaude", "config.json"),
    join(root, ".autoclaude", "config.json"),
  );
  return root;
}

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

function deps(root: string, platform: NodeJS.Platform, home: string): Partial<ServiceDeps> {
  return {
    root: () => root,
    platform,
    home,
    uid: 501,
    env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: home, USERDOMAIN: "WORK", USERNAME: "jw" },
    node: POSIX_NODE,
    main: POSIX_MAIN,
  };
}

describe("service verb on Windows", () => {
  it("install writes a UTF-16 task file and calls schtasks /Create /XML ... /TN ... /F", async () => {
    const root = project();
    const { io, err } = capture();
    const code = await serviceVerb(["install"], io, root, deps(root, "win32", mk("ac-home-")));
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
    const name = serviceName(root);
    const xmlPath = join(root, ".autoclaude", "state", "service.xml");
    expect(calls()).toEqual([
      { tool: "schtasks", argv: ["/Create", "/XML", xmlPath, "/TN", name, "/F"] },
    ]);
    const bytes = readFileSync(xmlPath);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const text = bytes.subarray(2).toString("utf16le");
    expect(text).toContain("Jürgen Müller");
    expect(text).toContain("<UserId>WORK\\jw</UserId>");
  });

  it("uninstall and status call /Delete and /Query", async () => {
    const root = project();
    const name = serviceName(root);
    const home = mk("ac-home-");
    expect(await serviceVerb(["uninstall"], capture().io, root, deps(root, "win32", home))).toBe(0);
    const s = capture();
    expect(await serviceVerb(["status"], s.io, root, deps(root, "win32", home))).toBe(0);
    expect(s.out.join("")).toContain("schtasks ok");
    expect(calls()).toEqual([
      { tool: "schtasks", argv: ["/Delete", "/TN", name, "/F"] },
      { tool: "schtasks", argv: ["/Query", "/TN", name, "/V", "/FO", "LIST"] },
    ]);
  });

  it("exits 1 and prints the tool's stderr when schtasks fails", async () => {
    process.env.AC_FAKE_FAIL = "schtasks";
    const root = project();
    const { io, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "win32", mk("ac-home-")))).toBe(1);
    expect(err.join("")).toContain("schtasks exploded");
  });
});

describe("service verb on Windows: uninstall of a task that is gone", () => {
  it("succeeds, and removes the stale task file", async () => {
    const root = project();
    const home = mk("ac-home-");
    await serviceVerb(["install"], capture().io, root, deps(root, "win32", home));
    const xml = join(root, ".autoclaude", "state", "service.xml");
    expect(existsSync(xml)).toBe(true);
    process.env.AC_FAKE_FAIL_ON = "schtasks:/Delete,schtasks:/Query";
    process.env.AC_FAKE_MSG = "ERROR: The system cannot find the file specified.";
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "win32", home))).toBe(0);
    expect(err.join("")).toBe("");
    expect(existsSync(xml)).toBe(false);
  });

  it("still fails when the delete fails and the task is there", async () => {
    const root = project();
    process.env.AC_FAKE_FAIL_ON = "schtasks:/Delete";
    process.env.AC_FAKE_MSG = "ERROR: Access is denied.";
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "win32", mk("ac-home-")))).toBe(1);
    expect(err.join("")).toContain("Access is denied");
  });

  it("names the OS user in the task when USERNAME and USERDOMAIN are unset", async () => {
    const root = project();
    const d = deps(root, "win32", mk("ac-home-"));
    d.env = { PATH: "/usr/bin" };
    expect(await serviceVerb(["install"], capture().io, root, d)).toBe(0);
    const bytes = readFileSync(join(root, ".autoclaude", "state", "service.xml"));
    const text = bytes.subarray(2).toString("utf16le");
    expect(text).toContain(`<UserId>${userInfo().username}</UserId>`);
  });
});

describe("service verb on macOS", () => {
  it("install writes the agent plist and bootstraps it into gui/<uid>", async () => {
    const root = project();
    const home = mk("ac-home-");
    const { io, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "darwin", home))).toBe(0);
    expect(err.join("")).toBe("");
    const name = serviceName(root);
    const plistPath = join(home, "Library", "LaunchAgents", `${name}.plist`);
    expect(readFileSync(plistPath, "utf8")).toContain("<key>RunAtLoad</key>");
    expect(readFileSync(plistPath, "utf8")).toContain("/opt/homebrew/bin:/usr/bin");
    expect(existsSync(join(root, ".autoclaude", "state"))).toBe(true);
    const all = calls();
    expect(all.every((c) => c.tool === "launchctl")).toBe(true);
    expect(all[all.length - 1]?.argv).toEqual(["bootstrap", "gui/501", plistPath]);
  });

  it("uninstall boots the agent out and removes the plist; status prints", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "darwin", home));
    writeFileSync(callLog, "");
    expect(await serviceVerb(["uninstall"], capture().io, root, deps(root, "darwin", home))).toBe(
      0,
    );
    expect(calls()).toEqual([{ tool: "launchctl", argv: ["bootout", `gui/501/${name}`] }]);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${name}.plist`))).toBe(false);
    writeFileSync(callLog, "");
    expect(await serviceVerb(["status"], capture().io, root, deps(root, "darwin", home))).toBe(0);
    expect(calls()).toEqual([{ tool: "launchctl", argv: ["print", `gui/501/${name}`] }]);
  });

  it("exits 1 when launchctl bootstrap fails", async () => {
    process.env.AC_FAKE_FAIL = "launchctl";
    const root = project();
    const { io, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "darwin", mk("ac-home-")))).toBe(1);
    expect(err.join("")).toContain("launchctl exploded");
  });
});

describe("service verb: uninstall of a service that is not loaded", () => {
  it("macOS removes the plist and succeeds when bootout and print fail", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "darwin", home));
    process.env.AC_FAKE_FAIL_ON = "launchctl:bootout,launchctl:print";
    process.env.AC_FAKE_MSG = "Boot-out failed: 5: Input/output error";
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "darwin", home))).toBe(0);
    expect(err.join("")).toBe("");
    expect(existsSync(join(home, "Library", "LaunchAgents", `${name}.plist`))).toBe(false);
  });

  it("macOS removes the plist but still fails when bootout fails on a loaded agent", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "darwin", home));
    process.env.AC_FAKE_FAIL_ON = "launchctl:bootout";
    process.env.AC_FAKE_MSG = "Operation not permitted";
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "darwin", home))).toBe(1);
    expect(err.join("")).toContain("Operation not permitted");
    expect(existsSync(join(home, "Library", "LaunchAgents", `${name}.plist`))).toBe(false);
  });

  it("Linux removes the unit and succeeds when the unit is not loaded", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "linux", home));
    process.env.AC_FAKE_FAIL_ON = "systemctl:disable";
    process.env.AC_FAKE_MSG = `Failed to disable unit: Unit file ${name}.service does not exist.`;
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "linux", home))).toBe(0);
    expect(err.join("")).toBe("");
    expect(existsSync(join(home, ".config", "systemd", "user", `${name}.service`))).toBe(false);
  });

  it("Linux removes the unit but fails when there is no user bus", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "linux", home));
    process.env.AC_FAKE_FAIL_ON = "systemctl:disable";
    process.env.AC_FAKE_MSG = "Failed to connect to bus: No medium found";
    const { io, err } = capture();
    expect(await serviceVerb(["uninstall"], io, root, deps(root, "linux", home))).toBe(1);
    expect(err.join("")).toContain("Failed to connect to bus");
    expect(existsSync(join(home, ".config", "systemd", "user", `${name}.service`))).toBe(false);
  });
});

describe("service verb on Linux", () => {
  it("install writes the user unit, reloads, enables --now and prints the linger hint", async () => {
    const root = project();
    const home = mk("ac-home-");
    const { io, out, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "linux", home))).toBe(0);
    expect(err.join("")).toBe("");
    const name = serviceName(root);
    const unitPath = join(home, ".config", "systemd", "user", `${name}.service`);
    expect(readFileSync(unitPath, "utf8")).toContain("Restart=on-failure");
    expect(calls()).toEqual([
      { tool: "systemctl", argv: ["--user", "daemon-reload"] },
      { tool: "systemctl", argv: ["--user", "enable", "--now", `${name}.service`] },
    ]);
    expect(out.join("")).toContain("loginctl enable-linger $USER");
  });

  it("uninstall disables --now, removes the unit and reloads; status calls systemctl status", async () => {
    const root = project();
    const home = mk("ac-home-");
    const name = serviceName(root);
    await serviceVerb(["install"], capture().io, root, deps(root, "linux", home));
    writeFileSync(callLog, "");
    expect(await serviceVerb(["uninstall"], capture().io, root, deps(root, "linux", home))).toBe(0);
    expect(calls()).toEqual([
      { tool: "systemctl", argv: ["--user", "disable", "--now", `${name}.service`] },
      { tool: "systemctl", argv: ["--user", "daemon-reload"] },
    ]);
    expect(existsSync(join(home, ".config", "systemd", "user", `${name}.service`))).toBe(false);
    writeFileSync(callLog, "");
    expect(await serviceVerb(["status"], capture().io, root, deps(root, "linux", home))).toBe(0);
    expect(calls()).toEqual([{ tool: "systemctl", argv: ["--user", "status", `${name}.service`] }]);
  });

  it("exits 1 and prints stderr when systemctl fails, with no hint", async () => {
    process.env.AC_FAKE_FAIL = "systemctl";
    const root = project();
    const { io, out, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "linux", mk("ac-home-")))).toBe(1);
    expect(err.join("")).toContain("systemctl exploded");
    expect(out.join("")).not.toContain("enable-linger");
  });
});

describe("service verb arguments and guards", () => {
  it("is registered as a verb and listed in the usage text", async () => {
    const { io, out } = capture();
    await main(["--help"], io);
    expect(out.join("")).toContain("service");
    expect(typeof VERBS.service).toBe("function");
  });

  it("exits 64 on a missing or unknown subcommand and on extra arguments", async () => {
    const root = project();
    for (const args of [[], ["bogus"], ["install", "extra"]]) {
      const { io, err } = capture();
      expect(await serviceVerb(args, io, root, deps(root, "linux", mk("ac-home-")))).toBe(64);
      expect(err.join("")).toContain("usage: autoclaude service");
    }
    expect(calls()).toEqual([]);
  });

  it("refuses to install when the project config does not load, touching nothing", async () => {
    const root = mk("ac-svc-noconfig-");
    const home = mk("ac-home-");
    const { io, err } = capture();
    expect(await serviceVerb(["install"], io, root, deps(root, "linux", home))).toBe(1);
    expect(err.join("")).not.toBe("");
    expect(calls()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });
});
