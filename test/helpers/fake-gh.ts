/**
 * A fake forge: an `Exec` that serves the `gh` subset the engine uses from an in-memory
 * repository (issues, labels, comments, pull requests, check rollups), so a test can drive
 * the real engine end to end with no network and no `gh` binary.
 *
 * Faithful where the engine depends on it:
 * - every call must carry `-R <owner>/<repo>` first; a call that does not is recorded in
 *   `violations` and fails;
 * - `--json` answers carry exactly the requested fields, so a field the engine reads and did
 *   not ask for is `undefined` here as it would be there;
 * - an issue or pull request label must exist in the repository (`gh issue edit` fails on an
 *   unknown one);
 * - `pr create` fails unless the head branch is on the bare remote, as GitHub's does.
 *
 * Anything else `gh` is asked is recorded in `unexpected` and fails, so a scenario cannot
 * quietly depend on a command the fake never learned.
 *
 * Not a `*.test.ts` name, so vitest does not collect it: it holds no cases.
 */
import { spawnSync } from "node:child_process";
import type { Exec, ExecResult } from "../../src/forge/exec.js";
import { childEnv } from "./child-env.js";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
  updatedAt: string;
}

export interface FakePr {
  number: number;
  title: string;
  body: string;
  base: string;
  head: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  statusCheckRollup: Array<Record<string, unknown>>;
  comments: Array<{ author: { login: string }; body: string }>;
}

export interface FakeGhOptions {
  /** `owner/name`: the value every call must pass after `-R`. */
  repo: string;
  /** Labels that exist in the repository. */
  labels: string[];
  /** The bare remote the pull requests' head branches must exist on. */
  remote: string;
  now: () => Date;
}

export interface FakeGh {
  exec: Exec;
  issues: Map<number, FakeIssue>;
  prs: FakePr[];
  /** Every gh call, `-R` included. */
  calls: string[][];
  /** Calls that did not start with `-R <repo>`. */
  violations: string[];
  /** Calls the fake does not serve. */
  unexpected: string[];
  addIssue(over: Partial<FakeIssue> & Pick<FakeIssue, "number" | "title" | "body">): FakeIssue;
}

const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ status: 1, stdout: "", stderr });

/** The value following `name` in `args`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

/** The fields `gh issue view|list --json` accepts (gh's documentation). */
const ISSUE_FIELDS = new Set(
  "assignees author body closed closedAt comments createdAt id isPinned labels milestone number projectCards projectItems reactionGroups state stateReason title updatedAt url".split(
    " ",
  ),
);

/** The fields `gh pr view|list --json` accepts (gh's documentation). */
const PR_FIELDS = new Set(
  "additions assignees author autoMergeRequest baseRefName body changedFiles closed closedAt closingIssuesReferences comments commits createdAt deletions files fullDatabaseId headRefName headRefOid headRepository headRepositoryOwner id isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit mergeStateStatus mergeable mergedAt mergedBy milestone number potentialMergeCommit projectCards projectItems reactionGroups reviewDecision reviewRequests reviews state statusCheckRollup title updatedAt url".split(
    " ",
  ),
);

/** A request the fake refuses the way gh does; `serve` turns it into a failed call. */
class Refused extends Error {}

/**
 * Keep only the fields `--json a,b,c` asked for. A field gh does not know fails as gh does
 * ("Unknown JSON field"); a field gh knows and this state cannot answer fails too, so a
 * request can never be answered with a silent `undefined`.
 */
function validFields(args: string[], known: Set<string>): void {
  for (const f of flag(args, "--json")?.split(",") ?? [])
    if (!known.has(f)) throw new Refused(`Unknown JSON field: "${f}"`);
}

function pick(value: object, args: string[], known: Set<string>): Record<string, unknown> {
  validFields(args, known);
  const fields = flag(args, "--json")?.split(",") ?? [];
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!known.has(f)) throw new Refused(`Unknown JSON field: "${f}"`);
    if (!(f in value)) throw new Refused(`the fake forge cannot answer the JSON field "${f}"`);
    out[f] = (value as Record<string, unknown>)[f];
  }
  return out;
}

/** Fail on a flag the verb's handler does not interpret (positional arguments are skipped). */
function allow(rest: string[], flags: string[]): void {
  for (const a of rest)
    if (a.startsWith("--") && !flags.includes(a))
      throw new Refused(`the fake forge does not interpret the flag ${a}`);
}

/** `--limit n` applied to a listing; gh's default is 30. */
const limited = <T>(items: T[], rest: string[]): T[] =>
  items.slice(0, Number(flag(rest, "--limit") ?? 30));

