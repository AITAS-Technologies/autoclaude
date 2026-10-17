# Code review: the `invariants` reading

Your angle is `invariants`: issue #{{issue}}'s change against every row of the project's invariants.
Your brief is the last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `invariants`

Walk every row of the project's invariants, `projectFacts.invariantsMd`, inspect what the row says to
inspect in the files the diff touches, and report a breach with that row's own rule id, copied
verbatim — never inferred from the row's wording, because an id the catalogue does not state is
dropped to `uncertain` as "not in the catalogue" and the finding is lost. The row carries the level;
you carry the confidence.

**Schema changes.** A new file in the migration directory `projectFacts.projectMd` →
`## Schema changes` names is **not** a forbidden path and is not a finding on its own — the
implementer is allowed to write one. Review it like any other change, against the rows of the
invariants that speak about schema changes and about new tables, with those rows' own rule ids, and
say that the diff carries a migration with one line in `uncertain`, `<path>` the migration file:
`schema — the diff carries a migration: <path>`. Absent heading: the project has no migration
procedure, so a file that looks like a migration is itself a finding rather than routine work.
Whether it may be merged is a human's decision, not yours and not the engine's.
