/**
 * Claude Code's PreToolUse hook for a stage: the payload in, the verdict out.
 *
 * A PreToolUse hook blocks on exit 2 and ONLY on exit 2. So every path that is not a
 * proven allow ends in exit 2: an unreadable payload, a payload for another tool, a
 * missing command, a malformed config, a thrown error. The decision itself is
 * `refusalFor`; this function only reads the payload and translates the answer, and the
 * `autoclaude guard --runtime claude` verb writes `stderr` and exits with `exit`.
 *
 * Claude Code shows the hook's stderr to the model (Phase 0, spike S4), so the reason is
 * one short line that says what was refused and why.
 *
 * Phase 0 also observed that in `dontAsk` mode read-only Bash commands run without any
 * allow rule; for Bash, this hook rather than the allow list is the fence.
 */
import { refusalFor, type GuardConfig } from "./core.js";

export interface HookVerdict {
  exit: 0 | 2;
  stderr: string;
}

/** A thrown value as text, without throwing again: the hook's last word must not fail. */
function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an error that cannot be printed";
  }
}

function block(reason: string): HookVerdict {
  return { exit: 2, stderr: `autoclaude guard: ${reason}\n` };
}

/**
 * The verdict for one PreToolUse payload.
 *
 * Only `Bash` payloads are decided. The guard reads POSIX shell, and a command meant for
 * another shell would be decided about text that shell reads differently — the source's
 * hook was attached to PowerShell as well (defect 5); a payload for any other tool is
 * refused here, whatever the hook's matcher says.
 */
export function claudeHook(stdin: string, cfg: GuardConfig): HookVerdict {
  try {
    if (typeof stdin !== "string") return block("the hook received no payload text");
    // Every parser accepts a leading UTF-8 BOM; JSON.parse does not, so it is dropped.
    const text = stdin.charCodeAt(0) === 0xfeff ? stdin.slice(1) : stdin;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      return block(`could not read the pending command from stdin (${describe(error)})`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return block("the payload is not a JSON object");
    const { tool_name: tool, tool_input: input } = payload as {
      tool_name?: unknown;
      tool_input?: unknown;
    };
    if (tool !== "Bash")
      return block(
        `this hook decides Bash commands only, and the payload is for ${typeof tool === "string" ? tool : "no named tool"}`,
      );
    const command =
      input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
    if (typeof command !== "string") return block("the payload carries no command string");
    const reason = refusalFor(command, cfg);
    if (reason) return block(reason);
    return { exit: 0, stderr: "" };
  } catch (error) {
    return block(`the guard itself failed (${describe(error)})`);
  }
}
