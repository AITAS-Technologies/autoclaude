import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJUnit } from "../../src/adapters/junit.js";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", "junit", `${name}.xml`), "utf8");

describe("parseJUnit", () => {
  it.each(["vitest", "jest", "pytest", "gotestsum", "node-test"])("parses %s JUnit", (name) => {
    expect(parseJUnit(fixture(name)).total).toBeGreaterThan(0);
  });

  it.each([
    ["vitest", { total: 3, failed: 1, errored: 0, suitesFailed: 0 }],
    ["jest", { total: 4, failed: 2, errored: 0, suitesFailed: 0 }],
    ["pytest", { total: 4, failed: 1, errored: 1, suitesFailed: 0 }],
    ["gotestsum", { total: 3, failed: 1, errored: 0, suitesFailed: 0 }],
    // A nested suite must not be counted on top of the file suite that holds it.
    ["node-test", { total: 2, failed: 1, errored: 0, suitesFailed: 0 }],
  ])("counts the %s fixture", (name, expected) => {
    expect(parseJUnit(fixture(name))).toEqual(expected);
  });

  it("reads a report with a BOM and CRLF line endings", () => {
    const xml = "﻿" + fixture("jest").replace(/\n/g, "\r\n");
    expect(parseJUnit(xml)).toEqual(parseJUnit(fixture("jest")));
  });

  it("falls back to counting test cases when no suite carries counts", () => {
    const xml = `<testsuite name="s"><testcase name="a"/><testcase name="b"><failure/></testcase>
      <testcase name="c"><error message="x"/></testcase></testsuite>`;
    expect(parseJUnit(xml)).toEqual({ total: 3, failed: 1, errored: 1, suitesFailed: 0 });
  });

  it("sums sibling suites when there is no testsuites total", () => {
    const xml = `<testsuite name="a" tests="2" failures="1" errors="0"><testcase name="x"/>
      <testcase name="y"><failure/></testcase></testsuite>
      <testsuite name="b" tests="3" failures="0" errors="1"><testcase name="z"><error/></testcase>
      <testcase name="p"/><testcase name="q"/></testsuite>`;
    expect(parseJUnit(xml)).toEqual({ total: 5, failed: 1, errored: 1, suitesFailed: 0 });
  });

  it("counts an error on a suite itself (a file that did not load) as a failed suite", () => {
    const xml = `<testsuites><testsuite name="broken.test" tests="0" failures="0" errors="1">
      <error message="Cannot find module './add'"/></testsuite>
      <testsuite name="ok" tests="1"><testcase name="t"/></testsuite></testsuites>`;
    const r = parseJUnit(xml);
    expect(r.suitesFailed).toBe(1);
    expect(r.total).toBe(1);
  });

  it("ignores failure-looking text inside CDATA and comments", () => {
    const xml = `<testsuite tests="1"><!-- <failure/> --><testcase name="a"><system-out><![CDATA[<failure/> <error/>]]></system-out></testcase></testsuite>`;
    expect(parseJUnit(xml)).toEqual({ total: 1, failed: 0, errored: 0, suitesFailed: 0 });
  });

  it("returns zeros for text that is not a report", () => {
    expect(parseJUnit("")).toEqual({ total: 0, failed: 0, errored: 0, suitesFailed: 0 });
    expect(parseJUnit("not xml")).toEqual({ total: 0, failed: 0, errored: 0, suitesFailed: 0 });
  });
});
