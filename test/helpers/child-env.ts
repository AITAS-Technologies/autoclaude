/**
 * The environment a spawned child of this suite gets: this one, minus git's own
 * variables.
 *
 * git exports GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE and GIT_INDEX_FILE to a hook and to
 * every subprocess it starts. Inherited, a `git init` in a temporary directory
 * re-initialises *that* repository instead of `<tmp>/.git`, and the code under test then
 * resolves its root to the real checkout, whose `.autoclaude/state/` these harnesses exist
 * to stay away from.
 *
 * Not a `.test.ts` file, so vitest does not collect it: it holds no cases.
 */
export function childEnv(extraPathDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])
    delete env[key];
  // Read from process.env, not from the copy: on Windows the key may be spelled `Path`,
  // and only the proxy resolves it case-insensitively.
  if (extraPathDir)
    env.PATH = `${extraPathDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`;
  return env;
}
