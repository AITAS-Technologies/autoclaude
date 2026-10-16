import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { processStartTime } from "../../src/platform/kill.js";
import { bashPath, runShell, runShellSync, shQuote } from "../../src/platform/shell.js";
import { run, runSync, spawnSupervised } from "../../src/platform/spawn.js";

const ECHO = resolve("test/helpers/echo-argv.mjs");
const SLEEPER = resolve("test/helpers/spawn-sleeper.mjs");
const temps: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (processStartTime(pid) === null) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("spawn", () => {
  it("round-trips cwd with space and umlaut", async () => {
    const dir = tmp("Jürgen Müller ");
    const r = await run(process.execPath, [ECHO], { cwd: dir });
    expect(JSON.parse(r.stdout).cwd).toBe(realpathSync.native(dir));
  });

  it("runSync passes argv verbatim and reports status", () => {
    const arg = 'a & b $(x) `id` "q"';
    const r = runSync(process.execPath, [ECHO, arg]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual([arg]);
  });

  it("feeds input on stdin", async () => {
    const r = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "hello",
    });
    expect(r.stdout).toBe("hello");
  });

  it.skipIf(process.platform !== "win32")(
    "passes metacharacters verbatim through a .cmd shim (win32 only: shims are a Windows concept)",
    async () => {
      const arg = 'Fix login & logout --replace $(rm -rf ~) `id` "q" %PATH% ^ |';
      const dir = tmp("shim-");
      const shim = join(dir, "echo.cmd");
      writeFileSync(shim, `@"${process.execPath}" "${ECHO}" %*\r\n`);
      expect(JSON.parse((await run(shim, [arg])).stdout).argv).toEqual([arg]);
    },
  );

  it("kills a grandchild on timeout", async () => {
    const r = await run(process.execPath, [SLEEPER], { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    const gpid = Number(r.stdout.trim());
    expect(gpid).toBeGreaterThan(0);
    expect(await waitGone(gpid)).toBe(true);
  });

  it("spawnSupervised streams large output to files and reports start time", async () => {
    const dir = tmp("sup-");
    const stdoutFile = join(dir, "out.txt");
    const stderrFile = join(dir, "err.txt");
    const h = spawnSupervised(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(3e6)); process.stderr.write('e')"],
      { stdoutFile, stderrFile },
    );
    expect(h.pid).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(h.startedAt))).toBe(false);
    const r = await h.done;
    expect(r.status).toBe(0);
    expect(readFileSync(stdoutFile, "utf8").length).toBe(3e6);
    expect(readFileSync(stderrFile, "utf8")).toBe("e");
  });

  it("spawnSupervised on a missing command fails cleanly (throw or failed result, never uncaught)", async () => {
    const dir = tmp("sup-");
    try {
      const h = spawnSupervised("definitely-not-a-command-xyz", [], {
        stdoutFile: join(dir, "o"),
        stderrFile: join(dir, "e"),
      });
      expect((await h.done).status).not.toBe(0);
    } catch (e) {
      expect(String(e)).toMatch(/Failed to start/);
    }
    await new Promise((r) => setTimeout(r, 200));
  });

  it("spawnSupervised kill() removes the process tree", async () => {
    const dir = tmp("sup-");
    const h = spawnSupervised(process.execPath, [SLEEPER], {
      stdoutFile: join(dir, "o"),
      stderrFile: join(dir, "e"),
    });
    let gpid = 0;
    for (let i = 0; i < 50 && !gpid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      gpid = Number(readFileSync(join(dir, "o"), "utf8").trim());
    }
    expect(gpid).toBeGreaterThan(0);
    await h.kill();
    await h.done;
    expect(await waitGone(h.pid)).toBe(true);
    expect(await waitGone(gpid)).toBe(true);
  });
});

describe("shell", () => {
  it("finds bash on every OS", () => {
    expect(existsSync(bashPath()) || bashPath() === "bash").toBe(true);
  });

  it("quotes {files} for bash", async () => {
    const r = await runShell(`printf '%s\\n' ${shQuote("a b'c.ts")}`);
    expect(r.stdout.trim()).toBe("a b'c.ts");
  });

  it("runShellSync runs through bash -c", () => {
    expect(runShellSync("echo hi").stdout.trim()).toBe("hi");
  });

  it.skipIf(process.platform !== "win32")(
    "bashPath honours CLAUDE_CODE_GIT_BASH_PATH (win32 only: POSIX always uses bash)",
    () => {
      expect(bashPath({ CLAUDE_CODE_GIT_BASH_PATH: process.execPath })).toBe(process.execPath);
    },
  );
});
