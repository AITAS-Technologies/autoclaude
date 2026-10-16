/**
 * The claim protocol from design section 14: a label plus a comment. Adding a label is
 * not a compare-and-swap, so the label is applied first, a claim comment is posted,
 * and the comments are re-read; the earliest active claim wins, and a loser moves on
 * without touching anything.
 *
 * Verbs (`cli`; wired onto the `autoclaude` binary by the CLI):
 *   claim <issue> [--takeover]        # exit 0 won, 1 lost or not claimable
 *   release <issue> --to <blocked|needs-shaping|ready|done|none> --reason "<text>"
 *
 * The two commands are functions over an injectable forge (claimIssue, releaseIssue), so
 * the race and the takeover are under test.
 */

import type { ProjectConfig } from "../config/types.js";
import { flag, issueArg } from "../cli/args.js";
import type { Forge, IssueSummary, PrSummary } from "../forge/github.js";
import { branchPrefixFor } from "./branch-names.js";
import { activeClaims, claimIsStale, type Claim } from "./ledger/ledger.js";
import { defuseMentions } from "./review/reports.js";

export type ClaimBlockerCode = "closed" | "not-ready" | "assigned" | "working";

/** Why an issue cannot be claimed, as a code the caller can branch on plus a sentence for a human. */
export function claimBlocker(
  issue: IssueSummary,
  cfg: ProjectConfig,
): { code: ClaimBlockerCode; reason: string } | null {
  const labels = issue.labels.map((l) => l.name);
  if (issue.state !== "OPEN") return { code: "closed", reason: "issue is closed" };
  if (!labels.includes(cfg.queue.ready))
    return { code: "not-ready", reason: `no ${cfg.queue.ready} label` };
  if (issue.assignees.length)
    return {
      code: "assigned",
      reason: `assigned to ${issue.assignees.map((a) => a.login).join(", ")}: a human has claimed it`,
    };
  if (labels.includes(cfg.labels.working))
    return { code: "working", reason: `carries ${cfg.labels.working} already` };
  return null;
}

/**
 * A claim is a fresh attempt. An issue a human re-released after `agent-blocked` still
 * carries that label and the counters of the last attempt; left in place, the new
 * attempt would start with its fix budget spent and block again one review later.
 */
export function freshAttemptLabels(current: string[], cfg: ProjectConfig): string[] {
  return current.filter(
    (l) =>
      l === cfg.labels.blocked ||
      l.startsWith(cfg.labels.fixRound) ||
      l.startsWith(cfg.labels.reviewRetry),
  );
}

/** The pull requests that belong to one issue, by branch prefix. */
function prsOf(issue: number, prs: PrSummary[], cfg: ProjectConfig): PrSummary[] {
  const prefix = branchPrefixFor(issue, cfg);
  return prs.filter((p) => p.headRefName.startsWith(prefix));
}

export function claimBody(machine: string, at: string): string {
  return `<!-- autodev-claim machine="${machine}" at="${at}" -->\nautodev: claimed by \`${machine}\` at ${at}. The earliest claim comment wins; a claim older than the configured stale window with no pull request activity may be taken over.`;
}

/**
 * The release comment, with the mentions that would notify someone or start a workflow
 * run taken out of its reason.
 *
 * `reason` is free text: an orchestrator's sentence, a review's own words, an operator's
 * `--reason`. Every mention is defused except those of `humans` (`cfg.humans`), who are
 * meant to be notified.
 *
 * The machine id is not scrubbed: it is `hostname()/username`, not model-written, and an
 * at in it would be a local account name rather than a mention.
 */
export function releaseBody(machine: string, reason: string, humans: string[]): string {
  return `<!-- autodev-release machine="${machine}" -->\nautodev (${machine}): ${defuseMentions(reason, humans)}`;
}

