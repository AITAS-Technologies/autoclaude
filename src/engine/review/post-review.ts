/**
 * Attach a code review's report to its pull request.
 *
 * Library half; the verb that wraps it is built later (`post-review <pr> --report <path>
 * --sha <sha>`) and its exit-code contract is recorded here for it:
 *   exit 0  posted, or already posted for this commit (it says which). A report that
 *           stopped early is posted too, under a banner saying the review did not finish:
 *           what it had written still belongs on the pull request, and refusing it would
 *           leave the pull request with no record of the run at all. So is one whose
 *           decision could not be computed, or whose score threshold fell back to the
 *           default, each under a line saying so — an unreadable ledger or config costs
 *           the refinement, not the comment
 *   exit 2  the report did not parse
 *   exit 1  anything else — a catalogue the loader refused (no vocabulary to classify a
 *           finding against, so every finding would read as withdrawn), an unreadable
 *           report file, or a `gh` call that failed. None is about the diff, and all are
 *           reported as a failed run. A refused *configuration* is deliberately not here:
 *           it degrades to exit 0 with its reason in the comment
 *   exit 64 the command line was wrong — not the review's fault, so it costs no retry
 *
 * The banner is reachable because a reviewer that stops early ends its block with
 * `CODE-REVIEW-STATUS: stopped`: the status line is the block's end marker, matched by
 * prefix, so any status parses and only `complete` says the review finished. The skill
 * used to have such a reviewer omit the line altogether, which made `extractBlock` throw
 * and turned every stopped review into exit 2, "the report did not parse" — the one
 * outcome that leaves a human with nothing (`/code-review` on the review-tiers branch).
 *
 * Why an engine step and not `gh pr comment` typed by the reviewer: the same reason publish.ts
 * exists. The code review produces findings and writes no GitHub state — "findings
 * only, never approval" is the property that makes a second reader worth having — and a
 * deterministic step is the only version of "do not post the same review twice" that can
 * be tested.
 *
 * Idempotent by commit, not by pull request. The marker carries the sha the review read,
 * so a rerun against the same commit posts nothing and the next push gets a comment of
 * its own. Editing one comment in place would lose the record of what each commit looked
 * like when it was reviewed, and `gh pr comment --edit-last` would clobber whatever the
 * orchestrator posted in between.
 */

import { loadProjectConfig } from "../../config/load.js";
import type { ProjectConfig } from "../../config/types.js";
import { flag, prArg } from "../../cli/args.js";
import { gh, ghText, realExec, resolveRepo, type Exec } from "../../forge/github.js";
import { entryForPr, foldNote, loadLedger } from "../ledger/ledger.js";
import { DEFAULT_MESSAGES, presentText } from "../publish.js";
import { repoRoot } from "../root.js";
import { decide, previousReport, type Decision } from "./decision.js";
import {
  classifyOptions,
  findingHead,
  isReportComplete,
  parseCodeReviewReport,
  parseStoppedCodeReview,
  reviewAccountAsMarkdown,
  tierSections,
  TIER_HEADINGS,
  uncertainSection,
  type ClassifyOptions,
  type CodeReviewReport,
  type ReviewFinding,
  type StoppedCodeReview,
} from "./reports.js";
import { DEFAULT_THRESHOLD, catalogueFor } from "./rules.js";

export const REVIEW_COMMENT_MARKER = "<!-- autodev-review";

const finding = (f: ReviewFinding) =>
  // `findingHead`, the one place rule, position and confidence are formatted: a finding
  // with no file — `spec/criterion-not-met` above all — must not read "at `:0`", and the
  // pull request body says it the same way.
  `${findingHead(f)}\n   ${f.message}` +
  (f.evidence.trim() ? `\n   Evidence: \`${f.evidence.trim().slice(0, 200)}\`` : "");

/**
 * How the comment is dressed, all of it the project's (design section 8.2): the footer
 * (`messages.footer`), whether a mention is defused (`messages.defuseMentions`) and
 * whose mention survives it (`humans`).
 */
export type CommentStyle = ProjectConfig["messages"] & { humans: string[] };

/**
 * The comment a human reads on the pull request.
 *
 * The three tiers are separated because they cost different things: a must blocks the
 * merge, a should costs a fix round without blocking it, a later is recorded and
 * deliberately not fixed now. Running them together would make the reader sort them.
 *
 * @param decision what `decide` made of this very report, when the ledger knew which
 *   worktree it was written against: the findings that stood, and the claims the evidence
 *   check withdrew. Absent renders the report exactly as it stands, which is the honest
 *   answer when nothing checked anything.
 * @param notes what could not be read, each already folded to one line. `decision` is why
 *   there is no decision and `config` why the threshold is the default rather than this
 *   project's. An *absence* of a decision is left unexplained on purpose — the findings
 *   standing as written is the whole of it — but a failure has to be said, because a
 *   comment that stopped checking its own quotes looks exactly like one that checked them
 *   and found nothing wrong. The wording lives here, with the rest of the comment's prose.
 * @param style the footer and the mention policy; the engine's defaults when absent
 */
