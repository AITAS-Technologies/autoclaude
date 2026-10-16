/**
 * The ledger: operational state on one machine, written after every transition, and
 * rebuilt from GitHub whenever it is missing or stale.
 *
 * Two rules from design sections 5 and 14. No field here is authoritative: the record
 * is GitHub, and the attempt counters are labels, cached here. And the file must be
 * reconstructible: `reconcile` rebuilds every entry this machine owns from the working
 * label, the claim comment, the open pull requests and the worktrees on disk.
 *
 * The CLI verbs (`ledgerCli`) are `show`, `set <issue> <state> [...]`, `note`, `limit`
 * and `archive`; the `autoclaude` binary registers them in a later task.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { flag, issueArg, prArg } from "../../cli/args.js";
import { loadProjectConfig } from "../../config/load.js";
import type { ProjectConfig } from "../../config/types.js";
import type { Forge, IssueComment, IssueSummary, PrSummary } from "../../forge/github.js";
import { branchPrefixFor, notIssueBranch, worktreeDirPrefix } from "../branch-names.js";
import { instantInZone, wallClockIn } from "../profile.js";
import { reportPath, type Stage } from "../review/reports.js";
import { escapeRegExp } from "../review/rules.js";
import { RETRY_CODES, STATE_DIR, sleepSync, withLedgerLock } from "./lock.js";

export { withLedgerLock, withLedgerLockAsync } from "./lock.js";
export type IssueState =
  | "claimed"
  | "planning"
  | "plan-reviewing"
  | "fixing-plan"
  | "implementing"
  | "code-reviewing"
  | "fixing-local"
  | "pr-open"
  | "fixing-ci"
  | "mergeable"
  | "merged"
  | "done"
  | "closed"
  | "blocked"
  | "needs-shaping"
  | "resume-needed";

export const TERMINAL: ReadonlySet<IssueState> = new Set([
  "done",
  "closed",
  "blocked",
  "needs-shaping",
]);

/**
 * A stage runs as a child process of the orchestrator, so it is identified by the
 * process (`pid`, and `processStartedAt` to tell it from an unrelated process that was
 * later given the same pid) and by the orchestrator instance that started it.
 */
export interface StageRun {
  stage: Stage;
  mode: "fresh" | "fix" | "resume";
  /** The child's pid, or null for a stage recorded before its process was started. */
  pid: number | null;
  /**
   * The orchestrator instance that started it. A child belongs to the process that
   * spawned it, so after a crash or a restart a stage of an earlier instance is dead (or
   * orphaned), and reconcile turns its entry into resume-needed instead of waiting on a
   * ghost.
   */
  instance: string;
  startedAt: string;
  /** The process's own start time as the OS reports it, to recognise a reused pid. */
  processStartedAt: string | null;
}

export interface LedgerEntry {
  issue: number;
  title: string;
  state: IssueState;
  branch: string;
  worktree: string;
  pr: number | null;
  attempts: { implement: number; fix: number; reviewRetry: number; plan: number };
  stage: StageRun | null;
  claimedAt: string;
  /**
   * The commit the publish step last pushed to the branch, so the next forced update can
   * name it as the lease (`--force-with-lease=refs/heads/<branch>:<sha>`) and a commit
   * anyone else pushed in between refuses the push.
   */
  pushedSha: string | null;
  lastError: string | null;
  lastCanMerge: string | null;
  updatedAt: string;
}

export interface LedgerEvent {
  at: string;
  issue: number;
  from: IssueState | null;
  to: IssueState;
  note: string | null;
}

export interface ForeignClaim {
  issue: number;
  machine: string;
  at: string | null;
  stale: boolean;
}

export interface Ledger {
  version: 1;
  machine: string;
  /** The orchestrator instance recorded in `.autoclaude/state/instance.json`, or null when none is. */
  instance: string | null;
  limitedUntil: string | null;
  issues: Record<string, LedgerEntry>;
  foreign: ForeignClaim[];
  events: LedgerEvent[];
}

/** Finished entries older than this leave the ledger; GitHub keeps the record. */
const PRUNE_DAYS = 7;

export interface GitHubFacts {
  /** Every issue carrying the working label, open or closed, with its comments. */
  working: IssueSummary[];
  /** Every pull request, open or not, so a merged one can be recognised. */
  prs: PrSummary[];
}

const MAX_EVENTS = 300;

/**
 * The facts `reconcile` needs, through the forge's complete listings (a truncated list
 * is refused there, never reconciled from): every issue carrying the working label,
 * open or closed, with its comments, and every pull request.
 */
export function gatherFacts(forge: Forge, cfg: Pick<ProjectConfig, "labels">): GitHubFacts {
  return { working: forge.listIssues(cfg.labels.working, "all"), prs: forge.listPrs("all") };
}

export function machineId(): string {
  return `${hostname()}/${userInfo().username}`;
}

export function emptyLedger(machine: string, instance: string | null = null): Ledger {
  return { version: 1, machine, instance, limitedUntil: null, issues: {}, foreign: [], events: [] };
}

/**
 * The instance id in `.autoclaude/state/instance.json` (`{ instance, pid, heartbeatAt }`,
 * written by the orchestrator), or null when it is missing, unreadable, malformed or has
 * no id. Read only here. A Windows editor's BOM is tolerated.
 */
export function recordedInstance(root: string): string | null {
  try {
    const text = readFileSync(join(root, STATE_DIR, "instance.json"), "utf8").replace(/^﻿/, "");
    const id = (JSON.parse(text) as { instance?: unknown }).instance;
    return typeof id === "string" && id.trim() !== "" ? id : null;
  } catch {
    return null;
  }
}

/** Every field an entry has, so a file from an older engine or a hand edit never lacks one. */
function blankEntry(issue: number, now: Date): Omit<LedgerEntry, "state"> {
  return {
    issue,
    title: "",
    branch: "",
    worktree: "",
    pr: null,
    attempts: { implement: 0, fix: 0, reviewRetry: 0, plan: 0 },
    stage: null,
    claimedAt: now.toISOString(),
    pushedSha: null,
    lastError: null,
    lastCanMerge: null,
    updatedAt: now.toISOString(),
  };
}

export function loadLedger(root: string, machine: string = machineId()): Ledger {
  const path = join(root, STATE_DIR, "ledger.json");
  const instance = recordedInstance(root);
  if (!existsSync(path)) return emptyLedger(machine, instance);
  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Ledger;
  // Defaults per entry, not only at the top level: the status and situation readers read
  // `attempts.fix` and `stage` off every row.
  const now = new Date();
  const issues = Object.fromEntries(
    Object.entries(parsed.issues ?? {}).map(([k, e]) => [
      k,
      {
        ...blankEntry(Number(k), now),
        ...e,
        attempts: { ...blankEntry(0, now).attempts, ...e.attempts },
      },
    ]),
  );
  return { ...emptyLedger(machine, instance), ...parsed, issues, machine, instance };
}

/**
 * Remove what this process left at a temp path, without ever throwing itself.
 *
 * Both atomic writers below need it, and both call it on a path whose write has just
 * failed: `rmSync` with `force` ignores a missing file but not a locked one, and by then
 * the caller has its own error to report or has already committed. `recursive` because
 * the path is this process's to clear whatever sits there — a directory in the way is why
 * the write failed in the first place.
 */
function dropTmp(tmp: string): void {
  try {
    rmSync(tmp, { force: true, recursive: true });
  } catch {
    // Nothing further to do about it here.
  }
}

/**
 * Atomic: write a sibling named after this process, then rename. A crash mid-write
 * leaves the old file, not half a new one, and two processes never share a temp name
 *. Callers that read, change and write hold the lock below.
 *
 * The rename is retried, like `status.md`'s, and unlike it still throws when it never
 * succeeds: the ledger write is this function's whole job, while `status.md` is derived.
 * What the retry removes is the lost race — measured on this machine (Node 24, libuv
 * 1.51), `renameSync` over a `ledger.json` that a Node reader holds open fails with EPERM,
 * and the watcher reads that file every five seconds. The `status.md` writer got its
 * loop because of exactly that reader and this rename beside it did not, so a `set` that
 * lost the race exited 1 and left `ledger.json.<pid>.tmp` behind; the repeat is what loses
 * data, `set … --bump fix` a second time counting the attempt twice.
 *
 * A failing write, once the retries are spent, still throws — `ledger.json` is the record,
 * and a caller told nothing would go on as if the transition were saved — but the temp file
 * goes first either way, for the reason `writeStatus` drops its own: every `set` and every
 * `note` is a one-shot CLI process whose pid names the file, so nothing would ever
 * overwrite it or sweep it up.
 */
