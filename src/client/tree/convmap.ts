/**
 * Floating miniature of the conversation tree — a METRO MAP of the branches.
 *
 * It draws the merged tree's SKELETON: the root, every branch point, and
 * every agent tip. Chains of ordinary messages collapse into a single route —
 * the mini answers shape, status and where-am-I, not content. Routes are
 * orthogonal box-drawing lines with rounded corners (the jj/serie "curved"
 * lineage), one soft color per top-level branch; agents are the stations,
 * drawn as their status glyph, clickable. The skeleton node nearest the
 * cursor is highlighted so the mini doubles as a you-are-here marker.
 */
import { statusGlyph, statusSgr } from "../forest/view.js";
import { FAINT, MUTED } from "../theme.js";
import { spliceCustom } from "./lanegraph.js";
import type { TreeDetail, TreeSummary } from "../../shared/types.js";

export interface SkelNode {
  id: string;
  /** Skeleton depth: how many branch points sit above (column). */
  depth: number;
  /** Index of the parent skeleton node (-1 for roots). */
  parent: number;
  /** Agents whose branch currently ends here. */
  tips?: TreeSummary[];
}

function isUserish(kind: string): boolean {
  return kind === "user" || kind === "compaction" || kind === "branch_summary";
}

/**
 * Reduce the merged tree to its skeleton, one vertex per branch SEGMENT —
 * headed by the user message that begins it, exactly like the transcript's
 * exchange fans. The answer chain lives inside its segment; tips anywhere
 * along a segment attach to its vertex. The graph's nodes are the user
 * messages, never the replies.
 *
 * `heads` = branch-head node ids of the agents on this tree. The transcript
 * lets a lone continuation flow on at the margin, but the map's job is WHERE
 * AGENTS SIT: a message that begins another agent's branch always gets its
 * own vertex, competing sibling or not — otherwise a fork of a fork would
 * pin its dot to the parent branch.
 */
export function buildSkeleton(
  detail: TreeDetail,
  tipsAt: Map<string, TreeSummary[]>,
  heads?: Set<string>,
): SkelNode[] {
  const { children, roots } = spliceCustom(detail);
  const out: SkelNode[] = [];
  const walkSeg = (head: string, parent: number, depth: number): void => {
    const idx = out.length;
    const tips: TreeSummary[] = [];
    out.push({ id: head, depth, parent, tips });
    let cur = head;
    const pending: string[] = [];
    for (let guard = 0; guard < 100_000; guard++) {
      for (const t of tipsAt.get(cur) ?? []) tips.push(t);
      const kids = children.get(cur) ?? [];
      const conts = kids.filter((k) => {
        const n = detail.nodes[k];
        return n && !isUserish(n.kind);
      });
      const next = conts[0];
      for (const k of kids) if (k !== next) pending.push(k);
      if (next) {
        cur = next;
        continue;
      }
      if (pending.length === 1 && !heads?.has(pending[0]!)) {
        cur = pending.pop()!;
        continue;
      }
      break;
    }
    for (const b of pending) walkSeg(b, idx, depth + 1);
  };
  for (const r of roots) walkSeg(r, -1, 0);
  return out;
}

export interface MiniNode extends SkelNode {
  x: number;
  y: number;
}

