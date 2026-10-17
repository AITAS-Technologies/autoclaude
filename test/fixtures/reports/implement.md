Some prose the agent wrote before the block.

AUTODEV-REPORT
issue: 42
status: done
reason:
db-migration-required: no
commit: 2a7e958a7b8df67bd77066bcf2d1919a2bb45959
criteria:
  1. met — Leading and trailing spaces are trimmed in the formatted label
  2. not met — Empty input yields an empty label on every platform (verified at unit level only)
tests-added: tests/unit/lib/parse.test.ts, tests/unit/lib/render.test.ts
observed-not-done:
  - legacy.test.ts asserts a behaviour this change does not touch
AUTODEV-REPORT-END
