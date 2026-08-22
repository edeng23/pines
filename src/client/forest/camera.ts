/**
 * Camera: world-space ↔ terminal-cell transform.
 *
 * World units are abstract; `zoom` is cells-per-world-unit horizontally. The
 * vertical scale is halved to compensate for the ~1:2 width:height aspect of
 * terminal cells, so circles in world space look circular on screen.
 */
import type { Camera } from "../../shared/types.js";

export const Y_ASPECT = 0.5;

export interface Viewport {
  width: number;
  height: number;
}

export function worldToCell(
  cam: Camera,
  vp: Viewport,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: (wx - cam.cx) * cam.zoom + vp.width / 2,
    y: (wy - cam.cy) * cam.zoom * Y_ASPECT + vp.height / 2,
  };
}

export function cellToWorld(
  cam: Camera,
  vp: Viewport,
  x: number,
  y: number,
): { wx: number; wy: number } {
  return {
    wx: (x - vp.width / 2) / cam.zoom + cam.cx,
    wy: (y - vp.height / 2) / (cam.zoom * Y_ASPECT) + cam.cy,
  };
}

/** Zoom about a fixed screen point (mouse wheel behavior). */
export function zoomAt(cam: Camera, vp: Viewport, x: number, y: number, factor: number): Camera {
  const { wx, wy } = cellToWorld(cam, vp, x, y);
  const zoom = clampZoom(cam.zoom * factor);
  // Keep (wx,wy) under the cursor after the zoom change.
  return {
    zoom,
    cx: wx - (x - vp.width / 2) / zoom,
    cy: wy - (y - vp.height / 2) / (zoom * Y_ASPECT),
  };
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 24;

export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

/** Semantic zoom bands. */
export function zoomBand(zoom: number): "z0" | "z1" {
  return zoom < 3 ? "z0" : "z1";
}

/**
 * Past this, a focused tree "opens" into the full tree view. Kept just shy of
 * MAX_ZOOM so there's plenty of z1 headroom to study the minis up close —
 * the flip into the tree view should feel like pushing through the end stop,
 * not an ambush halfway through the zoom range.
 */
export const OPEN_TREE_ZOOM = 22;

/**
 * Scroll-into-view-if-needed: return a camera from which (wx,wy) is visible
 * with `margin` cells of breathing room. If it already is, the camera comes
 * back unchanged (same reference) — selection moves, the view stays put. If
 * not, pan the minimum distance that lands the point just inside the margin,
 * rather than recentering; the user keeps their bearings.
 */
export function ensureVisible(
  cam: Camera,
  vp: Viewport,
  wx: number,
  wy: number,
  margin = { x: 10, y: 4 },
): Camera {
  const p = worldToCell(cam, vp, wx, wy);
  let dx = 0;
  let dy = 0;
  if (p.x < margin.x) dx = p.x - margin.x;
  else if (p.x > vp.width - margin.x) dx = p.x - (vp.width - margin.x);
  if (p.y < margin.y) dy = p.y - margin.y;
  else if (p.y > vp.height - margin.y) dy = p.y - (vp.height - margin.y);
  if (dx === 0 && dy === 0) return cam;
  return {
    ...cam,
    cx: cam.cx + dx / cam.zoom,
    cy: cam.cy + dy / (cam.zoom * Y_ASPECT),
  };
}

/**
 * Margins zoom-to-fit keeps around the trees, in cells. A tree is not a
 * point: its crown grows UP from its cell and its name runs to the RIGHT, so
 * the room it needs is lopsided, and framing the *positions* with an even
 * border either clips crowns off the top row or wastes a third of the pane.
 * Reserving the drawing's own shape instead is what lets the fit sit close
 * enough for trees to be drawn as trees.
 */
const FIT_MARGIN = { top: 8, bottom: 2, left: 3, right: 13 };
/** A hair of air beyond the margins, so nothing sits flush against an edge. */
const FIT_SLACK = 1.06;

/**
 * The same margins, scaled to the pane. On a short or narrow one the fixed
 * reserve would be most of the view — and a fit that spends half a 24-row
 * pane on unused sky puts every tree back to a single glyph, which is the
 * opposite of what the reserve is for.
 */
function fitMargin(vp: Viewport): { top: number; bottom: number; left: number; right: number } {
  const cap = (want: number, extent: number, share: number) =>
    Math.max(1, Math.min(want, Math.round(extent * share)));
  return {
    top: cap(FIT_MARGIN.top, vp.height, 0.16),
    bottom: cap(FIT_MARGIN.bottom, vp.height, 0.06),
    left: cap(FIT_MARGIN.left, vp.width, 0.04),
    right: cap(FIT_MARGIN.right, vp.width, 0.14),
  };
}

/** Fit camera to a set of world points with padding. */
export function fitCamera(
  points: Array<{ x: number; y: number }>,
  vp: Viewport,
): Camera {
  if (points.length === 0) return { cx: 0, cy: 0, zoom: 2 };
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  // Cells left for the trees themselves, once crowns and names are paid for.
  // Tiny panes can leave nothing: never fit to a negative box.
  const margin = fitMargin(vp);
  const roomX = Math.max(vp.width - margin.left - margin.right, 8);
  const roomY = Math.max(vp.height - margin.top - margin.bottom, 4);
  const zx = roomX / (spanX * FIT_SLACK);
  const zy = roomY / (spanY * FIT_SLACK * Y_ASPECT);
  const zoom = clampZoom(Math.min(zx, zy));
  // Center on the box the trees may occupy — offset from the pane's center by
  // half the difference between the margins — so the room bought for crowns
  // and names ends up where they are actually drawn: the wood sits a little
  // low and a little left, under its own canopy and beside its own names.
  const cx = (minX + maxX) / 2 + (margin.right - margin.left) / 2 / zoom;
  const cy = (minY + maxY) / 2 + (margin.bottom - margin.top) / 2 / (zoom * Y_ASPECT);
  return { cx, cy, zoom };
}