export const RELEASE_TARGETS = ["blocked", "needs-shaping", "ready", "done", "none"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export function releaseLabels(
  current: string[],
  to: ReleaseTarget,
  cfg: ProjectConfig,
): { remove: string[]; add: string[] } {
  const counters = current.filter(
    (l) => l.startsWith(cfg.labels.fixRound) || l.startsWith(cfg.labels.reviewRetry),
  );
  const has = (l: string) => current.includes(l);
  switch (to) {
    case "blocked":
      // Counters stay: a human reading the issue sees how many rounds it took.
      return {
        remove: [cfg.queue.ready, cfg.labels.working].filter(has),
        add: [cfg.labels.blocked],
      };
    case "needs-shaping":
      return {
        remove: [cfg.queue.ready, cfg.labels.working, ...counters].filter(has),
        add: [cfg.labels.needsShaping],
      };
    case "ready":
      return { remove: [cfg.labels.working, ...counters].filter(has), add: [cfg.queue.ready] };
    case "done":
      return { remove: [cfg.queue.ready, cfg.labels.working, ...counters].filter(has), add: [] };
    case "none":
      return { remove: [cfg.labels.working].filter(has), add: [] };
  }
}

export interface ClaimDeps {
  forge: Forge;
  cfg: ProjectConfig;
  machine: string;
  now?: Date;
}

export interface ClaimResult {
  won: boolean;
  /** Why it was not even attempted, when it was not. */
  code?: ClaimBlockerCode | "live-claim";
  reason?: string;
  owner?: Claim | null;
  at?: string;
}

/**
 * Take an issue, or find out that somebody else has it.
 *
 * Without --takeover the earliest active claim wins, whoever posted it and however old
 * it is: a dead machine's claim blocks the issue until a human takes it over, which is
 * the design's choice ("automatic takeover: built, invoked by a human"). With --takeover
 * every claim that is stale by the shared rule is treated as gone, ours must be the
 * earliest claim that is not stale, and once the race is won the stale claims are
 * released with a marker so the next reader sees only ours.
 */
export function claimIssue(
  issue: number,
  opts: { takeover: boolean },
  deps: ClaimDeps,
): ClaimResult {
  const { forge, cfg, machine } = deps;
  const now = deps.now ?? new Date();
  const staleMs = cfg.caps.staleClaimHours * 3600_000;
  const before = forge.viewIssue(issue);
  const blocker = claimBlocker(before, cfg);
  if (blocker && !(opts.takeover && blocker.code === "working")) {
    return { won: false, code: blocker.code, reason: blocker.reason };
  }

  const isStale = (c: Claim, prs: PrSummary[]) =>
    claimIsStale(c, prsOf(issue, prs, cfg), staleMs, now);
  let staleOnes: Claim[] = [];
  // Listed once per command: nothing between the two reads can change what the rule
  // reads.
  const prs = opts.takeover ? forge.listPrs("all") : [];
  if (opts.takeover) {
    const claims = activeClaims(before.comments);
    const live = claims.find((c) => !isStale(c, prs));
    if (live) {
      return {
        won: false,
        code: "live-claim",
        reason: `claim by ${live.machine} at ${live.createdAt} is not stale`,
        owner: live,
      };
    }
    staleOnes = claims;
  }

  // The label and the counters in one edit: a fresh attempt never inherits a spent
  // budget, and the label never lands without the counters leaving.
  const currentLabels = before.labels.map((l) => l.name);
  forge.editLabels(issue, {
    add: [cfg.labels.working],
    remove: freshAttemptLabels(currentLabels, cfg),
  });
  const at = now.toISOString();
  forge.commentIssue(issue, claimBody(machine, at));

  const after = forge.viewIssue(issue);
  const claims = activeClaims(after.comments);
  const owner = opts.takeover ? claims.find((c) => !isStale(c, prs)) : claims[0];
  const won = owner !== undefined && owner.machine === machine && owner.at === at;
  if (!won && !currentLabels.includes(cfg.labels.working)) {
    // The label was ours to add and the claim is not ours to keep: a ghost marker in the
    // thread must not leave a working label behind that refuses every later plain claim.
    forge.editLabels(issue, { remove: [cfg.labels.working] });
  }
  if (won && staleOnes.length) {
    // Only now, with the race won, are the old claims declared over. Posting the
    // release first would let a takeover that then lost leave a release standing.
    const who = staleOnes.map((c) => `${c.machine} (${c.createdAt})`).join(", ");
    forge.commentIssue(
      issue,
      releaseBody(machine, `stale claim(s) taken over: ${who}`, cfg.humans),
    );
    forge.commentIssue(issue, claimBody(machine, at));
  }
  return { won, owner: owner ?? null, at };
}

export function releaseIssue(
  issue: number,
  to: ReleaseTarget,
  reason: string,
  deps: ClaimDeps,
): { released: number; to: ReleaseTarget; removed: string[]; added: string[] } {
  const { forge, cfg, machine } = deps;
  if (!RELEASE_TARGETS.includes(to)) {
    throw new Error(`--to must be one of ${RELEASE_TARGETS.join(", ")}, got "${to}"`);
  }
  const current = forge.viewIssue(issue).labels.map((l) => l.name);
  const { remove, add } = releaseLabels(current, to, cfg);
  forge.editLabels(issue, { add, remove });
  forge.commentIssue(issue, releaseBody(machine, reason, cfg.humans));
  return { released: issue, to, removed: remove, added: add };
}

/**
 * The two verbs from a command line. Exported for its own tests, and `deps` with it: the
 * refusals below have to be observable as "nothing reached `gh`", which is the whole point
 * of refusing in front of the two calls that edit an issue and post to it.
 */
export function cli(argv: string[], deps: ClaimDeps): number {
  const [cmd, issueToken, ...rest] = argv;
  // One rule for "is this an issue number", shared with the other CLIs: a bare
  // `Number.isInteger` took `0x10` as 16 and `1e2` as 100, and this verb comments on
  // whatever issue the number names.
  const issue = issueArg(
    issueToken,
    "claim <issue> [--takeover] | release <issue> --to <target> --reason <text>",
  );

  if (cmd === "claim") {
    const result = claimIssue(issue, { takeover: rest.includes("--takeover") }, deps);
    console.log(JSON.stringify(result));
    return result.won ? 0 : 1;
  }
  if (cmd === "release") {
    // Through the shared parser, like every other CLI here. A raw `indexOf` takes the
    // first of two `--to` flags and drops the second silently — the rule the parser was
    // extracted to enforce, which no unknown-option scan can catch because both spellings
    // are known — and it was still missing from the one verb that edits an issue's labels
    // and posts to it: `release 9 --to blocked --reason x --to ready` released as blocked
    // with the typed `ready` gone. It also refuses a flag whose value is the next flag,
    // which `--to --reason x` used to pass through as the target "--reason".

    const to = flag(rest, "--to");
    const reason = flag(rest, "--reason");
    if (!to || !reason) throw new Error("release <issue> --to <target> --reason <text>");
    console.log(JSON.stringify(releaseIssue(issue, to as ReleaseTarget, reason, deps)));
    return 0;
  }
  throw new Error(`unknown command ${cmd}`);
}