export function saveLedger(
  root: string,
  ledger: Ledger,
  now: Date = new Date(),
  // Injectable for the reason `renameWithRetry`'s own is: a transient EPERM cannot be
  // staged on a real file system, and without a seam here nothing could assert that this
  // function renames through the retry at all — reverting that one line left every rename
  // test green. `writeStatus` below keeps the real one:
  // its rename is a different question with a different answer.
  rename: (from: string, to: string) => void = renameSync,
): void {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ledger.json");
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  } catch (error) {
    dropTmp(tmp);
    throw error;
  }
  try {
    renameWithRetry(tmp, path, rename);
  } catch (error) {
    dropTmp(tmp);
    throw error;
  }
  writeStatus(root, ledger, now);
}

/** Load, change, save, under the lock: the only way a script should write the ledger. */
export function updateLedger<T>(
  root: string,
  mutate: (ledger: Ledger) => T,
  now: Date = new Date(),
  machine: string = machineId(),
): T {
  return withLedgerLock(root, () => {
    const ledger = loadLedger(root, machine);
    const result = mutate(ledger);
    saveLedger(root, ledger, now);
    return result;
  });
}

export function transition(
  ledger: Ledger,
  issue: number,
  to: IssueState,
  patch: Partial<Omit<LedgerEntry, "issue" | "state">> & { note?: string },
  now: Date = new Date(),
): LedgerEntry {
  const key = String(issue);
  // Cast, not annotated: the index signature alone lets tsc believe every issue already
  // has an entry (and an annotation is narrowed straight back on assignment), which
  // would flag the defaults below as always overwritten.
  const before = ledger.issues[key] as LedgerEntry | undefined;
  const { note, ...fields } = patch;
  // A claim after a finished attempt starts clean. Carrying the old entry over let a
  // re-released issue inherit its closed pull request, its lease and its counters, and
  // publish then skipped `gh pr create` and pointed the ledger at the closed number, after
  // which the next tick destroyed the whole second attempt.
  const freshAttempt = before !== undefined && TERMINAL.has(before.state) && to === "claimed";
  const entry: LedgerEntry = {
    ...blankEntry(issue, now),
    ...(freshAttempt ? { title: before.title } : before),
    ...fields,
    state: to,
    updatedAt: now.toISOString(),
  };
  // A state change ends the running stage unless the patch names the next one.
  if (before && before.state !== to && fields.stage === undefined) entry.stage = null;
  ledger.issues[key] = entry;
  ledger.events.push({
    at: now.toISOString(),
    issue,
    from: before?.state ?? null,
    to,
    note: note ?? null,
  });
  if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
  return entry;
}

/**
 * The entry that owns a pull request number, preferring the attempt that is still live.
 *
 * `can-merge` starts from a pull request while the ledger is keyed by issue, so the
 * number has to be searched for. Two entries can carry it — a finished attempt whose
 * entry the prune has not reached yet, and the live one — and the live attempt is the one
 * whose archive describes the pull request as it stands. Among several of either kind the
 * most recently updated, so the answer does not depend on the order of the keys.
 */
export function entryForPr(ledger: Ledger, pr: number): LedgerEntry | null {
  const carrying = Object.values(ledger.issues).filter((e) => e.pr === pr);
  const newest = (entries: LedgerEntry[]): LedgerEntry | null =>
    entries.reduce<LedgerEntry | null>(
      (best, e) => (best === null || e.updatedAt > best.updatedAt ? e : best),
      null,
    );
  return newest(carrying.filter((e) => !TERMINAL.has(e.state))) ?? newest(carrying);
}

// --- claims ---------------------------------------------------------------

