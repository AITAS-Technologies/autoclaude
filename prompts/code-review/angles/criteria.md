# Code review: the `criteria` reading

Your angle is `criteria`: the change against the issue's acceptance criteria, for issue #{{issue}}.
Your brief is the last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `criteria`

For each acceptance criterion, find the lines in the diff that satisfy it and quote them. A
criterion with no quotable evidence is `spec/criterion-not-met`. Anything in the diff that no
criterion asked for is `spec/out-of-scope`, quoting the hunk.

**A criterion with no evidence in the diff is a measurement, not a claim about a line**, and the
drop rule does not reach it: you measured the criterion against the diff, with nothing left to
interpret. Mark it not met in `criteria` and file one `spec/criterion-not-met` candidate for it — one
candidate per criterion, never one for two. It has no diff line to quote, so write the file the
criterion should have been satisfied in as `file` — `""` when the change never touched one —
`"line": null`, and as `evidence` the criterion's own text quoted from the issue. That quote is what
tells two such findings apart from one round to the next. File it at the rubric's top rung, 9 or 10:
the line was opened and the measurement was made; nothing about it was inferred from a pattern.

Every criterion you mark not met needs its own candidate, and every `spec/criterion-not-met`
candidate needs its criterion marked not met: the report the engine assembles from yours has to add
up, and a report that says `not met` without a matching must does not parse.

If the dispatch file carries no acceptance criteria to check — a pull request review whose pull
request names no issue — write `criteria` as `[]` and file no `spec/criterion-not-met`.

Besides `candidates` and `uncertain`, your answer carries `criteria`: one entry per acceptance
criterion, in the issue's order, each with

- `n`: the criterion's number, counting from 1 in the issue's order;
- `met`: `true` when the diff carries evidence for it, `false` when it does not;
- `where`: where you found the evidence, as `file:line` — not a restatement of the criterion — or,
  when `met` is `false`, why there is none.
