AUTODEV-CODE-REVIEW
issue: 126
red-step:
reason:
fan-out:
scored-by:
criteria:
findings:
  - rule: bug/general-case
    confidence: 8
    file: src/server/documents/filename.ts
    line: 18
    evidence: "const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');"
    message: Handles the umlaut class but not other Latin-1 letters such as ñ.
uncertain:
  - perf/inefficiency — the fold may run twice per download, on a path whose cost was not measured
CODE-REVIEW-STATUS: stopped
