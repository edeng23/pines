/** ANSI-aware string measurement and clipping for cell-budgeted TUI rows. */

const SGR_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(SGR_RE, "").length;
}

/**
 * Clip a styled string to at most `maxCols` visible columns, preserving SGR
 * sequences and terminating with a reset when anything was cut. Assumes
 * single-width glyphs (matches the rest of the renderer).
 */
export function clipAnsi(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleLength(s) <= maxCols) return s;
  let out = "";
  let cols = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (cols === maxCols - 1) {
      out += "…";
      break;
    }
    out += s[i];
    cols++;
    i++;
  }
  return out + "\x1b[0m";
}
