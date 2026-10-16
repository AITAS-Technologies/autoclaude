import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The environment a stage process (a headless `claude -p` and everything it runs) gets: no
 * forge credential, but the runtime's own subscription login intact. Recipe verified by
 * Phase 0 spike S5 (docs/spikes/s5-stage-env.md).
 *
 * This is the layer that holds even when the command guard misses something. It is for stage
 * processes ONLY: the engine's own fetch, push and every `gh` call run with the normal
 * environment.
 *
 * `GIT_CONFIG_PARAMETERS` (what `git -c` uses) is the closer that works on every git; git
 * before 2.31 ignores `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, which are appended as well for
 * newer gits. `protocol.allow=never` refuses https and ssh to the forge; `protocol.file.allow
 * =always` keeps local clone/fetch/push (which project test suites use) working, and grants
 * no forge access.
 */

const WIN = process.platform === "win32";
const norm = (name: string): string => (WIN ? name.toUpperCase() : name);

const REMOVE = new Set(
  [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "SSH_AUTH_SOCK",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    // the guard does not model these; they would redirect `cd` or source arbitrary files
    "CDPATH",
    "BASH_ENV",
    "ENV",
    // describe a parent Claude Code session; a stage must not join or inherit it
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_AGENT_SDK_VERSION",
  ].map(norm),
);
const REMOVE_PREFIXES = ["CLAUDE_CODE_SESSION", "CLAUDE_CODE_MESSAGING", "CLAUDE_CODE_CHILD"].map(
  norm,
);

const GIT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["credential.helper", ""],
  ["protocol.allow", "never"],
  ["protocol.file.allow", "always"],
];

export function stageEnv(base: NodeJS.ProcessEnv, opts: { scratchDir: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const n = norm(name);
    if (REMOVE.has(n) || REMOVE_PREFIXES.some((p) => n.startsWith(p))) continue;
    env[name] = value;
  }

  // Read-and-remove (case-insensitively on win32) so the values are appended, never replaced
  // and never duplicated under a second spelling.
  const take = (name: string): string | undefined => {
    let found: string | undefined;
    for (const key of Object.keys(env)) {
      if (norm(key) === norm(name)) {
        found = env[key];
        delete env[key];
      }
    }
    return found;
  };

  const ghDir = join(opts.scratchDir, "gh");
  mkdirSync(ghDir, { recursive: true });
  env.GH_CONFIG_DIR = ghDir;
  take("GIT_TERMINAL_PROMPT");
  take("GCM_INTERACTIVE");
  take("DISABLE_AUTOUPDATER");
  take("AUTOCLAUDE_STAGE");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.DISABLE_AUTOUPDATER = "1";
  env.AUTOCLAUDE_STAGE = "1";

  const existingParams = take("GIT_CONFIG_PARAMETERS");
  const entries = GIT_SETTINGS.map(([k, v]) => `'${k}=${v}'`).join(" ");
  env.GIT_CONFIG_PARAMETERS = existingParams ? `${existingParams} ${entries}` : entries;

  const parsed = Number.parseInt(take("GIT_CONFIG_COUNT") ?? "0", 10);
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  GIT_SETTINGS.forEach(([k, v], i) => {
    take(`GIT_CONFIG_KEY_${count + i}`);
    take(`GIT_CONFIG_VALUE_${count + i}`);
    env[`GIT_CONFIG_KEY_${count + i}`] = k;
    env[`GIT_CONFIG_VALUE_${count + i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(count + GIT_SETTINGS.length);
  return env;
}