const CLAIM = /<!-- autodev-claim machine="([^"]+)" at="([^"]+)" -->/;
const RELEASE = /<!-- autodev-release machine="[^"]*" -->/;

export function parseClaim(body: string): { machine: string; at: string } | null {
  const m = body.match(CLAIM);
  return m?.[1] !== undefined && m[2] !== undefined ? { machine: m[1], at: m[2] } : null;
}

export interface Claim {
  machine: string;
  /** The claimant's own clock, from the marker: an identity, not an ordering. */
  at: string;
  /** GitHub's clock, from the comment: the ordering. Two skewed machines agree on it. */
  createdAt: string;
}

/** Claims posted after the most recent release marker, oldest first by GitHub's clock. */
export function activeClaims(comments: IssueComment[]): Claim[] {
  const lastRelease = comments.reduce((idx, c, i) => (RELEASE.test(c.body) ? i : idx), -1);
  return comments
    .slice(lastRelease + 1)
    .map((c) => {
      const claim = parseClaim(c.body);
      return claim ? { ...claim, createdAt: c.createdAt } : null;
    })
    .filter((c): c is Claim => c !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The one staleness rule, shared by reconcile (status) and the claim step (takeover), so the
 * two cannot disagree. A claim is stale when GitHub's clock says
 * it is older than the cap and no pull request of the issue moved within the cap. A
 * working label with no claim marker has no age and counts as stale.
 */
export function claimIsStale(
  owner: { createdAt: string } | null,
  prs: Array<{ updatedAt: string }>,
  staleMs: number,
  now: Date,
): boolean {
  const age = owner
    ? now.getTime() - new Date(owner.createdAt).getTime()
    : Number.POSITIVE_INFINITY;
  const recentPr = prs.some((p) => now.getTime() - new Date(p.updatedAt).getTime() < staleMs);
  return age > staleMs && !recentPr;
}

// --- reconcile ------------------------------------------------------------

function counter(labels: string[], prefix: string): number {
  return labels.reduce((max, l) => {
    if (!l.startsWith(prefix)) return max;
    const n = Number.parseInt(l.slice(prefix.length), 10);
    return Number.isInteger(n) && n > max ? n : max;
  }, 0);
}

function worktreeFor(issue: number, worktrees: string[], cfg: ProjectConfig): string | null {
  const prefix = `${worktreeDirPrefix(cfg)}${issue}-`;
  return worktrees.find((w) => basename(w).startsWith(prefix)) ?? null;
}

export function reconcile(
  ledger: Ledger,
  facts: GitHubFacts,
  worktrees: string[],
  cfg: ProjectConfig,
  now: Date,
): Ledger {
  const out: Ledger = {
    ...ledger,
    issues: { ...ledger.issues },
    foreign: [],
    events: [...ledger.events],
  };
  const staleMs = cfg.caps.staleClaimHours * 3600_000;
  const seen = new Set<string>();

  for (const iss of facts.working) {
    const key = String(iss.number);
    const labels = iss.labels.map((l) => l.name);
    const prefix = branchPrefixFor(iss.number, cfg);
    const prs = facts.prs.filter((p) => p.headRefName.startsWith(prefix));
    const owner = activeClaims(iss.comments)[0] ?? null;
    // Only pull requests that ended after the current claim belong to this attempt. An
    // earlier attempt's closed or merged pull request must neither block a fresh claim on
    // its first tick nor revive rejected work as resume-needed.
    // The clock is `closedAt`/`mergedAt`, not `updatedAt`: a human commenting on the
    // previous attempt's closed pull request moved `updatedAt` past the new claim and
    // blocked the fresh attempt with the old number.
    const attemptStart = owner ? new Date(owner.createdAt).getTime() : 0;
    const endedAt = (p: PrSummary) => p.mergedAt ?? p.closedAt ?? p.updatedAt;
    const ofAttempt = (p: PrSummary) => new Date(endedAt(p)).getTime() >= attemptStart;
    const open = prs.find((p) => p.state === "OPEN") ?? null;
    const merged = prs.find((p) => p.state === "MERGED" && ofAttempt(p)) ?? null;
    const closedPr = prs.find((p) => p.state === "CLOSED" && ofAttempt(p)) ?? null;

    if (!owner || owner.machine !== out.machine) {
      // Age by GitHub's clock (createdAt), the same clock the claim step uses for a takeover;
      // the marker's `at` is the claimant's clock and only identifies the claim.
      out.foreign.push({
        issue: iss.number,
        machine: owner?.machine ?? "unknown",
        at: owner?.at ?? null,
        stale: claimIsStale(owner, prs, staleMs, now),
      });
      continue;
    }

    seen.add(key);
    const wt = worktreeFor(iss.number, worktrees, cfg);
    const existing = out.issues[key];
    const attempts = {
      implement: existing?.attempts?.implement ?? (wt || open || merged ? 1 : 0),
      // The labels are the record, the ledger the cache; the higher of the two, so a
      // `--bump fix` survives a tick on which the label was not (yet) applied and a CI
      // fix round cannot repeat without bound.
      fix: Math.max(counter(labels, cfg.labels.fixRound), existing?.attempts?.fix ?? 0),
      reviewRetry: Math.max(
        counter(labels, cfg.labels.reviewRetry),
        existing?.attempts?.reviewRetry ?? 0,
      ),
      // No label for plan rounds: a lost count costs one extra plan review at most.
      plan: existing?.attempts?.plan ?? 0,
    };
    const base = {
      title: iss.title,
      branch:
        existing?.branch ||
        open?.headRefName ||
        merged?.headRefName ||
        (wt ? `${cfg.branchPrefix}${basename(wt).slice(worktreeDirPrefix(cfg).length)}` : ""),
      worktree: existing?.worktree || wt || "",
      pr: open?.number ?? merged?.number ?? existing?.pr ?? null,
      attempts,
      claimedAt: existing?.claimedAt ?? owner.createdAt,
    };

    // The stage is kept on the way into merged and closed, so the tick can stop a
    // stage process that is still working in the worktree before the cleanup removes it.
    if (merged && !open) {
      if (existing?.state !== "merged" && existing?.state !== "done") {
        transition(
          out,
          iss.number,
          "merged",
          {
            ...base,
            stage: existing?.stage ?? null,
            note: "pull request merged by a human; cleanup pending",
          },
          now,
        );
      }
      continue;
    }
    // A human closed the issue while the claim stood: the work is over, whatever the
    // worktree holds. The cleanup of worktree and labels is the orchestrator's next step.
    if (iss.state === "CLOSED") {
      if (existing?.state !== "closed") {
        transition(
          out,
          iss.number,
          "closed",
          {
            ...base,
            stage: existing?.stage ?? null,
            note: "issue closed by a human; cleanup pending",
          },
          now,
        );
      }
      continue;
    }
    // A human closed this attempt's pull request without merging: "not like this", never
    // "again". It ends the attempt whether or not the ledger still knows it.
    if (closedPr && !open) {
      if (existing?.state !== "blocked") {
        transition(
          out,
          iss.number,
          "blocked",
          {
            ...base,
            pr: closedPr.number,
            stage: existing?.stage ?? null,
            lastError: `pull request #${closedPr.number} closed without merge; re-apply ${cfg.queue.ready} for another attempt`,
            note: `pull request #${closedPr.number} closed by a human`,
          },
          now,
        );
      }
      continue;
    }
    // A finished entry whose working label survived a partial release stays finished;
    // it is not revived as claimed or resume-needed. Unless the claim on the issue is
    // newer than the entry: then a human re-released it and someone claimed it again,
    // and freezing that fresh attempt as finished would have the cleanup tear down a worktree
    // that had just been created.
    const claimIsNewer =
      owner !== undefined &&
      new Date(owner.createdAt).getTime() > new Date(existing?.updatedAt ?? 0).getTime();
    if (existing && TERMINAL.has(existing.state) && !claimIsNewer) {
      out.issues[key] = { ...existing, ...base, stage: existing.stage };
      continue;
    }
    if (existing && existing.stage && !TERMINAL.has(existing.state)) {
      if (existing.stage.instance === out.instance) {
        // A stage this instance dispatched is still the best knowledge there is.
        out.issues[key] = { ...existing, ...base, stage: existing.stage };
        continue;
      }
      // A stage of another instance (or of none, when no instance is live): its child
      // process belongs to an orchestrator that is gone. The worktree holds whatever it
      // reached; a review is the cheapest way to find out what.
      transition(
        out,
        iss.number,
        "resume-needed",
        {
          ...base,
          stage: null,
          note: `stage ${existing.stage.stage} belonged to instance ${existing.stage.instance}, which is gone`,
        },
        now,
      );
      continue;
    }
    if (existing && !TERMINAL.has(existing.state) && existing.state !== "claimed") {
      out.issues[key] = { ...existing, ...base };
      continue;
    }
    // A claim this machine already recorded stays `claimed`: the claim step creates the worktree
    // before it writes the entry, so deriving the state from the worktree alone turned
    // every fresh claim into `resume-needed` and sent a review into a worktree with no
    // commits. Only an entry rebuilt from nothing reads the
    // worktree as evidence of interrupted work.
    const state: IssueState = open
      ? "pr-open"
      : existing?.state === "claimed"
        ? "claimed"
        : wt
          ? "resume-needed"
          : "claimed";
    // An entry already in that state is refreshed in place, not transitioned again: a
    // repeated claimed -> claimed event on every tick filled the event log and made
    // the per-window claim count one issue several times.
    if (existing && existing.state === state) {
      out.issues[key] = { ...existing, ...base };
      continue;
    }
    transition(
      out,
      iss.number,
      state,
      { ...base, note: existing ? undefined : "rebuilt from GitHub" },
      now,
    );
  }

  for (const [key, entry] of Object.entries(out.issues)) {
    if (TERMINAL.has(entry.state)) {
      // Finished entries stay visible for a week, then go; the record is GitHub.
      if (now.getTime() - new Date(entry.updatedAt).getTime() > PRUNE_DAYS * 86_400_000)
        delete out.issues[key];
      continue;
    }
    if (seen.has(key)) continue;
    // A live stage means a stage process is still editing that worktree. Dropping the entry
    // would lose the task id, and the next tick would rebuild it from the worktree and
    // dispatch a second stage into the same directory. The label being gone is a fact
    // to report, not a reason to forget the running work.
    if (entry.stage && entry.stage.instance === out.instance) {
      out.issues[key] = {
        ...entry,
        lastError: `the ${cfg.labels.working} label is gone while stage ${entry.stage.stage} is still running; stop it before releasing`,
      };
      continue;
    }
    delete out.issues[key];
    out.events.push({
      at: now.toISOString(),
      issue: entry.issue,
      from: entry.state,
      to: "closed",
      note: "working label gone: released elsewhere, entry dropped",
    });
  }
  return out;
}

// --- status ---------------------------------------------------------------

function since(iso: string, now: Date): string {
  const min = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

/**
 * Whether the directory an entry names is still there.
 *
 * The entry keeps naming it after the cleanup removed it, and a path in a table reads as a
 * path that exists. The first answer to that was a `--worktree none` flag to blank the
 * field, which nothing ever called — and could not simply be called, because
 * `cleanupEntries` keeps an entry only while its label or its worktree is still there,
 * so blanking it after a half-failed removal would drop the entry out of cleanup for
 * good, and `reconcile` re-derives `branch` from the pull request's head ref with `||`,
 * which an empty string does not survive.
 *
 * The record was never wrong. Only the reading was, so the reading is what changed.
 */
function worktreeCell(e: LedgerEntry, onDisk: (p: string) => boolean): string {
  if (!e.worktree) return "-";
  return onDisk(e.worktree) ? "on disk" : "**gone**";
}

/**
 * One block per entry with a live stage: which stage is working on what, since when,
 * and the tail of what it reported. An entry without a stage gets nothing here — the
 * table above already says where it stands.
 *
 * `notes` is injected rather than read here, because `renderStatus` has no root: the
 * default is the empty reader, and `writeStatus` binds the real one.
 */
function runningBlocks(
  rows: LedgerEntry[],
  now: Date,
  notes: (issue: number) => string[],
): string[] {
  const out: string[] = [];
  for (const e of rows) {
    if (!e.stage) continue;
    out.push(
      `### #${e.issue} ${e.stage.stage} (${e.stage.mode}, ${since(e.stage.startedAt, now)})`,
      "",
      ...notes(e.issue),
      "",
    );
  }
  return out.length ? out : ["nothing running", ""];
}

export function renderStatus(
  ledger: Ledger,
  now: Date,
  onDisk: (p: string) => boolean = (p) => existsSync(p),
  recentNotes: (issue: number) => string[] = () => [],
): string {
  const rows = Object.values(ledger.issues).sort((a, b) => a.issue - b.issue);
  const lines = [
    `# autoclaude status — ${now.toISOString()} — machine ${ledger.machine}`,
    "",
    ledger.limitedUntil
      ? `**LIMITED**: limited until ${ledger.limitedUntil}`
      : "limits: none recorded",
    "",
    "| issue | state | PR | stage | attempts (impl/fix/retry) | worktree | since | note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (e) =>
        `| #${e.issue} | ${e.state} | ${e.pr ?? "-"} | ${e.stage ? `${e.stage.stage} (${e.stage.mode}, ${since(e.stage.startedAt, now)})` : "-"} | ${e.attempts?.implement ?? 0}/${e.attempts?.fix ?? 0}/${e.attempts?.reviewRetry ?? 0} | ${worktreeCell(e, onDisk)} | ${since(e.claimedAt, now)} | ${e.lastError ?? e.lastCanMerge ?? ""} |`,
    ),
    "",
    ledger.foreign.length
      ? [
          "## Claimed elsewhere",
          "",
          ...ledger.foreign.map(
            (f) => `- #${f.issue} by ${f.machine} at ${f.at ?? "?"}${f.stale ? " (stale)" : ""}`,
          ),
        ].join("\n")
      : "no foreign claims",
    "",
    "## Running",
    "",
    ...runningBlocks(rows, now, recentNotes),
    "## Last events",
    "",
    ...ledger.events
      .slice(-15)
      .map(
        (ev) =>
          `- ${ev.at} #${ev.issue} ${ev.from ?? "·"} → ${ev.to}${ev.note ? `: ${ev.note}` : ""}`,
      ),
    "",
  ];
  return lines.join("\n");
}

// --- the events log per issue ---------------------------------------------

/**
 * The layer below a transition (design, "A visible run").
 *
 * A transition says an issue is now `implementing`; it does not say which subagent is
 * working, on what, since when, or what it last reported — and a human following a run
 * saw "Waiting for 1 background agent" and nothing else. So every issue keeps an
 * append-only `runs/<issue>/events.log` that the stages and the engine write to, and
 * `status.md` shows its tail for every live stage.
 *
 * Deliberately not under the ledger lock: an append of one short line is atomic enough
 * for a log nothing reads back for a decision, and a milestone must never be able to
 * make a stage wait on the lock the orchestrator holds while it saves.
 */

/** The last lines of a live stage's log that `status.md` carries. */
const RUNNING_LINES = 8;

/** The text a note may carry, before it would drown the log a human reads. */
const NOTE_MAX = 300;

/** `runs/<issue>`: the issue's events log, reports and archives. */
export function runDir(root: string, issue: number): string {
  return join(root, STATE_DIR, "runs", String(issue));
}

/**
 * `runs/<issue>/events.log`: the one place the log's own path is spelled.
 *
 * It was written out five times — the append, the two warnings, and both readers — and a
 * path spelled five times is five things to edit the day the log moves.
 */
function eventsLog(root: string, issue: number): string {
  return join(runDir(root, issue), "events.log");
}

/**
 * One line, whatever arrived. A stage hands over whatever it has — a wrapped report
 * line, a tab-indented gate output — and a note that breaks into several lines breaks
 * the format every reader of the log relies on.
 *
 * Exported because a caller that builds the same text for something else — the rollback
 * puts its reason in a ledger event, a release comment and a printed command as well as
 * in the log — has to fold it the same way, or the log line and the event say different
 * things about the same run. Idempotent: folding folded text
 * changes nothing.
 */
export function foldNote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
}

/**
 * The line a state change writes: `state <from> -> <to>[: <note>]`.
 *
 * Exported for the one script that transitions the ledger without going through the CLI's
 * `set` verb: the rollback calls `transition` directly, and a scripted rollback whose log
 * lacked the line the printed by-hand command writes made the two routes disagree about
 * what had happened.
 */
export function transitionText(ev: {
  from: IssueState | null;
  to: IssueState;
  note: string | null;
}): string {
  return `state ${ev.from ?? "-"} -> ${ev.to}${ev.note ? `: ${ev.note}` : ""}`;
}

/**
 * Append one line to the issue's events log and return it exactly as written.
 *
 * `stage` is the stage the line belongs to, or null for `-`: an issue the ledger does
 * not know yet is the normal case at the start of a run, not an error.
 */
export function appendNote(
  root: string,
  issue: number,
  text: string,
  stage: Stage | null = null,
  now: Date = new Date(),
): string {
  // Checked before the directory is created: `String(NaN)` is a perfectly good
  // directory name, and `runs/NaN/events.log` is a log nobody would ever look for.
  // The same condition the CLI applies, so the two cannot disagree about a value; the
  // CLI checks first only to name the token a human typed.
  if (!Number.isInteger(issue) || issue <= 0)
    throw new Error(`note: "${issue}" is not an issue number`);
  const folded = foldNote(text);
  if (!folded) throw new Error("note <issue> <text>: the text must not be empty");
  const line = `${now.toISOString()} #${issue} ${stage ?? "-"} ${folded}`;
  mkdirSync(runDir(root, issue), { recursive: true });
  appendFileSync(eventsLog(root, issue), `${line}\n`);
  return line;
}

/**
 * `appendNote`, best-effort: a failed append warns and returns instead of throwing.
 *
 * For the two callers that write the log as a side effect of something else that has
 * already happened. In `set` the append runs inside the `updateLedger` callback — after
 * the orchestrator's `gh issue edit` and its dispatch, before `saveLedger` — and in
 * `appendTransitions` inside the tick's lock, before the save. An EACCES or a full disk
 * on `runs/<n>/events.log` would therefore fail that `set` or kill that tick over a line
 * nothing reads back for a decision, and the repeat is what loses data: `set ... --bump
 * fix` a second time double-counts the attempt. Same reasoning as `writeStatus`'s lost
 * rename, and the same shape.
 *
 * `appendNote` itself, and the `note` verb on top of it, deliberately keep throwing: the
 * append is their whole job, and a milestone that was not written must not be reported
 * as written.
 *
 * Exported for the rollback, whose scripted ledger step is a third caller of exactly
 * this shape: the release has been posted by then, and a log line must not undo it.
 */
export function appendNoteBestEffort(
  root: string,
  issue: number,
  text: string,
  stage: Stage | null,
  now: Date,
): void {
  try {
    appendNote(root, issue, text, stage, now);
  } catch (error) {
    process.emitWarning(
      `${eventsLog(root, issue)} could not be appended to (${String(error)}); the ledger keeps the transition`,
    );
  }
}

/**
 * The last `n` lines of an issue's events log, oldest first; none if it has none yet, and
 * a throw when the file is there and cannot be read.
 *
 * A count of none is none. `slice(-0)` is `slice(0)`, so asking for no lines used to
 * return the whole log — the one answer a caller asking for none can do nothing sensible
 * with, and the watcher worked around it by never passing 0.
 *
 * The reader both callers below share, and the one place the read itself happens: each of
 * them answers an unreadable log differently, and neither wants to repeat the parsing to
 * do so.
 */
function readNotes(root: string, issue: number, n: number): string[] {
  if (n <= 0) return [];
  const path = eventsLog(root, issue);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

/**
 * The last `n` lines of an issue's events log, oldest first; none if it has none yet.
 *
 * An unreadable log is none as well, with a warning, for the reason the append and the
 * `status.md` rename are best-effort: an EBUSY on an `events.log` must not take down a
 * caller that only wanted to show the tail. The watcher is that caller and wants
 * exactly this answer: a frame with no notes, not a dead watcher. `writeStatus` was the other one and now goes through `notesForStatus`, which has a
 * line to render instead and so keeps the reason as well as the transition.
 */
export function recentNotes(root: string, issue: number, n: number): string[] {
  try {
    return readNotes(root, issue, n);
  } catch (error) {
    process.emitWarning(
      `${eventsLog(root, issue)} could not be read (${String(error)}); the notes of issue ${issue} are left out`,
    );
    return [];
  }
}

/**
 * The tail `status.md` shows for one live stage, or a line saying why there is none.
 *
 * The append side of this log is best-effort for both of its callers; the read side was
 * not, and it sits one call deeper: `writeStatus` renders the Running section, which
 * reads back the log of every entry with a live stage. An unreadable log — an EACCES, a
 * directory in its place — therefore threw out of `writeStatus` **after** `saveLedger`
 * had renamed `ledger.json` into place, so a `set` that started a stage failed with its
 * transition already saved. The repeat is what loses data: `set ... --bump fix` a second
 * time double-counts the attempt.
 *
 * Folded to one line, because the section's format is one line per note, and warned about
 * once per render, because a log nobody can read is worth knowing about even though
 * nothing waits on it.
 *
 * Reads through `readNotes` rather than `recentNotes`, whose answer to the same failure is
 * silence plus a warning: that is right for the watcher, which has nowhere to put the
 * reason, and wrong here, where the Running section has a line for it.
 */
function notesForStatus(root: string, issue: number): string[] {
  try {
    return readNotes(root, issue, RUNNING_LINES);
  } catch (error) {
    const path = eventsLog(root, issue);
    process.emitWarning(`${path} could not be read (${String(error)}); status.md says so instead`);
    return [foldNote(`(the events log could not be read: ${String(error)})`)];
  }
}

/**
 * Every transition `after` holds and `before` did not, appended to the issues' logs.
 *
 * For the reconcile, which transitions entries on its own — a dead instance's stage, a
 * pull request a human closed, a working label that vanished. Those are the transitions
 * nobody typed, so they are the ones a human most needs to find in the log.
 *
 * The new events are found by identity, not by timestamp or by counting: `reconcile`
 * copies the array and keeps the element references, and `transition` splices the
 * oldest events off once there are more than `MAX_EVENTS`, which makes any index
 * arithmetic wrong exactly when a run has been long.
 */
export function appendTransitions(
  root: string,
  before: Ledger,
  after: Ledger,
  now: Date = new Date(),
): void {
  const known = new Set(before.events);
  for (const ev of after.events) {
    if (known.has(ev)) continue;
    const stage = after.issues[String(ev.issue)]?.stage?.stage ?? null;
    // Best-effort: this runs inside the tick's lock, before the save, and a log that
    // cannot be written must not take the tick with it.
    appendNoteBestEffort(root, ev.issue, transitionText(ev), stage, now);
  }
}

/** A rename that lost a race is retried this often, this far apart. */
const RENAME_RETRIES = 5;
const RENAME_DELAY_MS = 20;

/**
 * One rename, retried while the failure looks like a lost race, then thrown.
 *
 * Both files here are written as a sibling and renamed into place, and both have a reader
 * that is not under the ledger lock — an editor, the watcher, a virus scanner — which on
 * Windows makes the rename one of `RETRY_CODES`. The loop is shared so the two cannot
 * disagree about how long to try; what they do afterwards differs and stays with each
 * caller, because `ledger.json` is the record and `status.md` is derived from it
 *.
 *
 * What counts as a lost race is `RETRY_CODES`, and on Windows that includes EACCES: a
 * reader or a scanner holding the target open answers EPERM or EACCES depending on which
 * handle wins, so both are retried, six times, twenty milliseconds apart. A code outside
 * the set is thrown at once — ENOSPC or EROFS is a full or read-only disk, a broken machine
 * rather than a race, and retrying it only delays the report. The docstring named EACCES on
 * the wrong side of that line, which sent a reader looking for a bug the code does not have
 *.
 *
 * `rename` is injectable because a transient EPERM cannot be staged on a real file system —
 * every state that blocks a rename blocks it permanently — and `saveLedger` passes its own
 * through for the same reason.
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRY_CODES.has(code) || attempt >= RENAME_RETRIES) throw error;
      sleepSync(RENAME_DELAY_MS);
    }
  }
}

/**
 * The one place that writes `status.md`: a sibling named after this process, then a
 * rename, for the reason `saveLedger` does it — a crash mid-write leaves the last whole
 * file rather than half a new one, and two processes never share a temp name.
 *
 * The rename is retried and then given up on, never thrown. Both writers of this file
 * hold the ledger lock — `saveLedger` through `updateLedger`, the `note` verb around its
 * own load and render — so the two of them cannot overlap; what the lock does not cover
 * is a *reader* holding the file open, an editor or the watcher or a scanner, and on
 * Windows that is one of `RETRY_CODES` on the rename. Failing the caller for it would
 * report a failure for work that has already happened: `ledger.json` is renamed before
 * this runs, and a note's line is in the log before the status is rendered. The repeat is
 * what loses data — `set ... --bump fix` a second time double-counts the attempt, a
 * repeated milestone duplicates its line — while `status.md` is derived from the ledger
 * and the logs and is rewritten by the next transition.
 *
 * A failure to *render* or to write the temp file still throws: that is a bug in the
 * renderer or a full disk, not a lost race. The temp file goes either way, because every
 * `set` and every `note` is a one-shot process and its pid names the file: nothing would
 * ever overwrite or sweep up what a failed write left behind.
 */
export function writeStatus(root: string, ledger: Ledger, now: Date = new Date()): void {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "status.md");
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      tmp,
      renderStatus(ledger, now, undefined, (issue) => notesForStatus(root, issue)),
    );
  } catch (error) {
    dropTmp(tmp);
    throw error;
  }
  try {
    renameWithRetry(tmp, path);
  } catch (error) {
    // Nothing of the caller's work depends on this file, so all that is left is to not
    // leave the temp file behind and to say what happened. Swallowed whatever the code
    // was, unlike `saveLedger`'s: a `status.md` this process could not replace is one the
    // next transition rewrites.
    dropTmp(tmp);
    process.emitWarning(
      `${path} could not be replaced (${String(error)}); the next transition rewrites it`,
    );
  }
}

