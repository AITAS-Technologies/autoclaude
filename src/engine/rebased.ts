/**
 * Is this branch rebased onto the integration branch?
 *
 * Library half; the verbs that wrap it are built later, and their exit-code contracts
 * are recorded here for them:
 *   rebase check   exit 0 rebased, 1 stale or the fetch failed
 *   rebase hook    PreToolUse hook: reads the tool call as JSON on stdin; exit 2 blocks,
 *                  and ONLY exit 2 blocks. Every other code lets the tool call proceed.
 *
 * The same check lives in three places by design: the implement stage states the rule,
 * the hook refuses `gh pr create` on a stale branch, and the merge verdict catches drift
 * after the pull request opened. One module backs all three so they cannot disagree.
 *
 * Why not read mergeStateStatus from GitHub: it reports BEHIND only when branch
 * protection requires up-to-date branches, which a project cannot be assumed to have.
 *
 * A PreToolUse hook blocks on exit 2 and ONLY on exit 2. So once a command is known to
 * be a `gh pr create`, every path out of `hookDecision` that is not a proven "rebased"
 * must block, including thrown exceptions. A gate whose failure mode is "permit" is not
 * a gate.
 */

import { loadProjectConfig } from "../config/load.js";
import type { ProjectConfig } from "../config/types.js";
import { realExec, type Exec } from "../forge/exec.js";

export type Runner = (args: string[]) => { status: number | null };

const defaultRunner: Runner = (args) => realExec("git", args);

/** True when the tip of `base` is an ancestor of `head`, i.e. head contains all of base. */
export function isRebasedOnto(base: string, head: string, run: Runner = defaultRunner): boolean {
  return run(["merge-base", "--is-ancestor", base, head]).status === 0;
}

/**
 * `gh pr create`, anywhere in a command line.
 *
 * Two earlier versions of this leaked, and both failed the same way: they described
 * what may stand *before* `gh`, which is a blocklist, and a blocklist of shell syntax
 * is never finished.
 *
 * The first allowed only `^ ; & |`. A Bash tool call carries a whole script, and the
 * stage prompts teach exactly the shape it missed:
 *
 *     git push -u <remote> HEAD
 *     gh pr create --fill
 *
 * Adding `\n` and `(` to the class fixed that one and still let through
 * `GH_TOKEN=x gh pr create`, `if git push; then gh pr create; fi`,
 * `bash -c "gh pr create"`, and anything behind `sudo`, `env` or `time` — because in
 * each of those the character before the whitespace is an ordinary word character or a
 * quote. All are real invocations, not mentions of the command.
 *
 * `\b` makes no claim about the prefix at all, which is why it has nothing to leak
 * through. It still rejects `gh pr createx`, `gh pr list`, `ghost pr create` and
 * `gh pr view`. The remaining bias is deliberate and cheap: a command that merely
 * quotes this string is blocked, which costs one false refusal on a stale branch,
 * while missing a real invocation costs the whole rule.
 */
const PR_CREATE = /\bgh\s+pr\s+create\b/;

/** Does this command line invoke `gh pr create` anywhere in it? */
export function isPrCreate(command: string): boolean {
  return PR_CREATE.test(command.trim());
}

/** Where the integration branch lives, for the sentence that tells a reader how to fix a stale branch. */
export interface BaseRef {
  remote: string;
  integration: string;
}

/**
 * The remedy names the plain git steps. With the project's remote and branch to hand it
 * names them exactly; without, it names the placeholders, never a remote of its own.
 */
export function staleReason(where?: BaseRef): string {
  const remote = where?.remote ?? "<remote>";
  const branch = where?.integration ?? "<integration>";
  return (
    "Refusing gh pr create: this branch is not rebased onto the integration branch. " +
    `Run \`git fetch ${remote} ${branch} && git rebase ${remote}/${branch}\` and re-run the local ` +
    "checks first. The tests that went green ran against a base that no longer exists."
  );
}

