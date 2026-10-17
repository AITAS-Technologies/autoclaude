# Code review: the `tests` reading

Your angle is `tests`: the tests issue #{{issue}}'s change adds or changes, and the code it adds that
no test reaches. Your brief is the last section of this prompt; the rules before it hold for every
angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `tests`

For every test the diff adds or changes, in this order:

1. Would the assertion fail with the change reverted, or does it hold either way
   (`tests/passes-without-change`)?
2. Does an assertion that something does _not_ happen have a positive control beside it, a sibling
   test showing the same counter counting (`tests/no-positive-control`)?
3. Does every handler, branch or exported function the diff adds have a test that reaches it
   (`tests/handler-untested`)?
4. Does a test assert only that a double was called, saying nothing about the result the caller gets
   (`tests/asserts-mock`)?
5. Does an assertion hold for every possible implementation — a value compared with itself, a
   constant the test set — which is `tests/proves-nothing`?

Setup that starts a timer, a listener, a server or a subscription and never stops it is
`tests/teardown`; a helper written beside one that already does the job is `tests/duplicate-helper`.

The engine runs the red step itself — the new and changed tests against the integration base and the
head — and files what it measures; do not run it, and do not run the whole suite.
