AUTODEV-CODE-REVIEW
issue: 126
red-step: not-proven
fan-out: criteria, bugs, invariants, history, prior-prs, comments, performance, tests
scored-by: sonnet
criteria:
  1. met — tests/unit/app/api/documents-route.test.ts:41
  2. met — src/server/documents/filename.ts:12
  3. met — src/server/documents/filename.ts:18
findings:
  - rule: tests/passes-without-change
    confidence: 9
    file: tests/unit/app/api/documents-route.test.ts
    line: 41
    evidence: "it('keeps the umlauts in the Content-Disposition header', async () => {"
    message: Both tests added here pass unchanged against the base, so neither would fail if the fix were reverted.
  - rule: bug/general-case
    confidence: 7
    file: src/server/documents/filename.ts
    line: 18
    evidence: "const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');"
    message: Handles the umlaut class but not other Latin-1 letters such as ñ.
  - rule: tests/no-positive-control
    confidence: 8
    file: tests/unit/app/api/documents-route.test.ts
    line: 58
    evidence: "expect(headers.get('X-Fallback')).toBeNull();"
    message: No sibling test shows that header being set, so a broken harness reads as a pass.
  - rule: scope/follow-up
    confidence: 7
    file: src/server/documents/filename.ts
    line: 24
    evidence: "// TODO: the Latin-1 letters beyond the umlauts"
    message: The placeholder is worth its own issue rather than this round.
  - rule: perf/inefficiency
    confidence: 5
    file: src/server/documents/filename.ts
    line: 22
    evidence: "const folded = fold(name);"
    message: The fold may run twice per download, on a path whose cost was not measured.
uncertain:
  - spec/out-of-scope — the ASCII slug helper may be wider than criterion 3 asked for
CODE-REVIEW-STATUS: complete