/** Hook decision: only `gh pr create` is gated, and only when the branch is stale. */
export function decideHook(
  command: string,
  rebased: boolean,
  where?: BaseRef,
): { block: boolean; reason?: string } {
  if (!isPrCreate(command)) return { block: false };
  if (rebased) return { block: false };
  return { block: true, reason: staleReason(where) };
}

/**
 * Fetch the integration branch, and throw if it did not work.
 *
 * A discarded fetch failure is a false green: `<remote>/<integration>` keeps pointing at
 * an old tip, the ancestor test passes against that, and the branch is declared current
 * when it is behind.
 */
export function fetchBase(where: BaseRef, exec: Exec = realExec, cwd?: string): void {
  const result = exec("git", ["fetch", where.remote, where.integration, "--quiet"], { cwd });
  if (result.status !== 0) {
    throw new Error(
      `git fetch ${where.remote} ${where.integration} failed (exit ${result.status}). Cannot tell whether ` +
        `this branch is current, so the answer is no.`,
    );
  }
}

/**
 * The rebase check: fetch the integration branch and test `HEAD` against it.
 *
 * Throws when the fetch fails — an unverifiable branch is not a rebased one, and the
 * caller reports it as a failed check (exit 1), not as stale.
 */
export function checkRebased(
  cfg: Pick<ProjectConfig, "forge" | "branches">,
  exec: Exec = realExec,
  cwd?: string,
): { rebased: boolean; base: string } {
  const where = { remote: cfg.forge.remote, integration: cfg.branches.integration };
  fetchBase(where, exec, cwd);
  const base = `${where.remote}/${where.integration}`;
  return { rebased: isRebasedOnto(base, "HEAD", (args) => exec("git", args, { cwd })), base };
}

/**
 * Hook mode, as a function of the raw stdin payload. Ordered so the common case is
 * cheap: the matcher is `Bash`, so this runs before every shell command in the session,
 * and only a `gh pr create` is worth a config load and a network round trip.
 *
 * `block: true` is the verb's exit 2; `block: false` is its exit 0.
 *
 * @param loadConfig injectable so a test need not stage a project
 */
export function hookDecision(
  payload: string,
  deps: {
    projectRoot: string;
    exec?: Exec;
    loadConfig?: (projectRoot: string) => Pick<ProjectConfig, "forge" | "branches">;
  },
): { block: boolean; reason?: string } {
  const exec = deps.exec ?? realExec;
  let command: string;
  try {
    // Claude Code passes the pending tool call as JSON on stdin.
    const input = JSON.parse(payload.replace(/^﻿/, "")) as { tool_input?: { command?: unknown } };
    const raw = input.tool_input?.command;
    // A payload this hook matched but cannot read is not an allow. Defaulting to ""
    // here would make `{"tool_input":{}}` and `{"foo":1}` permit, while every other
    // unproven path in this module blocks by design.
    if (typeof raw !== "string") {
      return {
        block: true,
        reason:
          "Refusing the tool call: the payload carries no command string, so the rebase " +
          "guard cannot tell what it would be allowing.",
      };
    }
    command = raw;
  } catch (error) {
    return {
      block: true,
      reason:
        `Refusing the tool call: could not read the pending command from stdin (${String(error)}). ` +
        `The rebase guard cannot verify what it would be allowing.`,
    };
  }

  // Cheap test first. Not a pull request creation, so nothing to guard, and no config
  // load and no fetch are paid for.
  if (!isPrCreate(command)) return { block: false };

  let cfg: Pick<ProjectConfig, "forge" | "branches">;
  let rebased: boolean;
  try {
    cfg = (deps.loadConfig ?? loadProjectConfig)(deps.projectRoot);
    rebased = checkRebased(cfg, exec).rebased;
  } catch (error) {
    return {
      block: true,
      reason:
        `Refusing gh pr create: the rebase check could not run (${String(error)}). ` +
        `Fix the cause and try again; an unverifiable branch is treated as stale.`,
    };
  }

  // The decision itself goes through decideHook, which is what the test suite
  // exercises. An inline copy here would let the tested function and the running one
  // drift apart on a safety gate.
  return decideHook(command, rebased, {
    remote: cfg.forge.remote,
    integration: cfg.branches.integration,
  });
}
