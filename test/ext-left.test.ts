/**
 * The extension's ← rule: which raw input chunks count as an unmodified
 * left arrow (press or release), across the encodings pi's terminals send.
 */
import { describe, expect, it } from "vitest";
import { classifyLeft } from "../src/extension/pines-extension.js";

describe("classifyLeft", () => {
  it("recognizes the legacy and application-cursor forms", () => {
    expect(classifyLeft("\x1b[D")).toBe("press");
    expect(classifyLeft("\x1bOD")).toBe("press");
  });

  it("recognizes kitty's forms, including repeat and release event types", () => {
    expect(classifyLeft("\x1b[1;1D")).toBe("press");
    expect(classifyLeft("\x1b[1;1:1D")).toBe("press");
    expect(classifyLeft("\x1b[1;1:2D")).toBe("press"); // repeat still moves
    expect(classifyLeft("\x1b[1;1:3D")).toBe("release");
    // Keypad left as a kitty functional key.
    expect(classifyLeft("\x1b[57417u")).toBe("press");
    expect(classifyLeft("\x1b[57417;1u")).toBe("press");
    expect(classifyLeft("\x1b[57417;1:3u")).toBe("release");
  });

  it("tolerates caps/num lock bits but never a real modifier", () => {
    expect(classifyLeft("\x1b[1;65D")).toBe("press"); // caps lock
    expect(classifyLeft("\x1b[1;129D")).toBe("press"); // num lock
    expect(classifyLeft("\x1b[1;2D")).toBeNull(); // shift+←
    expect(classifyLeft("\x1b[1;3D")).toBeNull(); // alt+←
    expect(classifyLeft("\x1b[1;5D")).toBeNull(); // ctrl+←
    expect(classifyLeft("\x1b[57417;5u")).toBeNull();
  });

  it("leaves every other key alone", () => {
    for (const k of ["\x1b[C", "\x1b[A", "\x1b[d", "a", "\x1b", "\x1b[D\x1b[D", "\x1b[3~", ""]) {
      expect(classifyLeft(k)).toBeNull();
    }
  });
});
