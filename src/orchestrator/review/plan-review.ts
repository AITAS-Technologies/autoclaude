/**
 * The plan review, driven by the engine: one finder process, the quote-or-drop filter, one
 * scorer process, and the `AUTODEV-PLAN-REVIEW` block assembled here. The source's lead did
 * the same through an agent tool; the finder and the scorer are separate read-only stage
 * processes, and the scorer never sees the finder's reasoning, only the numbered candidates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEntry } from "../../engine/ledger/ledger.js";
import { classifyOptions, reportPath } from "../../engine/review/reports.js";
import { normaliseEvidence } from "../../engine/review/rules.js";
import { foreignGitDir } from "../../engine/worktree.js";
import type { Dispatch } from "../../prompts/dispatch.js";
import { prefetchIssue } from "../prefetch.js";
import type { OrchestratorCtx } from "../stage.js";
import { assemblePlanReview, type AssembledFinding, type PlanReviewParts } from "./assemble.js";
import {
  checkScores,
  findingsMarkdown,
  limitOutcome,
  projectFacts,
  runWithRetry,
  type ReviewOutcome,
} from "./process.js";
import { CandidatesSchema, ScoresSchema, type Candidates, type Scores } from "./schemas.js";

export async function runPlanReview(
  ctx: OrchestratorCtx,
  entry: LedgerEntry,
): Promise<ReviewOutcome> {
  const { cfg, root } = ctx;
  const issue = entry.issue;
  const worktree = entry.worktree;
  if (!worktree) throw new Error(`plan review: the ledger entry for #${issue} has no worktree`);
  const reportFile = join(worktree, reportPath("plan-review"));
  const planFile = join(worktree, ".autoclaude", "state", "plans", `${issue}.md`);
  const integrationRef = `${cfg.forge.remote}/${cfg.branches.integration}`;

  const write = (parts: PlanReviewParts): ReviewOutcome => {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, assemblePlanReview(parts));
    ctx.notes(issue, `plan review report written (${parts.status})`);
    return { kind: "report", reportFile };
  };
  const stopped = (why: string, uncertain: string[] = []): ReviewOutcome => {
    ctx.notes(issue, `plan review stopped: ${why}`);
    return write({
      issue,
      scoredBy: "",
      findings: [],
      uncertain: [...uncertain, `review — not finished: ${why}`],
      status: "stopped",
    });
  };

  // The engine fetches; a stage never does. Not into a git directory a stage chose by rewriting
  // the worktree's `.git` (R73).
  const foreign = foreignGitDir(ctx.root, worktree, ctx.exec);
  if (foreign !== null) return stopped(foreign);
  const fetched = ctx.exec("git", ["fetch", cfg.forge.remote, cfg.branches.integration], {
    cwd: worktree,
  });
  if (fetched.status !== 0)
    return stopped(`git fetch ${integrationRef} failed: ${fetched.stderr.trim()}`);

  const classify = classifyOptions("plan-review", { cfg, projectRoot: root });
  const threshold = classify.threshold ?? 7;
  const evidenceKind = new Map(classify.catalogue.map((r) => [r.id, r.evidence]));
  let issueView: Dispatch["issue"];
  try {
    issueView = prefetchIssue(ctx.forge, issue);
  } catch (error) {
    return stopped(`the issue could not be read: ${String(error).replace(/\s+/g, " ")}`);
  }
  const base: Dispatch = {
    issue: issueView,
    mode: "fresh",
    worktree,
    integrationRef,
    reportFile,
    planFile,
    projectFacts: projectFacts(root),
  };
  const vars = { issue: String(issue), worktree, planFile };

  const found = await runWithRetry<Candidates>(ctx, {
    issue,
    worktree,
    role: "plan-review-finder",
    promptName: "plan-review/finder",
    promptVars: vars,
    dispatch: base,
    spec: cfg.stages.planReview,
    schema: CandidatesSchema,
  });
  if (!found.ok) return found.limit ? limitOutcome([found.limit.resetsAt]) : stopped(found.reason);

  const kept = found.value.candidates.filter(
    (c) => evidenceKind.get(c.rule) === "measurement" || normaliseEvidence(c.evidence) !== "",
  );
  const dropped = found.value.candidates.length - kept.length;
  if (dropped > 0) ctx.notes(issue, `quote filter dropped ${dropped} candidate(s) without a quote`);

  const uncertain = [...found.value.uncertain];
  const numbered = kept.map((c, i) => ({ ...c, id: i + 1 }));
  if (numbered.length === 0)
    return write({
      issue,
      scoredBy: "none (no candidates to score)",
      findings: [],
      uncertain,
      status: "complete",
    });

  const scorer = cfg.stages.planReview.scorer;
  const scored = await runWithRetry<Scores>(
    ctx,
    {
      issue,
      worktree,
      role: "plan-review-scorer",
      promptName: "plan-review/scorer",
      promptVars: vars,
      dispatch: { ...base, findingsMarkdown: findingsMarkdown(numbered) },
      spec: scorer,
      schema: ScoresSchema,
    },
    checkScores(numbered.map((c) => c.id)),
  );
  if (!scored.ok && scored.limit) return limitOutcome([scored.limit.resetsAt]);
  if (!scored.ok)
    return stopped(
      scored.reason,
      numbered.map((c) => `${c.rule} — not scored: ${c.message}`),
    );
  const score = new Map(scored.value.scores.map((s) => [s.id, s.confidence]));
  const findings: AssembledFinding[] = [];
  for (const c of numbered) {
    const s = score.get(c.id)!;
    if (s < threshold)
      uncertain.push(
        `${c.rule} — scored ${s}, below the threshold of ${threshold}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}: ${c.message}`,
      );
    else
      findings.push({
        rule: c.rule,
        confidence: s,
        file: c.file,
        line: c.line,
        evidence: c.evidence,
        message: c.message,
      });
  }
  ctx.notes(
    issue,
    `scorer returned candidates=${numbered.length} below-threshold=${numbered.length - findings.length}`,
  );
  return write({ issue, scoredBy: scorer.model, findings, uncertain, status: "complete" });
}
