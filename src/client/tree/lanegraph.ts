/**
 * Trunk/lane graph layout for conversation trees — jj/Sapling-style.
 *
 * Depth costs nothing: the active branch (root → leaf) is a vertical trunk in
 * lane 0; only branches consume horizontal lanes, introduced with rounded
 * box-drawing connectors. Conversation trees never merge, so lanes are a
 * simple allocate-on-fork / free-on-subtree-end stack.
 *
 * Runs of "boring" linear steps (tool results, assistant continuations)
 * collapse into one `⋯ n steps` row, expandable per run. User messages,
 * branch points, labeled nodes, summaries, roots, and the leaf never elide.
 *
 * Used by BOTH the tree view (with text) and the forest z1 minis (gutter
 * only) so zooming feels continuous.
 */
import type { NodeSummary, TreeDetail } from "../../shared/types.js";
import { FAINT, MUTED } from "../theme.js";

export interface LaneCell {
  ch: string;
  sgr: string | null;
}

export interface GraphRow {
  kind: "node" | "elision" | "connector";
  /** One cell per lane column ×2 (lane + spacer), already glyph-populated. */
  gutter: LaneCell[];
  /** node rows */
  nodeId?: string;
  node?: NodeSummary;
  /** elision rows */
  runId?: string;
  count?: number;
  /** Node ids hidden inside this elision (search jumps expand the run). */
  ids?: string[];
  /** True when this row sits on the active root→leaf path. */
  onTrunk: boolean;
  /** True for the effective leaf's row. */
  isLeaf: boolean;
}

export interface LaneGraph {
  rows: GraphRow[];
  laneCount: number;
  /** Effective leaf after splicing plumbing nodes. */
  leafId: string | null;
}

export interface LaneGraphOptions {
  /** Expanded elision runs (keyed by first node id of the run). */
  expanded?: Set<string>;
  /** false = never collapse (show every node). Default true. */
  collapseRuns?: boolean;
}

/** Minimum run length worth collapsing ("⋯ 2 steps" earns its row). */
const MIN_RUN = 2;

const DIM = MUTED; // boring-but-content glyphs (elision ⋅, plain nodes)
const RAIL = FAINT;
const TRUNK_RAIL = "37";

interface Ctx {
  detail: TreeDetail;
  children: Map<string, string[]>;
  activePath: Set<string>;
  leafId: string | null;
  expanded: Set<string>;
  collapse: boolean;
  rows: GraphRow[];
  /** lane -> open? (drawn as a rail on every emitted row) */
  lanes: boolean[];
}

/**
 * Splice out pines plumbing (`custom` kind: stamps, branch markers): children
 * reattach to the custom node's parent; a leaf pointing at a custom node
 * resolves to its nearest non-custom ancestor.
 */
/** Effective conversation tree: pines plumbing spliced out (shared with asciitree). */
export function spliceCustom(detail: TreeDetail): {
  children: Map<string, string[]>;
  roots: string[];
  leafId: string | null;
} {
  // A labeled plumbing node was deliberately marked by the user — keep it.
  const isCustom = (id: string) => {
    const n = detail.nodes[id];
    return n?.kind === "custom" && !n.label;
  };
  const resolveUp = (id: string | null): string | null => {
    let cur = id;
    while (cur && isCustom(cur)) cur = detail.nodes[cur]?.parentId ?? null;
    return cur;
  };

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const attach = (parent: string | null, id: string) => {
    if (parent === null) roots.push(id);
    else {
      const arr = children.get(parent) ?? [];
      arr.push(id);
      children.set(parent, arr);
    }
  };

  const visit = (id: string, effectiveParent: string | null) => {
    const node = detail.nodes[id];
    if (!node) return;
    if (isCustom(id)) {
      for (const c of node.children) visit(c, effectiveParent);
      return;
    }
    attach(effectiveParent, id);
    for (const c of node.children) visit(c, id);
  };
  for (const r of detail.rootIds) visit(r, null);

  return { children, roots, leafId: resolveUp(detail.leafId) };
}

