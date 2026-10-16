/**
 * Reads the outcome of one `claude -p --output-format json` run (Phase 0, spike S4,
 * `docs/spikes/s4-claude-stage.md`): a single JSON object with `type: "result"` on stdout.
 * Success is exit 0 / `subtype: "success"`; structured output is in `structured_output`;
 * the turn limit is exit 1 / `is_error` / `subtype: "error_max_turns"` with no `result`;
 * a permission denial or a hook block is still a success, listed in `permission_denials`.
 */
import { parseLimit } from "../../engine/ledger/ledger.js";
import type { StageResult } from "../types.js";

export type ParsedResult = Omit<StageResult, "stdoutFile" | "stderrFile" | "pid" | "startedAt">;

export interface ParseOptions {
  /** The CLI's stderr; consulted only when stdout holds no result line. */
  stderr?: string;
  now?: Date;
  /** The schedule zone a reset clock time is read in. */
  timeZone?: string;
}

/** Observed only in the vendor docs, never from a real run (see the spike). */
const LIMIT = /You've hit your (session|weekly) limit · resets (.+)$/m;
const AUTH = /log ?in|\/login|invalid api key|unauthori[sz]ed/i;
const QUOTA = /\b(usage|rate|session|weekly)\s+limit\b|\bquota\b/i;
const NETWORK =
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network (error|is unreachable)/i;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "3:45pm" or "Mon 12:00am" (a time of the schedule zone) to an ISO instant, or undefined. */
export function resetInstant(text: string, now: Date, timeZone: string): string | undefined {
  const m =
    /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(
      text.trim(),
    );
  try {
    if (!m) return parseLimit(text.trim(), now, timeZone) ?? undefined;
    let h = Number(m[2]) % 12;
    if (m[4]!.toLowerCase() === "pm") h += 12;
    const hhmm = `${String(h).padStart(2, "0")}:${m[3] ?? "00"}`;
    let at = new Date(parseLimit(hhmm, now, timeZone)!);
    if (m[1]) {
      const want = WEEKDAYS.indexOf(m[1].toLowerCase());
      const dayOf = (d: Date): number =>
        WEEKDAYS.indexOf(
          new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone })
            .format(d)
            .toLowerCase()
            .slice(0, 3),
        );
      for (let i = 0; i < 7 && dayOf(at) !== want; i++) at = new Date(at.getTime() + 86_400_000);
    }
    return at.toISOString();
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;

function lastResultLine(stdout: string): Json | undefined {
  const lines = stdout.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object" && (v as Json).type === "result") return v as Json;
    } catch {
      // noise line
    }
  }
  return undefined;
}

export function parseClaudeResult(
  stdout: string,
  status: number | null,
  opts: ParseOptions = {},
): ParsedResult {
  const j = lastResultLine(stdout);
  if (!j) {
    const err = opts.stderr ?? "";
    return {
      exit: "failed",
      resultText: err.trim() || stdout.trim() || `no result from claude (exit ${status ?? "none"})`,
      errorClass: AUTH.test(err) ? "auth" : NETWORK.test(err) ? "network" : "unknown",
    };
  }
  const text = typeof j.result === "string" ? j.result : "";
  const out: ParsedResult = { exit: "ok", resultText: text };
  const usage = j.usage as Json | undefined;
  if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
    out.tokens = { input: usage.input_tokens, output: usage.output_tokens };
  }
  if (typeof j.total_cost_usd === "number") out.costUsd = j.total_cost_usd;
  if (j.structured_output !== undefined) out.structured = j.structured_output;
  if (Array.isArray(j.permission_denials) && j.permission_denials.length > 0) {
    out.permissionDenials = j.permission_denials;
  }

  const failed = j.is_error === true || (status !== null && status !== 0);
  if (!failed) return out;

  const errors = Array.isArray(j.errors) ? j.errors.map(String).join("\n") : "";
  const all = [text, errors].filter(Boolean).join("\n");
  if (!text && errors) out.resultText = errors;
  const limit = LIMIT.exec(all);
  if (limit) {
    out.exit = "limit";
    const at = resetInstant(
      limit[2]!.trim(),
      opts.now ?? new Date(),
      opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (at) out.limitResetsAt = at;
    return out;
  }
  out.exit = "failed";
  if (AUTH.test(all)) out.errorClass = "auth";
  else if (QUOTA.test(all)) out.errorClass = "quota";
  else if (NETWORK.test(all)) out.errorClass = "network";
  else if (j.subtype !== "error_max_turns") out.errorClass = "unknown";
  return out;
}
