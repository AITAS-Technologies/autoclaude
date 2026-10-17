/**
 * The code review, driven by the engine (design C2).
 *
 * In the source a model led a fan-out through an agent tool. Here the engine does the lead's
 * work and the model does only the readings: it computes the diff and the file list, runs the
 * red step, adds the mechanical path findings, runs each angle as its own read-only stage
 * process (in parallel up to `stages.codeReview.parallel`, each retried once), drops what has
 * no quote, hands the rest to one scorer, re-checks the measurements the scorer doubted, and
 * assembles the `AUTODEV-CODE-REVIEW` block itself. How the review ran — which angles
 * returned, who scored — is therefore a recorded fact and not a claim.
 *
 * Mapping of the source skill's steps:
 *   Step 0 target/inputs ........ fetch + `git diff --name-only <remote>/<integration>...<head>`
 *   Step 1 fan-out .............. `runAngle` over `cfg.codeReview.angles`, `pool`, one retry
 *   Step 2 red step ............. `runRedStep`, verdict -> `redStepCandidate` / uncertain line
 *   Step 5 forbidden paths ...... `pathCandidates`
 *   Step 6 quote-or-drop ........ `quoted` (the `measurement` rules are exempt)
 *   Step 6a reconcile ........... `reconcile`: criterion -> criteria-recheck process,
 *                                 red-step measurement -> kept at 9 with the scorer's number
 *   Step 6 scorer ............... one `code-review/scorer` process, ids mapped back
 *   Step 7 output ............... `assembleCodeReview`
 *   Step 8 posting .............. `postReview` for a pull request target
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesAny } from "../../config/globs.js";
import type { CodeReviewAngle } from "../../config/types.js";
import { postReview } from "../../engine/review/post-review.js";
import { classifyOptions, reportPath, type RedStepVerdict } from "../../engine/review/reports.js";
import { runRedStep, type RedStepResult } from "../../engine/review/red-step.js";
import { normaliseEvidence } from "../../engine/review/rules.js";
import type { LedgerEntry } from "../../engine/ledger/ledger.js";
import type { Dispatch } from "../../prompts/dispatch.js";
import { prefetchIssue, prefetchPriorPrs } from "../prefetch.js";
import type { OrchestratorCtx } from "../stage.js";
import { assembleCodeReview, type AssembledFinding, type CodeReviewParts } from "./assemble.js";
import {
  checkScores,
  findingsMarkdown,
  pool,
  projectFacts,
  runWithRetry,
  type ProcessSpec,
} from "./process.js";
import {
  CandidatesSchema,
  RecheckSchema,
  ScoresSchema,
  type Candidate,
  type Candidates,
  type Recheck,
  type Scores,
} from "./schemas.js";

export type ReviewTarget = { kind: "worktree" } | { kind: "pr"; pr: number; headSha: string };

/** Seams for tests; production passes nothing. */
export interface CodeReviewDeps {
  redStep?: (
    cfg: OrchestratorCtx["cfg"],
    worktree: string,
    base: string,
    exec: OrchestratorCtx["exec"],
  ) => Promise<RedStepResult>;
}

type Origin = "angle" | "path" | "red" | "criterion";
interface Cand extends Candidate {
  origin: Origin;
  /** The criterion number a `criterion` candidate is about. */
  criterion?: number;
}

const CRITERION_RULE = "spec/criterion-not-met";

const asFinding = (c: Candidate, over: Partial<Candidate> = {}): AssembledFinding => ({
  rule: c.rule,
  confidence: c.confidence,
  file: c.file,
  line: c.line,
  evidence: c.evidence,
  message: c.message,
  ...over,
});

const where = (c: Candidate): string =>
  c.file ? ` (${c.file}${c.line && c.line > 0 ? `:${c.line}` : ""})` : "";