/** Tidy layout: leaves take rows, parents centre on children, depth = column. */
export function layoutMini(skel: SkelNode[], w: number, h: number): MiniNode[] {
  if (skel.length === 0) return [];
  const kids: number[][] = skel.map(() => []);
  skel.forEach((n, i) => {
    if (n.parent >= 0) kids[n.parent]!.push(i);
  });
  const maxDepth = Math.max(...skel.map((n) => n.depth));
  const leaves = skel.filter((_, i) => kids[i]!.length === 0).length;
  const bodyH = Math.max(1, h - 2);
  const stepY = leaves > 1 ? Math.max(1, Math.min(3, Math.floor((bodyH - 1) / (leaves - 1)))) : 1;
  const colW = maxDepth > 0 ? Math.max(3, Math.min(10, Math.floor((w - 5) / maxDepth))) : 0;

  const ys: number[] = new Array(skel.length).fill(0);
  let nextLeafY = 0;
  const assign = (i: number): number => {
    const ch = kids[i]!;
    if (ch.length === 0) {
      ys[i] = nextLeafY;
      nextLeafY += stepY;
      return ys[i]!;
    }
    const childYs = ch.map(assign);
    ys[i] = Math.round((Math.min(...childYs) + Math.max(...childYs)) / 2);
    return ys[i]!;
  };
  skel.forEach((n, i) => {
    if (n.parent === -1) assign(i);
  });

  // Centre the constellation in its box.
  const span = Math.max(...ys) - Math.min(...ys);
  const top = 1 + Math.max(0, Math.floor((bodyH - 1 - span) / 2));
  const widest = maxDepth * colW + 3;
  const left = Math.max(1, Math.floor((w - widest) / 2));

  return skel.map((n, i) => ({
    ...n,
    x: Math.min(w - 3, left + n.depth * colW),
    y: Math.min(h - 1, top + ys[i]!),
  }));
}

export interface ConvMini {
  lines: string[];
  /** "x,y" cell → tip node id, for click-to-jump. */
  hits: Map<string, string>;
}

export function miniHitKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Soft, distinct route colors — one per top-level branch, cycling. */
const LANES = ["38;5;73", "38;5;108", "38;5;110", "38;5;139", "38;5;144", "38;5;66"];

/* Connection bitmask → box char. Pure corners are rounded (metro style). */
const U = 1, D = 2, L = 4, R = 8;
const BOX: Record<number, string> = {
  [U]: "│", [D]: "│", [U | D]: "│",
  [L]: "─", [R]: "─", [L | R]: "─",
  [D | R]: "╭", [D | L]: "╮", [U | R]: "╰", [U | L]: "╯",
  [U | D | R]: "├", [U | D | L]: "┤",
  [L | R | D]: "┬", [L | R | U]: "┴",
  [U | D | L | R]: "┼",
};

/**
 * Render the mini. `cursorSkelId` = the skeleton node whose region the
 * transcript cursor is in (highlighted as you-are-here).
 */
