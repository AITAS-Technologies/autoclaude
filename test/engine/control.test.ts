import { afterAll, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control, controlPaths, controlState } from "../../src/engine/control.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const root = () => {
  const r = mkdtempSync(join(tmpdir(), "autoclaude-control-"));
  roots.push(r);
  return r;
};

// Pause, drain, resume are files, so they work while the orchestrator is unresponsive. The
// two files exclude each other: a pause during a drain used to leave both, which no
// reader could name.
describe("control", () => {
  it("keeps exactly one of PAUSED and DRAINING, and resume clears both", () => {
    const r = root();
    expect(controlState(r)).toEqual({ paused: false, draining: false });
    expect(control(r, "drain")).toEqual({ paused: false, draining: true });
    expect(control(r, "pause")).toEqual({ paused: true, draining: false });
    expect(existsSync(controlPaths(r).draining)).toBe(false);
    expect(control(r, "drain")).toEqual({ paused: false, draining: true });
    expect(control(r, "resume")).toEqual({ paused: false, draining: false });
    expect(control(r, "show")).toEqual({ paused: false, draining: false });
  });
  it("refuses an unknown command", () => {
    expect(() => control(root(), "stop")).toThrow(/Usage/);
  });
});
