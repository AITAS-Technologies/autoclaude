/**
 * Hand-written validator for `.autoclaude/config.json`: one function per block, every
 * refusal names the file and the dotted key. A value the engine computes with is checked
 * once, at load, instead of being misread at three in the morning.
 */

import {
  CODE_REVIEW_ANGLES,
  EFFORTS,
  type CodeReviewAngle,
  type Effort,
  type Gate,
  type ProjectConfig,
  type Runtime,
  type StageSpec,
} from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Rec = Record<string, unknown>;

const RUNTIMES: readonly Runtime[] = ["claude", "codex"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * The engine range: `>=X.Y.Z` only. Other semver forms are refused for now; comparing
 * the range with the running version is `doctor`'s job, not the loader's.
 */
const ENGINE_RANGE = /^>=\d+\.\d+\.\d+$/;

const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";

/** One validation pass over one parsed document; `file` is what every message starts with. */
class Check {
  constructor(readonly file: string) {}

  bad(key: string, what: string, value: unknown): ConfigError {
    return new ConfigError(`${this.file}: ${key} ${what} but is ${show(value)}`);
  }

  fail(message: string): ConfigError {
    return new ConfigError(`${this.file}: ${message}`);
  }

  obj(key: string, v: unknown): Rec {
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw this.bad(key, "must be an object", v);
    return v as Rec;
  }

  /** Refuses any key not in `allowed`: a misspelling is ignored silently otherwise. */
  only(key: string, o: Rec, allowed: readonly string[]): void {
    for (const k of Object.keys(o))
      if (!allowed.includes(k)) throw this.fail(`unknown key "${key ? `${key}.` : ""}${k}"`);
  }

  str(key: string, v: unknown, what = "must be a non-empty string"): string {
    if (typeof v !== "string" || v.trim().length === 0) throw this.bad(key, what, v);
    return v;
  }

  int(key: string, v: unknown, min: number): number {
    if (!Number.isInteger(v) || (v as number) < min)
      throw this.bad(key, `must be a whole number of at least ${min}`, v);
    return v as number;
  }

  bool(key: string, v: unknown): boolean {
    if (typeof v !== "boolean") throw this.bad(key, "must be true or false", v);
    return v;
  }

  hhmm(key: string, v: unknown): string {
    if (typeof v !== "string" || !HHMM.test(v)) throw this.bad(key, "must be HH:MM", v);
    return v;
  }

  oneOf<T extends string>(key: string, v: unknown, allowed: readonly T[]): T {
    if (!allowed.includes(v as T)) throw this.bad(key, `must be one of ${allowed.join(", ")}`, v);
    return v as T;
  }

  /** A list of non-blank strings; `nonEmpty` for lists that decide something by being present. */
  strList(key: string, v: unknown, nonEmpty = false): string[] {
    if (
      !Array.isArray(v) ||
      (nonEmpty && v.length === 0) ||
      v.some((s) => typeof s !== "string" || s.trim().length === 0)
    )
      throw this.bad(key, `must be a ${nonEmpty ? "non-empty " : ""}list of strings`, v);
    return v as string[];
  }

  /** Optional block: absent gives `{}`, present must be an object. */
  block(key: string, v: unknown): Rec {
    return v === undefined ? {} : this.obj(key, v);
  }

  /** A required key of an object, reported by its dotted path. */
  need(key: string, o: Rec, k: string): unknown {
    if (o[k] === undefined) throw this.fail(`${key ? `${key}.` : ""}${k} is missing`);
    return o[k];
  }
}

const SPEC_KEYS = ["runtime", "model", "effort"] as const;

/** One stage's runtime, model, effort and optional fallback. `extra` names nested keys the caller handles. */
function stageSpec(c: Check, key: string, v: unknown, extra: readonly string[] = []): StageSpec {
  const o = c.obj(key, v);
  c.only(key, o, [...SPEC_KEYS, "fallback", ...extra]);
  const spec: StageSpec = {
    runtime: c.oneOf(`${key}.runtime`, o.runtime, RUNTIMES),
    model: c.str(`${key}.model`, o.model, "must name a model"),
    effort:
      o.effort === undefined ? "medium" : (c.oneOf(`${key}.effort`, o.effort, EFFORTS) as Effort),
  };
  if (o.fallback !== undefined) {
    const f = c.obj(`${key}.fallback`, o.fallback);
    c.only(`${key}.fallback`, f, SPEC_KEYS);
    spec.fallback = stageSpec(c, `${key}.fallback`, f) as Omit<StageSpec, "fallback">;
  }
  return spec;
}

function validateStages(c: Check, v: unknown): ProjectConfig["stages"] {
  const o = c.obj("stages", v);
  c.only("stages", o, ["triage", "plan", "planReview", "implement", "codeReview"]);
  const planReviewRaw = c.obj("stages.planReview", c.need("stages", o, "planReview"));
  const implementRaw = c.obj("stages.implement", c.need("stages", o, "implement"));
  const reviewRaw = c.obj("stages.codeReview", c.need("stages", o, "codeReview"));
  c.only("stages.codeReview", reviewRaw, ["angles", "scorer", "parallel"]);

  const anglesRaw = c.obj(
    "stages.codeReview.angles",
    c.need("stages.codeReview", reviewRaw, "angles"),
  );
  // A mistyped angle key would leave that angle silently on the default instead of refusing.
  for (const k of Object.keys(anglesRaw)) {
    if (k !== "default" && !CODE_REVIEW_ANGLES.includes(k as CodeReviewAngle))
      throw c.fail(
        `stages.codeReview.angles has an unknown angle key "${k}"; known are default, ${CODE_REVIEW_ANGLES.join(", ")}`,
      );
  }
  c.need("stages.codeReview.angles", anglesRaw, "default");
  const angles: Rec = {};
  for (const [k, spec] of Object.entries(anglesRaw))
    angles[k] = stageSpec(c, `stages.codeReview.angles.${k}`, spec);

  return {
    triage: stageSpec(c, "stages.triage", c.need("stages", o, "triage")),
    plan: stageSpec(c, "stages.plan", c.need("stages", o, "plan")),
    planReview: {
      ...stageSpec(c, "stages.planReview", planReviewRaw, ["scorer"]),
      scorer: stageSpec(
        c,
        "stages.planReview.scorer",
        c.need("stages.planReview", planReviewRaw, "scorer"),
      ),
    },
    implement: {
      ...stageSpec(c, "stages.implement", implementRaw, ["escalated"]),
      ...(implementRaw.escalated === undefined
        ? {}
        : { escalated: stageSpec(c, "stages.implement.escalated", implementRaw.escalated) }),
    },
    codeReview: {
      angles: angles as ProjectConfig["stages"]["codeReview"]["angles"],
      scorer: stageSpec(
        c,
        "stages.codeReview.scorer",
        c.need("stages.codeReview", reviewRaw, "scorer"),
      ),
      parallel:
        reviewRaw.parallel === undefined
          ? 4
          : c.int("stages.codeReview.parallel", reviewRaw.parallel, 1),
    },
  };
}

function validateGates(c: Check, v: unknown): Gate[] {
  if (!Array.isArray(v)) throw c.bad("gates", "must be a list", v);
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const key = `gates[${i}]`;
    const g = c.obj(key, raw);
    c.only(key, g, ["name", "check", "fix", "when"]);
    const name = c.str(`${key}.name`, g.name);
    if (seen.has(name)) throw c.fail(`${key}.name repeats gate "${name}"`);
    seen.add(name);
    const gate: Gate = {
      name,
      check: c.str(`${key}.check`, g.check, "must be a non-empty command"),
    };
    if (g.fix !== undefined) gate.fix = c.str(`${key}.fix`, g.fix, "must be a non-empty command");
    if (g.when !== undefined) gate.when = c.strList(`${key}.when`, g.when, true);
    return gate;
  });
}

