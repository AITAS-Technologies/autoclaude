import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyOptions, parsePlanReviewReport } from "../../../src/engine/review/reports.js";
import { runPlanReview } from "../../../src/orchestrator/review/plan-review.js";
import type { Dispatch } from "../../../src/prompts/dispatch.js";
import type { StageRequest } from "../../../src/runtimes/types.js";
import { reviewRig } from "../../helpers/review-rig.js";
import { asResult, scriptedRuntime, type Scripted } from "../../helpers/scripted-runtime.js";

const dispatchOf = (req: StageRequest): Dispatch =>
  JSON.parse(readFileSync(req.dispatchFile, "utf8")) as Dispatch;
const idsOf = (req: StageRequest): number[] =>
  [...(dispatchOf(req).findingsMarkdown ?? "").matchAll(/^- id: (\d+)$/gm)].map((m) =>
    Number(m[1]),
  );
const cand = (rule: string, over: Record<string, unknown> = {}) => ({
  rule,
  confidence: 9,
  file: ".autoclaude/state/plans/42.md",
  line: 10,
  evidence: "Step 2: write the code",
  message: "A finding.",
  ...over,
});

function setup(script: Scripted) {
  const r = reviewRig();
  mkdirSync(join(r.worktree, ".autoclaude", "state", "plans"), { recursive: true });
  writeFileSync(join(r.worktree, ".autoclaude", "state", "plans", "42.md"), "# Plan\n");
  const rt = scriptedRuntime(script);
  r.setRuntime(rt);
  return { r, rt };
}

async function planReport(r: ReturnType<typeof reviewRig>) {
  const out = await runPlanReview(r.ctx, r.entry());
  if (out.kind !== "report") throw new Error("test: expected a report, got a limit");
  return out;
}

const parse = (r: ReturnType<typeof reviewRig>, text: string) =>
  parsePlanReviewReport(text, classifyOptions("plan-review", { cfg: r.cfg, projectRoot: r.root }));

