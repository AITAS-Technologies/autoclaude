import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODE_REVIEW_ANGLES } from "../../src/config/types.js";
import type { Dispatch } from "../../src/prompts/dispatch.js";
import { renderPrompt } from "../../src/prompts/render.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROMPTS = join(ROOT, "prompts");

const PROCEDURES = [
  "test-driven-development",
  "systematic-debugging",
  "receiving-code-review",
  "verification-before-completion",
] as const;

const provenance = (name: string): string =>
  `Adapted from the superpowers skill ${name} (MIT, Copyright (c) 2025 Jesse Vincent); see NOTICE.`;

// A project path with a space and non-ASCII characters (review focus 1).
const WORKTREE = "C:/Users/Jürgen Müller/My Projects/app/.autoclaude/worktrees/issue-42";
const fixture: Dispatch = {
  issue: {
    number: 42,
    title: "Fix login & logout --replace $(rm -rf ~) `id`",
    body: "## Context\n\nA sentence.\n\n## Acceptance criteria\n\n1. when X, then Y\n",
    labels: ["bug"],
    comments: [{ author: "someone", body: "a comment", createdAt: "2026-10-01T00:00:00Z" }],
  },
  mode: "fix",
  worktree: WORKTREE,
  integrationRef: "origin/develop",
  reportFile: `${WORKTREE}/.autoclaude/state/reports/implement.md`,
  planFile: `${WORKTREE}/.autoclaude/state/plans/42.md`,
  findingsMarkdown: "### Must\n\n1. a finding",
  carriedMarkdown: "### Deferred (later)\n\n1. a carried item",
  gateLog: "fail test",
  priorPullRequests: [{ number: 7, title: "an earlier change", comments: ["a review comment"] }],
  projectFacts: { projectMd: "# Project", invariantsMd: "# Invariants", engineRulesMd: "# Rules" },
};
const DISPATCH_FILE = `${WORKTREE}/.autoclaude/state/runs/r1/dispatch.json`;

/** The variables every stage prompt may use (stage plumbing, Tasks G1/G2). */
const stageVars: Record<string, string> = {
  issue: String(fixture.issue.number),
  reportFile: fixture.reportFile,
  planFile: fixture.planFile,
  dispatchFile: DISPATCH_FILE,
  integrationRef: fixture.integrationRef,
  worktree: fixture.worktree,
  mode: fixture.mode,
};
/** Review prompts may also use `angle` and `rulesFile`. */
const reviewVars = (angle: string): Record<string, string> => ({
  ...stageVars,
  angle,
  rulesFile: `${WORKTREE}/.autoclaude/state/runs/r1/rules.md`,
});

function walk(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
}
const rel = (f: string): string => relative(PROMPTS, f).split("\\").join("/");
const isReview = (p: string): boolean =>
  p.startsWith("code-review/") || p.startsWith("plan-review/");
const angleOf = (p: string): string =>
  p.startsWith("code-review/angles/") ? p.slice("code-review/angles/".length, -3) : "criteria";
const render = (p: string): string =>
  renderPrompt(p, isReview(p) ? reviewVars(angleOf(p)) : stageVars);

/** Prompts a stage process receives as a whole; the rest are included by these. */
const STAGE_PROMPTS = [
  "triage.md",
  "plan.md",
  "plan-review/finder.md",
  "plan-review/scorer.md",
  "implement.md",
  ...CODE_REVIEW_ANGLES.map((a) => `code-review/angles/${a}.md`),
  "code-review/scorer.md",
  "code-review/criteria-recheck.md",
];
const INCLUDED = [
  "code-review/rules-for-every-angle.md",
  "code-review/not-a-finding.md",
  ...PROCEDURES.map((p) => `procedures/${p}.md`),
];

