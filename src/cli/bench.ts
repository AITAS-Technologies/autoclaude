import { readFileSync } from "node:fs";
import {
  loadExpected,
  matchFindings,
  type BenchResult,
  type Expected,
} from "../engine/review/bench.js";
import {
  classifyOptions,
  isReportComplete,
  parseCodeReviewReport,
  TIERS,
} from "../engine/review/reports.js";
import { normaliseQuotedPath } from "../engine/review/rules.js";
import { messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

const USAGE = "usage: autoclaude bench <report.md> <expected.json> [--json]";

/** Columns padded to their widest cell, the last one left ragged. */
function asTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((title, i) => Math.max(title.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)];
}

/** `must 2/4, should 1/2, …`: which class the misses are in, only for the tiers in use. */
function perTier(expected: Expected[], result: BenchResult): string {
  const hit = new Set(result.hits.map((h) => h.expected.id));
  const groups: Array<[string, Expected[]]> = [
    ...TIERS.map((tier): [string, Expected[]] => [tier, expected.filter((e) => e.tier === tier)]),
    ["unstated", expected.filter((e) => !e.tier)],
  ];
  return groups
    .filter(([, group]) => group.length > 0)
    .map(([name, group]) => `${name} ${group.filter((e) => hit.has(e.id)).length}/${group.length}`)
    .join(", ");
}

export function renderBench(
  expected: Expected[],
  result: BenchResult,
  where: { report: string; expected: string },
  worktreesRoot?: string,
): string {
  const hit = new Map(result.hits.map((h) => [h.expected.id, h.finding]));
  const wondered = new Map(result.seen.map((s) => [s.expected.id, s.uncertain]));
  const rows = expected.map((one) => {
    const finding = hit.get(one.id);
    const uncertain = wondered.get(one.id);
    const span = one.lines ? `${one.lines[0]}-${one.lines[1]}` : "*";
    const detail = finding
      ? `${finding.rule} at ${finding.file}:${finding.line} (${finding.tier}, confidence ${finding.confidence})`
      : uncertain
        ? `uncertain: ${uncertain}`
        : (one.note ?? "");
    return [
      one.id,
      finding ? "hit" : uncertain ? "seen" : "miss",
      one.tier ?? "-",
      `${normaliseQuotedPath(one.file, worktreesRoot)}:${span}`,
      detail,
    ];
  });
  const total = expected.length;
  const unmatched = result.unmatched.length
    ? [
        "",
        `unmatched findings (${result.unmatched.length}) — not false positives: the expected list is not exhaustive`,
        ...result.unmatched.map(
          (f, i) =>
            `  ${i + 1}. ${f.rule} at ${f.file}:${f.line} (${f.tier}, confidence ${f.confidence})`,
        ),
      ]
    : ["", "every finding in the report claimed an expectation"];
  return [
    `bench: ${where.report} against ${where.expected}`,
    `${total} expected: ${result.hits.length} hit, ${result.seen.length} seen, ${result.misses.length} missed`,
    "",
    ...asTable(["id", "outcome", "tier", "where", "detail"], rows),
    "",
    `recall ${result.recall.toFixed(2)} (${result.hits.length}/${total})  ` +
      `seenRate ${result.seenRate.toFixed(2)} (${result.hits.length + result.seen.length}/${total})`,
    `by tier: ${perTier(expected, result)}`,
    ...unmatched,
  ].join("\n");
}

/**
 * `autoclaude bench <report.md> <expected.json> [--json]`: measures a code-review report
 * against a list of expected findings. Exit 0 whatever the numbers say; 1 for an unreadable
 * file, a report the parser refuses, a report that did not finish or a bad expected list;
 * 64 for the wrong arguments.
 */
export async function benchVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  const files = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (files.length !== 2 || flags.some((f) => f !== "--json")) return usageError(io, USAGE);
  const [reportFile, expectedFile] = files as [string, string];
  try {
    const text = readFileSync(reportFile, "utf8");
    // Completeness first: a review that stopped early found less than one that ran to the
    // end, and the status line is the only proof it ran at all.
    if (!isReportComplete("code-review", text)) {
      io.err("report: the code-review report is not marked complete; the run did not finish\n");
      return 1;
    }
    const root = env.root(cwd);
    const cfg = env.config(root);
    const report = parseCodeReviewReport(
      text,
      classifyOptions("code-review", { cfg, projectRoot: root }),
    );
    const expected = loadExpected(expectedFile);
    const result = matchFindings(report, expected);
    io.out(
      `${
        flags.includes("--json")
          ? JSON.stringify({ reportFile, expectedFile, ...result }, null, 2)
          : renderBench(
              expected,
              result,
              { report: reportFile, expected: expectedFile },
              cfg.worktrees.root,
            )
      }\n`,
    );
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
