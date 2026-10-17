# Code review: the `history` reading

Your angle is `history`: issue #{{issue}}'s change against the history of the lines it rewrites.
Your brief is the last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `history`

Read `git log -n 20 --oneline -- <changed files>`, and `git blame -L <range> <file>` on the hunks the
diff rewrites. Was this line written the way it is on purpose? A change that reverts a fix without
saying so is `bug/undone-fix`. A rule with no history is not a finding.
