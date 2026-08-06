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
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  // Padding: 20% margin, and leave room for name labels (~12 cells).
  const zx = (vp.width - 24) / (spanX * 1.4);
  const zy = (vp.height - 4) / (spanY * 1.4 * Y_ASPECT);
  return { cx, cy, zoom: clampZoom(Math.min(zx, zy)) };
}
