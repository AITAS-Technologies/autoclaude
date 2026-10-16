/**
 * Loads a project's `.autoclaude/config.json`, merges the developer's own
 * `config.local.json` over it, validates, and applies defaults.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, validateConfig } from "./validate.js";
import { LOCAL_OVERRIDABLE, type ProjectConfig } from "./types.js";

export { ConfigError };

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const CONFIG = "config.json";
const LOCAL = "config.local.json";

/** Reads and parses one JSON file; a leading BOM is stripped, CRLF is plain JSON whitespace. */
function readJson(dir: string, name: string): unknown | undefined {
  const path = join(dir, name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (name === LOCAL && (e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`${name}: cannot read ${path} (${(e as Error).message})`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ConfigError(`${name}: invalid JSON in ${path} (${(e as Error).message})`);
  }
}

/** Plain objects merge recursively; arrays and scalars replace. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isRec(base) || !isRec(over)) return over;
  const out: Rec = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

const refuse = (key: string) => new ConfigError(`${LOCAL}: ${key} is not a personal setting`);

/** A stage spec in the local file may change only these, and only where config.json has the spec. */
const LOCAL_SPEC_KEYS = ["runtime", "model", "effort", "fallback"];

function checkLocalSpec(
  key: string,
  local: unknown,
  base: unknown,
  nested: readonly string[] = [],
) {
  if (!isRec(local))
    throw new ConfigError(`${LOCAL}: ${key} must be an object but is ${JSON.stringify(local)}`);
  if (!isRec(base)) throw new ConfigError(`${LOCAL}: ${key} is not a stage in ${CONFIG}`);
  for (const k of Object.keys(local)) {
    if (nested.includes(k)) checkLocalSpec(`${key}.${k}`, local[k], base[k]);
    else if (!LOCAL_SPEC_KEYS.includes(k)) throw refuse(`${key}.${k}`);
  }
}

/** `stages` in the local file: existing specs only, and only their runtime/model/effort/fallback. */
function checkLocalStages(local: unknown, base: unknown): void {
  if (!isRec(local))
    throw new ConfigError(`${LOCAL}: stages must be an object but is ${JSON.stringify(local)}`);
  const b = isRec(base) ? base : {};
  for (const [k, v] of Object.entries(local)) {
    switch (k) {
      case "triage":
      case "plan":
        checkLocalSpec(`stages.${k}`, v, b[k]);
        break;
      case "planReview":
        checkLocalSpec("stages.planReview", v, b[k], ["scorer"]);
        break;
      case "implement":
        checkLocalSpec("stages.implement", v, b[k], ["escalated"]);
        break;
      case "codeReview": {
        if (!isRec(v)) throw new ConfigError(`${LOCAL}: stages.codeReview must be an object`);
        const bc = isRec(b[k]) ? (b[k] as Rec) : {};
        for (const [ck, cv] of Object.entries(v)) {
          if (ck === "scorer") checkLocalSpec("stages.codeReview.scorer", cv, bc.scorer);
          else if (ck === "angles") {
            if (!isRec(cv))
              throw new ConfigError(`${LOCAL}: stages.codeReview.angles must be an object`);
            const ba = isRec(bc.angles) ? (bc.angles as Rec) : {};
            for (const [ak, av] of Object.entries(cv))
              checkLocalSpec(`stages.codeReview.angles.${ak}`, av, ba[ak]);
          } else throw refuse(`stages.codeReview.${ck}`);
        }
        break;
      }
      default:
        throw new ConfigError(`${LOCAL}: stages.${k} is not an existing stage in ${CONFIG}`);
    }
  }
}

/** Refuses anything in the local file that belongs to the project rather than the developer. */
function checkLocal(local: unknown, base: Rec): void {
  if (!isRec(local)) throw new ConfigError(`${LOCAL}: must be a JSON object`);
  for (const key of Object.keys(local))
    if (!(LOCAL_OVERRIDABLE as readonly string[]).includes(key)) throw refuse(key);
  if (local.stages !== undefined) checkLocalStages(local.stages, base.stages);
}

/**
 * @param projectRoot the project's main checkout, holding `.autoclaude/`.
 * @throws ConfigError naming the file and the dotted key of the first problem.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const dir = join(projectRoot, ".autoclaude");
  const base = readJson(dir, CONFIG);
  // The project's own file must stand alone: a fault in it is never blamed on the local file.
  const cfg = validateConfig(CONFIG, base);
  const local = readJson(dir, LOCAL);
  if (local === undefined) return cfg;
  checkLocal(local, base as Rec);
  return validateConfig(LOCAL, deepMerge(base, local));
}
