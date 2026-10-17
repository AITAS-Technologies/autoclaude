# Code review: the `bugs` reading

Your angle is `bugs`: does the code of issue #{{issue}}'s change actually do what it appears to do.
Your brief is the last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `bugs`

This is the angle that earns the review. The other readings check the change against things written
down: the criteria, the tests, the rules. This one has nothing to check against, and it is the one
that matters most on agent work.

An agent's diff fails differently from a person's. It rarely looks wrong. It calls an API with a
signature that API does not have, reads a field that does not exist on the type, satisfies the
example in the issue while missing the general case, or handles the happy path and quietly does the
wrong thing on the edge. Every one of those compiles, lints, and passes the tests the same agent
wrote.

So read the new logic as if you had to make it fail, and look for:

- **An invented interface.** A function called with arguments, an options object with keys, a
  property read off a result — check each against the definition, not against what it plausibly
  ought to be.
- **A boundary.** Empty input, one element, the maximum, zero, a negative number, the last index.
  What does the new branch do there?
- **An inverted or dead condition.** A negation too many, an `else` that cannot be reached, a check
  after the value was already used.
- **The general case behind the example.** The issue said "an accented letter is kept". Does the
  code handle that letter, or that class of characters?
- **An error path.** Something caught and swallowed, a failure reported as success, a default
  returned where the caller cannot tell it from a real answer.
- **Something left open.** Acquired and not released, awaited and not, started and not cancelled.

A finding here uses the rule family `bug/`, with a short suffix naming the kind: `bug/wrong-api`,
`bug/boundary`, `bug/inverted-condition`, `bug/general-case`, `bug/error-swallowed`, `bug/leak`,
`bug/race`, `bug/injection`, `bug/enum-incomplete`. Every row of that family is an `error` in the
catalogue, so what separates "wrong for a reachable input" from "fragile but currently correct" is
the confidence, not the rule: the first is a 9 or a 10 with the input named, the second a 7.

The last three name kinds this family kept missing; the taxonomy is from the `/review` command of
[gstack](https://github.com/garrytan/gstack) (MIT, Copyright (c) 2026 Garry Tan), and nothing of it
is copied here. `bug/race` is two operations whose order is relied on but not guaranteed.
`bug/injection` is untrusted input reaching an interpreter — SQL, a shell, a template, a model
prompt.

`bug/enum-incomplete` needs a rule of its own. When a change adds a value to a set, the sibling
handlers that must also learn about it are **outside the diff by definition**, so a reviewer who
reads only the diff cannot see them. For this one class, search the repository past the diff for the
other handlers of that set. Everything else about a finding still holds: quote what you found, with
its file and line.

The evidence rule is stricter here than anywhere else, because this is where a plausible-sounding
finding costs the most. Quote the line, **and name the input that breaks it**. "This might not handle
unicode" is not a finding. "With `name = '😀'.repeat(81)` line 44 slices mid-surrogate and returns a
replacement character" is.

If you cannot name that input, the observation belongs in `uncertain`, not in `candidates`.