export function renderReviewComment(
  review: StoppedCodeReview,
  sha: string,
  decision: Decision | null = null,
  notes: { decision?: string | null; config?: string | null } = {},
  style: CommentStyle = { ...DEFAULT_MESSAGES, humans: [] },
): string {
  const out = [`${REVIEW_COMMENT_MARKER} sha=${sha} -->`, "", "## Agent code review", ""];

  // A report that stopped before its status line is not a report that found nothing.
  if (!review.complete) {
    out.push(
      "**The review did not finish.** What it had written is below; the claim that",
      "this is everything is withdrawn.",
      "",
    );
  }
  // What the review did, before what it found. Without it a review that skipped the red
  // step and the criteria read "No findings against <sha>", exactly like a thorough one.
  out.push(...reviewAccountAsMarkdown(review));
  // And whatever could not be read, before the findings it qualifies. Both are about how
  // much of the list below has actually been checked, which nothing else in the comment
  // would give away.
  if (notes.config) {
    out.push(
      `**The project configuration could not be read** (${notes.config}). Findings are classified against the default score threshold of ${DEFAULT_THRESHOLD}, not this project's.`,
      "",
    );
  }
  if (notes.decision) {
    out.push(
      `**The decision could not be computed** (${notes.decision}). The findings below are as the review wrote them: no quote was checked and nothing was withdrawn.`,
      "",
    );
  }
  // What stood, which is the decision's `kept` when there was a decision to make. This
  // comment rendered every finding as the report stated it while the pull request body
  // renders the decision, so the two could disagree about the same sha — one listing a
  // must the evidence check had withdrawn and the other not.
  const findings = decision?.kept ?? review.findings;
  if (findings.length === 0) {
    out.push(`No findings against \`${sha}\`.`, "");
  }
  out.push(
    ...tierSections(findings, finding, {
      headings: TIER_HEADINGS,
      intro: {
        must: "These block the merge; each one costs a fix round.",
        should: "These cost a fix round without blocking the merge.",
        later: "Noted by the review, deliberately not fixed now:",
      },
    }),
  );
  // The report's own uncertain lines, and what the evidence check withdrew when it ran —
  // the same two lists the pull request body carries, and the second only the decision
  // knows. Without a decision it is the report's lines alone, which is what a caller with
  // no ledger entry to resolve gets: withdrawing findings against whatever directory the
  // process happens to stand in would be worse than not listing them.
  out.push(
    ...uncertainSection([
      ...review.uncertain,
      ...(decision?.demoted ?? []).map((f) => f.demotion ?? `${f.rule} — the claim was withdrawn`),
    ]),
  );
  out.push(style.footer);
  // Every finding's message, quote and uncertain line above is the reviewer's own text,
  // and a workflow that triggers on the mention it may contain would start a run from
  // inside a review comment.
  return presentText(out.join("\n"), style, style.humans);
}

/**
 * Whether this commit's review is already on the pull request.
 *
 * The marker has to open the comment. A marker quoted inside somebody's prose is a
 * mention, not a posted review, and reading it as one would silence the next review
 * on a pull request where a human had merely talked about it.
 */
export function alreadyPostedFor(comments: Array<{ body: string }>, sha: string): boolean {
  return comments.some((c) => c.body.trimStart().startsWith(`${REVIEW_COMMENT_MARKER} sha=${sha} -->`)); // prettier-ignore
}

export function prComments(
  n: number,
  repo: string,
  exec: Exec = realExec,
): Array<{ body: string }> {
  const r = gh<{ comments?: Array<{ body: string }> }>(
    ["-R", repo, "pr", "view", String(n), "--json", "comments"],
    exec,
  );
  return r.comments ?? [];
}

/** What `postReview` reads unless the caller already holds it. */
export interface PostOptions {
  /**
   * The catalogue and the threshold the findings are read against; by default the engine's
   * rules plus the project's own `.autoclaude/invariants.md` under `root`, and the
   * threshold of the project's config.
   */
  classify?: ClassifyOptions;
  /**
   * The main working directory, whose ledger says which worktree this pull request's
   * review was written against. `repoRoot(process.cwd())` by default, as the merge verdict
   * and `reviewDecision` resolve it, and deliberately not `process.cwd()`: the reviewer
   * runs in a worktree of its own.
   */
  root?: string;
  /** The project's config: the caps and labels `decide` reads, the messages, the humans. */
  cfg?: ProjectConfig;
  /**
   * `owner/name`, carried by every `gh` call as `-R`. Absent resolves it from the URL of
   * `cfg.forge.remote`, which needs a readable config: without a repository there is
   * nowhere to post, so that failure is not degraded.
   */
  repo?: string;
}

