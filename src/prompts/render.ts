import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Stage prompt rendering (design C3): prompts are templates the engine
 * renders, not skills a runtime discovers.
 *
 * Grammar:
 * - `{{name}}`: variable, `name` matches `[A-Za-z][A-Za-z0-9_]*`.
 * - `{{> relative/path}}`: include `prompts/<relative/path>.md` (the `.md`
 *   extension is implied when absent), resolved under `prompts/` only.
 *   Includes expand recursively before variable substitution.
 *
 * Values are inserted verbatim in a single pass and are never re-scanned.
 * GitHub-controlled text (issue title, body, comments) must never be passed as
 * a prompt variable: it belongs in the dispatch file. Stage prompts receive
 * only paths and engine-made values.
 */

const VAR = /^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/;
const INC = /^\{\{>\s*([^{}\r\n]*?)\s*\}\}/;

function normalizeInclude(raw: string): string {
  const bad = (): never => {
    throw new Error(`include path escapes prompts/ or is invalid: "${raw}"`);
  };
  if (raw === "" || /^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    return bad();
  }
  const parts = raw.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "." || p === "")) return bad();
  const joined = parts.join("/");
  return joined.endsWith(".md") ? joined : `${joined}.md`;
}

function expandIncludes(
  text: string,
  chain: string[],
  readInclude: (path: string) => string,
  vars: Record<string, string>,
  top: string,
): string {
  const where =
    chain.length === 0 ? top : `${chain.at(-1)} (included via ${[top, ...chain].join(" -> ")})`;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("{{", i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    const rest = text.slice(at);
    const m = INC.exec(rest);
    if (!m) {
      const v = VAR.exec(rest);
      if (!v) {
        const snippet = rest.slice(0, 40).split(/\r?\n/)[0];
        throw new Error(`unreplaced "{{" in ${where}: ${snippet}`);
      }
      if (!Object.hasOwn(vars, v[1] as string)) {
        throw new Error(`unknown variable "${v[1]}" in ${where}`);
      }
      out += "{{";
      i = at + 2;
      continue;
    }
    const path = normalizeInclude(m[1] ?? "");
    if (chain.includes(path)) {
      throw new Error(`include cycle: ${[...chain, path].join(" -> ")}`);
    }
    out += expandIncludes(readInclude(path), [...chain, path], readInclude, vars, top);
    i = at + m[0].length;
  }
  return out;
}

/** Pure renderer; `readInclude` receives a normalized path such as `common/rules.md`. */
export function renderTemplate(
  text: string,
  vars: Record<string, string>,
  readInclude: (path: string) => string,
  name: string,
): string {
  const expanded = expandIncludes(text, [], readInclude, vars, name);
  let out = "";
  let i = 0;
  while (i < expanded.length) {
    const at = expanded.indexOf("{{", i);
    if (at === -1) {
      out += expanded.slice(i);
      break;
    }
    out += expanded.slice(i, at);
    const m = VAR.exec(expanded.slice(at));
    if (!m) {
      const snippet = expanded.slice(at, at + 40).split(/\r?\n/)[0];
      throw new Error(`unreplaced "{{" in ${name}: ${snippet}`);
    }
    const key = m[1] as string;
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`unknown variable "${key}" in ${name}`);
    }
    out += vars[key] as string;
    i = at + m[0].length;
  }
  return out;
}

const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

/** Loads `prompts/<name>.md` from the package root (works from `src` and `dist`). */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const rel = normalizeInclude(name);
  const read = (p: string): string =>
    readFileSync(PROMPTS_DIR + p, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n");
  return renderTemplate(read(rel), vars, read, rel);
}