// --- reports --------------------------------------------------------------

/**
 * The path of a file inside an entry's worktree.
 *
 * An empty `worktree` is refused rather than joined. `join("", ".autoclaude/state/reports/plan.md")`
 * is relative, so `existsSync` would then test the **main working directory's** report and
 * `renameSync` would move it into the archive — and the main directory is the one place the
 * engine is never supposed to touch, while having exactly that file. `reconcile` writes an
 * empty worktree for an entry it derives from an open pull request with nothing on disk, so
 * this is reachable without anyone clearing a field.
 */
function inWorktree(entry: LedgerEntry, rel: string): string {
  if (!entry.worktree) {
    throw new Error(
      `issue ${entry.issue}: the ledger entry names no worktree, so "${rel}" has no absolute path`,
    );
  }
  return join(entry.worktree, rel);
}

/**
 * Move a stage's report out of the worktree into the run archive, numbered per stage.
 *
 * `stamp` adds attributes to the header line, and the caller owns their values.
 * The publish step is the one place that holds both the sha the review read and the sha it
 * pushed, so it passes them (`{ reviewed, head }`) and `can-merge` reads them back off
 * the archive. Nothing here calls `git rev-parse`: these functions run in directories
 * that are not repositories — every test below is one — and a sha out of the report block
 * is a model's claim rather than a fact (design).
 *
 * A caller with nothing to stamp passes nothing, and its archive carries no stamp: the
 * CLI's `archive` verb, and with it the orchestrator's fix-round archive, which is
 * correct, because that review never owned a push.
 *
 * `late` files the report **aside**, as `<stage>-late-<n>.md` on a counter of its own.
 * That is for the one report that must not be decided and must not stay where it is: a
 * review resumed after its stage was replaced and its round already decided. Left in the worktree it would be parsed as the next review's own report;
 * numbered into the series it would be read as a round — as the previous round's
 * fingerprints, and by `can-merge` as the review a push was stamped on. The name is
 * outside the `<stage>-<digits>` shape `archivedNumbered` matches, so neither happens, and
 * the header carries `late="true"` for the reader the file name is not enough for.
 */
