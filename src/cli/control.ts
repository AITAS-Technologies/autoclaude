import { control } from "../engine/control.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

/** `autoclaude pause|drain|resume`: the control files, from any terminal; prints the state as JSON. */
function controlVerb(cmd: "pause" | "drain" | "resume") {
  const usage = `usage: autoclaude ${cmd}`;
  return async (args: string[], io: Io, cwd: string, env: Env = realEnv): Promise<number> => {
    if (args.length > 0) return usageError(io, usage, `unknown argument: ${args[0]}`);
    try {
      io.out(`${JSON.stringify(control(env.root(cwd), cmd, env.now()))}\n`);
      return 0;
    } catch (e) {
      io.err(`${messageOf(e)}\n`);
      return 1;
    }
  };
}

export const pauseVerb = controlVerb("pause");
export const drainVerb = controlVerb("drain");
export const resumeVerb = controlVerb("resume");