export async function runCodeReview(
  ctx: OrchestratorCtx,
  entry: LedgerEntry,
  target: ReviewTarget,
  deps: CodeReviewDeps = {},
): Promise<{ reportFile: string }> {
  const { cfg, root } = ctx;
  const issue = entry.issue;
  const worktree = entry.worktree;
  if (!worktree) throw new Error(`code review: the ledger entry for #${issue} has no worktree`);
  const reportFile = join(worktree, reportPath("code-review"));
  const integrationRef = `${cfg.forge.remote}/${cfg.branches.integration}`;
  const head = target.kind === "pr" ? target.headSha : "HEAD";

  const write = (parts: CodeReviewParts): { reportFile: string } => {
    const text = assembleCodeReview(parts);
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, text);
    ctx.notes(issue, `code review report written (${parts.status})`);
    if (target.kind === "pr") {
      const posted = postReview(target.pr, text, target.headSha, ctx.exec, {
        cfg,
        root,
        repo: ctx.forge.repo,
        classify: classifyOptions("code-review", { cfg, projectRoot: root }),
      });
      if (posted.code !== 0) throw new Error(`code review: post-review failed: ${posted.message}`);
      ctx.notes(issue, posted.message);
    }
    return { reportFile };
  };
  const stoppedEarly = (why: string): { reportFile: string } => {
    ctx.notes(issue, `code review stopped: ${why}`);
    return write({
      issue,
      redStep: null,
      reason: "",
      fanOut: [],
      scoredBy: "",
      criteria: [],
      findings: [],
      uncertain: [`review — not run: ${why}`],
      status: "stopped",
    });
  };

  // Step 0: the engine fetches; a stage never does.
  const fetched = ctx.exec("git", ["fetch", cfg.forge.remote, cfg.branches.integration], {
    cwd: worktree,
  });
  if (fetched.status !== 0)
    return stoppedEarly(`git fetch ${integrationRef} failed: ${fetched.stderr.trim()}`);
  if (target.kind === "pr") {
    const at = ctx.exec("git", ["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
    if (!at || !(at.startsWith(target.headSha) || target.headSha.startsWith(at)))
      return stoppedEarly(
        `the worktree is at ${at || "an unknown commit"}, not at the pull request's head ${target.headSha}`,
      );
  }
  const diff = ctx.exec(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", `${integrationRef}...${head}`],
    { cwd: worktree },
  );
  if (diff.status !== 0)
    return stoppedEarly(`git diff ${integrationRef}...${head} failed: ${diff.stderr.trim()}`);
  const files = diff.stdout
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f !== "");

  const classify = classifyOptions("code-review", { cfg, projectRoot: root });
  const threshold = classify.threshold ?? 7;
  const evidenceKind = new Map(classify.catalogue.map((r) => [r.id, r.evidence]));
  const keepAt = Math.min(10, Math.max(9, threshold + 1));

  // Step 2: the red step. A step that throws is a step that could not run.
  let red: RedStepResult;
  try {
    red = await (deps.redStep ?? runRedStep)(cfg, worktree, integrationRef, ctx.exec);
  } catch (error) {
    const reason = `the red step failed: ${String(error).replace(/\s+/g, " ")}`;
    red = { verdict: { kind: "could-not-run", reason }, reason };
  }
  const verdict: RedStepVerdict = red.verdict.kind;
  const redReason = verdict === "could-not-run" ? red.reason : "";
  ctx.notes(issue, verdict === "proven" ? "red-step proven" : `red-step ${verdict}: ${red.reason}`);

  const uncertain: string[] = [];
  const mechanical: Cand[] = [];
  // Step 5: forbidden and policy-adjacent paths, mechanical evidence.
  for (const f of files) {
    if (matchesAny(f, cfg.forbiddenPaths))
      mechanical.push({
        origin: "path",
        rule: "paths/forbidden",
        confidence: 10,
        file: f,
        line: null,
        evidence: f,
        message: "The change touches a path the project forbids (forbiddenPaths).",
      });
    if (matchesAny(f, cfg.policyAdjacentPaths))
      mechanical.push({
        origin: "path",
        rule: "paths/policy-adjacent",
        confidence: 10,
        file: f,
        line: null,
        evidence: f,
        message: `The change touches a policy-adjacent path.${cfg.policyAdjacentReason ? ` ${cfg.policyAdjacentReason}` : ""}`,
      });
  }
  if (verdict === "not-proven") {
    const tests = red.files && red.files.length > 0 ? red.files.join(", ") : "the changed tests";
    mechanical.push({
      origin: "red",
      rule: "tests/passes-without-change",
      confidence: 9,
      file: "",
      line: null,
      evidence: tests,
      message: `The red step did not prove the tests: ${red.reason}.`,
    });
  } else if (verdict === "no-test-files") {
    const changed = red.skipped && red.skipped.length > 0 ? red.skipped : files;
    mechanical.push({
      origin: "angle",
      rule: "tests/handler-untested",
      confidence: 9,
      file: "",
      line: null,
      evidence: changed.join(", "),
      message: `The change adds or changes no test file (${red.reason}). Applies if it adds or rewrites a handler or exported function.`,
    });
  } else if (verdict === "could-not-run") {
    uncertain.push(`red-step — the red step could not run: ${red.reason}`);
  }

  // Step 1: the fan-out.
  const angles = cfg.codeReview.angles;
  const issueView = prefetchIssue(ctx.forge, issue);
  const base: Dispatch = {
    issue: issueView,
    mode: "fresh",
    worktree,
    integrationRef,
    reportFile,
    planFile: join(worktree, ".autoclaude", "state", "plans", `${issue}.md`),
    projectFacts: projectFacts(root),
  };
  let prior: Dispatch["priorPullRequests"];
  if (angles.includes("prior-prs")) {
    try {
      prior = prefetchPriorPrs(ctx.forge, files);
    } catch (error) {
      ctx.notes(issue, `prior pull requests could not be read: ${String(error)}`);
      prior = [];
    }
  }
  const procBase = (): Pick<ProcessSpec, "issue" | "worktree"> => ({ issue, worktree });
  const vars = { issue: String(issue), worktree, integrationRef };

  type AngleResult =
    | { angle: CodeReviewAngle; kind: "ok"; value: Candidates }
    | { angle: CodeReviewAngle; kind: "failed"; reason: string }
    | { angle: CodeReviewAngle; kind: "skipped" };
  let abort = false;
  const results = await pool<CodeReviewAngle, AngleResult>(
    angles,
    cfg.stages.codeReview.parallel,
    async (angle) => {
      if (abort) return { angle, kind: "skipped" };
      const out = await runWithRetry<Candidates>(ctx, {
        ...procBase(),
        role: `code-review-angle-${angle}`,
        promptName: `code-review/angles/${angle}`,
        promptVars: { ...vars, angle },
        dispatch: angle === "prior-prs" ? { ...base, priorPullRequests: prior ?? [] } : base,
        spec: cfg.stages.codeReview.angles[angle] ?? cfg.stages.codeReview.angles.default,
        schema: CandidatesSchema,
      });
      if (out.ok) return { angle, kind: "ok", value: out.value };
      abort = true;
      return { angle, kind: "failed", reason: out.reason };
    },
  );
  const returned = results.filter((r) => r.kind === "ok");
  const fanOut = returned.map((r) => r.angle);
  const failures = results.flatMap((r) => (r.kind === "failed" ? [r.reason] : []));

  // Criteria, from the criteria angle only.
  const criteriaResult = returned.find((r) => r.angle === "criteria");
  const criteriaList = [...(criteriaResult?.value.criteria ?? [])].sort((a, b) => a.n - b.n);
  const criteriaCands: Candidate[] = [];
  const candidates: Cand[] = [...mechanical];
  for (const r of returned) {
    uncertain.push(...r.value.uncertain);
    for (const c of r.value.candidates) {
      if (
        r.angle === "criteria" &&
        c.rule === CRITERION_RULE &&
        criteriaCands.length < criteriaList.filter((k) => !k.met).length
      )
        criteriaCands.push(c);
      else candidates.push({ ...c, origin: "angle" });
    }
  }
  // One finding per unmet criterion: the angle's own, or one the engine files from the list.
  criteriaList
    .filter((c) => !c.met)
    .forEach((c, i) => {
      const own = criteriaCands[i];
      candidates.push({
        origin: "criterion",
        criterion: c.n,
        ...(own ?? {
          rule: CRITERION_RULE,
          confidence: 9,
          file: "",
          line: null,
          evidence: `criterion ${c.n}`,
          message: `No evidence in the diff for criterion ${c.n}: ${c.where}`,
        }),
      });
    });

  // Step 6: quote or drop; a measurement rule has no line to quote.
  const quoted = (c: Cand): boolean =>
    evidenceKind.get(c.rule) === "measurement" || normaliseEvidence(c.evidence) !== "";
  const kept = candidates.filter(quoted);
  const dropped = candidates.length - kept.length;
  if (dropped > 0) ctx.notes(issue, `quote filter dropped ${dropped} candidate(s) without a quote`);

  const notScored = (why: string): string[] =>
    kept.map((c) => `${c.rule} — not scored (${why})${where(c)}: ${c.message}`);
  const finishStopped = (why: string, scored = false): { reportFile: string } =>
    write({
      issue,
      redStep: verdict,
      reason: redReason,
      fanOut,
      scoredBy: scored ? cfg.stages.codeReview.scorer.model : "",
      criteria: criteriaList.map(({ met, where: w }) => ({ met, where: w })),
      findings: [],
      uncertain: [...uncertain, ...(scored ? [] : notScored(why))],
      status: "stopped",
    });
  if (failures.length > 0) return finishStopped(failures.join("; "));

  // The scorer.
  const numbered = kept.map((c, i) => ({ ...c, id: i + 1 }));
  const scoreOf = new Map<number, number>();
  let scoredBy = "none (no candidates to score)";
  if (numbered.length > 0) {
    scoredBy = cfg.stages.codeReview.scorer.model;
    const scored = await runWithRetry<Scores>(
      ctx,
      {
        ...procBase(),
        role: "code-review-scorer",
        promptName: "code-review/scorer",
        promptVars: vars,
        dispatch: { ...base, findingsMarkdown: findingsMarkdown(numbered) },
        spec: cfg.stages.codeReview.scorer,
        schema: ScoresSchema,
      },
      checkScores(numbered.map((c) => c.id)),
    );
    if (!scored.ok) return finishStopped(scored.reason);
    for (const s of scored.value.scores) scoreOf.set(s.id, s.confidence);
    const below = numbered.filter((c) => scoreOf.get(c.id)! < threshold).length;
    ctx.notes(issue, `scorer returned candidates=${numbered.length} below-threshold=${below}`);
  }

  // Step 6a: reconcile the measurements the scorer put at or below the threshold.
  const criteria = criteriaList.map(({ met, where: w }) => ({ met, where: w }));
  const recheckFailures: string[] = [];
  type Settled = { finding?: AssembledFinding; uncertain?: string };
  const reconcile = async (c: (typeof numbered)[number]): Promise<Settled> => {
    const score = scoreOf.get(c.id)!;
    const stands = (note = ""): Settled => ({
      finding: asFinding(c, {
        confidence: keepAt,
        message: `${c.message} (scorer: ${score}; kept at ${keepAt}: the measurement stands${note})`,
      }),
    });
    if (score > threshold) return { finding: asFinding(c, { confidence: score }) };
    if (c.origin === "red") return stands();
    if (c.origin === "criterion") {
      const n = c.criterion!;
      const out = await runWithRetry<Recheck>(ctx, {
        ...procBase(),
        role: `code-review-recheck-${n}`,
        promptName: "code-review/criteria-recheck",
        promptVars: vars,
        dispatch: {
          ...base,
          findingsMarkdown: `### Criterion ${n}
- criterion: ${n}
- text: ${JSON.stringify(c.evidence)}`,
        },
        spec: cfg.stages.codeReview.scorer,
        schema: RecheckSchema,
      });
      if (!out.ok) {
        recheckFailures.push(out.reason);
        return stands("; the re-check did not finish");
      }
      if (!out.value.met) return stands("; the re-check found no evidence either");
      const slot = criteria[criteriaList.findIndex((k) => k.n === n)];
      if (slot) {
        slot.met = true;
        slot.where = out.value.where;
      }
      ctx.notes(issue, `criterion ${n} re-checked: met (${out.value.where})`);
      return {};
    }
    if (score < threshold)
      return {
        uncertain: `${c.rule} — scored ${score}, below the threshold of ${threshold}${where(c)}: ${c.message}`,
      };
    return { finding: asFinding(c, { confidence: score }) };
  };
  // Re-checks are processes: they share the cap with everything else. The rest is bookkeeping.
  const settled = await pool(numbered, cfg.stages.codeReview.parallel, reconcile);
  const findings = settled.flatMap((x) => (x.finding ? [x.finding] : []));
  uncertain.push(...settled.flatMap((x) => (x.uncertain ? [x.uncertain] : [])));

  let criteriaOut: CodeReviewParts["criteria"] = criteria;
  if (criteria.length === 0) {
    criteriaOut = "none";
    uncertain.push(
      criteriaResult
        ? "criteria — the issue lists no acceptance criterion the criteria reading could check"
        : "criteria — the criteria reading did not run, so no acceptance criterion was checked",
    );
  }
  return write({
    issue,
    redStep: verdict,
    reason: redReason,
    fanOut,
    scoredBy,
    criteria: criteriaOut,
    findings,
    uncertain,
    status: recheckFailures.length > 0 ? "stopped" : "complete",
  });
}