export function archiveReport(
  root: string,
  entry: LedgerEntry,
  stage: Stage,
  stamp: Record<string, string> = {},
  // The worktree copy's removal, injectable for the reason `renameWithRetry`'s rename is:
  // a transient EPERM cannot be staged on a real file system — an open handle does not
  // block a delete here (measured), and every state that does blocks it permanently
  //.
  remove: (path: string) => void = (path) => rmSync(path, { force: true }),
  opts: { late?: boolean } = {},
): string | null {
  const src = inWorktree(entry, reportPath(stage));
  if (!existsSync(src)) return null;
  const prefix = opts.late ? `${stage}-late` : stage;
  const dir = join(root, STATE_DIR, "runs", String(entry.issue));
  mkdirSync(dir, { recursive: true });
  // Under the lock: `nextNumber` reads the directory and the move writes into it, and
  // neither `ledgerCli` nor publish holds it otherwise, so two processes archiving the
  // same issue's stage picked the same n and the same destination.
  return withLedgerLock(root, () => {
    const n = nextNumber(dir, prefix);
    const dst = join(dir, `${prefix}-${n}.md`);
    // The header still names the stage, not the prefix: what it says about the report is
    // that it is a code review, and `late` is where the file sits, not what it holds. It
    // carries `late="true"` all the same, for the reader the file name is not enough for:
    // the aside counter starts at 1 again, so a header saying `n="1"` sits beside the
    // first round's, and nothing else in it would tell the two apart.
    stampedMove(src, dst, entry, stage, n, opts.late ? { ...stamp, late: "true" } : stamp, remove);
    return dst;
  });
}