/**
 * What `decide` makes of this report, or null when there is nothing to decide with.
 *
 * `entryForPr` is how `can-merge.ts` finds the entry that owns a pull request, and this
 * is the same lookup: with a worktree on disk the quotes can be checked, which is what
 * the pull request body already does with the same report. No entry, no worktree, or a
 * report that stopped early and therefore has no verdict to act on — each degrades to the
 * raw rendering, and the comment then says only what the review wrote.
 *
 * A failure to read the ledger or the config degrades the same way, and that is the
 * difference `problem` records. Deciding brought `loadLedger` and `loadConfig` into this
 * file, so a corrupt `ledger.json` or a config the loader refuses turned a `--pr` post
 * into exit 1 — on the one path whose whole job is to leave a human with the review. The
 * decision is a refinement of the comment, not a precondition for it. An absence needs no
 * explanation beyond the findings standing as written; a failure is told to the reader,
 * because a comment that silently stopped checking its own quotes looks exactly like one
 * that checked them and found nothing wrong.
 *
 * The quotes are checked against the worktree **as it stands**, not against the `--sha`
 * the comment is keyed on: nothing here compares the two. A worktree that has moved on
 * since the review can therefore withdraw a finding that was true at the reviewed commit,
 * and the comment lists it under Uncertain as a quoted line that was not found. The
 * ±5-line window absorbs the small drift a reformat causes; larger drift is meant to show
 * up that way rather than to be guessed at, which is the resolution the design's Later
 * bullet asked for.
 */
function decisionFor(
  pr: number,
  review: CodeReviewReport,
  root: string,
  config: LoadedConfig,
  classify: ClassifyOptions,
): { decision: Decision | null; problem: string | null } {
  try {
    const entry = entryForPr(loadLedger(root), pr);
    const worktree = entry?.worktree.trim() ?? "";
    if (!entry || worktree === "") return { decision: null, problem: null };
    // Read only now, after the absences above: no entry and no worktree need no config,
    // and say nothing about it.
    if (config.cfg === null) throw new Error(config.problem ?? "the configuration cannot be read");
    return {
      decision: decide(review, entry.attempts, config.cfg, {
        stage: "code-review",
        worktree,
        previous: previousReport(root, entry.issue, "code-review", classify),
      }),
      problem: null,
    };
  } catch (error) {
    // `foldNote` because this reaches a pull request comment as one line: a JSON parse
    // error arrives with a position and a config refusal with a list of keys, and neither
    // may become the body of the comment.
    return { decision: null, problem: foldNote(String(error)) };
  }
}

/** The project's config, or the reason it could not be read: the comment degrades, it does not fail. */
interface LoadedConfig {
  cfg: ProjectConfig | null;
  problem: string | null;
}

function loadConfigOnce(opts: PostOptions, root: string): LoadedConfig {
  if (opts.cfg) return { cfg: opts.cfg, problem: null };
  try {
    return { cfg: loadProjectConfig(root), problem: null };
  } catch (error) {
    return { cfg: null, problem: foldNote(String(error)) };
  }
}

/**
 * The catalogue and the threshold, or the default threshold and the reason the config
 * could not supply one.
 *
 * `classifyOptions` reads the config, and that read must sit inside a try of its own:
 * `decisionFor` wraps the same read, and a config the loader refused would otherwise throw
 * out of `postReview` and leave the pull request with no comment — the one outcome this
 * path exists to prevent.
 *
 * The fallback is the threshold's own default and the catalogue, because the catalogue
 * does not come from the config: it is the engine's rules plus `.autoclaude/invariants.md`.
 * A catalogue that cannot be read is a different failure and still throws — without it
 * there is no vocabulary to classify a finding against, so every finding would be
 * withdrawn as an unknown rule and the comment would read as a clean review.
 */
function classifyFor(
  opts: PostOptions,
  root: string,
  config: LoadedConfig,
): { classify: ClassifyOptions; problem: string | null } {
  if (opts.classify) return { classify: opts.classify, problem: null };
  if (config.cfg !== null) {
    try {
      return {
        classify: classifyOptions("code-review", { cfg: config.cfg, projectRoot: root }),
        problem: null,
      };
    } catch (error) {
      return { classify: fallbackClassify(root), problem: foldNote(String(error)) };
    }
  }
  return { classify: fallbackClassify(root), problem: config.problem };
}

