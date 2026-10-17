/**
 * The glob subset .autoclaude/config.json uses: `**` spans directories, `*` stays inside
 * one, everything else is literal.
 */
export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => {
    // One pass, longest token first. Sequential replaces would rewrite their own
    // output: the `*` inside the `.*` that `**` becomes would turn into `[^/]*` again.
    const re = g.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\]/g, (m) =>
      m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : m === "*" ? "[^/]*" : `\\${m}`,
    );
    return new RegExp(`^${re}$`).test(path);
  });
}
