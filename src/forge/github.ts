/**
 * gh and git, wrapped so every engine module builds the same command lines and every
 * test can hand in a fake runner. Nothing here is clever: the point is one place that
 * knows the --json field lists, and a failure that names the command.
 */

import { realExec, type Exec } from "./exec.js";

export { realExec } from "./exec.js";
export type { Exec, ExecResult } from "./exec.js";

/** Listings ask for this many; a result that fills it may have been cut off. */
const LIST_LIMIT = 1000;

function run(
  cmd: string,
  args: string[],
  exec: Exec,
  opts?: { cwd?: string; input?: string },
): string {
  const r = exec(cmd, args, opts);
  // A call killed at its limit is a failure like any other; the message names the limit.
  if (r.timedOut) throw new Error(`${cmd} ${args.join(" ")} ${r.stderr.trim()}`);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export function ghText(args: string[], exec: Exec = realExec, input?: string): string {
  return run("gh", args, exec, { input });
}

export function gh<T>(args: string[], exec: Exec = realExec): T {
  return JSON.parse(ghText(args, exec)) as T;
}

export function git(args: string[], exec: Exec = realExec, cwd?: string): string {
  return run("git", ["-c", "core.quotePath=false", ...args], exec, { cwd });
}

/** `owner/name` from an https, scp-style ssh or ssh:// remote URL. */
export function parseRepo(url: string): string {
  const m = url
    .trim()
    .match(
      /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\/|[^/@\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    );
  if (!m) throw new Error(`cannot read owner/name from remote URL "${url.trim()}"`);
  return `${m[1]}/${m[2]}`;
}

/** Resolve `owner/name` from the URL of the named git remote. */
export function resolveRepo(remote: string, cwd: string, exec: Exec = realExec): string {
  const url = git(["remote", "get-url", remote], exec, cwd).trim();
  try {
    return parseRepo(url);
  } catch {
    throw new Error(`remote "${remote}" has a URL that is not a GitHub repository: "${url}"`);
  }
}

export interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

/** What `issue list` returns: no body, and comments only when asked for. */
export interface IssueSummary {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  comments: IssueComment[];
  updatedAt: string;
}

/** What `issue view` returns: the summary plus the body. */
export interface IssueView extends IssueSummary {
  body: string;
}

const ISSUE_FIELDS = "number,title,state,labels,assignees,updatedAt";

/**
 * statusCheckRollup mixes two node types (design, verify-item 3): a CheckRun carries
 * name/status/conclusion, a legacy StatusContext carries context/state. can-merge.ts
 * normalises both and treats anything else as not passing.
 */
export interface RollupNode {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  context?: string | null;
  state?: string | null;
  workflowName?: string | null;
}

export interface PrView {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeStateStatus: string;
  statusCheckRollup: RollupNode[];
  labels: Array<{ name: string }>;
  url: string;
  updatedAt: string;
  isDraft: boolean;
}

const PR_FIELDS =
  "number,state,mergedAt,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup,labels,url,updatedAt,isDraft";

export interface PrSummary {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  updatedAt: string;
  /**
   * When the pull request ended, null while it is open. `updatedAt` moves on every
   * comment, so a human commenting on an earlier attempt's closed pull request made it
   * look like this attempt's; these two do not move. Optional
   * in the type only so a fixture may leave them out; `gh` always returns both, and a
   * reader that finds them missing falls back to `updatedAt`.
   */
  closedAt?: string | null;
  mergedAt?: string | null;
  url: string;
}

/** One workflow run as `gh run list` reports it. */
export interface RunSummary {
  databaseId: number;
  conclusion: string | null;
  status: string;
  url: string;
  headSha: string;
  workflowName: string;
}

export interface PrThread {
  number: number;
  title: string;
  files: Array<{ path: string }>;
  comments: Array<{ author: { login: string } | null; body: string }>;
  reviews: Array<{ author: { login: string } | null; body: string }>;
}

function complete<T>(items: T[], what: string): T[] {
  if (items.length >= LIST_LIMIT) {
    throw new Error(
      `${what}: the listing returned ${items.length} items, which may mean more than ${LIST_LIMIT} exist; refusing to work from a truncated list`,
    );
  }
  return items;
}

/** Every call carries `-R <owner>/<name>`, so no call depends on the working directory's remote. */
export class Forge {
  constructor(
    readonly repo: string,
    private readonly exec: Exec = realExec,
  ) {}

  private text(args: string[], input?: string): string {
    return ghText(["-R", this.repo, ...args], this.exec, input);
  }

  private json<T>(args: string[]): T {
    return gh<T>(["-R", this.repo, ...args], this.exec);
  }

  viewIssue(n: number): IssueView {
    return this.json<IssueView>([
      "issue",
      "view",
      String(n),
      "--json",
      `${ISSUE_FIELDS},comments,body`,
    ]);
  }

  /**
   * @param opts.comments fetch the comments too; only the claim protocol reads them, and
   *   on a busy repository they roughly double the payload of a list.
   */
  listIssues(
    label: string,
    state: "open" | "all",
    opts: { comments?: boolean } = {},
  ): IssueSummary[] {
    const fields = opts.comments === false ? ISSUE_FIELDS : `${ISSUE_FIELDS},comments`;
    const issues = complete(
      this.json<Array<Omit<IssueSummary, "comments"> & { comments?: IssueComment[] }>>([
        "issue",
        "list",
        "--label",
        label,
        "--state",
        state,
        "--limit",
        String(LIST_LIMIT),
        "--json",
        fields,
      ]),
      "gh issue list",
    );
    return issues.map((i) => ({ ...i, comments: i.comments ?? [] }));
  }

  /**
   * Add and remove in one `gh issue edit`, so a release cannot lose one label without
   * gaining the other. The separate add and remove wrappers were the non-atomic pair this
   * replaced, and are gone.
   */
  editLabels(n: number, change: { add?: string[]; remove?: string[] }): void {
    const args = ["issue", "edit", String(n)];
    if (change.add?.length) args.push("--add-label", change.add.join(","));
    if (change.remove?.length) args.push("--remove-label", change.remove.join(","));
    if (args.length > 3) this.text(args);
  }

  /**
   * Labels on a pull request. Its own call because `gh issue edit` refuses a pull request
   * number, and because the browser review's gate reads the labels of the *pull request*,
   * not of the issue the orchestrator otherwise labels.
   */
  editPrLabels(n: number, change: { add?: string[]; remove?: string[] }): void {
    const args = ["pr", "edit", String(n)];
    if (change.add?.length) args.push("--add-label", change.add.join(","));
    if (change.remove?.length) args.push("--remove-label", change.remove.join(","));
    if (args.length > 3) this.text(args);
  }

  /** The body goes through stdin, so markers, quotes and newlines never meet a shell. */
  commentIssue(n: number, body: string): void {
    this.text(["issue", "comment", String(n), "--body-file", "-"], body);
  }

  /** A comment on a pull request's conversation, through stdin like every other body here. */
  commentPr(n: number, body: string): void {
    this.text(["pr", "comment", String(n), "--body-file", "-"], body);
  }

  /**
   * The newest workflow runs of a branch, newest first. A bounded read on purpose: the gate
   * step wants the run behind a red check, which is among the last few, not a complete list.
   */
  listRuns(branch: string, limit = 20): RunSummary[] {
    return this.json<RunSummary[]>([
      "run",
      "list",
      "--branch",
      branch,
      "--limit",
      String(limit),
      "--json",
      "databaseId,conclusion,status,url,headSha,workflowName",
    ]);
  }

  /** The log of a run's failed steps only. */
  runFailedLog(id: number): string {
    return this.text(["run", "view", String(id), "--log-failed"]);
  }

  /**
   * Replace a pull request's body, through stdin like every other body this file writes.
   *
   * `publish.ts` calls it on every push after the first, because the body written at
   * creation used to stay put through every fix round: a human read the first review's
   * sections against the third push's diff. The cost is stated in the design and accepted —
   * a human's edit to an agent's pull request body is lost on the next push.
   */
  editPrBody(n: number, body: string): void {
    this.text(["pr", "edit", String(n), "--body-file", "-"], body);
  }

  /** Every label of the repository, by name. */
  listLabels(): string[] {
    return complete(
      this.json<Array<{ name: string }>>([
        "label",
        "list",
        "--limit",
        String(LIST_LIMIT),
        "--json",
        "name",
      ]),
      "gh label list",
    ).map((l) => l.name);
  }

  /** Create a label; `--force` makes one that appeared in the meantime an update, not an error. */
  createLabel(name: string, opts: { color?: string; description?: string } = {}): void {
    const args = ["label", "create", name, "--force"];
    if (opts.color) args.push("--color", opts.color);
    if (opts.description) args.push("--description", opts.description);
    this.text(args);
  }

  viewPr(n: number): PrView {
    return this.json<PrView>(["pr", "view", String(n), "--json", PR_FIELDS]);
  }

  /**
   * A pull request's title, changed files and discussion (conversation comments and review
   * bodies; inline review comments need the REST API and are not included).
   */
  viewPrThread(n: number): PrThread {
    return this.json<PrThread>([
      "pr",
      "view",
      String(n),
      "--json",
      "number,title,files,comments,reviews",
    ]);
  }

  listPrs(state: "open" | "all"): PrSummary[] {
    return complete(
      this.json<PrSummary[]>([
        "pr",
        "list",
        "--state",
        state,
        "--limit",
        String(LIST_LIMIT),
        "--json",
        "number,state,headRefName,updatedAt,closedAt,mergedAt,url",
      ]),
      "gh pr list",
    );
  }

  createPr(opts: { base: string; head: string; title: string; body: string }): {
    number: number;
    url: string;
  } {
    const url = this.text(
      [
        "pr",
        "create",
        "--base",
        opts.base,
        "--head",
        opts.head,
        "--title",
        opts.title,
        "--body-file",
        "-",
      ],
      opts.body,
    ).trim();
    const m = url.match(/\/pull\/(\d+)\s*$/);
    if (!m) throw new Error(`gh pr create printed no pull request URL: "${url}"`);
    return { number: Number(m[1]), url };
  }
}