function significant(ctx: Ctx, id: string): boolean {
  const node = ctx.detail.nodes[id]!;
  if (node.kind === "user" || node.kind === "compaction" || node.kind === "branch_summary")
    return true;
  if (node.label) return true;
  if ((ctx.children.get(id)?.length ?? 0) > 1) return true;
  if (id === ctx.leafId) return true;
  if (node.parentId === null || ctx.detail.rootIds.includes(id)) return true;
  return false;
}

/** Base gutter for one row: rails for open lanes. */
function railGutter(ctx: Ctx, activeLane: number): LaneCell[] {
  const cells: LaneCell[] = [];
  for (let i = 0; i < ctx.lanes.length; i++) {
    cells.push(
      ctx.lanes[i]
        ? { ch: "│", sgr: i === activeLane ? TRUNK_RAIL : RAIL }
        : { ch: " ", sgr: null },
    );
    cells.push({ ch: " ", sgr: null });
  }
  return cells;
}

function nodeGlyph(ctx: Ctx, id: string, onTrunk: boolean): LaneCell {
  const node = ctx.detail.nodes[id]!;
  if (id === ctx.leafId) return { ch: "●", sgr: "32" }; // where the story continues
  if (node.label) return { ch: "◆", sgr: "33" };
  if (node.kind === "compaction") return { ch: "⧗", sgr: onTrunk ? "33" : DIM };
  if (node.kind === "branch_summary") return { ch: "⑂", sgr: onTrunk ? "33" : DIM };
  if (node.kind === "user") return { ch: "○", sgr: "36" }; // dim cyan is unreadable on many themes
  if ((ctx.children.get(id)?.length ?? 0) > 1) return { ch: "●", sgr: onTrunk ? "37" : DIM };
  return { ch: "·", sgr: onTrunk ? "37" : DIM };
}

function emitNode(ctx: Ctx, id: string, lane: number): void {
  const onTrunk = ctx.activePath.has(id);
  const gutter = railGutter(ctx, ctx.activePath.size ? trunkLane(ctx) : -1);
  gutter[lane * 2] = nodeGlyph(ctx, id, onTrunk);
  ctx.rows.push({
    kind: "node",
    gutter,
    nodeId: id,
    node: ctx.detail.nodes[id],
    onTrunk,
    isLeaf: id === ctx.leafId,
  });
}

function emitElision(ctx: Ctx, runIds: string[], lane: number, onTrunk: boolean): void {
  const gutter = railGutter(ctx, trunkLane(ctx));
  gutter[lane * 2] = { ch: "⋅", sgr: DIM };
  ctx.rows.push({
    kind: "elision",
    gutter,
    runId: runIds[0]!,
    count: runIds.length,
    ids: [...runIds],
    onTrunk,
    isLeaf: false,
  });
}

/** The lane currently carrying the active path (lane 0 in practice). */
function trunkLane(_ctx: Ctx): number {
  return 0;
}

/** Flush a pending run of insignificant nodes as elision or plain rows. */
function flushRun(ctx: Ctx, run: string[], lane: number, onTrunk: boolean): void {
  if (run.length === 0) return;
  const runId = run[0]!;
  if (ctx.collapse && run.length >= MIN_RUN && !ctx.expanded.has(runId)) {
    emitElision(ctx, run, lane, onTrunk);
  } else {
    for (const id of run) emitNode(ctx, id, lane);
  }
  run.length = 0;
}

/**
 * Emit the connector row that opens `newLanes` off a fork at `lane`:
 *   ├─╮   (one branch)      ├─┬─╮   (two branches)
 */
function emitForkConnector(ctx: Ctx, lane: number, newLanes: number[], onTrunk: boolean): void {
  const gutter = railGutter(ctx, trunkLane(ctx));
  const maxLane = Math.max(...newLanes);
  const start = lane * 2;
  const end = maxLane * 2;
  gutter[start] = { ch: "├", sgr: onTrunk ? TRUNK_RAIL : RAIL };
  for (let c = start + 1; c < end; c++) {
    const laneIdx = c % 2 === 0 ? c / 2 : -1;
    if (laneIdx >= 0 && newLanes.includes(laneIdx)) {
      gutter[c] = { ch: "┬", sgr: RAIL };
    } else {
      gutter[c] = { ch: "─", sgr: RAIL };
    }
  }
  gutter[end] = { ch: "╮", sgr: RAIL };
  ctx.rows.push({ kind: "connector", gutter, onTrunk, isLeaf: false });
}

