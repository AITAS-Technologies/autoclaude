// Spike S1 helper: status-line command that appends its stdin payload as one JSON line.
// Output path: argv[2] or $S1_STATUSLINE_OUT. Prints only a short fixed string to stdout.
import { appendFileSync, readFileSync } from "node:fs";
const out = process.argv[2] ?? process.env.S1_STATUSLINE_OUT;
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { /* no stdin */ }
if (out) {
  let line = raw.trim();
  try { line = JSON.stringify(JSON.parse(line)); } catch { line = JSON.stringify({ unparsed: line }); }
  appendFileSync(out, line + "\n");
}
process.stdout.write("s1\n");
