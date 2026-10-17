/**
 * The second fence layer for a Claude Code stage: the per-run `--settings` file and the
 * MCP config.
 *
 * Two layers, on purpose. Claude Code's permission rules (this file) decide which tools
 * and paths a stage may use at all; the `PreToolUse` hook (`autoclaude guard`, see
 * `src/cli/guard.ts`) reads every Bash command. Phase 0 (spike S4) observed that in
 * `dontAsk` mode read-only Bash commands run with no allow rule, so for Bash the hook, not
 * the allow list, is the fence; the deny list is what holds for the other tools.
 *
 * Nothing here reads or writes the user's own Claude settings: the object is written per
 * run into the run directory (Task G1) and handed over with `--settings`.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny } from "../../config/globs.js";
import type { ProjectConfig } from "../../config/types.js";

/**
 * An absolute path in the spelling Claude Code's `Edit(...)`/`Write(...)` rules accept.
 *
 * Phase 0 observed on Windows: `//c/<rest>` works (MSYS style: two slashes, lowercase drive
 * letter, forward slashes), including under a path with a space and an umlaut; `//C:/...`
 * and `/C:/...` do not. On POSIX the form is `//` plus the path without its leading slash.
 * Pure string logic, so either OS's spelling is testable anywhere.
 *
 * @throws when the path is not absolute for `platform` (a UNC path included on Windows)
 */
export function claudePathRule(abs: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
    if (!m) throw new Error(`not an absolute path with a drive letter: ${abs}`);
    const rest = m[2]!.replaceAll("\\", "/").replace(/\/+$/, "");
    return rest === "" ? `//${m[1]!.toLowerCase()}` : `//${m[1]!.toLowerCase()}/${rest}`;
  }
  if (!abs.startsWith("/")) throw new Error(`not an absolute path: ${abs}`);
  return `//${abs.slice(1).replace(/\/+$/, "")}`;
}

