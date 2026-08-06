import { describe, expect, it } from "vitest";
import { clipAnsi, visibleLength } from "../src/client/ansi.js";

describe("clipAnsi", () => {
  it("passes short strings through untouched", () => {
    const s = "\x1b[36mhello\x1b[0m world";
    expect(clipAnsi(s, 20)).toBe(s);
  });

  it("clips visible columns, not raw chars, and appends ellipsis + reset", () => {
    const s = "\x1b[36mabcdef\x1b[0m ghij";
    const clipped = clipAnsi(s, 8);
    expect(visibleLength(clipped)).toBe(8);
    expect(clipped.endsWith("…\x1b[0m")).toBe(true);
    expect(clipped).toContain("\x1b[36m"); // styling preserved
  });

  it("handles zero and tiny budgets", () => {
    expect(clipAnsi("abc", 0)).toBe("");
    expect(visibleLength(clipAnsi("abcdef", 1))).toBe(1);
  });
});
