import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyOptions, parseCodeReviewReport } from "../../../src/engine/review/reports.js";
import type { RedStepResult } from "../../../src/engine/review/red-step.js";
import { runCodeReview } from "../../../src/orchestrator/review/code-review.js";
import type { Dispatch } from "../../../src/prompts/dispatch.js";
import type { StageRequest } from "../../../src/runtimes/types.js";
import { reviewRig, type ReviewRig, type RigOptions } from "../../helpers/review-rig.js";
import { asResult, scriptedRuntime, type Scripted } from "../../helpers/scripted-runtime.js";

type Answer = (req: StageRequest, attempt: number) => unknown;

const dispatchOf = (req: StageRequest): Dispatch =>
  JSON.parse(readFileSync(req.dispatchFile, "utf8")) as Dispatch;
const idsOf = (req: StageRequest): number[] =>
  [...(dispatchOf(req).findingsMarkdown ?? "").matchAll(/^- id: (\d+)$/gm)].map((m) =>
    Number(m[1]),
  );

const cand = (rule: string, over: Record<string, unknown> = {}) => ({
  rule,
  confidence: 9,
  file: "src/a.ts",
  line: 12,
  evidence: "const x = y + 1;",
  message: "A finding.",
  ...over,
});
const three = [
  { n: 1, met: true, where: "src/a.ts:1" },
  { n: 2, met: true, where: "src/a.ts:2" },
  { n: 3, met: true, where: "src/a.ts:3" },
];

function script(over: Record<string, Answer> = {}): Scripted {
  return (role, req, attempt) => {
    const o = over[role];
    if (o) return o(req, attempt);
    if (role === "code-review-angle-criteria")
      return { candidates: [], uncertain: [], criteria: three };
    if (role.startsWith("code-review-angle-")) return { candidates: [], uncertain: [] };
    if (role === "code-review-scorer")
      return { scores: idsOf(req).map((id) => ({ id, confidence: 9 })) };
    throw new Error(`test: no script for ${role}`);
  };
}

const red = (kind: "proven" | "not-proven" | "could-not-run" | "no-test-files", reason = "r") => {
  const result: RedStepResult = {
    verdict: kind === "no-test-files" ? { kind } : { kind, reason },
    reason,
    files: [],
    support: [],
    skipped: ["src/a.ts"],
  };
  return { redStep: async () => result };
};

function setup(over: Record<string, Answer> = {}, rigOpts: RigOptions = {}, delayMs?: number) {
  const r = reviewRig(rigOpts);
  const rt = scriptedRuntime(script(over), { delayMs });
  r.setRuntime(rt);
  return { r, rt };
}

async function reviewOutcome(
  r: ReviewRig,
  deps: Parameters<typeof runCodeReview>[3] = red("proven"),
  target: Parameters<typeof runCodeReview>[2] = { kind: "worktree" },
) {
  return runCodeReview(r.ctx, r.entry(), target, deps);
}

async function review(
  r: ReviewRig,
  deps: Parameters<typeof runCodeReview>[3] = red("proven"),
  target: Parameters<typeof runCodeReview>[2] = { kind: "worktree" },
) {
  const out = await reviewOutcome(r, deps, target);
  if (out.kind !== "report") throw new Error("test: expected a report, got a limit");
  const { reportFile } = out;
  const text = readFileSync(reportFile, "utf8");
  return {
    reportFile,
    text,
    parse: () =>
      parseCodeReviewReport(
        text,
        classifyOptions("code-review", { cfg: r.cfg, projectRoot: r.root }),
      ),
  };
}

