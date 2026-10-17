import type { ProjectConfig } from "../config/types.js";

/**
 * Every label the configuration names, once each: the queue and working labels, the three
 * state labels, the numbered fix-round and retry counters, the labels of `humanApproval`
 * and of `labelRules` (including the label that suppresses a rule).
 */
export function labelsOf(cfg: ProjectConfig): string[] {
  const names = [
    cfg.queue.ready,
    cfg.labels.working,
    cfg.labels.blocked,
    cfg.labels.needsShaping,
    ...Array.from({ length: cfg.caps.fixRounds }, (_, i) => `${cfg.labels.fixRound}${i + 1}`),
    ...Array.from(
      { length: cfg.caps.reviewRetries },
      (_, i) => `${cfg.labels.reviewRetry}${i + 1}`,
    ),
    ...cfg.humanApproval.map((h) => h.label),
    ...cfg.labelRules.flatMap((r) => [r.label, ...(r.suppressedBy ? [r.suppressedBy] : [])]),
  ];
  return [...new Set(names)];
}
