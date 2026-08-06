/**
 * Forest rendering: trees on the canvas.
 *
 * Each tree is one marker + name, drawn by the active style; lineage edges
 * connect parents to children underneath. The sprite carries the story at
 * every zoom — maturity by conversation size, life by color — and fills out
 * as spacing grows.
 *
 * This module owns everything that is *not* a matter of taste: culling, draw
 * order, de-cluttering, hit-testing. What a tree looks like belongs to
 * `styles.ts` — see `style.ts` for the contract between the two.
 */
import type { TreeSummary } from "../../shared/types.js";
import type { Camera } from "../../shared/types.js";
import { Canvas } from "./canvas.js";
import { worldToCell, type Viewport } from "./camera.js";
import { treeTitle } from "./sidebar.js";
import { FAINT, MUTED } from "../theme.js";
import { forestStyle } from "./styles.js";
import { LabelPlacer, type DrawCtx, type ForestStyle, type PlacedTree } from "./style.js";

export { SPINNER_FRAMES, statusGlyph, statusSgr } from "./status.js";

/** Dash pattern for lineage threads, in braille dots (on, off). */
export const LINEAGE_DASH: [number, number] = [7, 4];

export interface ForestRenderInput {
  trees: TreeSummary[];
  camera: Camera;
  vp: Viewport;
  selectedId: string | null;
  spinnerFrame: number;
  /** Visual option; defaults to classic. */
  style?: ForestStyle | string;
  /** Wall clock for age labels (injected so rendering stays deterministic). */
  now?: number;
}

export function renderForest(canvas: Canvas, input: ForestRenderInput): Map<number, string> {
  const { trees, camera, vp, selectedId, spinnerFrame } = input;
  const style =
    typeof input.style === "object" && input.style !== null
      ? input.style
      : forestStyle(input.style);
  const now = input.now ?? Date.now();
  const pickMap = new Map<number, string>();
  canvas.clear();

  if (trees.length === 0) {
    // Short lines (the canvas may be as narrow as ~45 cols beside the
    // sidebar), block-aligned so the key column reads as a column.
    const lines = [
      "the forest is empty",
      "",
      "n    plant a tree (runs pi here)",
      "pi   sessions started anywhere appear too",
    ];
    const blockW = Math.max(...lines.map((l) => l.length));
    const x0 = Math.max(0, Math.floor((vp.width - blockW) / 2));
    const y0 = Math.max(1, Math.floor(vp.height / 2) - 2);
    for (let i = 0; i < lines.length; i++) {
      canvas.text(x0, y0 + i, lines[i]!, i === 0 ? "1" : MUTED, -1);
    }
    return pickMap;
  }

  // Draw trees in attention priority so, when labels collide, the label that
  // survives is the one the user most needs (selected > unseen > live > recent).
  const prio = (t: TreeSummary): number => {
    if (t.treeId === selectedId) return 0;
    if (!t.seen) return 1;
    if (t.live) return 2;
    return 3;
  };
  const ordered = [...trees].sort((a, b) => prio(a) - prio(b) || b.mtime - a.mtime);

  let pickId = 0;
  const visible: PlacedTree[] = [];
  for (const t of ordered) {
    const pos = worldToCell(camera, vp, t.x, t.y);
    if (pos.x < -30 || pos.y < -20 || pos.x > vp.width + 30 || pos.y > vp.height + 20) continue;
    const id = pickId++;
    pickMap.set(id, t.treeId);
    visible.push({ t, pos, pickId: id, selected: t.treeId === selectedId });
  }

  // Backdrop (grids, contour rings), then lineage edges: both live under
  // every marker.
  style.underlay?.(canvas, { vp, visible, now, spacing: medianSpacing(visible) });

  const byPath = new Map<string, TreeSummary>();
  for (const t of trees) byPath.set(t.sessionPath, t);
  for (const t of trees) {
    if (!t.parentSessionPath) continue;
    const parent = byPath.get(t.parentSessionPath);
    if (!parent) continue;
    const a = worldToCell(camera, vp, parent.x, parent.y);
    const b = worldToCell(camera, vp, t.x, t.y);
    if (offscreen(a, b, vp)) continue;
    if (style.edge) style.edge(canvas, a, b);
    else canvas.line(a.x, a.y, b.x, b.y, FAINT, LINEAGE_DASH);
  }

  const labels = new LabelPlacer();
  // Names get shorter as the forest gets tighter, so more of them survive.
  const spacing = medianSpacing(visible);
  const nameMax = spacing < 10 ? 11 : 18;
  const ctxFor = (e: PlacedTree, roomy: boolean, speaks = true): DrawCtx => {
    const { title, fallback } = treeTitle(e.t);
    return { ...e, spinnerFrame, now, title, fallback, vp, roomy, speaks, nameMax, spacing, labels };
  };

  // One drawing path at every zoom: the sprite IS the tree — maturity by
  // conversation size, life by color — and it simply fills out as spacing
  // grows. (Mid-zoom once drew lane-graph minis here; they duplicated what
  // the sprite already says, and structure lives in the conversation's
  // metro map now.) Every tree's core cell is reserved before anything
  // draws, so no marker or label can ever land on another tree's marker;
  // then markers claim their full footprint in priority order.
  for (const e of visible) {
    labels.reserveRect(
      style.core?.(e.t, e.pos, spacing) ?? { x: e.pos.x, y: e.pos.y, w: 1, h: 1 },
      e.t.treeId,
    );
  }
  const sel = visible.find((e) => e.selected);
  if (sel) {
    labels.reserveRect(
      style.footprint(sel.t, sel.pos, { selected: true, now, nameMax, spacing }),
      sel.t.treeId,
    );
  }
  const budget = labelBudget(visible);
  for (const e of visible) {
    if (e.selected) continue;
    const speaks = budget.has(e.t.treeId);
    const rect = style.footprint(e.t, e.pos, { selected: false, now, nameMax, spacing });
    const roomy = speaks && labels.claimRect(rect, e.t.treeId);
    style.drawTree(canvas, ctxFor(e, roomy, speaks));
  }
  // The focused tree draws last, on top of everything: its label must
  // always read cleanly — but it must never ERASE a neighbor: every other
  // tree's core marker cells are painted back over the label's overflow.
  if (sel) {
    const cores = visible
      .filter((e) => !e.selected)
      .map((e) =>
        canvas.snapshotRect(
          style.core?.(e.t, e.pos, spacing) ?? { x: e.pos.x, y: e.pos.y, w: 1, h: 1 },
        ),
      );
    style.drawTree(canvas, ctxFor(sel, true));
    for (const cells of cores) canvas.restore(cells);
  }
  return pickMap;
}

