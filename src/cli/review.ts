import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { flag, prArg } from "./args.js";
import { bootstrapWorktree } from "../engine/bootstrap.js";
import { entryForPr, loadLedger, type LedgerEntry } from "../engine/ledger/ledger.js";
import { isReportComplete } from "../engine/review/reports.js";
import { escapeRegExp } from "../engine/review/rules.js";
import { repoRoot } from "../engine/root.js";
import { copyIntoWorktree } from "../engine/worktree.js";
import { git } from "../forge/github.js";
import type { TickCtx } from "../orchestrator/actions.js";
import { runCodeReview } from "../orchestrator/review/code-review.js";
import { messageOf, usageError } from "./common.js";
import { interruptible, type Interruptible } from "./interrupt.js";
import type { Io } from "./main.js";
import { realContext } from "./run.js";

const USAGE = "usage: autoclaude review --pr <n>";

export interface ReviewDeps {
  root: (cwd: string) => string;
  context: (root: string, instance: string) => TickCtx;
  review: typeof runCodeReview;
  /** Where the termination signals come from. */
  signals?: NodeJS.Process;
}

const realDeps: ReviewDeps = { root: repoRoot, context: realContext, review: runCodeReview };

/**
 * `autoclaude review --pr <n>`: the code review on an open pull request, posted as a comment
 * on it, through the same pipeline the orchestrator runs. The review reads the pull request's
 * head commit in a worktree: the ledger entry's when it stands at that commit, otherwise a
 * detached one made for the review (the project's `worktrees.copy` files copied in) and
 * removed afterwards. Either way the engine's `bootstrap` has run there, once, with the normal
 * environment.
 *
 * Exit 0 when the review ran to its verdict and the comment is posted (or was already), 2 when
 * the review stopped early (nothing was posted), 1 when it could not run, hit a usage limit or
 * was interrupted. Ctrl-C kills the review's processes.
 */
export async function reviewVerb(
  args: string[],
  io: Io,
  cwd: string,
  deps: ReviewDeps = realDeps,
): Promise<number> {
  let n: number;
  try {
    const unknown = args.find((a, i) => a !== "--pr" && args[i - 1] !== "--pr");
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
    const token = flag(args, "--pr");
    if (token === undefined) throw new Error("--pr <n> is required");
    n = prArg(token, "--pr");
  } catch (e) {
    return usageError(io, USAGE, messageOf(e));
  }

  let created: string | null = null;
  let root: string | null = null;
  let guard: Interruptible | null = null;
  try {
    root = deps.root(cwd);
    guard = interruptible(deps.context(root, `review-${process.pid}`), deps.signals ?? process);
    const ctx = guard.ctx;
    const { cfg, forge, exec } = ctx;
    const pr = forge.viewPr(n);
    if (pr.state !== "OPEN") {
      io.err(`pull request #${n} is ${pr.state.toLowerCase()}; only an open one is reviewed\n`);
      return 1;
    }
    const known = entryForPr(loadLedger(root), n);
    const prefix = escapeRegExp(cfg.branchPrefix);
    const fromBranch = new RegExp(`^${prefix}(\\d+)-`).exec(pr.headRefName);
    const issue = known?.issue ?? (fromBranch ? Number(fromBranch[1]) : null);
    if (issue === null) {
      io.err(
        `cannot tell which issue pull request #${n} belongs to: ${pr.headRefName} is not under ${cfg.branchPrefix}<issue>-, and the ledger does not know it\n`,
      );
      return 1;
    }
    git(
      ["fetch", cfg.forge.remote, pr.headRefName, cfg.branches.integration, "--quiet"],
      exec,
      root,
    );

    let worktree: string;
    const sameHead = (dir: string) =>
      existsSync(dir) &&
      exec("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout.trim() === pr.headRefOid;
    if (known && known.worktree && sameHead(known.worktree)) worktree = known.worktree;
    else {
      const parent = resolve(root, cfg.worktrees.root);
      worktree = join(parent, `review-pr-${n}`);
      mkdirSync(parent, { recursive: true });
      // A worktree an earlier, interrupted review left behind would make `worktree add` fail.
      exec("git", ["worktree", "remove", "--force", worktree], { cwd: root });
      rmSync(worktree, { recursive: true, force: true });
      exec("git", ["worktree", "prune"], { cwd: root });
      git(["worktree", "add", "--detach", "--quiet", worktree, pr.headRefOid], exec, root);
      created = worktree;
      copyIntoWorktree(root, worktree, cfg);
    }
    const failed = await bootstrapWorktree(cfg, worktree, ctx.now());
    if (failed !== null) {
      io.err(`review of #${n}: ${failed}\n`);
      return 1;
    }
    const base: LedgerEntry = known ?? {
      issue,
      title: "",
      state: "pr-open",
      branch: pr.headRefName,
      worktree,
      pr: n,
      attempts: { implement: 0, fix: 0, reviewRetry: 0, plan: 0 },
      stage: null,
      claimedAt: ctx.now().toISOString(),
      pushedSha: null,
      lastError: null,
      lastCanMerge: null,
      updatedAt: ctx.now().toISOString(),
    };
    const outcome = await deps.review(
      ctx,
      { ...base, worktree },
      { kind: "pr", pr: n, headSha: pr.headRefOid },
    );
    if (guard.interrupted()) {
      io.err(`review of #${n} was interrupted; nothing was posted\n`);
      return 1;
    }
    if (outcome.kind === "limit") {
      io.err(
        `usage limit until ${outcome.resetsAt}; nothing was posted, run this again after it\n`,
      );
      return 1;
    }
    const at = pr.headRefOid.slice(0, 12);
    if (!isReportComplete("code-review", readFileSync(outcome.reportFile, "utf8"))) {
      io.err(
        `review of #${n} at ${at} stopped before its verdict; nothing was posted (the report is ${outcome.reportFile})\n`,
      );
      return 2;
    }
    io.out(`review of #${n} at ${at} is posted (or was already)\n`);
    return 0;
  } catch (e) {
    io.err(`${guard?.interrupted() ? "interrupted: " : ""}${messageOf(e)}\n`);
    return 1;
  } finally {
    await guard?.dispose();
    if (created !== null && root !== null) {
      try {
        git(["worktree", "remove", "--force", created], guard?.ctx.exec, root);
        git(["worktree", "prune"], guard?.ctx.exec, root);
      } catch (e) {
        io.err(`could not remove ${created}: ${messageOf(e)}\n`);
      }
    }
  }
}
