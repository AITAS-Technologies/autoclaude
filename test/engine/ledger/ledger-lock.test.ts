import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  emptyLedger,
  loadLedger,
  saveLedger,
  withLedgerLockAsync,
} from "../../../src/engine/ledger/ledger.js";

/**
 * The lock exists for mutual exclusion between processes, and a single-process test
 * cannot see it: replacing the atomic `mkdirSync` with a check-then-create keeps such a
 * test green. So this one runs several processes **at the same time** and has each hold
 * the lock long enough to overlap. It fails when the acquisition stops being atomic.
 *
 * The children are plain `node` processes (`process.execPath`, no shell) running the
 * TypeScript sources through test/helpers/ts-register.mjs, so a path with spaces works
 * and nothing is left behind: every child exits on its own and is awaited.
 */
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "autoclaude lockrace-"));
  roots.push(r);
  const ledger = emptyLedger("me");
  ledger.limitedUntil = "0";
  saveLedger(r, ledger);
  return r;
}

const register = pathToFileURL(resolve("test/helpers/ts-register.mjs")).href;
const workerFile = resolve("test/helpers/lock-worker.ts");

/** Starts a worker; `ready` resolves when it prints "held" (hold mode), `done` when it exits. */
function worker(mode: string, r: string, arg: string) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      register,
      "--disable-warning=ExperimentalWarning",
      workerFile,
      mode,
      r,
      arg,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  let onHeld: () => void = () => {};
  const ready = new Promise<void>((res) => (onHeld = res));
  child.stdout.on("data", (d) => {
    out += String(d);
    if (out.includes("held")) onHeld();
  });
  child.stderr.on("data", (d) => (err += String(d)));
  const done = new Promise<number | null>((res) =>
    child.on("close", (code) => {
      if (code !== 0) console.error(`lock-worker ${mode} exited ${code}: ${err.slice(-800)}`);
      onHeld();
      res(code);
    }),
  );
  return { ready, done };
}

const ROUNDS = 40;
const WORKERS = 3;

describe("withLedgerLock across processes", () => {
  it("loses no update when several processes write the same ledger at once", async () => {
    const r = root();
    const codes = await Promise.all(
      Array.from({ length: WORKERS }, () => worker("count", r, String(ROUNDS)).done),
    );
    // Every worker must have finished cleanly, or the count below proves nothing.
    for (const code of codes) expect(code).toBe(0);
    expect(Number(loadLedger(r, "me").limitedUntil)).toBe(WORKERS * ROUNDS);
  }, 180_000);

  it("waits for the lock without blocking the event loop", async () => {
    const r = root();
    const holder = worker("hold", r, "1000");
    await holder.ready;
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    let entered = 0;
    try {
      await withLedgerLockAsync(r, async () => {
        entered = Date.now() - started;
      });
    } finally {
      clearInterval(timer);
    }
    expect(await holder.done).toBe(0);
    // The child held the lock about a second; a blocked loop would have counted ~0 ticks.
    expect(entered, "it really waited for the holder").toBeGreaterThan(300);
    expect(ticks, "the event loop kept running while it waited").toBeGreaterThan(10);
  }, 30_000);

  it("releases the lock after an async body, also when it throws", async () => {
    const r = root();
    await expect(
      withLedgerLockAsync(r, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withLedgerLockAsync(r, () => 7, 500)).toBe(7);
  });
});
