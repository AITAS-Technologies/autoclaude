import { describe, it, expect } from "vitest";
import { profileAt } from "../../src/engine/profile.js";
import type { ProjectConfig } from "../../src/config/types.js";

// Engine test: an invented config, so the assertions hold for any project.
const cfg = {
  schedule: {
    timezone: "UTC",
    profiles: { day: { from: "07:00", to: "22:00" }, nightStopsTakingWorkAt: "05:00" },
  },
  caps: { concurrency: { day: 1, night: 2 } },
} as unknown as ProjectConfig;

const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 8, h, m));

describe("profileAt", () => {
  it("is day from day.from up to but excluding day.to", () => {
    expect(profileAt(at(7, 0), cfg)).toEqual({ name: "day", concurrency: 1, takesNewWork: true });
    expect(profileAt(at(21, 59), cfg).name).toBe("day");
    expect(profileAt(at(22, 0), cfg).name).toBe("night");
    expect(profileAt(at(6, 59), cfg).name).toBe("night");
  });

  it("uses the night concurrency at night", () => {
    expect(profileAt(at(23, 30), cfg).concurrency).toBe(2);
  });

  // The five-hour window is rolling: a window drained at 06:30 is still drained at
  // 11:30. So the night stops taking work before the human's morning.
  it("takes no new work between the night cutoff and the start of the day", () => {
    expect(profileAt(at(4, 59), cfg).takesNewWork).toBe(true);
    expect(profileAt(at(5, 0), cfg).takesNewWork).toBe(false);
    expect(profileAt(at(6, 59), cfg).takesNewWork).toBe(false);
    expect(profileAt(at(7, 0), cfg).takesNewWork).toBe(true);
  });

  it("refuses a day that ends before it starts", () => {
    const bad = {
      ...cfg,
      schedule: {
        ...cfg.schedule,
        profiles: { ...cfg.schedule.profiles, day: { from: "22:00", to: "07:00" } },
      },
    };
    expect(() => profileAt(at(12, 0), bad)).toThrow(/before/);
  });

  it("computes the day profile in the configured zone", () => {
    const now = new Date("2026-10-16T05:30:00Z"); // 07:30 in Berlin (CEST), 05:30 in UTC
    const zoned = (timezone: string) => ({ ...cfg, schedule: { ...cfg.schedule, timezone } });
    expect(profileAt(now, zoned("Europe/Berlin")).name).toBe("day");
    expect(profileAt(now, zoned("UTC")).name).toBe("night");
    // And a zone far from the machine's: 05:30Z is 22:30 the evening before in Los Angeles.
    expect(profileAt(now, zoned("America/Los_Angeles")).name).toBe("night");
  });

  it("refuses a zone it does not know, by name", () => {
    const bad = { ...cfg, schedule: { ...cfg.schedule, timezone: "Mars/Olympus" } };
    expect(() => profileAt(at(12, 0), bad)).toThrow(/Mars\/Olympus/);
  });
});
