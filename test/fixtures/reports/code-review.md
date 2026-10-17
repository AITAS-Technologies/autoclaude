AUTODEV-CODE-REVIEW
issue: 42
red-step: not-proven
fan-out: criteria, bugs, invariants, history, prior-prs, comments, performance, tests
scored-by: sonnet
criteria:
  1. met — tests/unit/lib/format.test.ts:41
  2. met — src/lib/format.ts:12
  3. met — src/lib/format.ts:18
findings:
  - rule: tests/passes-without-change
    confidence: 9
    file: tests/unit/lib/format.test.ts
    line: 41
    evidence: "it('trims the label before it is shown', async () => {"
    message: Both tests added here pass unchanged against the base, so neither would fail if the fix were reverted.
  - rule: bug/general-case
    confidence: 7
    file: src/lib/format.ts
    line: 18
    evidence: "const label = name.trim().replace(/ +/g, ' ');"
    message: Collapses spaces but not tabs or other whitespace.
  - rule: tests/no-positive-control
    confidence: 8
    file: tests/unit/lib/format.test.ts
    line: 58
    evidence: "expect(labels.get('suffix')).toBeNull();"
    message: No sibling test shows that suffix being set, so a broken harness reads as a pass.
  - rule: scope/follow-up
    confidence: 7
    file: src/lib/format.ts
    line: 24
    evidence: "// TODO: handle tabs and other whitespace"
    message: The placeholder is worth its own issue rather than this round.
  - rule: perf/inefficiency
    confidence: 5
    file: src/lib/format.ts
    line: 22
    evidence: "const folded = collapse(name);"
    message: The collapse may run twice per call, on a path whose cost was not measured.
uncertain:
  - spec/out-of-scope — the shared trim helper may be wider than criterion 3 asked for
CODE-REVIEW-STATUS: complete
