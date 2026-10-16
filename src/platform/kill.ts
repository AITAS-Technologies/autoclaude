import { spawn, spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills a process and all its descendants. Windows: `taskkill /pid <pid> /T /F`.
 * POSIX: SIGTERM to the process group (children are spawned `detached: true`, so
 * they lead a group), SIGKILL after 5 s. Never rejects; a missing process is fine.
 */
export async function killTree(pid: number): Promise<void> {
  if (IS_WIN) {
    await new Promise<void>((resolve) => {
      const p = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      p.on("error", () => resolve());
      p.on("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!groupAlive(pid) && !alive(pid)) return;
    await sleep(50);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function toIso(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Start time of a process as ISO-8601 UTC with millisecond precision, stable across
 * calls for the same process; `null` when the process does not exist.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (IS_WIN) {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out ? toIso(new Date(out.replace(/(\.\d{3})\d*Z$/, "$1Z"))) : null;
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out ? toIso(new Date(out)) : null;
}
