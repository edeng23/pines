/**
 * Cell canvas: a styled character grid with a Braille sub-cell layer for
 * smooth edges and a pick-buffer for O(1) mouse hit-testing.
 *
 * Braille resolution is 2×4 dots per cell; lines are Bresenham-rasterized
 * into dot masks and composed into cells that hold no glyph.
 */

const BRAILLE_MASK: number[][] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export const NO_PICK = -1;

export class Canvas {
  readonly w: number;
  readonly h: number;
  private ch: string[];
  private sgr: (string | null)[];
  private pick: Int32Array;
  private dots: Uint8Array;
  private dotSgr: (string | null)[];
  /** Cells explicitly written (even with a space) occlude the Braille layer. */
  private occupied: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.ch = new Array(w * h).fill(" ");
    this.sgr = new Array(w * h).fill(null);
    this.pick = new Int32Array(w * h).fill(NO_PICK);
    this.dots = new Uint8Array(w * h);
    this.dotSgr = new Array(w * h).fill(null);
    this.occupied = new Uint8Array(w * h);
  }

  clear(): void {
    this.ch.fill(" ");
    this.sgr.fill(null);
    this.pick.fill(NO_PICK);
    this.dots.fill(0);
    this.dotSgr.fill(null);
    this.occupied.fill(0);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /**
   * Snapshot a rect's occupied cells so they can be painted back verbatim
   * after something draws over them (a selected tree's label must never
   * erase a neighbor's marker).
   */
  snapshotRect(r: { x: number; y: number; w: number; h: number }): Array<{
    x: number;
    y: number;
    ch: string;
    sgr: string | null;
    pick: number;
  }> {
    const out: Array<{ x: number; y: number; ch: string; sgr: string | null; pick: number }> = [];
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const x = Math.round(r.x) + dx;
        const y = Math.round(r.y) + dy;
        if (!this.inBounds(x, y)) continue;
        const i = y * this.w + x;
        if (!this.occupied[i]) continue;
        out.push({ x, y, ch: this.ch[i]!, sgr: this.sgr[i]!, pick: this.pick[i]! });
      }
    }
    return out;
  }

  restore(cells: Array<{ x: number; y: number; ch: string; sgr: string | null; pick: number }>): void {
    for (const c of cells) this.set(c.x, c.y, c.ch, c.sgr, c.pick);
  }

  set(x: number, y: number, ch: string, sgr: string | null, pickId = NO_PICK): void {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.inBounds(x, y)) return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.sgr[i] = sgr;
    this.occupied[i] = 1;
    if (pickId !== NO_PICK) this.pick[i] = pickId;
  }

  text(x: number, y: number, str: string, sgr: string | null, pickId = NO_PICK): void {
    x = Math.round(x);
    y = Math.round(y);
    for (let i = 0; i < str.length; i++) {
      this.set(x + i, y, str[i]!, sgr, pickId);
    }
  }

  /** Plot one Braille dot at sub-cell resolution (2× width, 4× height). */
  dot(px: number, py: number, sgr: string | null): void {
    const cx = Math.floor(px / 2);
    const cy = Math.floor(py / 4);
    if (!this.inBounds(cx, cy)) return;
    const dx = ((px % 2) + 2) % 2;
    const dy = ((py % 4) + 4) % 4;
    const i = cy * this.w + cx;
    this.dots[i] = (this.dots[i]! | BRAILLE_MASK[dy]![dx]!) & 0xff;
    if (sgr) this.dotSgr[i] = sgr;
  }

  /**
   * Rasterize a line between cell-space endpoints into the Braille layer.
   *
   * `dash` is [on, off] in dots: a long lineage edge drawn solid reads as a
   * structural rule across the map, while a dashed one reads as a thread
   * between two trees, which is what it is.
   */
  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    sgr: string | null,
    dash?: [number, number],
  ): void {
    // Convert cell coords to dot coords.
    let px0 = Math.round(x0 * 2);
    let py0 = Math.round(y0 * 4);
    const px1 = Math.round(x1 * 2);
    const py1 = Math.round(y1 * 4);
    const dx = Math.abs(px1 - px0);
    const dy = -Math.abs(py1 - py0);
    const sx = px0 < px1 ? 1 : -1;
    const sy = py0 < py1 ? 1 : -1;
    let err = dx + dy;
    let guard = 0;
    let step = 0;
    const period = dash ? dash[0] + dash[1] : 0;
    const maxSteps = (this.w * 2 + this.h * 4) * 2;
    for (;;) {
      if (!dash || step % period < dash[0]) this.dot(px0, py0, sgr);
      step++;
      if (px0 === px1 && py0 === py1) break;
      if (++guard > maxSteps) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        px0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        py0 += sy;
      }
    }
  }

  pickAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return NO_PICK;
    return this.pick[y * this.w + x]!;
  }

  /** Compose to per-row ANSI strings (Braille fills glyph-free cells). */
  render(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let row = "";
      let curSgr: string | null | undefined;
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        let ch = this.ch[i]!;
        let sgr = this.sgr[i];
        if (ch === " " && !this.occupied[i] && this.dots[i]! !== 0) {
          ch = String.fromCharCode(0x2800 + this.dots[i]!);
          sgr = this.dotSgr[i];
        }
        if (sgr !== curSgr) {
          row += sgr === null ? "\x1b[0m" : `\x1b[0m\x1b[${sgr}m`;
          curSgr = sgr;
        }
        row += ch;
      }
      row += "\x1b[0m";
      rows.push(row);
    }
    return rows;
  }
}
