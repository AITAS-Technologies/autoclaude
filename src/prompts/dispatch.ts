import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The input every stage reads from `<runDir>/dispatch.json`. */
export interface Dispatch {
  issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    comments: Array<{ author: string; body: string; createdAt: string }>;
  };
  mode: "fresh" | "fix" | "resume";
  worktree: string;
  integrationRef: string;
  reportFile: string;
  planFile: string;
  findingsMarkdown?: string;
  carriedMarkdown?: string;
  gateLog?: string;
  priorPullRequests?: Array<{ number: number; title: string; comments: string[] }>;
  projectFacts: { projectMd: string; invariantsMd: string; engineRulesMd: string };
}

/** Writes `<runDir>/dispatch.json` and returns its absolute path. */
export function writeDispatch(runDir: string, d: Dispatch): string {
  const dir = resolve(runDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "dispatch.json");
  writeFileSync(file, JSON.stringify(d, null, 2) + "\n", "utf8");
  return file;
}