describe("runPlanReview", () => {
  it("runs finder, quote filter and scorer, and writes a block the plan-review parser reads", async () => {
    const { r, rt } = setup((role, req) => {
      if (role === "plan-review-finder")
        return {
          candidates: [
            cand("plan/placeholder"),
            cand("bug/boundary", { evidence: "" }), // line rule, no quote: dropped
            cand("plan/criterion-uncovered", {
              file: "",
              line: null,
              evidence: "",
              message: "3 maps to nothing.",
            }), // measurement: kept
            cand("plan/oversized", { line: 5 }),
          ],
          uncertain: ["plan/too-large — maybe"],
        };
      if (role === "plan-review-scorer")
        return {
          scores: idsOf(req).map((id) => ({ id, confidence: id === 2 ? 4 : 9 })),
        };
      throw new Error(role);
    });
    const { reportFile } = await planReport(r);
    expect(reportFile).toBe(join(r.worktree, ".autoclaude", "state", "reports", "plan-review.md"));
    const text = readFileSync(reportFile, "utf8");
    expect(text.split("\n")[0]).toBe("AUTODEV-PLAN-REVIEW");
    const report = parse(r, text);
    expect(report.complete).toBe(true);
    expect(report.scoredBy).toBe(r.cfg.stages.planReview.scorer.model);
    expect(report.findings.map((f) => [f.rule, f.tier])).toEqual([
      ["plan/placeholder", "must"],
      ["plan/oversized", "should"],
    ]);
    expect(report.uncertain.some((u) => u.startsWith("plan/too-large"))).toBe(true);
    expect(report.uncertain.some((u) => u.startsWith("plan/criterion-uncovered"))).toBe(true);
    // finder on the planReview spec, scorer on its scorer spec, both read-only in the worktree
    expect(rt.requests.map((x) => x.role)).toEqual(["plan-review-finder", "plan-review-scorer"]);
    expect(rt.requests[0]!.req.model).toBe(r.cfg.stages.planReview.model);
    expect(rt.requests[1]!.req.model).toBe(r.cfg.stages.planReview.scorer.model);
    for (const { req } of rt.requests) {
      expect(req.readOnly).toBe(true);
      expect(req.cwd).toBe(r.worktree);
    }
    // the dropped candidate never reached the scorer
    expect(dispatchOf(rt.requests[1]!.req).findingsMarkdown).not.toContain("bug/boundary");
    // renders the finder prompt with the plan file
    expect(readFileSync(rt.requests[0]!.req.promptFile, "utf8")).toContain(
      join(r.worktree, ".autoclaude", "state", "plans", "42.md"),
    );
  });

  it("with nothing found it runs no scorer", async () => {
    const { r, rt } = setup(() => ({ candidates: [], uncertain: [] }));
    const { reportFile } = await planReport(r);
    const report = parse(r, readFileSync(reportFile, "utf8"));
    expect(report.complete).toBe(true);
    expect(report.findings).toEqual([]);
    expect(rt.requests.map((x) => x.role)).toEqual(["plan-review-finder"]);
  });

  it("retries the finder once, and a second failure writes a stopped block", async () => {
    const { r, rt } = setup(() => asResult({ exit: "failed" }));
    const { reportFile } = await planReport(r);
    const text = readFileSync(reportFile, "utf8");
    expect(text.trimEnd().endsWith("PLAN-REVIEW-STATUS: stopped")).toBe(true);
    expect(parse(r, text).complete).toBe(false);
    expect(rt.requests.map((x) => x.role)).toEqual(["plan-review-finder", "plan-review-finder"]);
  });

  it("a scorer that skips a candidate is a failed scorer, retried once", async () => {
    let tries = 0;
    const { r, rt } = setup((role, req) => {
      if (role === "plan-review-finder")
        return { candidates: [cand("plan/placeholder"), cand("plan/oversized")], uncertain: [] };
      tries += 1;
      return tries === 1
        ? { scores: [{ id: 1, confidence: 9 }] }
        : { scores: idsOf(req).map((id) => ({ id, confidence: 8 })) };
    });
    const { reportFile } = await planReport(r);
    expect(parse(r, readFileSync(reportFile, "utf8")).findings).toHaveLength(2);
    expect(rt.requests.filter((x) => x.role === "plan-review-scorer")).toHaveLength(2);
  });

  it("a usage limit in the finder or the scorer is a limit: no report, no retry", async () => {
    const a = setup(() => asResult({ exit: "limit", limitResetsAt: "2026-03-01T12:00:00.000Z" }));
    expect(await runPlanReview(a.r.ctx, a.r.entry())).toEqual({
      kind: "limit",
      resetsAt: "2026-03-01T12:00:00.000Z",
    });
    expect(a.rt.requests).toHaveLength(1);
    expect(
      existsSync(join(a.r.worktree, ".autoclaude", "state", "reports", "plan-review.md")),
    ).toBe(false);

    const b = setup((role) =>
      role === "plan-review-finder"
        ? { candidates: [cand("plan/placeholder")], uncertain: [] }
        : asResult({ exit: "limit", limitResetsAt: "2026-03-01T17:00:00.000Z" }),
    );
    expect(await runPlanReview(b.r.ctx, b.r.entry())).toEqual({
      kind: "limit",
      resetsAt: "2026-03-01T17:00:00.000Z",
    });
    expect(b.rt.requests.filter((x) => x.role === "plan-review-scorer")).toHaveLength(1);
  });

  it("an issue that cannot be read is a stopped report, not an exception", async () => {
    const { r } = setup(() => ({ candidates: [], uncertain: [] }));
    const exec = r.ctx.exec;
    r.ctx.exec = (cmd, args, o) =>
      cmd === "gh" ? { status: 1, stdout: "", stderr: "gh: rate limited" } : exec(cmd, args, o);
    const { reportFile } = await planReport(r);
    expect(readFileSync(reportFile, "utf8")).toContain("PLAN-REVIEW-STATUS: stopped");
  });
});
