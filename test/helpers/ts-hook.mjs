// A resolve hook so a plain `node` child can run the engine's TypeScript sources, which
// import each other as "./x.js". Node strips the types itself (24.x, and 22.18+);
// this only maps a relative ".js" specifier to the ".ts" file next to it when the ".js"
// does not exist.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js") && context.parentURL) {
    const asTs = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(asTs))) return next(asTs.href, context);
  }
  return next(specifier, context);
}
