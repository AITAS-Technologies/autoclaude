import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeAdapter, StageRequest, StageResult } from "../../src/runtimes/types.js";

export interface FakeRuntimeOptions {
  /** Written to `<req.cwd>/.autoclaude/state/reports/<file>` when the stage starts. */
  report?: { file: string; text: string };
  /** Merged over the default `ok` result. */
  result?: Partial<StageResult>;
  /** The pid the "child" reports; default: this process, whose start time is readable. */
  pid?: number;
  /** `start()` throws this synchronously (a settings.json write into a missing run dir, say). */
  throwOnStart?: Error;
  /** When set, `done` stays pending until the test calls `finish()`. */
  hold?: boolean;
  /** Runs inside `start()`, before the report is written (to record ordering). */
  onStart?: (req: StageRequest) => void;
}

export interface FakeRuntime extends RuntimeAdapter {
  requests: StageRequest[];
  /** Resolves a held `done`. */
  finish(): void;
}

/** A `RuntimeAdapter` whose child is scripted: it writes a report file and returns a result. */
export function fakeRuntime(opts: FakeRuntimeOptions = {}): FakeRuntime {
  const requests: StageRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    name: "claude",
    requests,
    finish: () => release(),
    available: async () => ({ ok: true, version: "0.0.0" }),
    start(req) {
      requests.push(req);
      opts.onStart?.(req);
      if (opts.throwOnStart) throw opts.throwOnStart;
      if (opts.report) {
        const dir = join(req.cwd, ".autoclaude", "state", "reports");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, opts.report.file), opts.report.text);
      }
      const pid = opts.pid ?? process.pid;
      const startedAt = new Date().toISOString();
      const result: StageResult = {
        exit: "ok",
        resultText: "",
        stdoutFile: join(req.runDir, "stdout.json"),
        stderrFile: join(req.runDir, "stderr.txt"),
        pid,
        startedAt,
        ...opts.result,
      };
      const done = (opts.hold ? gate : Promise.resolve()).then(() => result);
      return { pid, startedAt, done, kill: async () => {} };
    },
  };
}
