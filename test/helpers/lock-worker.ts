// A child process for the ledger lock tests; run through test/helpers/ts-register.mjs.
//   lock-worker.ts count <root> <rounds>   increment limitedUntil <rounds> times, with a pause between read and write
//   lock-worker.ts hold <root> <ms>        take the lock, print "held", keep it <ms>, release
import { updateLedger, withLedgerLock } from "../../src/engine/ledger/ledger.js";

const [mode, root, arg] = process.argv.slice(2) as [string, string, string];
const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (mode === "count") {
  for (let i = 0; i < Number(arg); i++) {
    updateLedger(root, (l) => {
      const seen = Number(l.limitedUntil ?? "0");
      wait(2);
      l.limitedUntil = String(seen + 1);
    });
  }
} else if (mode === "hold") {
  withLedgerLock(root, () => {
    console.log("held");
    wait(Number(arg));
  });
} else {
  process.exit(64);
}