export function renderConvMini(
  skel: SkelNode[],
  opts: {
    width: number;
    height: number;
    spinnerFrame: number;
    cursorSkelId?: string | null;
    /** Skeleton ids on the flow's route — drawn bold (flow mode highlight). */
    routeIds?: Set<string>;
  },
): ConvMini {
  const { width: w, height: h } = opts;
  const hits = new Map<string, string>();
  const nodes = layoutMini(skel, w, h);
  const mask: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const railSgr: string[][] = Array.from({ length: h }, () => new Array<string>(w).fill(FAINT));
  const glyph: ({ ch: string; sgr: string } | null)[][] = Array.from({ length: h }, () =>
    new Array<{ ch: string; sgr: string } | null>(w).fill(null),
  );
  if (nodes.length === 0) return { lines: Array.from({ length: h }, () => ""), hits };

  // Route color = the top-level branch a vertex belongs to (metro "line").
  const laneOf = new Array<string>(nodes.length).fill(FAINT);
  {
    let next = 0;
    const paint = (i: number, sgr: string): void => {
      laneOf[i] = sgr;
      nodes.forEach((n, j) => {
        if (n.parent === i) paint(j, sgr);
      });
    };
    nodes.forEach((n, i) => {
      if (n.parent >= 0 && nodes[n.parent]!.parent === -1) paint(i, LANES[next++ % LANES.length]!);
    });
  }

  const put = (x: number, y: number, bits: number, sgr: string): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    mask[y]![x] = (mask[y]![x] ?? 0) | bits;
    railSgr[y]![x] = sgr;
  };

  // The flow's route reads bold: a rail is on the route when both of its
  // endpoints are (root → tip is a single ancestor chain in the skeleton).
  const onRoute = (i: number): boolean => opts.routeIds?.has(nodes[i]!.id) ?? false;
  const boldIf = (b: boolean, sgr: string): string => (b ? `1;${sgr}` : sgr);

  // Routes, per parent: a short horizontal stub out of the parent into a
  // vertical spine, then rounded elbows fanning to each child's station.
  nodes.forEach((p, pi) => {
    const kids = nodes.filter((n) => n.parent === pi);
    if (kids.length === 0) return;
    const cx = Math.min(...kids.map((k) => k.x));
    const sx = Math.max(p.x + 1, Math.min(p.x + 2, cx - 1));
    // Attachment rows on the spine: the parent's and every child's.
    const parentOnRoute = onRoute(pi) && kids.some((k) => onRoute(nodes.indexOf(k)));
    const rows = [
      {
        y: p.y,
        x: p.x,
        sgr: boldIf(parentOnRoute, laneOf[pi]!),
        from: "parent" as const,
        route: parentOnRoute,
      },
      ...kids.map((k) => ({
        y: k.y,
        x: k.x,
        sgr: boldIf(onRoute(pi) && onRoute(nodes.indexOf(k)), laneOf[nodes.indexOf(k)]!),
        from: "child" as const,
        route: onRoute(pi) && onRoute(nodes.indexOf(k)),
      })),
    ].sort((a, b) => a.y - b.y);
    const topY = rows[0]!.y;
    const botY = rows[rows.length - 1]!.y;
    for (const r of rows) {
      if (r.from === "parent") {
        for (let x = p.x + 1; x < sx; x++) put(x, r.y, L | R, r.sgr);
        put(sx, r.y, L, r.sgr);
      } else {
        for (let x = sx + 1; x < r.x; x++) put(x, r.y, L | R, r.sgr);
        put(sx, r.y, R, r.sgr);
      }
      // Spine continuation through this attachment.
      if (r.y > topY) put(sx, r.y, U, r.sgr);
      if (r.y < botY) put(sx, r.y, D, r.sgr);
    }
    // Vertical runs between attachments.
    for (let i = 0; i + 1 < rows.length; i++) {
      for (let y = rows[i]!.y + 1; y < rows[i + 1]!.y; y++) {
        put(sx, y, U | D, rows[i + 1]!.sgr);
      }
    }
  });

  // Stations last: they sit on top of the rails.
  nodes.forEach((n, i) => {
    const here = n.id === opts.cursorSkelId;
    const route = onRoute(i);
    const tip = n.tips?.[0];
    if (tip) {
      glyph[n.y]![n.x] = {
        ch: statusGlyph(tip, opts.spinnerFrame),
        sgr: here ? "7" : boldIf(route, statusSgr(tip)),
      };
      hits.set(miniHitKey(n.x, n.y), n.id);
      hits.set(miniHitKey(n.x + 1, n.y), n.id);
      hits.set(miniHitKey(n.x - 1, n.y), n.id);
    } else if (n.parent === -1) {
      glyph[n.y]![n.x] = { ch: "○", sgr: here ? "7" : boldIf(route, "36") };
    } else {
      glyph[n.y]![n.x] = { ch: "·", sgr: here ? "7" : boldIf(route, MUTED) };
    }
  });

  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const g = glyph[y]![x];
      if (g) {
        line += `\x1b[${g.sgr}m${g.ch}\x1b[0m`;
      } else if (mask[y]![x]) {
        line += `\x1b[${railSgr[y]![x]}m${BOX[mask[y]![x]!] ?? "·"}\x1b[0m`;
      } else {
        line += " ";
      }
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return { lines, hits };
}

/**
 * The skeleton node whose region contains `nodeId`: itself if structural,
 * else its nearest skeleton ancestor. Gives the mini its you-are-here mark.
 */
export function skelNodeFor(
  detail: TreeDetail,
  skel: SkelNode[],
  nodeId: string | null | undefined,
): string | null {
  if (!nodeId) return null;
  const ids = new Set(skel.map((n) => n.id));
  let cur: string | null = nodeId;
  for (let guard = 0; cur && guard < 10_000; guard++) {
    if (ids.has(cur)) return cur;
    cur = detail.nodes[cur]?.parentId ?? null;
  }
  return null;
}
