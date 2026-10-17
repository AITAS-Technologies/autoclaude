/**
 * The red step's verdict: whether a test the change adds fails against the base.
 *
 * Only the type lives here. Reports state the verdict and the parser reads it, so the
 * report module must not import the red step itself.
 */
export type Verdict =
  | { kind: "proven"; reason: string }
  | { kind: "not-proven"; reason: string }
  | { kind: "could-not-run"; reason: string };
