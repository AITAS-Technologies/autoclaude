# Code review: the `security` reading

Your angle is `security`: every way into issue #{{issue}}'s change from outside it. Your brief is the
last section of this prompt; the rules before it hold for every angle.

{{> code-review/rules-for-every-angle}}

## Your reading: `security`

For each entry point the diff adds or changes — a route, a handler, a server action, a webhook, a
job, a script that takes arguments — ask who may call it and where that is checked: one that reads,
changes or deletes a resource for a caller it never checked is `security/authz-missing`.

Then follow every value that arrives from outside — a request field, a header, a file name, an
archive entry, a quoted path, a model's output, an argument — to where it is used. Into a file path
it is `security/path-traversal`, unless the resolved path is checked against the directory the code
meant; into the host or URL of an outbound request, `security/ssrf`; into a redirect target,
`security/open-redirect`; into anything that builds objects or runs code from it — an eval, a
function constructor, a parser with custom types, a recursive merge that walks `__proto__` —
`security/unsafe-deserialisation`; into an interpreter, `bug/injection`, cited under that id.

A credential in the source, or a secret value written to a log line, an error message, a response or
a browser bundle, is `security/secret-exposed`. A dependency the diff adds or upgrades is read for
what installing it runs and who publishes it, `security/dependency-risk`, quoting the manifest line.

Where the project's own catalogue states a rule for its own architecture — which layer checks
authorisation, which client bypasses the data layer's access rules, which variables reach the
browser — leave it to the `invariants` reading, which walks every one of those rows: yours are the
ways in that no project row names. As in the `bugs` reading, name the input that gets in; a way in
you cannot name is `uncertain`.