/**
 * Which trees get to speak their name.
 *
 * When trees are far apart every one of them can: the placer sorts out the
 * occasional overlap. Packed together, first-come-first-served produces a
 * wall of half-names where nothing stands out — so a crowded forest names
 * only what you'd want to see from across the room (the live, the unseen, the
 * crashed), topped up with the most recent so an all-quiet forest is never
 * anonymous. Zooming in spreads the trees and hands everyone their name back.
 */
function labelBudget(visible: PlacedTree[]): Set<string> {
  const speaks = new Set<string>();
  if (medianSpacing(visible) >= 10) {
    for (const e of visible) speaks.add(e.t.treeId);
    return speaks;
  }
  for (const e of visible) {
    if (!e.t.seen || e.t.live || e.t.status === "crashed") speaks.add(e.t.treeId);
  }
  const floor = Math.max(8, Math.round(visible.length * 0.25));
  const byRecency = [...visible].sort((a, b) => b.t.mtime - a.t.mtime);
  for (const e of byRecency) {
    if (speaks.size >= floor) break;
    speaks.add(e.t.treeId);
  }
  return speaks;
}

/**
 * Median nearest-neighbor distance, in cells. Cheap enough to brute-force at
 * forest scale, and it tells a style how much room its decoration has.
 */
function medianSpacing(visible: PlacedTree[]): number {
  if (visible.length < 2) return Infinity;
  const dists: number[] = [];
  for (let i = 0; i < visible.length; i++) {
    let best = Infinity;
    for (let j = 0; j < visible.length; j++) {
      if (i === j) continue;
      const dx = visible[i]!.pos.x - visible[j]!.pos.x;
      // Rows are twice as tall as columns are wide: compare in x-cell units.
      const dy = (visible[i]!.pos.y - visible[j]!.pos.y) * 2;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    dists.push(best);
  }
  dists.sort((a, b) => a - b);
  return dists[Math.floor(dists.length / 2)]!;
}

function offscreen(
  a: { x: number; y: number },
  b: { x: number; y: number },
  vp: Viewport,
): boolean {
  const pad = 40;
  return (
    (a.x < -pad && b.x < -pad) ||
    (a.y < -pad && b.y < -pad) ||
    (a.x > vp.width + pad && b.x > vp.width + pad) ||
    (a.y > vp.height + pad && b.y > vp.height + pad)
  );
}