/**
 * Move a report into the archive with a header line, because the file name carries only
 * an order. One issue's directory holds every attempt's reports side by side, so
 * `plan-1.md` and `plan-2.md` may be two runs a week apart, and nothing in the file said
 * which.
 *
 * The stamp is composed first and the destination is created by one rename, so a file in
 * the archive never exists without its real header as the first line.
 *
 * Three shapes have been tried and each one taught something. Renaming and then rewriting
 * the file in place under a bare `catch {}` left a truncated report where a whole one had
 * been, and the publish step meets that file through `readLatestReport` a tick later, well
 * away from the cause. Moving first and stamping second, still swallowing the failure,
 * fixed the truncation and left the forgery: `ARCHIVE_HEADER` is anchored at the start of
 * the file, the model that writes the report chooses its first line, and a lost stamp left
 * that line to be read as a genuine one — `can-merge` skips an archive with no `head`, so
 * supplying that attribute is exactly what gets the archive selected.
 *
 * So the temp file carries the header and the body, and `renameSync(tmp, dst)` publishes
 * the two together. A failure before that rename leaves no archive at all and throws: the
 * report is still in the worktree, and a retry archives it. A stamp that could not be
 * written is not a cosmetic loss — it is the attribute two of `can-merge`'s checks read —
 * so it fails the archive step rather than passing silently.
 *
 * Removing the source after the rename re-opens the window the second shape closed: for
 * the duration of one syscall the report exists in the worktree and in the archive, and
 * `readLatestReport` prefers the worktree copy. It is one
 * syscall now rather than a whole file write, and the alternative order — remove, then
 * rename — loses the report outright on the same crash instead of duplicating it.
 *
 * That removal is the one part of the step that is **best-effort**, and the only one. It
 * sat outside every try, so an EPERM or EBUSY on the worktree copy — the class
 * `renameWithRetry` exists for — threw out of `archiveReport` after the archive was
 * already published, and in the publish step a throw there skips the `record(() => "pr-open")`
 * that follows: the branch pushed and the pull request open with no ledger row for either.
 * The work is done by then, so the failure is a `process.emitWarning` naming the file
 * somebody has to clear, not a lost transition. Everything before the rename still throws
 *.
 *
 * The temp name carries the pid for the same reason `saveLedger` does: two processes
 * never share one. `recursive` on its cleanup because a directory in the way is what the
 * write failed on, and `force` alone will not remove one.
 */
function stampedMove(
  src: string,
  dst: string,
  entry: LedgerEntry,
  what: string,
  n: number,
  stamp: Record<string, string> = {},
  remove: (path: string) => void = (path) => rmSync(path, { force: true }),
): void {
  const stamped = Object.entries(stamp)
    .map(([key, value]) => ` ${key}="${headerValue(value)}"`)
    .join("");
  const header = [
    `<!-- autodev-archive issue="${entry.issue}" stage="${what}" n="${n}" branch="${entry.branch}" state="${entry.state}" archivedAt="${new Date().toISOString()}"${stamped} -->`,
    "",
  ].join("\n");
  const tmp = `${dst}.${process.pid}.stamping`;
  try {
    writeFileSync(tmp, header + readFileSync(src, "utf8"));
    renameSync(tmp, dst);
  } catch (error) {
    dropTmp(tmp);
    throw error;
  }
  try {
    remove(src);
  } catch (error) {
    process.emitWarning(
      `${src} could not be removed (${String(error)}); the report is archived at ${dst} and this copy is a leftover`,
    );
  }
}

/**
 * A stamp value on the header line: one line, and a quote inside it does not end the
 * attribute.
 *
 * Only the quote is escaped, and only `\"` is an escape to `parseArchiveHeader` — the
 * attributes the header has always carried are written unescaped, and a general
 * backslash escape would make the parser mangle them instead. A value whose last
 * character is a backslash would therefore still run past its closing quote; the shas the
 * engine stamps cannot contain one, and values are opaque strings otherwise.
 */
function headerValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/"/g, '\\"');
}

