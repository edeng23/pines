/**
 * Overlay line-editing chords: terminals encode Cmd/Option+Backspace many
 * ways; normalizeUiKey must collapse them all onto the readline control bytes
 * the overlay handlers understand (\x15 kill line, \x17 kill word).
 */
import { describe, expect, it } from "vitest";
import { normalizeUiKey } from "../src/client/app.js";

describe("normalizeUiKey line editing", () => {
  it("maps kill-line variants to \\x15 (legacy ctrl+u, kitty ctrl+u, kitty super+backspace)", () => {
    expect(normalizeUiKey("\x15")).toBe("\x15");
    expect(normalizeUiKey("\x1b[117;5u")).toBe("\x15");
    expect(normalizeUiKey("\x1b[127;9u")).toBe("\x15");
  });

  it("maps kill-word variants to \\x17 (legacy ctrl+w, ESC+DEL, kitty alt+backspace)", () => {
    expect(normalizeUiKey("\x17")).toBe("\x17");
    expect(normalizeUiKey("\x1b\x7f")).toBe("\x17");
    expect(normalizeUiKey("\x1b[127;3u")).toBe("\x17");
  });

  it("leaves plain backspace and printables untouched", () => {
    expect(normalizeUiKey("\x7f")).toBe("\x7f");
    expect(normalizeUiKey("a")).toBe("a");
  });
});