function validateRedStep(c: Check, v: unknown): ProjectConfig["redStep"] {
  const o = c.obj("redStep", v);
  c.only("redStep", o, ["testFiles", "supportFiles", "exclude", "run", "result", "install"]);
  const red: ProjectConfig["redStep"] = {
    testFiles: c.strList("redStep.testFiles", o.testFiles, true),
    supportFiles:
      o.supportFiles === undefined ? [] : c.strList("redStep.supportFiles", o.supportFiles),
    exclude: o.exclude === undefined ? [] : c.strList("redStep.exclude", o.exclude),
    run: c.str("redStep.run", o.run, "must be a non-empty command"),
    result: c.oneOf("redStep.result", o.result, ["junit", "exit-code"] as const),
  };
  if (o.install !== undefined) {
    const i = c.obj("redStep.install", o.install);
    c.only("redStep.install", i, ["when", "run"]);
    red.install = {
      when: c.str("redStep.install.when", i.when),
      run: c.str("redStep.install.run", i.run, "must be a non-empty command"),
    };
  }
  return red;
}

function validateCaps(c: Check, v: unknown): ProjectConfig["caps"] {
  const o = c.obj("caps", v);
  c.only("caps", o, [
    "concurrency",
    "fixRounds",
    "reviewRetries",
    "planRounds",
    "issuesPerNight",
    "wallClockMinutesPerStage",
    "openPullRequests",
    "staleClaimHours",
    "maxTurnsPerStage",
  ]);
  // Enumerated, not iterated over whatever is present: a config without staleClaimHours
  // would otherwise load and make every takeover impossible, silently.
  const n = (name: string) => c.int(`caps.${name}`, o[name], 1);
  const conc = c.obj("caps.concurrency", o.concurrency);
  c.only("caps.concurrency", conc, ["day", "night"]);
  return {
    concurrency: {
      day: c.int("caps.concurrency.day", conc.day, 0),
      night: c.int("caps.concurrency.night", conc.night, 0),
    },
    fixRounds: n("fixRounds"),
    reviewRetries: n("reviewRetries"),
    planRounds: n("planRounds"),
    issuesPerNight: n("issuesPerNight"),
    wallClockMinutesPerStage: n("wallClockMinutesPerStage"),
    openPullRequests: n("openPullRequests"),
    staleClaimHours: n("staleClaimHours"),
    maxTurnsPerStage: o.maxTurnsPerStage === undefined ? 200 : n("maxTurnsPerStage"),
  };
}