/** The header line an archived report starts with, and the attributes in it. */
const ARCHIVE_HEADER = /^<!-- autodev-archive ([^\n]*?) -->/;
const ARCHIVE_ATTRIBUTE = /([A-Za-z][\w-]*)="((?:\\"|[^"])*)"/g;

/**
 * The header attributes of an archived report: what `stampedMove` wrote, plus whatever
 * the caller stamped.
 *
 * Anchored at the start of the text, where the header is by construction, so a report
 * that merely quotes a header in its prose is not read as one — and `stampedMove` creates
 * an archive only with its real header first, so a body line can never be in that
 * position. A file with no header there is an empty record rather than a throw all the
 * same: an archive from before the stamp existed, one a human wrote by hand, and a plan
 * file are all readable states this has to answer for (design). Not because the stamping is best-effort — it is not, and has not
 * been since the header moved into the temp file.
 * A caller asking about a stamp asks for the key it stamped, `header.head`, and
 * `undefined` means no stamp.
 */
export function parseArchiveHeader(text: string): Record<string, string> {
  const header = text.match(ARCHIVE_HEADER);
  if (!header) return {};
  const attributes: Record<string, string> = {};
  for (const [, key, value] of (header[1] ?? "").matchAll(ARCHIVE_ATTRIBUTE)) {
    if (key !== undefined && value !== undefined) attributes[key] = value.replace(/\\"/g, '"');
  }
  return attributes;
}

export interface ArchivedReport {
  path: string;
  text: string;
  /** The header's attributes, empty for a file the stamping never reached. */
  header: Record<string, string>;
}

/**
 * What the publish step stamped about the decision it acted on: the action, and the findings
 * that stood by tier.
 *
 * Counts and not the findings themselves, because that is all check 3 asks: a must at the
 * cap blocks, and everything else publishes with its list in the body.
 */
export interface StampedDecision {
  action: string;
  must: number;
  should: number;
  later: number;
  withdrawn: number;
}

/** What a published code review's archive header carries, read back. */
export interface ArchiveStamp {
  /** The sha the review was read at, or null when the archive names none. */
  reviewed: string | null;
  /** The sha the push sent, or null. */
  head: string | null;
  /** The decision, or null for an archive that names none or names one unreadably. */
  decision: StampedDecision | null;
  /** Why `decision` is null although the header names an action; null otherwise. */
  problem: string | null;
}

/** The four counts of a decision stamp, in the order a reader wants them. */
const STAMPED_COUNTS = ["must", "should", "later", "withdrawn"] as const;

/**
 * The seven header attributes of a published review's stamp.
 *
 * Written here and read by `parseDecisionStamp` below, because the publish step spelled the
 * seven keys as independent literals and the merge check read them back as seven more: two
 * lists that could drift apart with nothing to say they had, in a file that already owns
 * `archiveReport` and `parseArchiveHeader`.
 */
export function decisionStamp(
  reviewed: string,
  head: string,
  decision: StampedDecision,
): Record<string, string> {
  return {
    reviewed,
    head,
    decision: decision.action,
    ...Object.fromEntries(STAMPED_COUNTS.map((key) => [key, String(decision[key])])),
  };
}

/**
 * The stamp an archived report's header carries.
 *
 * An empty attribute is no sha rather than an empty one: check 6 would otherwise report
 * "archive head " and call it a push after the review. An archive with no `decision` is
 * one written before the stamp existed, and that is not a problem — check 3 re-classifies
 * the report as it used to.
 *
 * A `decision` whose counts cannot all be read **is** a problem, and it is named. The
 * reader turned a missing or malformed count into 0, which reads exactly like "nothing is
 * open": with `decision` present and `must` absent, check 3 reported "0 must open" while
 * the re-parsed text held one, against the rule that an absent signal is a refusal. Only
 * version skew or a hand-edited archive produces it — which is the day the check exists
 * for.
 */
export function parseDecisionStamp(header: Record<string, string>): ArchiveStamp {
  const shas = { reviewed: header.reviewed || null, head: header.head || null };
  const action = (header.decision ?? "").trim();
  if (!action) return { ...shas, decision: null, problem: null };
  const counts: Record<string, number> = {};
  const unreadable: string[] = [];
  for (const key of STAMPED_COUNTS) {
    const written = (header[key] ?? "").trim();
    // Whole or not at all: `parseInt` reads "1 finding" as 1 and "0.5" as 0, and a count
    // guessed out of a value nobody can read is the guess this refusal exists to refuse.
    if (/^\d+$/.test(written)) counts[key] = Number(written);
    else unreadable.push(`${key}="${written}"`);
  }
  if (unreadable.length) {
    return {
      ...shas,
      decision: null,
      problem:
        `the stamp says the review decided ${action}, but its ` +
        `${unreadable.join(", ")} ${unreadable.length === 1 ? "is" : "are"} not a count`,
    };
  }
  return {
    ...shas,
    decision: { action, ...(counts as unknown as Omit<StampedDecision, "action">) },
    problem: null,
  };
}

/**
 * Every archived report of one stage, **newest first**, read from `runs/<issue>/` and
 * nowhere else.
 *
 * Deliberately not `readLatestReport`, which prefers the live copy in the entry's
 * worktree: `can-merge` runs against a pull request, whose entry `reconcile` may have
 * rebuilt with no worktree on disk at all, and the copy it has to read is the archived
 * one — that is the copy the header, and therefore the stamp, belongs to.
 *
 * The list rather than only the newest, because two readers need the one before it. The
 * decision script's `--report <archive>` has to skip the very file it is deciding about,
 * or the report is its own previous round and every finding in it is a repeat of itself;
 * and `can-merge` wants the newest archive that carries a push stamp, an unstamped
 * fix-round archive on top of it being a review of a tree the pull request never showed.
 */
export function archivedReportsOf(root: string, issue: number, stage: Stage): ArchivedReport[] {
  const dir = runDir(root, issue);
  return archivedNumbered(dir, stage)
    .reverse()
    .map(({ f }) => {
      const path = join(dir, f);
      const text = readFileSync(path, "utf8");
      return { path, text, header: parseArchiveHeader(text) };
    });
}

/**
 * The archived files of one prefix, numbered, oldest first. Anchored on both sides: a
 * bare prefix test let `plan-` match `plan-file-1.md` and `plan-review-1.md`, so the
 * numbering skipped and the newest "plan report" could be the plan document.
 */
function archivedNumbered(dir: string, prefix: string): Array<{ f: string; n: number }> {
  const re = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)\\.md$`);
  const numbered = existsSync(dir)
    ? readdirSync(dir)
        .map((f) => ({ f, n: Number(f.match(re)?.[1]) }))
        .filter((x) => Number.isInteger(x.n))
    : [];
  return numbered.sort((a, b) => a.n - b.n);
}

function archivedReports(dir: string, stage: Stage): string[] {
  return archivedNumbered(dir, stage).map((x) => x.f);
}

/** One past the highest number present, never count plus one: a gap must not overwrite the newest file. */
function nextNumber(dir: string, prefix: string): number {
  const numbered = archivedNumbered(dir, prefix);
  return (numbered.at(-1)?.n ?? 0) + 1;
}

/** The planner's file, moved out of the worktree so the reviewer cannot read it. */
export function archivePlanFile(root: string, entry: LedgerEntry): string | null {
  const src = inWorktree(entry, join(".autoclaude", "state", "plans", `${entry.issue}.md`));
  if (!existsSync(src)) return null;
  const dir = join(root, STATE_DIR, "runs", String(entry.issue));
  mkdirSync(dir, { recursive: true });
  return withLedgerLock(root, () => {
    const n = nextNumber(dir, "plan-file");
    const dst = join(dir, `plan-file-${n}.md`);
    stampedMove(src, dst, entry, "plan-file", n);
    return dst;
  });
}

/** The report still in the worktree if there is one, else the newest archived copy. */
export function readLatestReport(root: string, entry: LedgerEntry, stage: Stage): string {
  const live = inWorktree(entry, reportPath(stage));
  if (existsSync(live)) return readFileSync(live, "utf8");
  const dir = join(root, STATE_DIR, "runs", String(entry.issue));
  const archived = archivedReports(dir, stage);
  const newest = archived[archived.length - 1];
  if (!newest) throw new Error(`no ${stage} report for issue ${entry.issue}, live or archived`);
  return readFileSync(join(dir, newest), "utf8");
}

// --- CLI ------------------------------------------------------------------

// `flag` and `issueArg` live in cli/args.ts, a module that imports nothing, and are
// re-exported here because this is where callers of the ledger already look.
export { flag, issueArg } from "../../cli/args.js";

export const ISSUE_STATES: readonly IssueState[] = [
  "claimed",
  "planning",
  "plan-reviewing",
  "fixing-plan",
  "implementing",
  "code-reviewing",
  "fixing-local",
  "pr-open",
  "fixing-ci",
  "mergeable",
  "merged",
  "done",
  "closed",
  "blocked",
  "needs-shaping",
  "resume-needed",
];
const STAGES: readonly Stage[] = ["plan", "plan-review", "implement", "code-review"];
const MODES: readonly StageRun["mode"][] = ["fresh", "fix", "resume"];

/**
 * `limit` takes `+MINUTES`, a clock time the message named (`15:00`, the next one in the
 * future in `timeZone`), an ISO instant, or `clear`. Anything else throws with the forms
 * it accepts, instead of `new Date(v).toISOString()` throwing RangeError: the orchestrator
 * passes "the reset time if it names one", which is free-form text, and `+60m`, `3pm` and
 * `resets at 15:00` must not leave `limitedUntil` null, so that the next tick walks back
 * into the rate limit.
 *
 * A clock time is a wall-clock time of the configured zone, not of the machine. Across a
 * daylight-saving change a time the zone skips resolves to the later valid instant and a
 * time it shows twice to the earlier (`instantInZone`).
 */
export function parseLimit(value: string, now: Date, timeZone: string): string | null {
  if (value === "clear") return null;
  if (/^\+\d+$/.test(value))
    return new Date(now.getTime() + Number(value.slice(1)) * 60_000).toISOString();
  const clock = value.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [h, m] = [Number(clock[1]), Number(clock[2])];
    if (h > 23 || m > 59) throw new Error(`limit: "${value}" is not a time of day`);
    const today = wallClockIn(now, timeZone);
    let at = instantInZone(today.year, today.month, today.day, h, m, timeZone);
    if (at <= now) at = instantInZone(today.year, today.month, today.day + 1, h, m, timeZone);
    return at.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`limit: cannot read "${value}"; use +MINUTES, HH:MM, an ISO instant, or clear`);
  }
  // A backoff in the past is not a backoff. `new Date("1500")` is the year 1500, and it
  // would be stored, printed as a limit that had been set, and ignored by the gate.
  if (parsed.getTime() <= now.getTime()) {
    throw new Error(
      `limit: "${value}" reads as ${parsed.toISOString()}, which is in the past; use +MINUTES, HH:MM, a future ISO instant, or clear`,
    );
  }
  return parsed.toISOString();
}

/** A process id on the command line: decimal digits only, and its own number. */
function processArg(token: string): number {
  const n = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== token) {
    throw new Error(`--pid: "${token}" is not a process id`);
  }
  return n;
}

/** A CLI enum is validated, never cast: a typo by the model that composes the line must fail loudly. */
function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  what: string,
): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} must be one of ${allowed.join(", ")}, got "${value ?? ""}"`);
  }
  return value as T;
}

/**
 * The CLI as a function, so a test can drive it against a temporary root. Returns what it
 * printed.
 *
 * `cfg` is read from the project root's `.autoclaude/config.json` when it is not given,
 * and only where it is needed (`set --branch`, and `limit HH:MM` for the zone): a
 * temporary root has no config, and every other verb has to keep working there.
 */