/** A path as the hook command line spells it: forward slashes on Windows. */
const forShell = (p: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? p.replaceAll("\\", "/") : p;

/** Double-quotes a word for a POSIX shell (Git Bash on Windows): `\`, `"`, `$` and backtick stay literal. */
const dq = (s: string): string => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;

/**
 * The ready-to-use command prefix that starts the guard: the running node and the compiled
 * hook entry, each in double quotes with forward slashes. No `.cmd` shim and no PATH lookup:
 * hooks run in Git Bash on Windows, which cannot run a `.cmd` reliably (Phase 0).
 *
 * The entry is `hook-entry.js`, not `main.js`: it runs the guard verb with no entry-point
 * check, so no spelling of its path can turn the hook into a silent exit 0.
 */
export function autoclaudeBinCommand(
  nodePath: string = process.execPath,
  entry: string = fileURLToPath(new URL("../../cli/hook-entry.js", import.meta.url)),
  platform: NodeJS.Platform = process.platform,
): string {
  return `${dq(forShell(nodePath, platform))} ${dq(forShell(entry, platform))}`;
}

/**
 * The hook line: the guard with the worktree in double quotes, ending in `|| exit 2`.
 *
 * A PreToolUse hook blocks on exit 2 and only on exit 2; node that cannot start or import
 * exits 1 (or the shell 127), which Claude Code reads as a non-blocking error. The suffix
 * turns every such failure into a block. The worktree is escaped for the double quotes, so
 * no character in a path is ever interpreted; nothing GitHub controls goes into this line.
 */
export function hookCommand(
  autoclaudeBin: string,
  worktree: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${autoclaudeBin} guard --runtime claude --worktree ${dq(forShell(worktree, platform))} || exit 2`;
}

/** `Bash(<prefix>)` and `Bash(<prefix> *)`: the bare command and the command with arguments. */
const bash = (prefix: string): string[] => [`Bash(${prefix})`, `Bash(${prefix} *)`];

const READ_GIT = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git rev-parse",
  "git ls-files",
  "git merge-base",
  "git worktree list",
  "git branch --show-current",
  "git stash list",
];
/** Git verbs that change the work tree or history; a read-only stage gets none of them. */
const WRITE_GIT = [
  "git add",
  "git commit",
  "git rebase",
  "git checkout",
  "git switch",
  "git restore",
];
const LOCAL_GIT = [...READ_GIT, ...WRITE_GIT];
const ENGINE_VERBS = ["autoclaude note", "autoclaude gates"];
// Not `cd`, `find`, `sort` or `uniq` (R42): `find -exec|-delete|-fprint`, `sort -o` and
// `uniq in out` execute or write, and the source product denied all four.
const SHELL_VERBS = ["ls", "pwd", "wc", "echo"];

/** File readers (the Read and Grep tools are the way to read), network tools, nested claude. */
const DENIED_COMMANDS = [
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "sed",
  "awk",
  "more",
  "less",
  "strings",
  "xxd",
  "od",
  "type",
  "curl",
  "wget",
  "claude",
];

const SECRET_FILES = ["//**/.env*", "//**/.git-credentials", "//**/.netrc", "//**/.npmrc"];
const HOME_SECRETS = [
  "~/.ssh/**",
  "~/.gitconfig",
  "~/.npmrc",
  "~/.aws/**",
  "~/.config/gh/**",
  "~/.docker/**",
  "~/.kube/**",
  "~/.azure/**",
  "~/.gnupg/**",
  "~/.config/gcloud/**",
];

/** The characters Claude Code reads as pattern or rule syntax. No escape is documented. */
const RULE_SYNTAX = /[*?[\]{}()]/;
/** Seconds a hook may run before Claude Code gives up (and fails open); above the guard's own watchdog. */
export const HOOK_TIMEOUT_SECONDS = 30;

/** A forbidden-path glob, placed under the worktree: no leading `./` or `/`. */
const underWorktree = (rule: string, glob: string): string =>
  `${rule}/${glob.replace(/^(\.\/|\/)+/, "")}`;

/** Representative paths of the files a plan and an implement stage must be able to write. */
const REPORT_SAMPLE = ".autoclaude/state/reports/plan.md";
const PLAN_SAMPLE = ".autoclaude/state/plans/1.md";

/**
 * What a forbidden glob that covers the report and plan paths (the example `.autoclaude/**`)
 * becomes instead. A deny rule beats an allow rule, so the glob is split: the files directly
 * under `.autoclaude/` (the committed config) and under `.autoclaude/state/` stay denied, and
 * so does every other subdirectory present now; `state/reports` and `state/plans` stay
 * writable. Publish's forbidden-path diff check remains the backstop for anything committed.
 */
function reportCarveOut(worktree: string): string[] {
  const dirs = (rel: string, keep: string[]): string[] => {
    try {
      return readdirSync(join(worktree, rel), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !keep.includes(d.name))
        .map((d) => `${rel}/${d.name}/**`);
    } catch {
      return [];
    }
  };
  return [
    ".autoclaude/*",
    ".autoclaude/state/*",
    ...dirs(".autoclaude", ["state"]),
    ...dirs(".autoclaude/state", ["reports", "plans"]),
  ];
}

/**
 * The `--settings` object for one Claude stage run in `worktree`.
 *
 * @param autoclaudeBin ready-to-use quoted command prefix, see `autoclaudeBinCommand`
 * @param opts.readOnly a stage that only reads (triage): no `Edit`/`Write` allow rule, those
 *   tools denied outright, and none of the git verbs that change the tree, nor the engine
 *   verbs (`autoclaude gates` may run a project's fix command)
 */
export function claudeSettings(
  cfg: ProjectConfig,
  worktree: string,
  autoclaudeBin: string,
  platform: NodeJS.Platform = process.platform,
  opts: { readOnly?: boolean } = {},
): object {
  const readOnly = opts.readOnly === true;
  if (RULE_SYNTAX.test(forShell(worktree, platform)))
    throw new Error(
      `the worktree path contains a character that is permission-rule syntax (* ? [ ] { } ( )), so the stage's write fence cannot be stated safely: ${worktree}`,
    );
  const root = claudePathRule(worktree, platform);
  const allow = [
    "Read",
    "Grep",
    "Glob",
    ...(readOnly ? [] : [`Edit(${root}/**)`, `Write(${root}/**)`]),
    ...(readOnly
      ? [...READ_GIT, ...SHELL_VERBS]
      : [...LOCAL_GIT, ...ENGINE_VERBS, ...SHELL_VERBS]
    ).flatMap(bash),
    // A prefix followed by a space and a star: `npx tool sub new *` cannot match `... newx`.
    // A project prefix may write, so a read-only stage gets none.
    ...(readOnly ? [] : cfg.fence.allow).map((p) => `Bash(${p} *)`),
  ];
  const deny = [
    "PowerShell",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Agent",
    ...(readOnly ? ["Edit", "Write"] : []),
    ...DENIED_COMMANDS.flatMap(bash),
    ...SECRET_FILES.flatMap((f) => [`Edit(${f})`, `Write(${f})`, `Read(${f})`]),
    ...HOME_SECRETS.flatMap((f) => [`Edit(${f})`, `Write(${f})`, `Read(${f})`]),
    // A stage must not write project Claude settings (R44).
    `Edit(${root}/.claude/**)`,
    `Write(${root}/.claude/**)`,
    ...cfg.forbiddenPaths.flatMap((g) => {
      // A path without glob characters names a file or a directory: deny both readings.
      const dir = g.replace(/\/+$/, "");
      const globs = RULE_SYNTAX.test(g) ? [g] : [dir, `${dir}/**`];
      const covers = globs.some(
        (x) => matchesAny(REPORT_SAMPLE, [x]) || matchesAny(PLAN_SAMPLE, [x]),
      );
      return (covers ? reportCarveOut(worktree) : globs).flatMap((x) => [
        `Edit(${underWorktree(root, x)})`,
        `Write(${underWorktree(root, x)})`,
      ]);
    }),
  ];
  return {
    permissions: { defaultMode: "dontAsk", allow, deny },
    hooks: {
      PreToolUse: [
        {
          // Bash only: the guard parses POSIX shell, and the PowerShell tool is denied above.
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: hookCommand(autoclaudeBin, worktree, platform),
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The MCP config to pass with `--mcp-config`: the project's `.autoclaude/mcp.claude.json`
 * when it has one, else a generated file with no servers.
 */
export function mcpConfigFor(projectRoot: string): string {
  const own = join(projectRoot, ".autoclaude", "mcp.claude.json");
  if (existsSync(own)) return own;
  const dir = join(projectRoot, ".autoclaude", "state");
  mkdirSync(dir, { recursive: true });
  const empty = join(dir, "mcp.empty.json");
  writeFileSync(empty, '{ "mcpServers": {} }\n');
  return empty;
}
