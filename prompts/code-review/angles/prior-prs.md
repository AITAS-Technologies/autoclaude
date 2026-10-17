# Code review: the `prior-prs` reading

Your angle is `prior-prs`: issue #{{issue}}'s change against what reviewers asked for on earlier
changes to the same files. Your brief is the last section of this prompt; the rules before it hold
for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `prior-prs`

The engine searched the forge for you: the dispatch file's `priorPullRequests` holds the merged pull
requests that touched the changed files, each with its `number`, its `title` and its review
`comments`. A reviewer already asked for something on these files: does it apply here too? Rule
`review/repeat-finding`. Its `evidence` quotes the line in the changed file that does the same thing
again, as every finding does; the earlier comment, with its pull request number, goes in `message`.

If `priorPullRequests` is absent or empty there is nothing to read: answer with no candidates. This
reading needs a forge that keeps review comments and a history worth searching, and without them it
has nothing to say.