describe("runCodeReview", () => {
  it("assembles a block the C2 parser reads, naming the angles that returned and the scorer", async () => {
    const { r, rt } = setup({
      "code-review-angle-bugs": () => ({ candidates: [cand("bug/boundary")], uncertain: [] }),
    });
    const out = await review(r);
    expect(out.reportFile).toBe(
      join(r.worktree, ".autoclaude", "state", "reports", "code-review.md"),
    );
    const report = out.parse();
    expect(report.complete).toBe(true);
    expect(report.redStep).toBe("proven");
    expect(report.fanOut).toBe(r.cfg.codeReview.angles.join(", "));
    expect(report.scoredBy).toBe(r.cfg.stages.codeReview.scorer.model);
    expect(report.findings.map((f) => [f.rule, f.tier])).toEqual([["bug/boundary", "must"]]);
    // every process is a read-only stage in the worktree with its schema
    expect(rt.requests.length).toBe(r.cfg.codeReview.angles.length + 1);
    for (const { req } of rt.requests) {
      expect(req.readOnly).toBe(true);
      expect(req.cwd).toBe(r.worktree);
      expect(req.schema).toBeTruthy();
      expect(req.projectRoot).toBe(r.root);
    }
  });

  it("fetches, then diffs the worktree against <remote>/<integration> before any process", async () => {
    const { r } = setup();
    await review(r);
    // R73: the worktree's git directory is checked first, then the fetch runs there.
    const all = r.calls.filter((c) => c.cmd === "git");
    expect(all.slice(0, 2).map((c) => c.args)).toEqual([
      ["rev-parse", "--git-common-dir"],
      ["rev-parse", "--git-common-dir"],
    ]);
    const git = all.slice(2);
    expect(git[0]!.args).toEqual(["fetch", "origin", "develop"]);
    expect(git[0]!.cwd).toBe(r.worktree);
    const diff = git.find((c) => c.args.includes("diff"))!;
    expect(diff.args.join(" ")).toContain("origin/develop...HEAD");
  });

  it("runs each angle on its own spec, falling back to the default", async () => {
    const { r, rt } = setup(
      { "code-review-angle-bugs": () => ({ candidates: [cand("bug/boundary")], uncertain: [] }) },
      {
        edit: (c) => {
          c.stages.codeReview.angles.security = {
            runtime: "claude",
            model: "model-special",
            effort: "max",
          };
        },
      },
    );
    await review(r);
    const byRole = new Map(rt.requests.map((x) => [x.role, x.req]));
    expect(byRole.get("code-review-angle-security")!.model).toBe("model-special");
    expect(byRole.get("code-review-angle-security")!.effort).toBe("max");
    expect(byRole.get("code-review-angle-bugs")!.model).toBe(
      r.cfg.stages.codeReview.angles.default.model,
    );
    expect(byRole.get("code-review-scorer")!.model).toBe(r.cfg.stages.codeReview.scorer.model);
  });

  it("drops an unquotable candidate, keeps a measurement one, and keeps a quoted one", async () => {
    const { r, rt } = setup({
      "code-review-angle-bugs": () => ({
        candidates: [
          cand("bug/boundary", { evidence: "   " }),
          cand("bug/race", { evidence: "lock.release();" }),
        ],
        uncertain: [],
      }),
      "code-review-angle-criteria": () => ({
        candidates: [
          cand("spec/out-of-scope", { file: "", line: null, evidence: "", message: "Unasked." }),
        ],
        uncertain: [],
        criteria: three,
      }),
    });
    const report = (await review(r)).parse();
    expect(report.findings.map((f) => f.rule).sort()).toEqual(["bug/race", "spec/out-of-scope"]);
    // the dropped one never reached the scorer
    const scorer = rt.requests.find((x) => x.role === "code-review-scorer")!;
    expect(dispatchOf(scorer.req).findingsMarkdown).not.toContain("bug/boundary");
  });

  it("numbers the candidates for the scorer and maps the ids back, whatever order it answers in", async () => {
    const { r } = setup({
      "code-review-angle-bugs": () => ({
        candidates: [
          cand("bug/boundary"),
          cand("bug/race", { line: 30 }),
          cand("bug/leak", { line: 40 }),
        ],
        uncertain: [],
      }),
      "code-review-scorer": (req) => {
        const md = dispatchOf(req).findingsMarkdown!;
        expect(md).toMatch(/- id: 1\n[\s\S]*bug\/boundary/);
        const ids = idsOf(req);
        expect(ids).toEqual([1, 2, 3]);
        // reversed order; id 2 (bug/race) is scored below the threshold
        return {
          scores: [
            { id: 3, confidence: 9 },
            { id: 2, confidence: 3 },
            { id: 1, confidence: 8 },
          ],
        };
      },
    });
    const report = (await review(r)).parse();
    expect(report.findings.map((f) => [f.rule, f.confidence])).toEqual([
      ["bug/boundary", 8],
      ["bug/leak", 9],
    ]);
    expect(report.uncertain.some((u) => u.startsWith("bug/race"))).toBe(true);
  });

  it("gives the scorer no angle reasoning, only the candidates' own fields", async () => {
    const { r, rt } = setup({
      "code-review-angle-bugs": () => ({
        candidates: [cand("bug/boundary")],
        uncertain: ["bug/race — a long argument about why"],
      }),
    });
    await review(r);
    const md = dispatchOf(
      rt.requests.find((x) => x.role === "code-review-scorer")!.req,
    ).findingsMarkdown!;
    expect(md).not.toContain("long argument");
    expect(md).toContain("src/a.ts");
    expect(md).toContain("const x = y + 1;");
  });

  it("recheck: met drops the finding and marks the criterion met", async () => {
    const { r, rt } = setup({
      "code-review-angle-criteria": () => ({
        candidates: [
          cand("spec/criterion-not-met", {
            file: "",
            line: null,
            evidence: "Second criterion text",
            message: "No evidence.",
          }),
        ],
        uncertain: [],
        criteria: [three[0], { n: 2, met: false, where: "nothing touches it" }, three[2]],
      }),
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 5 })) }),
      "code-review-recheck-2": () => ({ met: true, where: "src/b.ts:9" }),
    });
    const report = (await review(r)).parse();
    expect(report.criteria.map((c) => c.met)).toEqual([true, true, true]);
    expect(report.criteria[1]!.text).toBe("src/b.ts:9");
    expect(report.findings).toEqual([]);
    const recheck = rt.requests.find((x) => x.role === "code-review-recheck-2")!;
    expect(recheck.req.readOnly).toBe(true);
    const md = dispatchOf(recheck.req).findingsMarkdown!;
    expect(md).toContain("Second");
    expect(md).not.toMatch(/\b5\b/); // the scorer's number is deliberately not given
  });

  it("recheck: not met keeps the finding at 9 with the scorer's number on its message", async () => {
    const { r } = setup({
      "code-review-angle-criteria": () => ({
        candidates: [
          cand("spec/criterion-not-met", {
            file: "",
            line: null,
            evidence: "Second",
            message: "None.",
          }),
        ],
        uncertain: [],
        criteria: [three[0], { n: 2, met: false, where: "nothing touches it" }, three[2]],
      }),
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 7 })) }),
      "code-review-recheck-2": () => ({ met: false, where: "no file" }),
    });
    const report = (await review(r)).parse(); // the strict parser would refuse anything but a must
    const f = report.findings.find((x) => x.rule === "spec/criterion-not-met")!;
    expect(f.tier).toBe("must");
    expect(f.confidence).toBe(9);
    expect(f.message).toMatch(/scorer: 7/);
    expect(report.criteria[1]!.met).toBe(false);
  });

  it("files a finding for an unmet criterion the criteria angle marked but did not file", async () => {
    const { r } = setup({
      "code-review-angle-criteria": () => ({
        candidates: [],
        uncertain: [],
        criteria: [three[0], { n: 2, met: false, where: "nothing touches it" }, three[2]],
      }),
      "code-review-recheck-2": () => ({ met: false, where: "no file" }),
    });
    const report = (await review(r)).parse();
    expect(report.findings.filter((f) => f.rule === "spec/criterion-not-met")).toHaveLength(1);
  });

  it("turns a red step that is not proven into tests/passes-without-change, kept at 9 on a low score", async () => {
    const { r, rt } = setup({
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 4 })) }),
    });
    const report = (
      await review(r, red("not-proven", "every test passes on the base too"))
    ).parse();
    expect(report.redStep).toBe("not-proven");
    const f = report.findings.find((x) => x.rule === "tests/passes-without-change")!;
    expect(f.tier).toBe("must");
    expect(f.confidence).toBe(9);
    expect(f.message).toMatch(/scorer: 4/);
    // a red-step measurement is not re-read through the criterion prompt
    expect(rt.requests.some((x) => x.role.startsWith("code-review-recheck"))).toBe(false);
  });

  it("states could-not-run with its reason and files nothing against the implementer", async () => {
    const { r } = setup();
    const report = (
      await review(r, red("could-not-run", "the base cannot load the suite"))
    ).parse();
    expect(report.redStep).toBe("could-not-run");
    expect(report.reason).toBe("the base cannot load the suite");
    expect(report.findings).toEqual([]);
    expect(report.uncertain.join("\n")).toContain("the base cannot load the suite");
  });

  it("turns a diff with no test file into a candidate for the scorer, not a verdict of its own", async () => {
    const { r } = setup();
    const report = (await review(r, red("no-test-files", "no test files among 1 path(s)"))).parse();
    expect(report.redStep).toBe("no-test-files");
    expect(report.findings.map((f) => f.rule)).toEqual(["tests/handler-untested"]);
  });

  it("a red step that throws is could-not-run, not a failed review", async () => {
    const { r } = setup();
    const report = (
      await review(r, {
        redStep: async () => {
          throw new Error("git said no");
        },
      })
    ).parse();
    expect(report.redStep).toBe("could-not-run");
    expect(report.reason).toContain("git said no");
  });

  it("adds the mechanical path candidates from the globs and scores them with the rest", async () => {
    const { r, rt } = setup(
      {},
      {
        files: ["src/a.ts", ".github/workflows/ci.yml", "db/policy.sql"],
        edit: (c) => {
          c.policyAdjacentPaths = ["db/**"];
          c.policyAdjacentReason = "Policies need a human.";
        },
      },
    );
    const report = (await review(r)).parse();
    expect(report.findings.map((f) => [f.rule, f.file]).sort()).toEqual([
      ["paths/forbidden", ".github/workflows/ci.yml"],
      ["paths/policy-adjacent", "db/policy.sql"],
    ]);
    const md = dispatchOf(
      rt.requests.find((x) => x.role === "code-review-scorer")!.req,
    ).findingsMarkdown!;
    expect(md).toContain("paths/forbidden");
    expect(md).toContain("Policies need a human.");
    for (const f of report.findings) expect(f.tier).toBe("must");
  });

  it("retries an angle once, and a second failure makes the review stopped with no scorer run", async () => {
    const { r, rt } = setup({
      "code-review-angle-tests": () => asResult({ exit: "failed", resultText: "boom" }),
      "code-review-angle-bugs": () => ({ candidates: [cand("bug/boundary")], uncertain: [] }),
    });
    const { text } = await review(r);
    expect(rt.requests.filter((x) => x.role === "code-review-angle-tests")).toHaveLength(2);
    expect(rt.requests.some((x) => x.role === "code-review-scorer")).toBe(false);
    expect(text.trimEnd().endsWith("CODE-REVIEW-STATUS: stopped")).toBe(true);
    const fan = /^fan-out: (.*)$/m.exec(text)![1]!;
    expect(fan).not.toContain("tests");
    expect(fan).toContain("bugs");
    // what was found is not thrown away: the unscored candidate is listed as uncertain
    expect(text).toMatch(/bug\/boundary — .*not scored/);
    expect(r.notes.join("\n")).toMatch(/tests/);
  });

  it("an angle whose answer does not validate fails like one that exited badly, and the retry can recover", async () => {
    const { r, rt } = setup({
      "code-review-angle-bugs": (_req, attempt) =>
        attempt === 1
          ? { candidates: "not a list", uncertain: [] }
          : { candidates: [], uncertain: [] },
    });
    const { parse } = await review(r);
    expect(parse().complete).toBe(true);
    expect(rt.requests.filter((x) => x.role === "code-review-angle-bugs")).toHaveLength(2);
  });

  it("never runs more angle processes at once than stages.codeReview.parallel", async () => {
    const { r, rt } = setup({}, { edit: (c) => (c.stages.codeReview.parallel = 2) }, 15);
    await review(r);
    expect(rt.maxConcurrent).toBe(2);
    const single = setup({}, { edit: (c) => (c.stages.codeReview.parallel = 1) }, 5);
    await review(single.r);
    expect(single.rt.maxConcurrent).toBe(1);
  });

  it("only fans out to the angles the config names, and hands the prior-prs angle the prior pull requests", async () => {
    const { r, rt } = setup({}, { edit: (c) => (c.codeReview.angles = ["criteria", "prior-prs"]) });
    const report = (await review(r)).parse();
    expect(report.fanOut).toBe("criteria, prior-prs");
    const prior = rt.requests.find((x) => x.role === "code-review-angle-prior-prs")!;
    expect(dispatchOf(prior.req).priorPullRequests).toEqual([]);
    const crit = rt.requests.find((x) => x.role === "code-review-angle-criteria")!;
    expect(dispatchOf(crit.req).priorPullRequests).toBeUndefined();
  });

  it("renders the prompt per angle with exactly the ruled variables and the dispatch beside it", async () => {
    const { r, rt } = setup();
    await review(r);
    const bugs = rt.requests.find((x) => x.role === "code-review-angle-bugs")!;
    const prompt = readFileSync(bugs.req.promptFile, "utf8");
    expect(prompt).toContain(bugs.req.dispatchFile);
    expect(prompt).toContain("origin/develop");
    expect(prompt).toContain("`bugs`");
    expect(existsSync(bugs.req.dispatchFile)).toBe(true);
    expect(dispatchOf(bugs.req).issue.title).toContain("$(rm -rf ~)");
    expect(prompt).not.toContain("$(rm -rf ~)");
  });

  it("for a pull request, diffs at the head sha and posts the report through postReview", async () => {
    const posted: string[] = [];
    const { r } = setup({}, { pr: 7, head: "deadbeefcafe", posted });
    await review(r, red("proven"), { kind: "pr", pr: 7, headSha: "deadbeefcafe" });
    const diff = r.calls.find((c) => c.cmd === "git" && c.args.includes("diff"))!;
    expect(diff.args.join(" ")).toContain("origin/develop...deadbeefcafe");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("<!-- autodev-review sha=deadbeefcafe -->");
    expect(posted[0]).toContain("No findings against `deadbeefcafe`.");
    expect(posted[0]).toContain(r.cfg.messages.footer);
  });

  it("a worktree at another commit than the pull request's head is a stopped result for the caller, never posted", async () => {
    const posted: string[] = [];
    const { r, rt } = setup({}, { pr: 7, head: "1111111", posted });
    const { text } = await review(r, red("proven"), { kind: "pr", pr: 7, headSha: "deadbeefcafe" });
    expect(text.trimEnd().endsWith("CODE-REVIEW-STATUS: stopped")).toBe(true);
    expect(rt.requests).toHaveLength(0);
    // never under the head's marker: that would silence the real review of this commit
    expect(posted).toHaveLength(0);
  });

  it("posts nothing for a worktree target", async () => {
    const posted: string[] = [];
    const { r } = setup({}, { posted });
    await review(r);
    expect(r.calls.some((c) => c.cmd === "gh" && c.args.includes("comment"))).toBe(false);
  });

  it("a failed fetch is a stopped review that says so", async () => {
    const { r, rt } = setup();
    const exec = r.ctx.exec;
    r.ctx.exec = (cmd, args, o) =>
      cmd === "git" && args.includes("fetch")
        ? { status: 1, stdout: "", stderr: "no network" }
        : exec(cmd, args, o);
    const { text } = await review(r);
    expect(text).toContain("CODE-REVIEW-STATUS: stopped");
    expect(text).toContain("no network");
    expect(rt.requests).toHaveLength(0);
  });

  it("a usage limit pauses the review: no report, no post, no retry, no new process, earliest reset", async () => {
    const posted: string[] = [];
    const { r, rt } = setup(
      {
        "code-review-angle-bugs": () =>
          asResult({ exit: "limit", limitResetsAt: "2026-03-01T15:00:00.000Z" }),
        "code-review-angle-tests": () =>
          asResult({ exit: "limit", limitResetsAt: "2026-03-01T13:00:00.000Z" }),
      },
      {
        pr: 7,
        head: "deadbeefcafe",
        posted,
        edit: (c) => {
          c.stages.codeReview.parallel = 3;
          c.codeReview.angles = ["criteria", "bugs", "tests"];
        },
      },
      10,
    );
    const out = await reviewOutcome(r, red("proven"), {
      kind: "pr",
      pr: 7,
      headSha: "deadbeefcafe",
    });
    expect(out).toEqual({ kind: "limit", resetsAt: "2026-03-01T13:00:00.000Z" });
    expect(posted).toHaveLength(0);
    expect(existsSync(join(r.worktree, ".autoclaude", "state", "reports", "code-review.md"))).toBe(
      false,
    );
    for (const angle of ["bugs", "tests"])
      expect(rt.requests.filter((x) => x.role === `code-review-angle-${angle}`)).toHaveLength(1);
    expect(rt.requests.some((x) => x.role === "code-review-scorer")).toBe(false);
  });

  it("a usage limit in the scorer, or in a re-check, is a limit and not a stopped review", async () => {
    const a = setup({
      "code-review-angle-bugs": () => ({ candidates: [cand("bug/boundary")], uncertain: [] }),
      "code-review-scorer": () =>
        asResult({ exit: "limit", limitResetsAt: "2026-03-01T14:00:00.000Z" }),
    });
    expect(await reviewOutcome(a.r)).toEqual({
      kind: "limit",
      resetsAt: "2026-03-01T14:00:00.000Z",
    });
    expect(a.rt.requests.filter((x) => x.role === "code-review-scorer")).toHaveLength(1);

    const b = setup({
      "code-review-angle-criteria": () => ({
        candidates: [
          cand("spec/criterion-not-met", {
            file: "",
            line: null,
            evidence: "Second",
            message: "n",
          }),
        ],
        uncertain: [],
        criteria: [three[0], { n: 2, met: false, where: "none" }, three[2]],
      }),
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 4 })) }),
      "code-review-recheck-2": () =>
        asResult({ exit: "limit", limitResetsAt: "2026-03-01T16:00:00.000Z" }),
    });
    expect(await reviewOutcome(b.r)).toEqual({
      kind: "limit",
      resetsAt: "2026-03-01T16:00:00.000Z",
    });
    expect(b.rt.requests.filter((x) => x.role === "code-review-recheck-2")).toHaveLength(1);
  });

  it("pairs a criterion finding with its criterion by the text it quotes, not by position", async () => {
    const { r, rt } = setup({
      "code-review-angle-criteria": () => ({
        // the third criterion's finding only; the second criterion has none of its own
        candidates: [
          cand("spec/criterion-not-met", {
            file: "",
            line: null,
            evidence: "Third",
            message: "third unmet",
          }),
        ],
        uncertain: [],
        criteria: [
          three[0],
          { n: 2, met: false, where: "none" },
          { n: 3, met: false, where: "none" },
        ],
      }),
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 4 })) }),
      "code-review-recheck-2": () => ({ met: false, where: "no file" }),
      "code-review-recheck-3": () => ({ met: true, where: "src/c.ts:4" }),
    });
    const report = (await review(r)).parse();
    // criterion 3 was re-checked on its own text and found met; criterion 2 stands
    expect(report.criteria.map((c) => c.met)).toEqual([true, false, true]);
    const f = report.findings.filter((x) => x.rule === "spec/criterion-not-met");
    expect(f).toHaveLength(1);
    // the finding the engine filed itself quotes the criterion's text, not "criterion 2"
    expect(f[0]!.evidence).toBe("Second");
    expect(f[0]!.message).not.toContain("third unmet");
    const md = (n: number) =>
      dispatchOf(rt.requests.find((x) => x.role === `code-review-recheck-${n}`)!.req)
        .findingsMarkdown!;
    expect(md(3)).toContain("Third");
    expect(md(2)).toContain("Second");
  });

  it("a re-check that fails keeps the finding and leaves the review complete", async () => {
    const { r, rt } = setup({
      "code-review-angle-criteria": () => ({
        candidates: [
          cand("spec/criterion-not-met", {
            file: "",
            line: null,
            evidence: "Second",
            message: "n",
          }),
        ],
        uncertain: [],
        criteria: [three[0], { n: 2, met: false, where: "none" }, three[2]],
      }),
      "code-review-scorer": (req) => ({ scores: idsOf(req).map((id) => ({ id, confidence: 5 })) }),
      "code-review-recheck-2": () => asResult({ exit: "failed" }),
    });
    const report = (await review(r)).parse();
    expect(report.complete).toBe(true);
    const f = report.findings.find((x) => x.rule === "spec/criterion-not-met")!;
    expect(f.tier).toBe("must");
    expect(f.confidence).toBe(9);
    expect(rt.requests.filter((x) => x.role === "code-review-recheck-2")).toHaveLength(2);
  });

  it("a criteria reading with no criterion is invalid, retried, then the review is stopped", async () => {
    const { r, rt } = setup({
      "code-review-angle-criteria": () => ({ candidates: [], uncertain: [], criteria: [] }),
    });
    const { text } = await review(r);
    expect(text.trimEnd().endsWith("CODE-REVIEW-STATUS: stopped")).toBe(true);
    expect(text).not.toContain("criteria: none");
    expect(rt.requests.filter((x) => x.role === "code-review-angle-criteria")).toHaveLength(2);
  });

  it("an issue that cannot be read is a stopped report with the reason, not an exception, and is not posted", async () => {
    const posted: string[] = [];
    const { r, rt } = setup({}, { pr: 7, head: "deadbeefcafe", posted });
    const exec = r.ctx.exec;
    r.ctx.exec = (cmd, args, o) =>
      cmd === "gh" && args.includes("issue")
        ? { status: 1, stdout: "", stderr: "gh: rate limited" }
        : exec(cmd, args, o);
    const out = await reviewOutcome(r, red("proven"), {
      kind: "pr",
      pr: 7,
      headSha: "deadbeefcafe",
    });
    expect(out.kind).toBe("report");
    const text = readFileSync((out as { reportFile: string }).reportFile, "utf8");
    expect(text).toContain("CODE-REVIEW-STATUS: stopped");
    expect(text).toContain("rate limited");
    expect(rt.requests).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("after a usage limit no further process is started", async () => {
    const { r, rt } = setup(
      { "code-review-angle-criteria": () => asResult({ exit: "limit" }) },
      {
        edit: (c) => {
          c.stages.codeReview.parallel = 1;
          c.codeReview.angles = ["criteria", "bugs", "tests"];
        },
      },
    );
    const out = await reviewOutcome(r);
    expect(out.kind).toBe("limit");
    expect(rt.requests.map((x) => x.role)).toEqual(["code-review-angle-criteria"]);
  });
});
