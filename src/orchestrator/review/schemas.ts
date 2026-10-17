/**
 * The four answers a stage process gives as JSON (ruling R10). Each is a JSON Schema object
 * handed to the runtime (`--json-schema`) and a TypeScript type; the prompts under `prompts/`
 * describe the same fields. `validate` checks an answer against one of them, because a
 * runtime that does not enforce its schema must not make an unchecked answer a finding.
 */

export const CandidatesSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule: { type: "string" },
          confidence: { type: "integer", minimum: 1, maximum: 10 },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          evidence: { type: "string" },
          message: { type: "string" },
        },
        required: ["rule", "confidence", "file", "line", "evidence", "message"],
        additionalProperties: false,
      },
    },
    uncertain: { type: "array", items: { type: "string" } },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer", minimum: 1 },
          met: { type: "boolean" },
          where: { type: "string" },
        },
        required: ["n", "met", "where"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates", "uncertain"],
  additionalProperties: false,
} as const;

export const ScoresSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          confidence: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["id", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

export const RecheckSchema = {
  type: "object",
  properties: { met: { type: "boolean" }, where: { type: "string" } },
  required: ["met", "where"],
  additionalProperties: false,
} as const;

/** What triage answers with (see `prompts/triage.md`). */
export const TriageSchema = {
  type: "object",
  properties: {
    decision: { enum: ["ready", "needs-shaping", "skipped"] },
    reason: { type: "string" },
    comment: { type: "string" },
    proposedCriteria: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "reason", "comment"],
  additionalProperties: false,
} as const;

export interface Candidate {
  rule: string;
  confidence: number;
  file: string;
  line: number | null;
  evidence: string;
  message: string;
}
export interface Candidates {
  candidates: Candidate[];
  uncertain: string[];
  criteria?: Array<{ n: number; met: boolean; where: string }>;
}
export interface Scores {
  scores: Array<{ id: number; confidence: number }>;
}
export interface Recheck {
  met: boolean;
  where: string;
}
export interface Triage {
  decision: "ready" | "needs-shaping" | "skipped";
  reason: string;
  comment: string;
  proposedCriteria?: string[];
}

type Schema = {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
  maximum?: number;
};

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "integer":
      return Number.isInteger(v);
    case "null":
      return v === null;
    default:
      return typeof v === t;
  }
}

/** The first way `value` breaks `schema` (the subset used above), or null when it fits. */
export function validate(schema: object, value: unknown, at = "answer"): string | null {
  const s = schema as Schema;
  if (s.enum && !s.enum.some((e) => e === value)) return `${at} is not one of the allowed values`;
  if (s.type) {
    const types = typeof s.type === "string" ? [s.type] : s.type;
    if (!types.some((t) => typeOk(t, value))) return `${at} must be ${types.join(" or ")}`;
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) return `${at} is below ${s.minimum}`;
    if (s.maximum !== undefined && value > s.maximum) return `${at} is above ${s.maximum}`;
  }
  if (Array.isArray(value) && s.items) {
    for (const [i, item] of value.entries()) {
      const e = validate(s.items, item, `${at}[${i}]`);
      if (e) return e;
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && s.properties) {
    const rec = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in rec)) return `${at}.${k} is missing`;
    for (const [k, v] of Object.entries(rec)) {
      const sub = s.properties[k];
      if (!sub) {
        if (s.additionalProperties === false) return `${at}.${k} is not a known field`;
        continue;
      }
      const e = validate(sub, v, `${at}.${k}`);
      if (e) return e;
    }
  }
  return null;
}
