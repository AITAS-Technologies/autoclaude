Some prose the agent wrote before the block.

AUTODEV-REPORT
issue: 126
status: done
reason:
db-migration-required: no
commit: 2a7e958a7b8df67bd77066bcf2d1919a2bb45959
criteria:
  1. met — Ä, Ö, Ü, ä, ö, ü are preserved in the download file name
  2. not met — ß is preserved on all three operating systems (verified at unit level only)
tests-added: tests/unit/server/documents/renderers.test.ts, tests/unit/server/documents/orchestrator.test.ts
observed-not-done:
  - documents-route.test.ts asserts a route this change does not touch
AUTODEV-REPORT-END