export function ledgerCli(
  argv: string[],
  root: string,
  now: Date = new Date(),
  cfg?: ProjectConfig,
): unknown {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "show":
      return loadLedger(root);
    case "set": {
      const issue = issueArg(rest[0], "set <issue> <state>");
      const state = oneOf(rest[1], ISSUE_STATES, "state");
      const patch: Parameters<typeof transition>[3] = {};
      const pr = flag(rest, "--pr");
      // `--pr none` clears the number; a re-released issue must not inherit a closed one.
      // Validated like every other typed value: `--pr --note` would otherwise record NaN.
      if (pr === "none") patch.pr = null;
      else if (pr !== undefined) {
        // The shared rule, not a third spelling of it: `Number` took `0x10` as 16, so
        // `set 5 pr-open --pr 0x10` recorded pull request 16 and every later command —
        // `entryForPr`, `can-merge`, the review's own post — looked for the number that
        // was typed.
        patch.pr = prArg(pr, "--pr <number>|none on `ledger set`");
      }
      for (const k of ["title", "worktree"] as const) {
        const v = flag(rest, `--${k}`);
        if (v) patch[k] = v;
      }
      // `--branch` is the one field of this row that something later deletes on the
      // remote: a rollback pushes `--delete` on it when no worktree is registered, and
      // that push is a child process of the engine, so a Bash-level guard never sees it.
      // Stored unvalidated, `set 9 claimed --branch develop` would be enough, and
      // `reconcile` keeps `existing?.branch` forever. The config is read here rather than
      // passed in from every caller, and only for this flag, so a root without one still
      // runs every other verb.
      const branch = flag(rest, "--branch");
      if (branch) {
        const outside = notIssueBranch(branch, issue, cfg ?? loadProjectConfig(root));
        if (outside !== null) {
          throw new Error(
            `--branch ${branch}: ${outside}. a rollback deletes the branch this row names on the remote, so the row may only name a branch of issue ${issue}`,
          );
        }
        patch.branch = branch;
      }
      const stage = flag(rest, "--stage");
      const bump = flag(rest, "--bump");
      if (bump && !["fix", "retry", "implement", "plan"].includes(bump))
        throw new Error(`--bump ${bump}: expected fix, retry, implement or plan`);
      const err = flag(rest, "--error");
      if (err !== undefined) patch.lastError = err;
      const cm = flag(rest, "--can-merge");
      if (cm !== undefined) patch.lastCanMerge = cm;
      const note = flag(rest, "--note");
      if (note) patch.note = note;
      return updateLedger(
        root,
        (ledger) => {
          const before = ledger.issues[String(issue)];
          if (stage === "none") {
            // Ends a stage without a state change: the limit pause and the retry keep the
            // state and must drop the dead process record and its clock.
            patch.stage = null;
          } else if (stage !== undefined) {
            const mode = flag(rest, "--mode");
            const name = oneOf(stage, STAGES, "--stage");
            const modeValue = mode === undefined ? "fresh" : oneOf(mode, MODES, "--mode");
            const instance = flag(rest, "--instance") ?? ledger.instance;
            // Validated like every other stage field: a stage recorded without its owner
            // is never examined, never stopped and never resumed, and it holds a
            // concurrency slot until a human edits the file. The instance defaults to the
            // live one in instance.json; without either there is nothing to record.
            if (!instance) {
              throw new Error(
                `--stage ${stage} needs --instance <id> (no live instance is recorded in ${join(STATE_DIR, "instance.json")})`,
              );
            }
            const pid = flag(rest, "--pid");
            patch.stage = {
              stage: name,
              mode: modeValue,
              pid: pid === undefined ? null : processArg(pid),
              instance,
              startedAt: now.toISOString(),
              processStartedAt: flag(rest, "--process-started-at") ?? null,
            };
          }
          if (bump) {
            const a = {
              ...(before?.attempts ?? { implement: 0, fix: 0, reviewRetry: 0, plan: 0 }),
            };
            if (bump === "fix") a.fix += 1;
            else if (bump === "retry") a.reviewRetry += 1;
            else if (bump === "implement") a.implement += 1;
            else a.plan += 1;
            patch.attempts = a;
          }
          const entry = transition(ledger, issue, state, patch, now);
          // The transition goes into the events log through the same writer a note uses,
          // so the log is complete even when a stage forgets its notes. Written here,
          // before `saveLedger` renders `status.md`, so the "Running" section it writes
          // already carries this line rather than lagging one command behind — and
          // best-effort, because by this point the caller's labels are edited and its
          // stage is dispatched, and this line is the only thing left that could fail.
          appendNoteBestEffort(
            root,
            issue,
            transitionText({ from: before?.state ?? null, to: state, note: patch.note ?? null }),
            entry.stage?.stage ?? null,
            now,
          );
          return entry;
        },
        now,
      );
    }
    case "note": {
      const issue = issueArg(rest[0], "note <issue> <text>");
      // Every remaining word, not only the first: the text is quoted by convention, and
      // an unquoted milestone line would otherwise be recorded as one word of itself.
      const text = rest.slice(1).join(" ");
      // The append stays outside the lock, the way the events log is designed: one short
      // line, written whatever else is going on, so the milestone itself never waits. What
      // does take the lock is the `status.md` render below, for the milliseconds a render
      // costs — and a note that cannot get it reports the line anyway.
      // The stage is the one the ledger knows, or `-`. An issue it does not know yet is
      // the normal case at the start of a run, so it is not an error.
      const noted = appendNote(
        root,
        issue,
        text,
        loadLedger(root).issues[String(issue)]?.stage?.stage ?? null,
        now,
      );
      // The log line is half the point; `status.md` is what a human actually reads. Its
      // load, render and rename go under the ledger lock, held for the milliseconds of a
      // render: unlocked, a note that had read the ledger before a concurrent transition
      // renamed its stale render over the transition's own, and writeStatus's retry loop
      // guards the rename, never the staleness of what it renames. Re-read inside the lock, so what is rendered is what is on disk.
      //
      // Best-effort around the whole of it, not only inside `writeStatus`: by this point
      // the line is in the log and `noted` is what the caller reports, so a lock that
      // cannot be taken or a temp file that cannot be written must not make a stage
      // repeat a milestone it already wrote. `set` keeps throwing for the same failure,
      // because there the status write sits inside the transition's own lock.
      try {
        withLedgerLock(root, () => writeStatus(root, loadLedger(root), now));
      } catch (error) {
        process.emitWarning(
          `${join(root, STATE_DIR, "status.md")} was not rewritten (${String(error)}); the next transition rewrites it`,
        );
      }
      return { noted };
    }
    case "limit": {
      const v = rest[0];
      if (!v) throw new Error("limit <ISO | +MINUTES | HH:MM | clear>");
      const until = parseLimit(
        v,
        now,
        /^\d{1,2}:\d{2}$/.test(v) ? (cfg ?? loadProjectConfig(root)).schedule.timezone : "UTC",
      );
      return updateLedger(
        root,
        (ledger) => {
          ledger.limitedUntil = until;
          return { limitedUntil: ledger.limitedUntil };
        },
        now,
      );
    }
    case "archive": {
      const ledger = loadLedger(root);
      const entry = ledger.issues[rest[0] ?? ""];
      if (!entry) throw new Error(`no ledger entry for issue ${rest[0]}`);
      // Only `--late`, and an unknown option is refused rather than ignored: a typo that
      // silently archived into the numbered series is the mistake this verb cannot make.
      const unknown = rest.slice(2).find((a) => a !== "--late");
      if (unknown !== undefined) throw new Error(`archive: unknown option ${unknown}`);
      const late = rest.includes("--late");
      if (late && rest[1] === "plan-file") {
        throw new Error("archive: --late is for a stage report; the plan file has no rounds");
      }
      const archived =
        rest[1] === "plan-file"
          ? archivePlanFile(root, entry)
          : archiveReport(root, entry, oneOf(rest[1], STAGES, "stage"), {}, undefined, { late });
      // null means nothing was there to move; the caller decides whether that is news.
      return { archived, note: archived ? undefined : "nothing to archive" };
    }
    default:
      throw new Error(
        "Usage: ledger show | set <issue> <state> [...] | note <issue> <text> | limit <...> | archive <issue> <stage|plan-file> [--late]",
      );
  }
}