function validateSchedule(c: Check, v: unknown): ProjectConfig["schedule"] {
  const o = c.obj("schedule", v);
  c.only("schedule", o, ["timezone", "profiles"]);
  const p = c.obj("schedule.profiles", o.profiles);
  c.only("schedule.profiles", p, ["day", "nightStopsTakingWorkAt"]);
  const day = c.obj("schedule.profiles.day", p.day);
  c.only("schedule.profiles.day", day, ["from", "to"]);
  return {
    timezone: c.str("schedule.timezone", o.timezone),
    profiles: {
      day: {
        from: c.hhmm("schedule.profiles.day.from", day.from),
        to: c.hhmm("schedule.profiles.day.to", day.to),
      },
      nightStopsTakingWorkAt: c.hhmm(
        "schedule.profiles.nightStopsTakingWorkAt",
        p.nightStopsTakingWorkAt,
      ),
    },
  };
}

/** `codeReview` and `planReview` are optional; a threshold is 1-10, the scorer's rubric. */
function score(c: Check, key: string, v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 10)
    throw c.bad(key, "must be an integer from 1 to 10", v);
  return v as number;
}

function validateCodeReview(c: Check, v: unknown): ProjectConfig["codeReview"] {
  const o = c.block("codeReview", v);
  c.only("codeReview", o, ["angles", "scoreThreshold"]);
  const raw = o.angles === undefined ? [...CODE_REVIEW_ANGLES] : o.angles;
  if (!Array.isArray(raw) || raw.length === 0)
    throw c.bad("codeReview.angles", "must list at least one angle", raw);
  for (const a of raw)
    if (!CODE_REVIEW_ANGLES.includes(a as CodeReviewAngle))
      throw c.fail(
        `codeReview.angles has an unknown angle ${show(a)}; known are ${CODE_REVIEW_ANGLES.join(", ")}`,
      );
  if (!raw.includes("criteria"))
    throw c.fail(
      'codeReview.angles must include "criteria": the review states a verdict on every acceptance criterion, and a review without that reading cannot be decided',
    );
  if (new Set(raw).size !== raw.length)
    throw c.fail(`codeReview.angles repeats an angle: ${show(raw)}`);
  return {
    angles: raw as CodeReviewAngle[],
    scoreThreshold:
      o.scoreThreshold === undefined ? 7 : score(c, "codeReview.scoreThreshold", o.scoreThreshold),
  };
}

function validateQueueAndLabels(c: Check, raw: Rec): Pick<ProjectConfig, "queue" | "labels"> {
  const q = c.obj("queue", c.need("", raw, "queue"));
  c.only("queue", q, ["ready", "priority"]);
  const l = c.obj("labels", c.need("", raw, "labels"));
  const names = ["working", "blocked", "needsShaping", "fixRound", "reviewRetry"] as const;
  c.only("labels", l, names);
  const labels = {} as ProjectConfig["labels"];
  const queue = {
    ready: c.str("queue.ready", q.ready),
    priority: q.priority === undefined ? [] : c.strList("queue.priority", q.priority),
  };
  // Two states sharing a label cannot be told apart on the issue.
  const seen = new Map<string, string>([[queue.ready, "queue.ready"]]);
  for (const name of names) {
    const value = c.str(`labels.${name}`, l[name]);
    const other = seen.get(value);
    if (other !== undefined)
      throw c.fail(`labels.${name} repeats the label of ${other}: ${show(value)}`);
    seen.set(value, `labels.${name}`);
    labels[name] = value;
  }
  return { queue, labels };
}

