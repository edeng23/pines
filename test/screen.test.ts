/**
 * screenLines: the daemon's croppable view of an agent's screen — styled
 * lines a client can clip like any other row, unlike the replay snapshot.
 */
import { describe, expect, it } from "vitest";
import xterm from "@xterm/headless";
import { screenLines } from "../src/daemon/screen.js";
import { visibleLength } from "../src/client/ansi.js";

async function terminal(cols: number, rows: number, ...writes: string[]) {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 50 });
  for (const w of writes) await new Promise<void>((r) => term.write(w, r));
  return term;
}

describe("screenLines", () => {
  it("returns one line per row, trimmed of trailing blanks, with SGR only", async () => {
    const term = await terminal(20, 3, "\x1b[1mREADY\x1b[0m cwd=/p\r\nplain\r\n");
    const lines = screenLines(term, 20);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("\x1b[0;1mREADY\x1b[0m cwd=/p");
    expect(lines[1]).toBe("plain");
    expect(lines[2]).toBe("");
    for (const l of lines) expect(l).not.toMatch(/\x1b\[[0-9;]*[A-Za-ln-z]/); // no cursor moves
  });

  it("crops to the requested width by cells, never past the terminal's own width", async () => {
    const term = await terminal(30, 2, "0123456789abcdefghijklmnopqrs");
    expect(screenLines(term, 10)[0]).toBe("0123456789");
    expect(screenLines(term, 99)[0]).toBe("0123456789abcdefghijklmnopqrs");
  });

  it("keeps styled blanks (an inverse caret, a background fill) as content", async () => {
    const term = await terminal(10, 1, "ab\x1b[7m \x1b[0m   ");
    const line = screenLines(term, 10)[0]!;
    expect(line).toBe("ab\x1b[0;7m \x1b[0m");
    expect(visibleLength(line)).toBe(3);
  });

  it("encodes palette and truecolor foregrounds and backgrounds", async () => {
    const term = await terminal(
      40,
      1,
      "\x1b[31mred\x1b[0m \x1b[38;5;208mo\x1b[0m \x1b[48;2;1;2;3mbg\x1b[0m \x1b[94mb",
    );
    const line = screenLines(term, 40)[0]!;
    expect(line).toContain("\x1b[0;31mred");
    expect(line).toContain("\x1b[0;38;5;208mo");
    expect(line).toContain("\x1b[0;48;2;1;2;3mbg");
    expect(line).toContain("\x1b[0;94mb");
    expect(line.endsWith("\x1b[0m")).toBe(true);
  });

  it("drops a wide glyph that would straddle the crop edge rather than splitting it", async () => {
    const term = await terminal(10, 1, "ab漢字");
    // 'a','b' = 2 cells, 漢 = 2 cells (ends at 4), 字 would end at 6.
    expect(screenLines(term, 5)[0]).toBe("ab漢");
    expect(screenLines(term, 6)[0]).toBe("ab漢字");
  });

  it("shows the visible rows, not scrollback, when output has scrolled", async () => {
    const term = await terminal(10, 2, "one\r\ntwo\r\nthree\r\nfour");
    expect(screenLines(term, 10)).toEqual(["three", "four"]);
  });
});
