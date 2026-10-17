import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Per-machine state directory (usage cache etc.). */
export function machineStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "autoclaude");
  if (platform === "darwin") return join(home, "Library", "Application Support", "autoclaude");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "autoclaude");
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** True when both paths name the same location, using the file system's case rules. */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const x = canonical(a);
  const y = canonical(b);
  if (platform === "win32" || platform === "darwin") return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