const fallbackClassify = (root: string): ClassifyOptions => ({
  catalogue: catalogueFor(root),
  threshold: DEFAULT_THRESHOLD,
});

const failWith = (problem: string | null): never => {
  throw new Error(problem ?? "the project configuration cannot be read");
};

export function postReview(
  pr: number,
  reportText: string,
  sha: string,
  exec: Exec = realExec,
  opts: PostOptions = {},
): { code: number; message: string } {
  const root = opts.root ?? repoRoot(process.cwd());
  const config = loadConfigOnce(opts, root);
  const { classify, problem: classifyProblem } = classifyFor(opts, root, config);
  let review: StoppedCodeReview;
  try {
    // Completeness first, then the parser that fits the answer. Every check the strict
    // parser adds is about a report that claims to be whole — a verdict without the
    // finding it needs, a criterion marked unmet with nothing accounting for it — and a
    // reviewer that stopped before Step 2 or Step 6 has written none of the fields those
    // checks read. Refusing it over an empty `fan-out:` was exit 2, "the report did not
    // parse", on exactly the report this script promises to post under a banner: the one
    // outcome that leaves a human with nothing.
    review = isReportComplete("code-review", reportText)
      ? parseCodeReviewReport(reportText, classify)
      : parseStoppedCodeReview(reportText, classify);
  } catch (e) {
    return { code: 2, message: `report did not parse: ${(e as Error).message}` };
  }
  // The repository every `gh` call names: handed in, or the URL of the configured remote.
  // Not degradable — without it there is nowhere to post — so an unreadable config ends here.
  const repo =
    opts.repo ?? resolveRepo((config.cfg ?? failWith(config.problem)).forge.remote, root, exec);
  if (alreadyPostedFor(prComments(pr, repo, exec), sha)) {
    return { code: 0, message: `already posted for ${sha}; nothing to do` };
  }
  // After the idempotence guard, because deciding reads the ledger and every quoted file:
  // a rerun against a commit already reviewed has nothing to render and should do no work
  // that could fail. Only for a report that reached its verdict, too — a stopped one has
  // no decision to act on, and `redStep: null` is not a report `decide` may be handed.
  const { decision, problem } =
    review.redStep !== null && review.complete
      ? decisionFor(pr, review as CodeReviewReport, root, config, classify)
      : { decision: null, problem: null };
  const style: CommentStyle = config.cfg
    ? { ...config.cfg.messages, humans: config.cfg.humans }
    : { ...DEFAULT_MESSAGES, humans: [] };
  ghText(
    ["-R", repo, "pr", "comment", String(pr), "--body-file", "-"],
    exec,
    renderReviewComment(
      review,
      sha,
      decision,
      { decision: problem, config: classifyProblem },
      style,
    ),
  );
  const n = (decision?.kept ?? review.findings).length;
  return { code: 0, message: `posted ${n} finding${n === 1 ? "" : "s"} for ${sha} on #${pr}` };
}

/**
 * The command line, or the message to print when it is wrong.
 *
 * A returned result rather than a throw, so the two exit codes are separated by a type
 * the reader and the compiler can both see. The previous shape declared `pr` as a `let`
 * with no initialiser and let a `catch` ending in `process.exit` establish that it had
 * been assigned — true, because `process.exit` is typed `never`, but the one place in
 * these CLIs where definite assignment rested on a library type, and a statement inserted
 * after that catch would have broken it silently. It is also the
 * parse every sibling CLI exports for its own tests.
 *
 * The token goes through the shared rule rather than `Number.parseInt`, which stops at
 * the first character it does not like: `0x10` parsed as 0 and `164x` as 164 — a review
 * posted onto a pull request whose number nobody typed. It is read in front of the report
 * and the sha, so a bad number cannot spend a file read either.
 */
export function parsePostReviewArgs(
  argv: string[],
): { pr: number; reportFile: string; sha: string } | { usage: string } {
  const usage = "Usage: post-review <pr> --report <path> --sha <sha>";
  // Both flags through the shared parser, like the token in front of them. The private
  // reader this replaces took the next token whatever it was — `--report --sha abc123`
  // recorded the report path `--sha` and read a file of that name — and it ignored a
  // repeat, so a `--sha` given twice keyed the review on the first commit while the caller
  // meant the second.
  try {
    const pr = prArg(argv[0], usage);
    const reportFile = flag(argv, "--report");
    const sha = flag(argv, "--sha");
    if (!reportFile || !sha) return { usage };
    return { pr, reportFile, sha };
  } catch (e) {
    // Every refusal here is a command line the caller has to correct, which is the same
    // answer as the usage line: exit 64, and never the review's retry budget.
    return { usage: (e as Error).message };
  }
}
