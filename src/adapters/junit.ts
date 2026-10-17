export interface JUnitCounts {
  total: number;
  /** test cases that ran and failed an assertion (`<failure>` inside a test case) */
  failed: number;
  /** test cases that errored (`<error>` inside a test case) */
  errored: number;
  /** suites that never got to run tests: an `<error>` or `<failure>` on the suite itself */
  suitesFailed: number;
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTR = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]!] = m[2] ?? m[3] ?? "";
  return out;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

interface Totals {
  tests?: number;
  failures?: number;
  errors?: number;
}

/**
 * Counts from a JUnit XML report, with no XML dependency. The dialects differ (vitest,
 * jest-junit, pytest, gotestsum and `node --test` all write their own), so two sources are
 * read and the larger count wins: the `tests`/`failures`/`errors` attributes of
 * `<testsuites>` (or, without totals there, of the top-level `<testsuite>` elements, so a
 * nested suite is never counted twice) and the elements themselves, `<failure`/`<error`
 * inside a `<testcase`. An `<error`/`<failure` on a suite outside any test case is a suite
 * that did not load and is counted apart. Tolerates a BOM, CRLF, an XML declaration,
 * comments and CDATA. Text that is not a report gives zeros.
 */
export function parseJUnit(xml: string): JUnitCounts {
  const text = xml
    .replace(/^﻿/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");

  let rootTotals: Totals | undefined;
  const topSuites: Totals = {};
  let hasTopSuite = false;
  let suiteDepth = 0;
  let inCase = false;
  let cases = 0;
  let caseFailures = 0;
  let caseErrors = 0;
  let suiteLevel = 0;
  let suiteLevelFailures = 0;

  const add = (t: Totals, a: Record<string, string>): void => {
    for (const k of ["tests", "failures", "errors"] as const) {
      const n = num(a[k]);
      if (n !== undefined) t[k] = (t[k] ?? 0) + n;
    }
  };

  for (const m of text.matchAll(TAG)) {
    const closing = m[1] === "/";
    const name = m[2]!;
    const selfClosing = m[4] === "/";
    if (name === "testsuites" && !closing) {
      const a = attrs(m[3]!);
      if (a.tests !== undefined || a.failures !== undefined || a.errors !== undefined) {
        rootTotals = {};
        add(rootTotals, a);
      }
    } else if (name === "testsuite") {
      if (closing) suiteDepth = Math.max(0, suiteDepth - 1);
      else {
        if (suiteDepth === 0) {
          hasTopSuite = true;
          add(topSuites, attrs(m[3]!));
        }
        if (!selfClosing) suiteDepth += 1;
      }
    } else if (name === "testcase") {
      if (closing) inCase = false;
      else {
        cases += 1;
        inCase = !selfClosing;
      }
    } else if ((name === "failure" || name === "error") && !closing) {
      if (inCase) {
        if (name === "failure") caseFailures += 1;
        else caseErrors += 1;
      } else if (suiteDepth > 0) {
        suiteLevel += 1;
        if (name === "failure") suiteLevelFailures += 1;
      }
    }
  }

  const totals: Totals = rootTotals ?? (hasTopSuite ? topSuites : {});
  // A suite-level error or failure is also in the suite's attribute; it must not count twice.
  return {
    total: Math.max(totals.tests ?? 0, cases),
    failed: Math.max((totals.failures ?? 0) - suiteLevelFailures, caseFailures),
    errored: Math.max((totals.errors ?? 0) - (suiteLevel - suiteLevelFailures), caseErrors),
    suitesFailed: suiteLevel,
  };
}
