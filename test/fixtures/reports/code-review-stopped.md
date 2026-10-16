AUTODEV-CODE-REVIEW
issue: 42
red-step:
reason:
fan-out:
scored-by:
criteria:
findings:
  - rule: bug/general-case
    confidence: 8
    file: src/lib/format.ts
    line: 18
    evidence: "const label = name.trim().replace(/ +/g, ' ');"
    message: Collapses spaces but not tabs or other whitespace.
uncertain:
  - perf/inefficiency — the collapse may run twice per call, on a path whose cost was not measured
CODE-REVIEW-STATUS: stopped