function allocLane(ctx: Ctx, after: number): number {
  for (let i = after + 1; i < ctx.lanes.length; i++) {
    if (!ctx.lanes[i]) {
      ctx.lanes[i] = true;
      return i;
    }
  }
  ctx.lanes.push(true);
  return ctx.lanes.length - 1;
}

/**
 * Walk a chain starting at `id` in `lane`, emitting rows; recurse at forks.
 * Frees the lane when the subtree ends (unless it is lane 0).
 */
function walk(ctx: Ctx, id: string | undefined, lane: number): void {
  const run: string[] = [];
  let cur = id;
  while (cur) {
    const kids = ctx.children.get(cur) ?? [];
    const onTrunk = ctx.activePath.has(cur);

    if (significant(ctx, cur)) {
      flushRun(ctx, run, lane, onTrunk);
      emitNode(ctx, cur, lane);
    } else {
      run.push(cur);
    }

    if (kids.length === 0) {
      flushRun(ctx, run, lane, onTrunk);
      if (lane !== 0) ctx.lanes[lane] = false;
      return;
    }
    if (kids.length === 1) {
      cur = kids[0];
      continue;
    }

    // Fork. Active child continues this lane; the rest branch right.
    flushRun(ctx, run, lane, onTrunk);
    const activeChild = kids.find((k) => ctx.activePath.has(k)) ?? kids[0]!;
    const branchKids = kids.filter((k) => k !== activeChild);
    const newLanes = branchKids.map(() => allocLane(ctx, lane));
    emitForkConnector(ctx, lane, newLanes, onTrunk);
    // Abandoned branches first (older); the active continuation ends at the
    // leaf, so the story reads top-to-bottom into "now".
    branchKids.forEach((k, i) => walk(ctx, k, newLanes[i]!));
    cur = activeChild;
  }
}

export function buildLaneGraph(detail: TreeDetail, opts: LaneGraphOptions = {}): LaneGraph {
  const { children, roots, leafId } = spliceCustom(detail);

  const activePath = new Set<string>();
  for (let cur = leafId; cur; ) {
    activePath.add(cur);
    cur = detail.nodes[cur]?.parentId ?? null;
    // parentId chains may pass through spliced custom nodes — harmless to
    // include them; membership checks only ever use real node ids.
  }

  const ctx: Ctx = {
    detail,
    children,
    activePath,
    leafId,
    expanded: opts.expanded ?? new Set(),
    collapse: opts.collapseRuns ?? true,
    rows: [],
    lanes: [],
  };

  for (const root of roots) {
    ctx.lanes[0] = true;
    walk(ctx, root, 0);
    ctx.lanes[0] = false;
  }

  // Gutters were built while lanes were being allocated; normalize widths.
  const laneCount = Math.max(1, ...ctx.rows.map((r) => Math.ceil(r.gutter.length / 2)));
  for (const row of ctx.rows) {
    while (row.gutter.length < laneCount * 2) row.gutter.push({ ch: " ", sgr: null });
  }

  return { rows: ctx.rows, laneCount, leafId };
}

/** Row indices a selection cursor may rest on (nodes + elisions). */
export function selectableRows(graph: LaneGraph): number[] {
  const out: number[] = [];
  graph.rows.forEach((row, i) => {
    if (row.kind !== "connector") out.push(i);
  });
  return out;
}

/** Find the row index for a node id (for search jumps / leaf selection). */
export function rowIndexOf(graph: LaneGraph, nodeId: string | null | undefined): number {
  if (!nodeId) return -1;
  return graph.rows.findIndex((r) => r.nodeId === nodeId);
}

/** The elision run currently hiding `nodeId`, if any (so callers can expand it). */
export function runContaining(graph: LaneGraph, nodeId: string): string | undefined {
  return graph.rows.find((r) => r.kind === "elision" && r.ids?.includes(nodeId))?.runId;
}
