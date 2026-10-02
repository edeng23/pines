/**
 * Visible-screen extraction from an xterm headless terminal: one styled line
 * per row, SGR only. The serialize addon's output is for REPLAYING a screen
 * (it moves the cursor to skip blanks, then restores modes), which a client
 * cannot crop or embed in a pane; these lines can be clipped like any other
 * TUI row — that is what the forest's preview pane needs.
 */
import type { IBufferCell, Terminal } from "@xterm/headless";

const RESET = "\x1b[0m";

interface Style {
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

const PLAIN: Style = {
  fg: "",
  bg: "",
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
};

function color(cell: IBufferCell, which: "fg" | "bg"): string {
  const isDefault = which === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return "";
  const n = which === "fg" ? cell.getFgColor() : cell.getBgColor();
  const base = which === "fg" ? 38 : 48;
  if (which === "fg" ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${base};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  }
  // Palette: 0-7 and 8-15 have short forms, the rest go through 256-color.
  if (n < 8) return String((which === "fg" ? 30 : 40) + n);
  if (n < 16) return String((which === "fg" ? 90 : 100) + n - 8);
  return `${base};5;${n}`;
}

function styleOf(cell: IBufferCell): Style {
  return {
    fg: color(cell, "fg"),
    bg: color(cell, "bg"),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    strike: cell.isStrikethrough() !== 0,
  };
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike
  );
}

/** Full SGR for a style from a reset state (simple and always correct). */
function sgr(s: Style): string {
  if (sameStyle(s, PLAIN)) return RESET;
  const parts: string[] = ["0"];
  if (s.bold) parts.push("1");
  if (s.dim) parts.push("2");
  if (s.italic) parts.push("3");
  if (s.underline) parts.push("4");
  if (s.inverse) parts.push("7");
  if (s.strike) parts.push("9");
  if (s.fg) parts.push(s.fg);
  if (s.bg) parts.push(s.bg);
  return `\x1b[${parts.join(";")}m`;
}

/**
 * The terminal's visible rows (not scrollback) as styled lines, each at most
 * `cols` cells wide. Trailing blank cells are trimmed so a narrow pane pads
 * with its own background rather than the agent's. A wide glyph that would
 * straddle the crop edge is dropped whole.
 */
export function screenLines(term: Terminal, cols: number): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  const width = Math.max(0, Math.min(cols, term.cols));
  for (let r = 0; r < term.rows; r++) {
    const line = buf.getLine(buf.viewportY + r);
    if (!line) {
      out.push("");
      continue;
    }
    let text = "";
    let style = PLAIN;
    let pendingBlank = ""; // blanks held back until a glyph follows them
    let x = 0;
    while (x < width) {
      const cell = line.getCell(x);
      if (!cell) break;
      const w = cell.getWidth();
      if (w === 0) {
        // Continuation of a wide glyph already emitted (or dropped).
        x++;
        continue;
      }
      if (x + w > width) break;
      const chars = cell.getChars() || " ";
      const st = styleOf(cell);
      // A styled blank (background fill, inverse caret) is content; a plain
      // blank only becomes content once something follows it.
      if (chars === " " && sameStyle(st, PLAIN)) {
        pendingBlank += " ";
      } else {
        if (pendingBlank) {
          if (!sameStyle(style, PLAIN)) {
            text += RESET;
            style = PLAIN;
          }
          text += pendingBlank;
          pendingBlank = "";
        }
        if (!sameStyle(st, style)) {
          text += sgr(st);
          style = st;
        }
        text += chars;
      }
      x += w;
    }
    if (!sameStyle(style, PLAIN)) text += RESET;
    out.push(text);
  }
  return out;
}
