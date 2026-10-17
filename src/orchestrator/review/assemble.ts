/**
 * The two review blocks, assembled by the engine from what the review processes answered.
 *
 * Pure. The output is the contract the C2 parsers read (`parseCodeReviewReport`,
 * `parseStoppedCodeReview`, `parsePlanReviewReport`) and is byte-compatible with the source
 * skills' block: same markers, keys and order, `line: -` for no line, the evidence in double
 * quotes. There is no level and no class; those are computed on read. Every value is flattened
 * to one line, so text a model wrote cannot add a key, a finding or a status line.
 */
import type { RedStepVerdict } from "../../engine/review/reports.js";

export interface AssembledFinding {
  rule: string;
  confidence: number;
  file: string;
  line: number | null;
  evidence: string;
  message: string;
}

export interface CodeReviewParts {
  issue: number;
  /** Null only for a review that stopped before the red step. */
  redStep: RedStepVerdict | null;
  /** Required by the parser for `could-not-run`; empty otherwise. */
  reason: string;
  /** The angles that returned; empty reads `none`. */
  fanOut: string[];
  /** The scorer's model; empty is allowed only for a stopped review. */
  scoredBy: string;
  /** One entry per acceptance criterion in order, or `none` when there is nothing to check. */
  criteria: Array<{ met: boolean; where: string }> | "none";
  findings: AssembledFinding[];
  uncertain: string[];
  status: "complete" | "stopped";
}

export interface PlanReviewParts {
  issue: number;
  scoredBy: string;
  findings: AssembledFinding[];
  uncertain: string[];
  status: "complete" | "stopped";
}

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function findingLines(findings: AssembledFinding[]): string[] {
  return [
    "findings:",
    ...findings.flatMap((f) => [
      `  - rule: ${flat(f.rule)}`,
      `    confidence: ${f.confidence}`,
      `    file: ${flat(f.file)}`,
      `    line: ${f.line !== null && f.line > 0 ? f.line : "-"}`,
      `    evidence: "${flat(f.evidence)}"`,
      `    message: ${flat(f.message)}`,
    ]),
  ];
}

function uncertainLines(uncertain: string[]): string[] {
  return [
    "uncertain:",
    ...uncertain
      .map(flat)
      .filter((u) => u !== "")
      .map((u) => `  - ${u}`),
  ];
}

export function assembleCodeReview(parts: CodeReviewParts): string {
  const criteria =
    parts.criteria === "none"
      ? ["criteria: none"]
      : [
          "criteria:",
          ...parts.criteria.map(
            (c, i) => `  ${i + 1}. ${c.met ? "met" : "not met"} — ${flat(c.where) || "not stated"}`,
          ),
        ];
  const lines = [
    "AUTODEV-CODE-REVIEW",
    `issue: ${parts.issue}`,
    ...(parts.redStep === null ? [] : [`red-step: ${parts.redStep}`]),
    flat(parts.reason) === "" ? "reason:" : `reason: ${flat(parts.reason)}`,
    `fan-out: ${parts.fanOut.length > 0 ? parts.fanOut.map(flat).join(", ") : "none"}`,
    ...(flat(parts.scoredBy) === "" && parts.status === "stopped"
      ? []
      : [`scored-by: ${flat(parts.scoredBy) || "none"}`]),
    ...criteria,
    ...findingLines(parts.findings),
    ...uncertainLines(parts.uncertain),
    `CODE-REVIEW-STATUS: ${parts.status}`,
  ];
  return lines.join("\n") + "\n";
}

export function assemblePlanReview(parts: PlanReviewParts): string {
  return (
    [
      "AUTODEV-PLAN-REVIEW",
      `issue: ${parts.issue}`,
      `scored-by: ${flat(parts.scoredBy) || "none"}`,
      ...findingLines(parts.findings),
      ...uncertainLines(parts.uncertain),
      `PLAN-REVIEW-STATUS: ${parts.status}`,
    ].join("\n") + "\n"
  );
}
