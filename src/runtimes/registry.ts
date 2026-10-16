import type { Runtime } from "../config/types.js";
import { claudeAdapter } from "./claude/run.js";
import type { RuntimeAdapter } from "./types.js";

export function runtimeFor(name: Runtime): RuntimeAdapter {
  if (name === "claude") return claudeAdapter;
  throw new Error("codex runtime is not available before phase 3");
}
