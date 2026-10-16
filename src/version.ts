import { readFileSync } from "node:fs";

// package.json is the single source of truth. Both src/ (vitest) and dist/ (tsc)
// sit one level below the package root, so the same relative URL works for both.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const VERSION: string = pkg.version;
