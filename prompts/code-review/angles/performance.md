# Code review: the `performance` reading

Your angle is `performance`: what issue #{{issue}}'s change does to the work its hot paths do, and to
when they do it. Your brief is the last section of this prompt; the rules before it hold for every
angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `performance`

For every changed hot path — a loop over a collection nothing bounds, a render path, a request
handler, an event or change callback, a timer or a scheduler, a query — four questions: what ran
before, what runs now, per what unit, and _when_ it runs. A change to when something runs is a change
to behaviour, not a matter of taste. Argued with a mechanism quoted from the source and a scenario
that reaches it, it is `perf/regression`; with one of the two missing it is `perf/inefficiency`,
which still quotes its line.

When an update moves to a path that runs sooner or at a higher priority than before, say what that
does to work already in flight: name every piece of in-flight work it can interrupt or force to
start again, and quote the scheduling rule from the source — the regression is then in two places,
where the update is scheduled and where the interrupted work is started, and both are named.

Something appended per event, render or request with nothing that ever removes an entry is
`perf/unbounded-growth`. A notification loop over a live collection is judged for three listeners —
one that adds or removes during the pass, one that throws and stops the rest, one that re-enters the
dispatch — and a copy taken before the pass answers all three; iterating the live collection is
`bug/mutation-during-iteration` when any of the three can happen, and the loop body or a callback it
can reach adding to or removing from the collection is the same rule.
