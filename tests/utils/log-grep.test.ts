import { describe, it, expect } from "vitest";
import { grepLog } from "../../src/utils/log-grep.js";

const sample = [
  "[INFO] Starting build",
  "[INFO] Compiling sources",
  "[INFO] Running tests",
  "[ERROR] Test failed: AuthSpec",
  "  expected 200 but got 401",
  "  at AuthSpec.scala:42",
  "[INFO] Cleaning up",
  "[ERROR] Build failed",
].join("\n");

describe("grepLog", () => {
  it("returns matches with surrounding context", () => {
    const out = grepLog(sample, { pattern: "ERROR", before: 1, after: 2 });
    expect(out.matches).toHaveLength(2);
    expect(out.matches[0].lineNumber).toBe(4);
    expect(out.matches[0].context).toEqual([
      { lineNumber: 3, text: "[INFO] Running tests" },
      { lineNumber: 4, text: "[ERROR] Test failed: AuthSpec" },
      { lineNumber: 5, text: "  expected 200 but got 401" },
      { lineNumber: 6, text: "  at AuthSpec.scala:42" },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("supports regex mode", () => {
    const out = grepLog(sample, { pattern: "\\[ERROR\\] [A-Z]", regex: true, before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
  });

  it("does case-insensitive substring match by default", () => {
    const out = grepLog(sample, { pattern: "error", before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
  });

  it("truncates after maxMatches and reports truncated=true", () => {
    const out = grepLog(sample, { pattern: "INFO", maxMatches: 2, before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("rejects invalid regex with a clear error", () => {
    expect(() => grepLog(sample, { pattern: "[invalid", regex: true, before: 0, after: 0 })).toThrow(/Invalid regex/);
  });

  it("does not duplicate context lines when matches overlap", () => {
    const text = ["a", "b ERROR", "c", "d ERROR", "e"].join("\n");
    const out = grepLog(text, { pattern: "ERROR", before: 1, after: 1 });
    // matches at line 2 and line 4 with before=after=1 — line 3 is shared
    expect(out.matches).toHaveLength(2);
    // First match block: lines 1-3
    expect(out.matches[0].context.map((c) => c.lineNumber)).toEqual([1, 2, 3]);
    // Second match block: lines 3-5
    expect(out.matches[1].context.map((c) => c.lineNumber)).toEqual([3, 4, 5]);
  });
});
