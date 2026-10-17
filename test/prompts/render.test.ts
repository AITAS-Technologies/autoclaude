import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDispatch, type Dispatch } from "../../src/prompts/dispatch.js";
import { renderTemplate } from "../../src/prompts/render.js";

const none = (p: string): string => {
  throw new Error(`unexpected include ${p}`);
};
const files = (m: Record<string, string>) => (p: string) => {
  const v = m[p];
  if (v === undefined) throw new Error(`missing ${p}`);
  return v;
};

describe("renderTemplate", () => {
  it("substitutes variables", () => {
    expect(renderTemplate("a {{x}} b {{y_2}} {{x}}", { x: "1", y_2: "2" }, none, "t.md")).toBe(
      "a 1 b 2 1",
    );
  });

  it("allows unused variables", () => {
    expect(renderTemplate("hi", { x: "1" }, none, "t.md")).toBe("hi");
  });

  it("throws on an unknown variable naming it", () => {
    expect(() => renderTemplate("a {{nope}}", {}, none, "t.md")).toThrow(/nope/);
  });

  it("expands includes, appending .md when absent", () => {
    const read = files({ "common/rules.md": "RULES {{x}}", "b.md": "B" });
    expect(renderTemplate("{{> common/rules}} | {{> b.md}}", { x: "1" }, read, "t.md")).toBe(
      "RULES 1 | B",
    );
  });

  it("expands nested includes", () => {
    const read = files({ "a.md": "A[{{> b}}]", "b.md": "B" });
    expect(renderTemplate("{{> a}}", {}, read, "t.md")).toBe("A[B]");
  });

  it("throws on an include cycle naming the chain", () => {
    const read = files({ "a.md": "{{> b}}", "b.md": "{{> a}}" });
    expect(() => renderTemplate("{{> a}}", {}, read, "t.md")).toThrow(/a\.md.*b\.md.*a\.md/);
  });

  it.each(["../secret", "/etc/passwd", "a/../../x", "C:/x", "a\\..\\..\\x"])(
    "rejects an include path that escapes prompts/: %s",
    (p) => {
      expect(() => renderTemplate(`{{> ${p}}}`, {}, files({}), "t.md")).toThrow(
        /escape|outside|invalid/i,
      );
    },
  );

  it("throws on an unreplaced {{ that is not a variable or include", () => {
    expect(() => renderTemplate("a {{ bad name }}", {}, none, "t.md")).toThrow(/\{\{/);
    expect(() => renderTemplate("a {{", {}, none, "t.md")).toThrow(/\{\{/);
    expect(() => renderTemplate("{{1x}}", {}, none, "t.md")).toThrow(/\{\{/);
  });

  it("inserts values verbatim and never re-scans them", () => {
    expect(renderTemplate("<{{x}}> {{y}}", { x: "{{y}} {{> z}} {{", y: "Y" }, none, "t.md")).toBe(
      "<{{y}} {{> z}} {{> Y",
    );
  });

  it("does not interpret $ patterns in values", () => {
    expect(renderTemplate("{{x}}", { x: "$& $1 $$" }, none, "t.md")).toBe("$& $1 $$");
  });

  it("names the template for a top-level unknown variable", () => {
    expect(() => renderTemplate("{{gone}}", {}, none, "top.md")).toThrow(/gone.*top.md/);
  });

  it("names the included file for an unknown variable inside an include", () => {
    const read = files({ "inc.md": "{{gone}}" });
    expect(() => renderTemplate("{{> inc}}", {}, read, "top.md")).toThrow(/gone.*inc.md.*top.md/);
  });

  it("names the included file for a stray {{ inside an include", () => {
    const read = files({ "inc.md": "x {{ bad }}" });
    expect(() => renderTemplate("{{> inc}}", {}, read, "top.md")).toThrow(/inc.md.*top.md/);
  });
});

describe("writeDispatch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes <runDir>/dispatch.json as pretty LF JSON, creating runDir", () => {
    const base = mkdtempSync(join(tmpdir(), "dispatch-é "));
    dirs.push(base);
    const d: Dispatch = {
      issue: {
        number: 7,
        title: "T $(x)",
        body: "line1\nline2",
        labels: ["a"],
        comments: [{ author: "u", body: "c", createdAt: "2026-01-01T00:00:00Z" }],
      },
      mode: "fresh",
      worktree: "/w",
      integrationRef: "origin/main",
      reportFile: "/w/r.md",
      planFile: "/w/p.md",
      projectFacts: { projectMd: "p", invariantsMd: "i", engineRulesMd: "e" },
    };
    const path = writeDispatch(join(base, "nested", "run"), d);
    expect(path).toBe(join(base, "nested", "run", "dispatch.json"));
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("\r");
    expect(text).toContain('\n  "issue"');
    expect(JSON.parse(text)).toEqual(d);
  });
});
