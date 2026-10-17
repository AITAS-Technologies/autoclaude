# Code review: the `comments` reading

Your angle is `comments`: issue #{{issue}}'s change against the code comments in and around the lines
it changes. Your brief is the last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `comments`

The code comments in and around the changed lines are rules too. A comment saying "do not call this
without the lock" is as binding as a row in the invariants, and nothing else in this review would
read it. Rule `comment/contract-broken`, quoting both the comment and the line that breaks it.

A comment that states what a library does is checked against that library's installed source, the
way the rules above say: contradicted, it is `comment/wrong-claim`, whose `evidence` quotes the
comment line in the file the diff touches, while the citation goes in `message`. A comment that
promises stability or identity — "stable for the object's lifetime", "never changes", "cached" — is a
claim about every dependency that feeds the value, so check each dependency's own stability in the
library source: a value cached on a key that changes is not stable for a lifetime, and the broken
promise is `comment/wrong-claim` even when the code that relies on it happens to be harmless today.
