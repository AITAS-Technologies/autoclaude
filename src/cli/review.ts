import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { prArg, flag } from "./args.js";
import { entryForPr, loadLedger, type LedgerEntry } from "../engine/ledger/ledger.js";
import { escapeRegExp } from "../engine/review/rules.js";
import { repoRoot } from "../engine/root.js";
import { git } from "../forge/github.js";
import type { TickCtx } from "../orchestrator/actions.js";
import { runCodeReview } from "../orchestrator/review/code-review.js";
import { messageOf, usageError } from "./common.js";
import type { Io } from "./main.js";
import { realContext } from "./run.js";

const USAGE = "usage: autoclaude review --pr <n>";

export interface ReviewDeps {
  root: (cwd: string) => string;
  context: (root: string, instance: string) => TickCtx;
  review: typeof runCodeReview;
}

const realDeps: ReviewDeps = { root: repoRoot, context: realContext, review: runCodeReview };

/**
 * `autoclaude review --pr <n>`: the code review on an open pull request, posted as a comment
 * on it. The review reads the pull request's head commit in a worktree: the ledger entry's,
 * when it stands at that commit, otherwise a detached one made for the review and removed
 * afterwards. Exit 0 when the review ran (and was posted, or was already posted for that
 * commit), 1 when it could not run or hit a usage limit.
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
  let ctx: TickCtx | null = null;
  try {
    root = deps.root(cwd);
    ctx = deps.context(root, `review-${process.pid}`);
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
      worktree = join(resolve(root, cfg.worktrees.root), `review-pr-${n}`);
      mkdirSync(resolve(root, cfg.worktrees.root), { recursive: true });
      git(["worktree", "add", "--detach", "--quiet", worktree, pr.headRefOid], exec, root);
      created = worktree;
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
      {
        kind: "pr",
        pr: n,
        headSha: pr.headRefOid,
      },
    );
    if (outcome.kind === "limit") {
      io.err(`usage limit until ${outcome.resetsAt}; run this again after it\n`);
      return 1;
    }
    io.out(
      `review of #${n} at ${pr.headRefOid.slice(0, 12)} done; the report is ${outcome.reportFile}\n`,
    );
    return 0;
  } catch (e) {
    io.err(`${messageOf(e)}\n`);
    return 1;
  } finally {
    if (created !== null && root !== null) {
      try {
        git(["worktree", "remove", "--force", created], ctx?.exec ?? undefined, root);
        git(["worktree", "prune"], ctx?.exec ?? undefined, root);
      } catch (e) {
        io.err(`could not remove ${created}: ${messageOf(e)}\n`);
      }
    }
  }
}
