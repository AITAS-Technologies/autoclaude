AUTODEV-PLAN
issue: 56
status: planned
reason:
db-migration-required: no
plan-file: .autoclaude/state/plans/56.md
files:
  - src/server/api/client.ts — modified — read and surface the response body on non-2xx
tests-first:
  - tests/unit/server/api/client.test.ts — a 413 with a JSON body yields the body's message
criteria-covered:
  1. fetchProfile reports the API's own message on a size error — tests/unit/server/api/client.test.ts
risks:
  - none
AUTODEV-PLAN-END
