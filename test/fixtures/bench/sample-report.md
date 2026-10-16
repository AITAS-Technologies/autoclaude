AUTODEV-CODE-REVIEW
issue: 7
red-step: proven
fan-out: criteria, bugs, invariants, history, prior-prs, comments, performance, tests
scored-by: sonnet
criteria:
  1. met — src/lib/pager.ts:42
  2. met — src/lib/pager.ts:57
findings:
  - rule: bug/boundary
    confidence: 9
    file: src/lib/pager.ts
    line: 42
    evidence: "const last = items.length / size;"
    message: An empty list or one page of items yields a fractional last page index.
  - rule: bug/inverted-condition
    confidence: 7
    file: src/lib/pager.ts
    line: 57
    evidence: "if (!hasNext) return next(cursor);"
    message: The branch advances the cursor exactly when there is no next page.
  - rule: tests/no-positive-control
    confidence: 8
    file: tests/lib/pager.test.ts
    line: 31
    evidence: "expect(pages.get('next')).toBeNull();"
    message: No sibling test shows that key being set, so a broken harness reads as a pass.
  - rule: perf/unbounded-growth
    confidence: 8
    file: src\lib\cache.ts
    line: 14
    evidence: "seen.push(page);"
    message: Every page request appends an entry that nothing ever removes.
  - rule: tests/teardown
    confidence: 7
    file: tests/lib/pager.test.ts
    line: 12
    evidence: "const timer = setInterval(tick, 10);"
    message: The timer is started in setup and never cleared.
  - rule: docs/completeness
    confidence: 7
    file: docs/paging.md
    line: 3
    evidence: "Pages are numbered from zero."
    message: The document still describes the old numbering.
uncertain:
  - bug/general-case — the clamp in guardrail.ts may not hold for a page size of zero
  - perf/unbounded-growth — the sorted scan was never measured against a long list
CODE-REVIEW-STATUS: complete
