import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { main } from "../../src/cli/main.js";

it("prints the package version", async () => {
  const out: string[] = [];
  expect(await main(["--version"], { out: (s) => out.push(s), err: () => {} })).toBe(0);
  expect(out.join("")).toContain(JSON.parse(readFileSync("package.json", "utf8")).version);
});

it("refuses an unknown verb with exit 64 and the usage", async () => {
  const err: string[] = [];
  expect(await main(["frobnicate"], { out: () => {}, err: (s) => err.push(s) })).toBe(64);
  expect(err.join("")).toMatch(/usage: autoclaude <verb>/i);
});

it("prints the usage on --help and on an empty argv", async () => {
  for (const argv of [["--help"], []]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(code).toBe(argv.length === 0 ? 64 : 0);
    expect((argv.length === 0 ? err : out).join("")).toMatch(/usage: autoclaude <verb>/i);
  }
});
