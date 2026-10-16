import { spawn, spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  // Guard: pid 0 would signal our own group, pid 1 becomes kill(-1) (everything we may signal).
  if (!Number.isInteger(pid) || pid <= 1) return;
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
    // A zombie leader is dead for our purposes (processStartTime reports it as null).
    if (processStartTime(pid) === null) break;
    await sleep(100);
  }
  if (processStartTime(pid) === null && !groupAlive(pid)) return;
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
 * Parses `ps -o stat=,lstart=` output: null for empty output or a zombie (state Z),
 * otherwise the start time as ISO-8601 UTC.
 */
export function parsePsStartLine(line: string): string | null {
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(line);
  if (!m || m[1]!.startsWith("Z")) return null;
  return toIso(new Date(m[2]!));
}

/**
 * Start time of a process as ISO-8601 UTC with millisecond precision, stable across
 * calls for the same process; `null` when the process does not exist or is a zombie.
 * POSIX values come from `ps lstart` and have second precision; they can shift by about
 * a second after a wall-clock step (NTP, VM resume), so callers must compare POSIX start
 * times with a tolerance (Task G4 uses +-2 s). Windows values are exact.
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
  const r = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (r.status !== 0) return null;
  return parsePsStartLine(r.stdout);
}
