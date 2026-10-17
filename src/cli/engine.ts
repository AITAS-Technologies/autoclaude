/**
 * The engine's own steps as verbs, for the human who has to run one by hand and for the
 * remedies the other verbs print: `ledger`, `claim`, `release`, `worktree remove`, `decision`,
 * `reports`, `publish`, `post-review` and `check-rebased`. Each is a thin wrapper over the
 * library function the orchestrator calls, with the exit codes the source scripts defined.
 */
import { readFileSync } from "node:fs";
import { flag, issueArg } from "./args.js";
import { claimIssue, RELEASE_TARGETS, releaseIssue, type ReleaseTarget } from "../engine/claims.js";
import { ledgerCli, machineId } from "../engine/ledger/ledger.js";
import { publish } from "../engine/publish.js";
import { checkRebased } from "../engine/rebased.js";
import {
  reviewDecision,
  REVIEW_STAGES,
  type DecisionResult,
  type ReviewStage,
} from "../engine/review/decision.js";
import { foldNote } from "../engine/ledger/ledger.js";
import { parsePostReviewArgs, postReview } from "../engine/review/post-review.js";
import {
  classifyOptions,
  isReportComplete,
  parseCodeReviewReport,
  parseImplementReport,
  parsePlanReport,
  parsePlanReviewReport,
} from "../engine/review/reports.js";
import { removeWorktree } from "../engine/worktree.js";
import { isArgumentError, messageOf, realEnv, usageError, type Env } from "./common.js";
import type { Io } from "./main.js";

// --- ledger ----------------------------------------------------------------

const LEDGER_USAGE =
  "usage: autoclaude ledger show | set <issue> <state> [options] | note <issue> <text> | limit <ISO|+MINUTES|HH:MM|clear> | archive <issue> <stage|plan-file> [--late]";