/** The tip of a branch of the bare remote, or null when it is not there. */
function remoteHead(remote: string, branch: string): string | null {
  const r = spawnSync(
    "git",
    ["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${branch}`],
    {
      encoding: "utf8",
      env: childEnv(),
    },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

export function fakeGh(opts: FakeGhOptions): FakeGh {
  const issues = new Map<number, FakeIssue>();
  const prs: FakePr[] = [];
  const calls: string[][] = [];
  const violations: string[] = [];
  const unexpected: string[] = [];
  const iso = () => opts.now().toISOString();

  const issueOut = (i: FakeIssue) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    assignees: i.assignees.map((login) => ({ login })),
    comments: i.comments,
    updatedAt: i.updatedAt,
  });
  const prOut = (p: FakePr) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    headRefName: p.head,
    headRefOid: remoteHead(opts.remote, p.head) ?? "",
    baseRefName: p.base,
    mergeStateStatus: "CLEAN",
    mergedAt: null,
    closedAt: null,
    statusCheckRollup: p.statusCheckRollup,
    labels: p.labels.map((name) => ({ name })),
    url: p.url,
    updatedAt: p.updatedAt,
    isDraft: false,
    files: [],
    comments: p.comments,
    reviews: [],
  });

  const editLabels = (labels: string[], rest: string[]): string | null => {
    const add = flag(rest, "--add-label")?.split(",") ?? [];
    const remove = flag(rest, "--remove-label")?.split(",") ?? [];
    for (const name of add) if (!opts.labels.includes(name)) return `'${name}' not found`;
    const next = labels.filter((l) => !remove.includes(l));
    for (const name of add) if (!next.includes(name)) next.push(name);
    labels.splice(0, labels.length, ...next);
    return null;
  };

  const serve = (args: string[], input: string | undefined): ExecResult => {
    const [noun, verb, ...rest] = args.slice(2);
    const key = `${noun} ${verb}`;
    const number = Number(rest[0]);
    switch (key) {
      case "issue view": {
        const i = issues.get(number);
        return i
          ? ok(JSON.stringify(pick(issueOut(i), rest, ISSUE_FIELDS)))
          : fail(`issue #${number} not found`);
      }
      case "issue list": {
        allow(rest, ["--label", "--state", "--limit", "--json"]);
        validFields(rest, ISSUE_FIELDS);
        const label = flag(rest, "--label");
        const all = flag(rest, "--state") === "all";
        const hits = [...issues.values()].filter(
          (i) => (label === undefined || i.labels.includes(label)) && (all || i.state === "OPEN"),
        );
        return ok(
          JSON.stringify(limited(hits, rest).map((i) => pick(issueOut(i), rest, ISSUE_FIELDS))),
        );
      }
      case "issue edit": {
        const i = issues.get(number);
        if (!i) return fail(`issue #${number} not found`);
        const err = editLabels(i.labels, rest);
        if (err) return fail(err);
        i.updatedAt = iso();
        return ok();
      }
      case "issue comment": {
        const i = issues.get(number);
        if (!i) return fail(`issue #${number} not found`);
        if (flag(rest, "--body-file") !== "-") return fail("the fake serves --body-file - only");
        i.comments.push({
          author: { login: "autoclaude-bot" },
          body: input ?? "",
          createdAt: iso(),
        });
        i.updatedAt = iso();
        return ok();
      }
      case "pr list": {
        allow(rest, ["--state", "--head", "--limit", "--json"]);
        validFields(rest, PR_FIELDS);
        // The two states the engine asks for (gh's default is open); `--head` is an exact match.
        const state = flag(rest, "--state") ?? "open";
        if (state !== "open" && state !== "all")
          throw new Refused(`the fake forge does not interpret --state ${state}`);
        const head = flag(rest, "--head");
        const hits = prs.filter(
          (p) => (state === "all" || p.state === "OPEN") && (head === undefined || p.head === head),
        );
        return ok(JSON.stringify(limited(hits, rest).map((p) => pick(prOut(p), rest, PR_FIELDS))));
      }
      case "pr create": {
        const head = flag(rest, "--head") ?? "";
        if (remoteHead(opts.remote, head) === null)
          return fail(`Head sha can't be blank: branch ${head} is not on the remote`);
        if (flag(rest, "--body-file") !== "-") return fail("the fake serves --body-file - only");
        const n = prs.length + 1;
        const url = `https://github.com/${opts.repo}/pull/${n}`;
        prs.push({
          number: n,
          title: flag(rest, "--title") ?? "",
          body: input ?? "",
          base: flag(rest, "--base") ?? "",
          head,
          state: "OPEN",
          labels: [],
          url,
          createdAt: iso(),
          updatedAt: iso(),
          statusCheckRollup: [],
          comments: [],
        });
        return ok(`${url}\n`);
      }
      case "pr view": {
        const p = prs.find((x) => x.number === number);
        return p
          ? ok(JSON.stringify(pick(prOut(p), rest, PR_FIELDS)))
          : fail(`pull request #${number} not found`);
      }
      case "pr edit": {
        const p = prs.find((x) => x.number === number);
        if (!p) return fail(`pull request #${number} not found`);
        if (rest.includes("--body-file")) p.body = input ?? "";
        const err = editLabels(p.labels, rest);
        if (err) return fail(err);
        p.updatedAt = iso();
        return ok();
      }
      case "pr comment": {
        const p = prs.find((x) => x.number === number);
        if (!p) return fail(`pull request #${number} not found`);
        p.comments.push({ author: { login: "autoclaude-bot" }, body: input ?? "" });
        return ok();
      }
      case "run list":
        return ok("[]");
      default:
        unexpected.push(args.join(" "));
        return fail(`the fake forge does not serve: gh ${args.join(" ")}`);
    }
  };

  const exec: Exec = (cmd, args, o) => {
    if (cmd !== "gh") {
      unexpected.push(`${cmd} ${args.join(" ")}`);
      return fail(`the fake forge serves gh only, not ${cmd}`);
    }
    calls.push(args);
    if (args[0] !== "-R" || args[1] !== opts.repo) {
      violations.push(args.join(" "));
      return fail(`gh was called without -R ${opts.repo}: gh ${args.join(" ")}`);
    }
    try {
      return serve(args, o?.input);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      unexpected.push(`${args.join(" ")} (${error.message})`);
      return fail(error.message);
    }
  };

  return {
    exec,
    issues,
    prs,
    calls,
    violations,
    unexpected,
    addIssue(over) {
      const issue: FakeIssue = {
        state: "OPEN",
        labels: [],
        assignees: [],
        comments: [],
        updatedAt: iso(),
        ...over,
      };
      issues.set(issue.number, issue);
      return issue;
    },
  };
}
