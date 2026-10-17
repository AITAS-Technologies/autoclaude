import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeResult } from "../../../src/runtimes/claude/result.js";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, `../../fixtures/runtime/claude/${name}.json`), "utf8");

const NOW = { now: new Date("2026-10-16T10:00:00Z"), timeZone: "UTC" }; // a Friday

describe("parseClaudeResult", () => {
  it("reads a plain success", () => {
    const r = parseClaudeResult(fixture("ok"), 0);
    expect(r.exit).toBe("ok");
    expect(r.resultText.length).toBeGreaterThan(0);
    expect(r.tokens).toEqual({ input: 2, output: 4 });
    expect(r.costUsd).toBeCloseTo(0.0547606);
    expect(r.errorClass).toBeUndefined();
  });

  it("reads structured output", () => {
    const r = parseClaudeResult(fixture("structured"), 0);
    expect(r.exit).toBe("ok");
    expect(r.structured).toEqual({ ok: true });
  });

  it("maps the turn limit to a failed stage", () => {
    const r = parseClaudeResult(fixture("max-turns"), 1);
    expect(r.exit).toBe("failed");
    expect(r.resultText).toContain("Reached maximum number of turns");
  });

  it.each(["refused", "hook-blocked"])("keeps %s a success and exposes the denials", (name) => {
    const r = parseClaudeResult(fixture(name), 0);
    expect(r.exit).toBe("ok");
    expect(r.permissionDenials).toHaveLength(1);
  });

  it("ignores noise lines, a BOM and CRLF around the result", () => {
    const out = `﻿Update available\r\n${fixture("ok").trim()}\r\ntrailing noise\r\n`;
    expect(parseClaudeResult(out, 0).exit).toBe("ok");
  });

  it("takes the last result line", () => {
    const first = '{"type":"result","is_error":false,"result":"one"}';
    const second = '{"type":"result","is_error":false,"result":"two"}';
    expect(parseClaudeResult(`${first}\n${second}\n`, 0).resultText).toBe("two");
  });

  it("classifies a logged-out CLI as auth", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}',
      1,
    );
    expect(r.exit).toBe("failed");
    expect(r.errorClass).toBe("auth");
  });

  it("fails with auth from stderr when stdout has no result", () => {
    const r = parseClaudeResult("", 1, { stderr: "Please run /login" });
    expect(r.exit).toBe("failed");
    expect(r.errorClass).toBe("auth");
  });

  it("fails with unknown when there is no result line at all", () => {
    const r = parseClaudeResult("garbage\n", 0);
    expect(r.exit).toBe("failed");
    expect(r.errorClass).toBe("unknown");
  });

  it("detects a session limit and its reset", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":true,"result":"You\'ve hit your session limit · resets 3:45pm"}',
      1,
      NOW,
    );
    expect(r.exit).toBe("limit");
    expect(r.limitResetsAt).toBe("2026-10-16T15:45:00.000Z");
  });

  it("detects a weekly limit with a weekday", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":true,"result":"You\'ve hit your weekly limit · resets Mon 12:00am"}',
      1,
      NOW,
    );
    expect(r.exit).toBe("limit");
    expect(r.limitResetsAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("keeps a limit whose reset it cannot read", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":true,"result":"You\'ve hit your session limit · resets soonish"}',
      1,
    );
    expect(r.exit).toBe("limit");
    expect(r.limitResetsAt).toBeUndefined();
  });

  it("does not read a successful answer that quotes the limit text as a limit", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":false,"result":"You\'ve hit your session limit · resets 3:45pm"}',
      0,
    );
    expect(r.exit).toBe("ok");
  });

  it("classifies a clear quota message as quota", () => {
    const r = parseClaudeResult(
      '{"type":"result","is_error":true,"result":"Usage limit reached"}',
      1,
    );
    expect(r.exit).toBe("failed");
    expect(r.errorClass).toBe("quota");
  });
});
