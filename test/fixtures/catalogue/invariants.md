# Invariants (test fixture)

A generic project half of the rule catalogue: six rows in two families.

| Rule id                           | Level   | What to inspect                                      | A breach looks like                                   | Evidence    |
| --------------------------------- | ------- | ---------------------------------------------------- | ----------------------------------------------------- | ----------- |
| `example/no-console-in-handlers`  | error   | every request handler the diff adds or changes       | a handler that calls `console.log` with request data | line        |
| `example/public-config-only`      | error   | every value the diff reads from the environment      | a secret read into code that ships to the client      | line        |
| `layer/auth-in-server`            | error   | every route the diff adds                            | a route that checks the caller only in the client     | line        |
| `layer/schema-file-first`         | error   | the changed file list against the schema directory   | a schema change with no schema file in the diff       | measurement |
| `example/naming`                  | warning | the names the diff introduces                        | a name that breaks the project's naming convention    | line        |
| `example/docs-updated`            | note    | the docs that describe the behaviour the diff alters | a behaviour change with its documentation left as is  | line        |
