import type { Forge } from "../forge/github.js";
import type { Dispatch } from "../prompts/dispatch.js";

/**
 * The issue as the forge returns it: title, body, label names and every comment with its
 * author and date. Phase 1 does not filter comments by author: author trust is Phase 2
 * (plan Global Constraint), so a stage reads all of them. GitHub-controlled text goes into
 * the dispatch file only, never into a prompt or a command line.
 */
export function prefetchIssue(forge: Forge, issue: number): Dispatch["issue"] {
  const v = forge.viewIssue(issue);
  return {
    number: v.number,
    title: v.title,
    body: v.body,
    labels: v.labels.map((l) => l.name),
    comments: v.comments.map((c) => ({
      author: c.author?.login ?? "",
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

/** Candidates whose files are looked at, at most, so a large history costs a bounded number of calls. */
const MAX_PRS_VIEWED = 200;

/**
 * Merged and closed pull requests that touched any of `files`, newest first, at most `limit`,
 * each with its discussion (`<author>: <text>` per conversation comment and non-empty review).
 * The candidates are the newest pull requests of any state, a bounded read (`recentPrs`); the
 * files of each are read one pull request at a time, newest first, until `limit` have matched.
 */
export function prefetchPriorPrs(
  forge: Forge,
  files: string[],
  limit = 20,
): NonNullable<Dispatch["priorPullRequests"]> {
  if (files.length === 0 || limit <= 0) return [];
  const wanted = new Set(files);
  const when = (p: { closedAt?: string | null; mergedAt?: string | null; updatedAt: string }) =>
    p.mergedAt ?? p.closedAt ?? p.updatedAt;
  const ended = forge
    .recentPrs(MAX_PRS_VIEWED)
    .filter((p) => p.state !== "OPEN")
    .sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : b.number - a.number))
    .slice(0, MAX_PRS_VIEWED);
  const out: NonNullable<Dispatch["priorPullRequests"]> = [];
  for (const p of ended) {
    if (out.length >= limit) break;
    const t = forge.viewPrThread(p.number);
    if (!t.files.some((f) => wanted.has(f.path))) continue;
    const say = (c: { author: { login: string } | null; body: string }): string[] =>
      c.body.trim() === "" ? [] : [`${c.author?.login ?? "unknown"}: ${c.body}`];
    out.push({
      number: t.number,
      title: t.title,
      comments: [...t.comments.flatMap(say), ...t.reviews.flatMap(say)],
    });
  }
  return out;
}
