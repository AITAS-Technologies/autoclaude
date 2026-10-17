AUTODEV-PLAN-REVIEW
issue: 12
scored-by: sonnet
findings:
  - rule: plan/invented-interface
    confidence: 9
    file: .autoclaude/state/plans/12.md
    line: 14
    evidence: "fetchProfile(prompt, { readBody: true })"
    message: fetchProfile takes one argument; src/server/api/client.ts:41 reads `export async function fetchProfile(input: ProfileInput)`.
  - rule: plan/test-asserts-mock
    confidence: 7
    file: .autoclaude/state/plans/12.md
    line: 22
    evidence: "expect(fetchMock).toHaveBeenCalledWith(...)"
    message: The test as described asserts the call, not the behaviour the criterion names.
uncertain:
  - plan/out-of-scope — the trim helper may be more than criterion 3 asks for
PLAN-REVIEW-STATUS: complete