function validateRules(c: Check, raw: Rec): Pick<ProjectConfig, "humanApproval" | "labelRules"> {
  const list = (key: string): unknown[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw c.bad(key, "must be a list", v);
    return v;
  };
  const humanApproval = list("humanApproval").map((r, i) => {
    const key = `humanApproval[${i}]`;
    const o = c.obj(key, r);
    c.only(key, o, ["paths", "label"]);
    return {
      paths: c.strList(`${key}.paths`, o.paths, true),
      label: c.str(`${key}.label`, o.label),
    };
  });
  const labelRules = list("labelRules").map((r, i) => {
    const key = `labelRules[${i}]`;
    const o = c.obj(key, r);
    c.only(key, o, ["when", "unless", "label", "suppressedBy"]);
    const rule: ProjectConfig["labelRules"][number] = {
      when: c.strList(`${key}.when`, o.when, true),
      label: c.str(`${key}.label`, o.label),
    };
    if (o.unless !== undefined) rule.unless = c.strList(`${key}.unless`, o.unless);
    if (o.suppressedBy !== undefined)
      rule.suppressedBy = c.str(`${key}.suppressedBy`, o.suppressedBy);
    return rule;
  });
  return { humanApproval, labelRules };
}

/** Later-phase keys: validated now so a typo surfaces now, acted on later. */
function validateLaterPhases(c: Check, raw: Rec): Partial<ProjectConfig> {
  const out: Partial<ProjectConfig> = {};
  if (raw.budget !== undefined) {
    const b = c.obj("budget", raw.budget);
    c.only("budget", b, RUNTIMES);
    const budget: NonNullable<ProjectConfig["budget"]> = {};
    for (const rt of RUNTIMES) {
      if (b[rt] === undefined) continue;
      const key = `budget.${rt}`;
      const e = c.obj(key, b[rt]);
      c.only(key, e, ["fiveHourPct", "weeklyPct"]);
      const pct = (name: "fiveHourPct" | "weeklyPct") => {
        const x = e[name];
        if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 100)
          throw c.bad(`${key}.${name}`, "must be a number from 0 to 100", x);
        return x;
      };
      budget[rt] = { fiveHourPct: pct("fiveHourPct"), weeklyPct: pct("weeklyPct") };
    }
    out.budget = budget;
  }
  if (raw.triage !== undefined) {
    const t = c.obj("triage", raw.triage);
    c.only("triage", t, ["since", "optInLabel", "maxPerDay", "at"]);
    const triage: NonNullable<ProjectConfig["triage"]> = {};
    if (t.since !== undefined) {
      const ok =
        typeof t.since === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(t.since) &&
        !Number.isNaN(Date.parse(`${t.since}T00:00:00Z`)) &&
        new Date(`${t.since}T00:00:00Z`).toISOString().startsWith(t.since);
      if (!ok) throw c.bad("triage.since", "must be an ISO date (YYYY-MM-DD)", t.since);
      triage.since = t.since as string;
    }
    if (t.optInLabel !== undefined) triage.optInLabel = c.str("triage.optInLabel", t.optInLabel);
    if (t.maxPerDay !== undefined) triage.maxPerDay = c.int("triage.maxPerDay", t.maxPerDay, 1);
    if (t.at !== undefined) triage.at = c.hhmm("triage.at", t.at);
    out.triage = triage;
  }
  if (raw.automerge !== undefined) {
    const a = c.obj("automerge", raw.automerge);
    c.only("automerge", a, ["enabled", "label", "categories", "method"]);
    out.automerge = {
      enabled: c.bool("automerge.enabled", a.enabled),
      label: c.str("automerge.label", a.label),
      categories: c.strList("automerge.categories", a.categories),
      method: c.oneOf("automerge.method", a.method, ["squash", "merge", "rebase"] as const),
    };
  }
  return out;
}

const TOP_LEVEL = [
  "autoclaude",
  "forge",
  "branches",
  "branchPrefix",
  "humans",
  "bootstrap",
  "gates",
  "redStep",
  "worktrees",
  "stages",
  "codeReview",
  "planReview",
  "queue",
  "labels",
  "humanApproval",
  "labelRules",
  "requiredChecks",
  "forbiddenPaths",
  "policyAdjacentPaths",
  "policyAdjacentReason",
  "fence",
  "caps",
  "schedule",
  "budget",
  "triage",
  "automerge",
  "messages",
] as const;

