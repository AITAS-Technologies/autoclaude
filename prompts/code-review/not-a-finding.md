## What is not a finding

A pre-existing problem on an untouched line, a nitpick, a general code-quality wish: those are what
the catalogue's `note` rows are for (`scope/follow-up`, `docs/completeness`, `perf/inefficiency`,
`tests/teardown`, `tests/duplicate-helper`). An observation that fits one of those has a `note` rule
of its own, so it is reported as a `later` and read by a human instead of being dropped on the floor;
it quotes its line like everything else, and after the first round it costs nobody a fix round. One
that fits no row at all is still not a finding: say it in `uncertain` or leave it out.

One routing rule sits beside the three items below, and it is not a fourth exclusion. The angles that
read whole files rather than hunks — `invariants`, `history`, `comments`, `performance` — turn up
breaches on lines the diff never touched. Those belong to whoever wrote them, whatever level their row
carries, and an error row above the threshold is a **must**: it would block a change that did not
cause the problem. So a breach on an untouched line goes under `uncertain` with the note
`pre-existing`, naming its file and line, **unless the change made it reachable or worse** — then it
is a finding like any other, and the message says which of the two it is. This is about a rule
breached before the diff, not about the `note` rows above, which describe what _this_ change leaves
behind and stay findings. Either way a human reads it, in the pull request's Uncertain section.

- **Anything a linter, type-checker, compiler or formatter would catch.** Those run as their own
  gates (`gates` in `.autoclaude/config.json`). A finding here costs a whole fix round on something
  that was already blocking, and teaches the implementer that the review is noise.
- **Something silenced on purpose**, with a lint-ignore comment or an explicit note saying why.
- **A change in behaviour that the issue asked for.** Read the criteria before calling a deliberate
  change a regression.