/** `autoclaude ledger …`: the ledger's own commands. Exit 1 when the command fails, 64 when it is mistyped. */
export async function ledgerVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  if (args.length === 0) return usageError(io, LEDGER_USAGE);
  try {
    const root = env.root(cwd);
    io.out(`${JSON.stringify(ledgerCli(args, root, env.now()))}\n`);
    return 0;
  } catch (e) {
    if (isArgumentError(e) || /^limit: cannot read|^limit <|not a time of day/.test(messageOf(e)))
      return usageError(io, LEDGER_USAGE, messageOf(e));
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

// --- claim, release, worktree -----------------------------------------------

const CLAIM_USAGE = "usage: autoclaude claim <issue> [--takeover]";
const RELEASE_USAGE = `usage: autoclaude release <issue> --to <${RELEASE_TARGETS.join("|")}> --reason <text>`;
const WORKTREE_USAGE = "usage: autoclaude worktree remove <issue> [--remote]";

/** `autoclaude claim <issue> [--takeover]`: exit 0 when the claim is ours, 1 when not. */
export async function claimVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  try {
    const unknown = args.slice(1).find((a) => a !== "--takeover");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    const issue = issueArg(args[0], CLAIM_USAGE);
    const root = env.root(cwd);
    const cfg = env.config(root);
    const result = claimIssue(
      issue,
      { takeover: args.includes("--takeover") },
      {
        forge: env.forge(cfg, root),
        cfg,
        machine: machineId(),
        now: env.now(),
      },
    );
    io.out(`${JSON.stringify(result)}\n`);
    return result.won ? 0 : 1;
  } catch (e) {
    if (isArgumentError(e)) return usageError(io, CLAIM_USAGE, messageOf(e));
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

/** `autoclaude release <issue> --to <target> --reason <text>`: labels and the release comment, nothing else. */
export async function releaseVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  let issue: number;
  let to: ReleaseTarget;
  let reason: string;
  try {
    const unknown = args
      .slice(1)
      .find((a) => a.startsWith("--") && a !== "--to" && a !== "--reason");
    if (unknown !== undefined) throw new Error(`unknown option ${unknown}`);
    issue = issueArg(args[0], RELEASE_USAGE);
    const t = flag(args, "--to");
    if (t === undefined || !(RELEASE_TARGETS as readonly string[]).includes(t))
      throw new Error(`--to must be one of ${RELEASE_TARGETS.join(", ")}, got "${t ?? ""}"`);
    to = t as ReleaseTarget;
    const r = flag(args, "--reason");
    if (r === undefined || r.trim() === "") throw new Error("--reason <text> is required");
    reason = r.trim();
  } catch (e) {
    return usageError(io, RELEASE_USAGE, messageOf(e));
  }
  try {
    const root = env.root(cwd);
    const cfg = env.config(root);
    io.out(
      `${JSON.stringify(
        releaseIssue(issue, to, foldNote(reason), {
          forge: env.forge(cfg, root),
          cfg,
          machine: machineId(),
          now: env.now(),
        }),
      )}\n`,
    );
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

/** `autoclaude worktree remove <issue> [--remote]`: the issue's worktree and local branches, and with `--remote` its remote branches. */
export async function worktreeVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  let issue: number;
  try {
    if (args[0] !== "remove") throw new Error("expected: remove");
    const unknown = args.slice(2).find((a) => a !== "--remote");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    issue = issueArg(args[1], WORKTREE_USAGE);
  } catch (e) {
    return usageError(io, WORKTREE_USAGE, messageOf(e));
  }
  try {
    const root = env.root(cwd);
    removeWorktree(
      root,
      issue,
      env.config(root),
      { deleteRemote: args.includes("--remote") },
      env.exec,
    );
    io.out(`removed the worktree and branches of issue ${issue}\n`);
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

// --- decision --------------------------------------------------------------

const DECISION_USAGE =
  "usage: autoclaude decision <issue> [--stage code-review|plan-review] [--json|--markdown] [--report <path>]";
const DECISION_FLAGS = ["--stage", "--report", "--json", "--markdown"];

export function parseDecisionArgs(argv: string[]): {
  issue: number;
  stage: ReviewStage;
  report?: string;
  markdown: boolean;
} {
  const issue = issueArg(argv[0], "decision");
  // An unknown option is refused rather than ignored: `--pr 12` would otherwise decide about
  // the worktree while the caller believed it was asking about a pull request.
  const unknown = argv.slice(1).find((a) => a.startsWith("--") && !DECISION_FLAGS.includes(a));
  if (unknown !== undefined) throw new Error(`decision: unknown option ${unknown}`);
  const stage = flag(argv, "--stage") ?? "code-review";
  if (!(REVIEW_STAGES as readonly string[]).includes(stage))
    throw new Error(`--stage must be one of ${REVIEW_STAGES.join(", ")}, got "${stage}"`);
  const markdown = argv.includes("--markdown");
  if (markdown && argv.includes("--json"))
    throw new Error("--json and --markdown ask for two different outputs; pass one");
  return { issue, stage: stage as ReviewStage, report: flag(argv, "--report"), markdown };
}

export interface DecisionVerbDeps {
  reviewDecision: (
    issue: number,
    deps: { root: string; stage: ReviewStage; report?: string },
  ) => DecisionResult;
}

/**
 * `autoclaude decision <issue> …`: what the engine does next with the issue's review report.
 * Exit 0 decided (the decision as JSON, or the dispatch with `--markdown`), 1 cannot decide,
 * 2 the report is not marked complete, 64 usage; the one line `issue N: <action> — <reason>`
 * goes to stderr.
 */
export async function decisionVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps: DecisionVerbDeps = { reviewDecision },
): Promise<number> {
  let opts: ReturnType<typeof parseDecisionArgs>;
  try {
    opts = parseDecisionArgs(args);
  } catch (e) {
    return usageError(io, DECISION_USAGE, messageOf(e));
  }
  let result: DecisionResult;
  try {
    result = deps.reviewDecision(opts.issue, {
      root: env.root(cwd),
      stage: opts.stage,
      report: opts.report,
    });
  } catch (e) {
    io.err(`${foldNote(`issue ${opts.issue}: cannot-decide — ${messageOf(e)}`)}\n`);
    return 1;
  }
  if (result.decision !== null) {
    io.out(
      `${opts.markdown ? result.decision.dispatchMarkdown || result.decision.reason : JSON.stringify(result.decision, null, 2)}\n`,
    );
  }
  io.err(`${result.message}\n`);
  return result.code;
}

// --- reports ---------------------------------------------------------------

const REPORTS_USAGE = "usage: autoclaude reports <plan|plan-review|implement|code-review> <file>";
const REPORT_STAGES = ["plan", "plan-review", "implement", "code-review"] as const;

/**
 * `autoclaude reports <stage> <file>`: the parsed report as JSON. Exit 2 when a review is not
 * marked complete (asked before the catalogue is loaded), 1 when it cannot be read or parsed,
 * 64 usage.
 */
export async function reportsVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
): Promise<number> {
  const [stage, file, ...extra] = args;
  if (
    stage === undefined ||
    file === undefined ||
    extra.length > 0 ||
    !(REPORT_STAGES as readonly string[]).includes(stage)
  )
    // 64 and not 2: exit 2 means "the review stopped early", and sharing it with a typo
    // charged the reviewer's retry budget for the caller's mistake.
    return usageError(io, REPORTS_USAGE);
  const kind = stage as (typeof REPORT_STAGES)[number];
  try {
    const text = readFileSync(file, "utf8");
    if (kind === "code-review" || kind === "plan-review") {
      if (!isReportComplete(kind, text)) {
        io.err(`report: the ${kind} report is not marked complete; the run did not finish\n`);
        return 2;
      }
      const root = env.root(cwd);
      const opts = classifyOptions(kind, { cfg: env.config(root), projectRoot: root });
      const parsed =
        kind === "code-review"
          ? parseCodeReviewReport(text, opts)
          : parsePlanReviewReport(text, opts);
      io.out(`${JSON.stringify(parsed, null, 2)}\n`);
    } else {
      const parsed = kind === "plan" ? parsePlanReport(text) : parseImplementReport(text);
      io.out(`${JSON.stringify(parsed, null, 2)}\n`);
    }
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

// --- publish ---------------------------------------------------------------

const PUBLISH_USAGE = "usage: autoclaude publish <issue> [--update]";

export interface PublishVerbDeps {
  publish: (issue: number, update: boolean) => ReturnType<typeof publish>;
}

/** `autoclaude publish <issue> [--update]`: push the branch and open (or update) the pull request. Exit 0 pushed, 3 rebase conflict, 1 anything else. */
export async function publishVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps?: PublishVerbDeps,
): Promise<number> {
  let issue: number;
  try {
    const unknown = args.slice(1).find((a) => a !== "--update");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    issue = issueArg(args[0], PUBLISH_USAGE);
  } catch (e) {
    return usageError(io, PUBLISH_USAGE, messageOf(e));
  }
  const update = args.includes("--update");
  try {
    const root = env.root(cwd);
    const cfg = env.config(root);
    const result = deps
      ? deps.publish(issue, update)
      : publish(issue, update, {
          exec: env.exec,
          root,
          cfg,
          forge: env.forge(cfg, root),
          now: env.now(),
        });
    if (result.code === 3) {
      io.err(
        `rebase onto ${cfg.forge.remote}/${cfg.branches.integration} conflicted:\n${result.conflict}\n`,
      );
      return 3;
    }
    io.out(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

// --- post-review -----------------------------------------------------------

const POST_USAGE = "usage: autoclaude post-review <pr> --report <path> --sha <sha>";

export interface PostReviewVerbDeps {
  postReview: (pr: number, text: string, sha: string) => { code: number; message: string };
}

/** `autoclaude post-review <pr> --report <path> --sha <sha>`: post a review report as a pull request comment. Exit 0 posted or already posted, 2 the report did not parse, 1 anything else, 64 usage. */
export async function postReviewVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps?: PostReviewVerbDeps,
): Promise<number> {
  const parsed = parsePostReviewArgs(args);
  if ("usage" in parsed) return usageError(io, POST_USAGE, parsed.usage);
  try {
    const text = readFileSync(parsed.reportFile, "utf8");
    let r: { code: number; message: string };
    if (deps) r = deps.postReview(parsed.pr, text, parsed.sha);
    else {
      const root = env.root(cwd);
      const cfg = env.config(root);
      r = postReview(parsed.pr, text, parsed.sha, env.exec, {
        cfg,
        root,
        repo: env.forge(cfg, root).repo,
      });
    }
    io.err(`${r.message}\n`);
    return r.code;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}

// --- check-rebased ---------------------------------------------------------

const REBASED_USAGE = "usage: autoclaude check-rebased";

export interface CheckRebasedVerbDeps {
  checkRebased: (cwd: string) => { rebased: boolean; base: string };
}

/** `autoclaude check-rebased`: is this checkout's HEAD on top of the integration branch? Exit 0 yes, 1 no or unverifiable. */
export async function checkRebasedVerb(
  args: string[],
  io: Io,
  cwd: string,
  env: Env = realEnv,
  deps?: CheckRebasedVerbDeps,
): Promise<number> {
  if (args.length > 0) return usageError(io, REBASED_USAGE, `unknown argument: ${args[0]}`);
  try {
    const r = deps
      ? deps.checkRebased(cwd)
      : checkRebased(env.config(env.root(cwd)), env.exec, cwd);
    if (r.rebased) {
      io.out(`Rebased onto ${r.base}.\n`);
      return 0;
    }
    const [remote, ...rest] = r.base.split("/");
    io.err(
      `Not rebased onto ${r.base}. Run: git fetch ${remote} && git rebase ${remote}/${rest.join("/")}\n`,
    );
    return 1;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  }
}