const REQUIRED = [
  "autoclaude",
  "branches",
  "gates",
  "redStep",
  "stages",
  "queue",
  "labels",
  "requiredChecks",
  "forbiddenPaths",
  "caps",
  "schedule",
] as const;

/**
 * Validates a parsed document and returns it with the defaults applied. `file` is the
 * name every message starts with: `config.json`, or `config.local.json` when the merged
 * document fails after `config.json` alone was fine.
 */
export function validateConfig(file: string, doc: unknown): ProjectConfig {
  const c = new Check(file);
  const raw = c.obj("config", doc);
  c.only("", raw, TOP_LEVEL);
  for (const key of REQUIRED)
    if (raw[key] === undefined) throw c.fail(`missing required key "${key}"`);

  if (typeof raw.autoclaude !== "string" || !ENGINE_RANGE.test(raw.autoclaude))
    throw c.bad("autoclaude", 'must be a range like ">=0.1.0"', raw.autoclaude);

  const forge = c.block("forge", raw.forge);
  c.only("forge", forge, ["remote"]);
  const branches = c.obj("branches", raw.branches);
  c.only("branches", branches, ["integration", "production"]);
  const integration = c.str("branches.integration", branches.integration);
  const production = c.str("branches.production", branches.production);
  // Merging a branch into itself is the one branch mistake a config can encode.
  if (integration === production)
    throw c.fail(
      `branches.production must differ from branches.integration but both are ${show(production)}`,
    );

  const branchPrefix = raw.branchPrefix === undefined ? "agent/" : raw.branchPrefix;
  if (typeof branchPrefix !== "string" || !/^[a-z0-9-]+\/$/.test(branchPrefix))
    throw c.bad("branchPrefix", "must be lowercase and end with a slash", branchPrefix);

  const worktrees = c.block("worktrees", raw.worktrees);
  c.only("worktrees", worktrees, ["root", "copy"]);
  const fence = c.block("fence", raw.fence);
  c.only("fence", fence, ["allow"]);
  const messages = c.block("messages", raw.messages);
  c.only("messages", messages, ["footer", "defuseMentions"]);
  const planReview = c.block("planReview", raw.planReview);
  c.only("planReview", planReview, ["scoreThreshold"]);

  const cfg: ProjectConfig = {
    autoclaude: raw.autoclaude,
    forge: { remote: forge.remote === undefined ? "origin" : c.str("forge.remote", forge.remote) },
    branches: { integration, production },
    branchPrefix,
    humans: raw.humans === undefined ? [] : c.strList("humans", raw.humans),
    gates: validateGates(c, raw.gates),
    redStep: validateRedStep(c, raw.redStep),
    worktrees: {
      root:
        worktrees.root === undefined
          ? ".autoclaude/worktrees"
          : c.str("worktrees.root", worktrees.root),
      copy: worktrees.copy === undefined ? [] : c.strList("worktrees.copy", worktrees.copy),
    },
    stages: validateStages(c, raw.stages),
    codeReview: validateCodeReview(c, raw.codeReview),
    planReview: {
      scoreThreshold:
        planReview.scoreThreshold === undefined
          ? 7
          : score(c, "planReview.scoreThreshold", planReview.scoreThreshold),
    },
    ...validateQueueAndLabels(c, raw),
    ...validateRules(c, raw),
    requiredChecks: c.strList("requiredChecks", raw.requiredChecks, true),
    forbiddenPaths: c.strList("forbiddenPaths", raw.forbiddenPaths, true),
    policyAdjacentPaths:
      raw.policyAdjacentPaths === undefined
        ? []
        : c.strList("policyAdjacentPaths", raw.policyAdjacentPaths),
    fence: { allow: fence.allow === undefined ? [] : c.strList("fence.allow", fence.allow) },
    caps: validateCaps(c, raw.caps),
    schedule: validateSchedule(c, raw.schedule),
    ...validateLaterPhases(c, raw),
    messages: {
      footer:
        messages.footer === undefined
          ? "Generated by autoclaude"
          : c.str("messages.footer", messages.footer),
      defuseMentions:
        messages.defuseMentions === undefined
          ? true
          : c.bool("messages.defuseMentions", messages.defuseMentions),
    },
  };
  if (raw.bootstrap !== undefined)
    cfg.bootstrap = c.str("bootstrap", raw.bootstrap, "must be a non-empty command");
  if (raw.policyAdjacentReason !== undefined)
    cfg.policyAdjacentReason = c.str("policyAdjacentReason", raw.policyAdjacentReason);
  return cfg;
}