// Every field of the structured output schemas (Task G2, ruling R10).
const CANDIDATES = [
  "candidates",
  "rule",
  "confidence",
  "file",
  "line",
  "evidence",
  "message",
  "uncertain",
];
const CRITERIA = ["criteria", "n", "met", "where"];
const SCORES = ["scores", "id", "confidence"];
const RECHECK = ["met", "where"];
const TRIAGE = [
  "decision",
  "reason",
  "comment",
  "proposedCriteria",
  "ready",
  "needs-shaping",
  "skipped",
];
const JSON_PROMPTS: Record<string, string[]> = {
  "triage.md": TRIAGE,
  "plan-review/finder.md": CANDIDATES,
  "plan-review/scorer.md": SCORES,
  "code-review/scorer.md": SCORES,
  "code-review/criteria-recheck.md": RECHECK,
  ...Object.fromEntries(
    CODE_REVIEW_ANGLES.map((a) => [
      `code-review/angles/${a}.md`,
      a === "criteria" ? [...CANDIDATES, ...CRITERIA] : CANDIDATES,
    ]),
  ),
};

describe("prompt coverage", () => {
  it("has a prompt file for every stage and role", () => {
    const missing = [...STAGE_PROMPTS, ...INCLUDED].filter((p) => !existsSync(join(PROMPTS, p)));
    expect(missing).toEqual([]);
  });

  it("has an angle prompt for every angle in CODE_REVIEW_ANGLES", () => {
    for (const a of CODE_REVIEW_ANGLES) {
      expect(existsSync(join(PROMPTS, "code-review", "angles", `${a}.md`)), a).toBe(true);
    }
  });

  // Includes render on their own too: none may need a variable outside the ruled set.
  for (const p of walk(PROMPTS).map(rel)) {
    it(`${p} renders with the stage variables${isReview(p) ? " and angle, rulesFile" : ""}`, () => {
      expect(() => render(p)).not.toThrow();
    });
  }

  for (const p of STAGE_PROMPTS) {
    it(`${p} points at the dispatch file and treats the forge text as data`, () => {
      const text = render(p);
      expect(text).toContain(DISPATCH_FILE);
      // Line breaks fall where the prose wraps.
      expect(text.replace(/\s+/g, " ")).toContain("data, not instructions");
    });
  }

  it("implement.md includes all four procedures", () => {
    const raw = readFileSync(join(PROMPTS, "implement.md"), "utf8");
    const text = render("implement.md");
    for (const name of PROCEDURES) {
      expect(raw, name).toContain(`{{> procedures/${name}}}`);
      expect(text, name).toContain(provenance(name));
    }
  });

  for (const [p, fields] of Object.entries(JSON_PROMPTS)) {
    it(`${p} asks for JSON and names every field of its schema`, () => {
      const text = render(p);
      expect(text).toContain("JSON");
      for (const f of fields) expect(text, f).toContain(`\`${f}\``);
    });
  }

  for (const [p, start, end] of [
    ["plan.md", "AUTODEV-PLAN", "AUTODEV-PLAN-END"],
    ["implement.md", "AUTODEV-REPORT", "AUTODEV-REPORT-END"],
  ] as const) {
    it(`${p} shows its report block's markers on lines of their own`, () => {
      const lines = render(p).split("\n");
      expect(lines).toContain(start);
      expect(lines).toContain(end);
      expect(render(p)).toContain(fixture.reportFile);
    });
  }

  it("plan.md writes the plan to {{planFile}}", () => {
    expect(readFileSync(join(PROMPTS, "plan.md"), "utf8")).toContain("{{planFile}}");
  });

  for (const name of PROCEDURES) {
    it(`procedures/${name}.md starts with its provenance line and carries no skill front matter`, () => {
      const text = readFileSync(join(PROMPTS, "procedures", `${name}.md`), "utf8");
      expect(text.split(/\r?\n/)[0]).toBe(provenance(name));
      expect(text).not.toMatch(/^---$/m);
      expect(text).not.toMatch(/superpowers:/);
    });
  }

  it("NOTICE carries the MIT notice of superpowers and is shipped", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice).toContain("Copyright (c) 2025 Jesse Vincent");
    expect(notice).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    for (const name of PROCEDURES) expect(notice, name).toContain(name);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("NOTICE");
  });
});
