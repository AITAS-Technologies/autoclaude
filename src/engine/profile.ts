/**
 * Which profile the orchestrator is in right now, and the wall-clock arithmetic in a
 * configured IANA zone that it (and the ledger's `limit` verb) need.
 *
 * The day profile competes with a human for the same five-hour window, so it runs
 * fewer issues; the night profile stops taking new work some hours before the day
 * starts, because a window drained at 06:30 is still drained at 11:30 (design,
 * section 11, "The human reserve").
 *
 * Wall-clock times are evaluated in `schedule.timezone`, never in the machine's zone,
 * through `Intl.DateTimeFormat` (no dependency).
 */

import type { ProjectConfig } from "../config/types.js";

export interface Profile {
  name: "day" | "night";
  /** Issues that may have a running stage at once. 0 means: finish what is in flight, take nothing new. */
  concurrency: number;
  /** False in the last hours of the night, so a run never overlaps the human's morning. */
  takesNewWork: boolean;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new Error(`unknown time zone "${timeZone}"; use an IANA name such as Europe/Berlin`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds (whole minutes). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClockIn(new Date(ms), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant at which a zone's wall clock reads the given date and time.
 *
 * Daylight saving makes this ambiguous at two moments a year. A local time the zone
 * skips (02:30 when 02:00 jumps to 03:00) resolves to the later valid instant (03:30);
 * a local time it shows twice (02:30 when 03:00 falls back to 02:00) resolves to the
 * earlier one.
 *
 * `month` is 1-12; `day` may overflow the month (the 32nd is the 1st of the next).
 */
export function instantInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // The offsets in force a day either side bracket any transition near `naive`.
  const offsets = new Set([
    offsetAt(naive - 86_400_000, timeZone),
    offsetAt(naive + 86_400_000, timeZone),
  ]);
  const candidates = [...offsets].map((o) => naive - o);
  const valid = candidates.filter((c) => offsetAt(c, timeZone) === naive - c);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(Math.max(...candidates));
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function profileAt(now: Date, cfg: ProjectConfig): Profile {
  const { timezone, profiles } = cfg.schedule;
  const wall = wallClockIn(now, timezone);
  const t = wall.hour * 60 + wall.minute;
  const from = minutesOf(profiles.day.from);
  const to = minutesOf(profiles.day.to);
  const cutoff = minutesOf(profiles.nightStopsTakingWorkAt);
  if (from >= to) {
    throw new Error(
      `schedule.profiles.day.from (${profiles.day.from}) must be before schedule.profiles.day.to (${profiles.day.to})`,
    );
  }
  if (t >= from && t < to) {
    return { name: "day", concurrency: cfg.caps.concurrency.day, takesNewWork: true };
  }
  // Night. The cutoff normally sits between midnight and day.from; if it is set later
  // than day.from it wraps around midnight instead. It gates new claims only: a chain
  // claimed at 04:55 still runs its stages into the morning, as the design accepts
  // ("work already in flight finishes").
  const inCutoff = cutoff <= from ? t >= cutoff && t < from : t >= cutoff || t < from;
  return { name: "night", concurrency: cfg.caps.concurrency.night, takesNewWork: !inCutoff };
}
