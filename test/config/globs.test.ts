import { describe, it, expect } from "vitest";
import { matchesAny } from "../../src/config/globs.js";

describe("matchesAny", () => {
  it("lets ** span directories and * stay inside one", () => {
    expect(matchesAny("src/ui/a/b.tsx", ["src/ui/**"])).toBe(true);
    expect(matchesAny("src/ui/b.tsx", ["src/ui/*.tsx"])).toBe(true);
    expect(matchesAny("src/ui/a/b.tsx", ["src/ui/*.tsx"])).toBe(false);
  });

  it("treats **/ as zero or more leading directories", () => {
    expect(matchesAny("x.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(matchesAny("a/b/x.test.ts", ["**/*.test.ts"])).toBe(true);
  });

  it("keeps everything else literal, dots and brackets included", () => {
    expect(matchesAny("package-lock.json", ["package-lock.json"])).toBe(true);
    expect(matchesAny("package-lockXjson", ["package-lock.json"])).toBe(false);
    expect(matchesAny("a+b(1).ts", ["a+b(1).ts"])).toBe(true);
  });

  it("matches nothing for an empty list", () => {
    expect(matchesAny("a.ts", [])).toBe(false);
  });
});
