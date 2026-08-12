/**
 * The forest style contract.
 *
 * A style owns how a tree *reads* — its marker, its label, the lineage edges
 * between trees, and any backdrop — while the renderer keeps owning layout,
 * culling, draw order, hit-testing, and de-cluttering. Everything a style
 * needs arrives in a `DrawCtx`; everything it may occupy it declares up front
 * via `footprint`, so no style can paint over another tree's marker.
 *
 * Status semantics (color + animation) are deliberately *not* a style's
 * choice: they come from `status.ts` so a yellow spinner always means
 * "working".
 */
import type { TreeSummary } from "../../shared/types.js";
import type { Canvas } from "./canvas.js";
import type { Viewport } from "./camera.js";

export type ForestStyleId = "canopy";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tree that survived culling, with its cell position and pick id. */
export interface PlacedTree {
  t: TreeSummary;
  pos: Point;
  pickId: number;
  selected: boolean;
}

export interface DrawCtx extends PlacedTree {
  spinnerFrame: number;
  /** Display name, already resolved (session name → cwd → id). */
  title: string;
  /**
   * True when the title is a stand-in (the cwd) rather than the session's own
   * name — pi leaves a session unnamed until its first prompt. Placeholders
   * render as placeholders: never bold, never shouting for attention.
   */
  fallback: boolean;
  /** Canvas extent, so a label can stop at the edge instead of being cut. */
  vp: Viewport;
  /**
   * False when the marker's full footprint collided with a neighbor: draw the
   * compact form (the core cell always fits — it is reserved for every tree).
   */
  roomy: boolean;
  /**
   * False when a crowded forest has decided this tree stays quiet. A style
   * may shrink or reposition a name when `roomy` is false, but it must not
   * draw one at all when this is false — that is how every look keeps the
   * same amount of text on a packed map.
   */
  speaks: boolean;
  /**
   * How many characters of the name to show. A packed forest trades length
   * for count: eight short names tell you more than three long ones.
   */
  nameMax: number;
  /** Median distance in cells to a nearest neighbor — how much room there is. */
  spacing: number;
  labels: LabelPlacer;
}

export interface UnderlayCtx {
  vp: Viewport;
  visible: PlacedTree[];
  /**
   * Median distance in cells between a tree and its nearest neighbor. A
   * backdrop that looks considered around eight well-spaced trees turns to
   * noise around forty crowded ones — styles scale their decoration by this.
   */
  spacing: number;
}

export interface ForestStyle {
  id: ForestStyleId;
  /** Shown in the style picker. */
  name: string;
  /** One line describing what the option is going for. */
  blurb: string;
  /** Cells the full marker wants. Declared before anything draws. */
  footprint(
    t: TreeSummary,
    pos: Point,
    opts: { selected: boolean; nameMax: number; spacing: number },
  ): Rect;
  /**
   * Cells the marker occupies for real — reserved for every tree before
   * anything is drawn, so no label can ever be placed where a marker will
   * land. Defaults to the single cell under the tree; a style whose marker is
   * taller or wider than one cell must say so here, or a neighbor's name ends
   * up underneath it. `spacing` is the forest's median neighbor distance, so
   * a style that scales its marker with room can reserve what it will draw.
   */
  core?(t: TreeSummary, pos: Point, spacing: number): Rect;
  /** Backdrop under the edges (grids, contour rings). */
  underlay?(canvas: Canvas, ctx: UnderlayCtx): void;
  /** Lineage parent→child link; defaults to a faint braille thread. */
  edge?(canvas: Canvas, a: Point, b: Point): void;
  /** The tree's marker and label. */
  drawTree(canvas: Canvas, ctx: DrawCtx): void;
}

/**
 * Row-interval registry that de-clutters overlapping text: higher-priority
 * markers (drawn first) claim their span; later claims that intersect an
 * occupied span are rejected so names never overwrite each other.
 *
 * Spans carry the tree that owns them, so a marker can claim a rectangle that
 * includes its own already-reserved core cell.
 */
export class LabelPlacer {
  private rows = new Map<number, Array<{ a: number; b: number; owner: string | null }>>();

  /** Mark cells occupied without competing (glyphs, minis). */
  reserve(x: number, y: number, width: number, owner: string | null = null): void {
    const row = Math.round(y);
    const spans = this.rows.get(row) ?? [];
    spans.push({ a: Math.round(x), b: Math.round(x) + width - 1, owner });
    this.rows.set(row, spans);
  }

  /** Try to claim a span; false = something already there, skip drawing. */
  claim(x: number, y: number, width: number, owner: string | null = null): boolean {
    if (!this.free(x, y, width, owner)) return false;
    this.reserve(x, y, width, owner);
    return true;
  }

  reserveRect(r: Rect, owner: string | null = null): void {
    for (let i = 0; i < r.h; i++) this.reserve(r.x, r.y + i, r.w, owner);
  }

  /** All-or-nothing claim across every row of a rectangle. */
  claimRect(r: Rect, owner: string | null = null): boolean {
    for (let i = 0; i < r.h; i++) {
      if (!this.free(r.x, r.y + i, r.w, owner)) return false;
    }
    this.reserveRect(r, owner);
    return true;
  }

  private free(x: number, y: number, width: number, owner: string | null): boolean {
    const spans = this.rows.get(Math.round(y));
    if (!spans) return true;
    const x0 = Math.round(x);
    const x1 = x0 + width - 1;
    for (const s of spans) {
      if (s.owner !== null && s.owner === owner) continue; // one's own reservation
      if (x0 <= s.b && x1 >= s.a) return false;
    }
    return true;
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Clip a label to what is left of the row. Terminal canvases drop
 * out-of-bounds writes silently, which cuts a name mid-word at the right
 * edge — on a narrow pane with prompt-derived names that is the common case,
 * not an edge case. An ellipsis says "there is more" instead.
 */
export function fitText(s: string, x: number, vpWidth: number): string {
  const room = vpWidth - Math.round(x);
  if (room <= 0) return "";
  if (s.length <= room) return s;
  return room === 1 ? "…" : truncate(s, room);
}
