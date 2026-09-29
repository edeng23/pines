/**
 * Forest layout strategies — candidate answers to "the forest is too dense".
 *
 * EXPERIMENTAL: several layouts live side by side here so they can be compared
 * on a real forest (`g` in the forest view, or `layout` in config.json) before
 * one of them becomes *the* layout. Every strategy is a pure function of the
 * embedded trees, deterministic, and ends with the same overlap relaxation, so
 * they differ only in the geometry they hand to it.
 *
 * Why the current layout packs: PCA of a few hundred 384-d sentence
 * embeddings is a Gaussian-looking blob (the top two components carry a
 * fraction of the variance, and every vector shares a large common
 * direction), and the overlap relaxation then pushes every pair apart to the
 * same minimum distance — which flattens whatever cluster structure survived
 * the projection into an even lattice. Each strategy attacks that from a
 * different side:
 *
 * - `pca`      today's layout, kept as the baseline.
 * - `wide`     the same layout stretched to the terminal's aspect: at fit
 *              zoom a square cloud uses about half the columns, so the
 *              cheapest room to be had is sideways.
 * - `groves`   cluster the embeddings first, stand the groves apart, pack the
 *              members inside: the gaps between groups are explicit.
 * - `projects` the same groves, but grouped by working directory — a cluster
 *              the user already thinks in — with topic layout inside each.
 * - `springs`  a small force-directed refinement of the PCA start: similar
 *              trees pull together, everything repels, so dense regions and
 *              voids emerge without hard group boundaries.
 *
 * Every strategy but the baseline is also widened (see `ASPECT`): the
 * finished layout will be, whichever wins, and comparing them narrow would
 * bias the verdict toward the one that happens to be tallest.
 */
import { fitPca, projectPca, type PcaBasis } from "./pca.js";
import { relax } from "./relax.js";

export type LayoutStrategy = "pca" | "wide" | "groves" | "projects" | "springs";

export const DEFAULT_LAYOUT: LayoutStrategy = "pca";

export const LAYOUT_STRATEGIES: ReadonlyArray<{
  id: LayoutStrategy;
  name: string;
  blurb: string;
}> = [
  {
    id: "pca",
    name: "pca (current)",
    blurb: "principal components of the embeddings, then pushed apart until nothing overlaps",
  },
  {
    id: "wide",
    name: "pca, widened",
    blurb: "the current layout stretched sideways to fill a wide terminal at fit zoom",
  },
  {
    id: "groves",
    name: "topic groves",
    blurb: "cluster by what the conversations are about; groves stand apart, members pack inside",
  },
  {
    id: "projects",
    name: "project groves",
    blurb: "one grove per working directory; inside a grove, trees sit by topic",
  },
  {
    id: "springs",
    name: "springs",
    blurb: "force-directed: similar trees pull together, everything else pushes away",
  },
];

export function parseLayoutStrategy(v: unknown): LayoutStrategy | undefined {
  return LAYOUT_STRATEGIES.some((s) => s.id === v) ? (v as LayoutStrategy) : undefined;
}

export interface LayoutItem {
  id: string;
  /** Pooled embedding; null when not embedded yet (such a tree keeps its spot). */
  vec: ArrayLike<number> | null;
  cwd: string | null;
  x: number;
  y: number;
}

export interface LayoutResult {
  /** New coordinates for every embedded item (unembedded ones are pinned). */
  positions: Map<string, { x: number; y: number }>;
  /** PCA basis fitted over the embedded items, for incremental placement. */
  basis: PcaBasis | null;
}

/** Same floor the daemon has always used: no two trees closer than this. */
export const MIN_DIST = 2.4;
/** World span the point cloud is fitted to (see fitPca). */
const SPAN = 30;
/** Fewer embedded trees than this and there is nothing to lay out yet. */
export const MIN_TREES_FOR_LAYOUT = 3;
/**
 * World x:y ratio the widened strategies lay out to. A terminal canvas is
 * wide (about 1.6–2:1 in world units once rows count double), and zoom-to-fit
 * is bound by whichever axis runs out first — for a square cloud that is
 * always the vertical one, leaving the sides empty.
 */
export const ASPECT = 1.8;

/* --------------------------------- vectors -------------------------------- */

function unit(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] as number) ** 2;
  n = Math.sqrt(n) || 1;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / n;
  return out;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function meanVec(vs: ArrayLike<number>[]): number[] {
  const d = vs[0]?.length ?? 0;
  const m = new Array<number>(d).fill(0);
  for (const v of vs) for (let i = 0; i < d; i++) m[i]! += (v[i] as number) / vs.length;
  return m;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------- clustering ------------------------------- */

/**
 * Agglomerative clustering (average linkage on cosine distance) down to `k`
 * groups. O(n³) in the naive form used here, which is fine at forest scale
 * (a few hundred trees, and only on relayout). Deterministic: ties go to the
 * lowest index pair.
 */
export function agglomerate(units: number[][], k: number): number[] {
  const n = units.length;
  const label = new Array<number>(n).fill(0).map((_, i) => i);
  if (n === 0) return [];
  if (k >= n) return label;
  const alive = new Array<boolean>(n).fill(true);
  const size = new Array<number>(n).fill(1);
  const dist: number[][] = units.map((a) => units.map((b) => 1 - dot(a, b)));
  let groups = n;
  while (groups > k) {
    let bi = -1;
    let bj = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const d = dist[i]![j]!;
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    // Merge bj into bi (Lance–Williams update for average linkage).
    for (let m = 0; m < n; m++) {
      if (!alive[m] || m === bi || m === bj) continue;
      const d = (size[bi]! * dist[bi]![m]! + size[bj]! * dist[bj]![m]!) / (size[bi]! + size[bj]!);
      dist[bi]![m] = d;
      dist[m]![bi] = d;
    }
    size[bi]! += size[bj]!;
    alive[bj] = false;
    for (let m = 0; m < n; m++) if (label[m] === bj) label[m] = bi;
    groups--;
  }
  // Renumber 0..k-1 in first-appearance order.
  const seen = new Map<number, number>();
  return label.map((l) => {
    let idx = seen.get(l);
    if (idx === undefined) seen.set(l, (idx = seen.size));
    return idx;
  });
}

/** How many topic groves a forest of `n` trees gets. */
export function groveCount(n: number): number {
  if (n < 4) return 1;
  return Math.max(2, Math.min(12, Math.round(Math.sqrt(n))));
}

/* --------------------------------- groves --------------------------------- */

interface Embedded extends LayoutItem {
  vec: ArrayLike<number>;
  u: number[];
}

/** Space between the edges of neighboring groves, in world units. */
const GROVE_GAP = 7;

interface Grove {
  members: Embedded[];
  /** Member offsets from the grove anchor. */
  local: Map<string, { x: number; y: number }>;
  radius: number;
  centroid: number[];
  ax: number;
  ay: number;
}

/**
 * Stand groups of trees apart: each group is laid out on its own (through
 * the shared basis, so "left" means the same thing in every grove), packed
 * to a radius that grows with its size; anchors come from a PCA of the
 * groups' centroids so related groves are neighbors, and are pushed apart
 * until every grove has clear ground around it.
 */
function layoutGroves(groups: Embedded[][], basis: PcaBasis): Map<string, { x: number; y: number }> {
  const groves: Grove[] = groups.map((members) => {
    const pts = members.map((m) => projectPca(basis, m.vec));
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let maxR = 0;
    for (const p of pts) maxR = Math.max(maxR, Math.hypot(p.x - mx, p.y - my));
    // Pack the grove: its members keep their relative topic layout but are
    // squeezed to a footprint that grows with the count, then relaxed.
    const target = 1.4 * Math.sqrt(members.length) + 0.5;
    const s = maxR > 1e-9 ? Math.min(1, target / maxR) : 1;
    const local = pts.map((p) => ({ x: (p.x - mx) * s, y: (p.y - my) * s, pinned: false }));
    relax(local, MIN_DIST, 40);
    let radius = 0;
    for (const p of local) radius = Math.max(radius, Math.hypot(p.x, p.y));
    return {
      members,
      local: new Map(members.map((m, i) => [m.id, local[i]!])),
      radius: radius + 1,
      centroid: unit(meanVec(members.map((m) => m.u))),
      ax: 0,
      ay: 0,
    };
  });

  // Anchors: related groves near each other, via a PCA of the centroids.
  if (groves.length >= 3) {
    const cb = fitPca(groves.map((g) => g.centroid), SPAN);
    for (const g of groves) {
      const p = projectPca(cb, g.centroid);
      g.ax = p.x;
      g.ay = p.y;
    }
  } else if (groves.length === 2) {
    const half = (groves[0]!.radius + groves[1]!.radius + GROVE_GAP) / 2;
    groves[0]!.ax = -half;
    groves[1]!.ax = half;
  }
  // Push anchors apart until no two groves' footprints (plus the gap) touch.
  // A deterministic direction resolves coincident anchors.
  for (let iter = 0; iter < 80; iter++) {
    let moved = false;
    for (let i = 0; i < groves.length; i++) {
      for (let j = i + 1; j < groves.length; j++) {
        const a = groves[i]!;
        const b = groves[j]!;
        const need = a.radius + b.radius + GROVE_GAP;
        let dx = b.ax - a.ax;
        let dy = b.ay - a.ay;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 1e-9) {
          const angle = (i * 2.399963 + j) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          d = 1;
        }
        const push = ((need - d) / d) * 0.5;
        a.ax -= dx * push;
        a.ay -= dy * push;
        b.ax += dx * push;
        b.ay += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const g of groves) {
    for (const m of g.members) {
      const l = g.local.get(m.id)!;
      out.set(m.id, { x: g.ax + l.x, y: g.ay + l.y });
    }
  }
  return out;
}

/* --------------------------------- springs -------------------------------- */

/** Attractive edges per tree: its nearest neighbors in embedding space. */
const SPRING_NEIGHBORS = 4;
const SPRING_STEPS = 150;
/** Repulsion strength (all pairs, inverse square). */
const SPRING_REPEL = 24;
/** Attraction strength along neighbor edges (linear in distance). */
const SPRING_ATTRACT = 0.9;

/**
 * Fruchterman–Reingold-style refinement from the PCA start. Similar trees
 * (a kNN graph on cosine similarity, weighted by how similar) are joined by
 * springs with rest length zero; every pair repels. Cooling makes it settle;
 * the result is recentered and rescaled to the usual span before the final
 * overlap pass.
 */
function layoutSprings(items: Embedded[], basis: PcaBasis): Map<string, { x: number; y: number }> {
  const n = items.length;
  const pos = items.map((m) => projectPca(basis, m.vec));
  const sims: number[][] = items.map((a) => items.map((b) => dot(a.u, b.u)));
  const edges: Array<{ i: number; j: number; w: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const order = sims[i]!
      .map((s, j) => ({ s, j }))
      .filter((e) => e.j !== i)
      .sort((a, b) => b.s - a.s || a.j - b.j)
      .slice(0, SPRING_NEIGHBORS);
    for (const e of order) {
      const key = i < e.j ? `${i}:${e.j}` : `${e.j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ i, j: e.j, w: Math.max(0.05, e.s) });
    }
  }
  const disp = pos.map(() => ({ x: 0, y: 0 }));
  for (let step = 0; step < SPRING_STEPS; step++) {
    for (const d of disp) {
      d.x = 0;
      d.y = 0;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[j]!.x - pos[i]!.x;
        let dy = pos[j]!.y - pos[i]!.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          const angle = (i * 2.399963 + j) % (Math.PI * 2);
          dx = Math.cos(angle) * 1e-3;
          dy = Math.sin(angle) * 1e-3;
          dist = 1e-3;
        }
        const f = SPRING_REPEL / Math.max(dist * dist, 0.25);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        disp[i]!.x -= fx;
        disp[i]!.y -= fy;
        disp[j]!.x += fx;
        disp[j]!.y += fy;
      }
    }
    for (const e of edges) {
      const dx = pos[e.j]!.x - pos[e.i]!.x;
      const dy = pos[e.j]!.y - pos[e.i]!.y;
      const fx = dx * e.w * SPRING_ATTRACT;
      const fy = dy * e.w * SPRING_ATTRACT;
      disp[e.i]!.x += fx;
      disp[e.i]!.y += fy;
      disp[e.j]!.x -= fx;
      disp[e.j]!.y -= fy;
    }
    // Cooling: a step may move a tree at most `temp` units.
    const temp = 3 * (1 - step / SPRING_STEPS) + 0.05;
    for (let i = 0; i < n; i++) {
      const d = disp[i]!;
      const len = Math.hypot(d.x, d.y);
      const k = len > temp ? temp / len : 1;
      pos[i]!.x += d.x * k;
      pos[i]!.y += d.y * k;
    }
  }
  // Recenter and rescale to the standard span.
  const mx = pos.reduce((s, p) => s + p.x, 0) / n;
  const my = pos.reduce((s, p) => s + p.y, 0) / n;
  let maxAbs = 1e-9;
  for (const p of pos) maxAbs = Math.max(maxAbs, Math.abs(p.x - mx), Math.abs(p.y - my));
  const s = SPAN / (2 * maxAbs);
  return new Map(items.map((m, i) => [m.id, { x: (pos[i]!.x - mx) * s, y: (pos[i]!.y - my) * s }]));
}

/* ---------------------------------- entry --------------------------------- */

/**
 * Lay out the whole forest. Items without an embedding are pinned where they
 * are; everything else gets a fresh position. Returns nothing to apply when
 * there are too few embedded trees to say anything.
 */
export function layoutForest(strategy: LayoutStrategy, items: LayoutItem[]): LayoutResult {
  const embedded: Embedded[] = items
    .filter((it): it is LayoutItem & { vec: ArrayLike<number> } => it.vec !== null)
    .map((it) => ({ ...it, u: unit(it.vec) }));
  if (embedded.length < MIN_TREES_FOR_LAYOUT) return { positions: new Map(), basis: null };

  const basis = fitPca(embedded.map((m) => m.vec), SPAN);
  let positions: Map<string, { x: number; y: number }>;
  switch (strategy) {
    case "pca":
    case "wide":
      positions = new Map(embedded.map((m) => [m.id, projectPca(basis, m.vec)]));
      break;
    case "groves": {
      const labels = agglomerate(
        embedded.map((m) => m.u),
        groveCount(embedded.length),
      );
      const groups: Embedded[][] = [];
      labels.forEach((l, i) => (groups[l] ??= []).push(embedded[i]!));
      positions = layoutGroves(groups, basis);
      break;
    }
    case "projects": {
      const byCwd = new Map<string, Embedded[]>();
      for (const m of embedded) {
        const key = m.cwd ?? "~unknown";
        let arr = byCwd.get(key);
        if (!arr) byCwd.set(key, (arr = []));
        arr.push(m);
      }
      // Stable grove order regardless of discovery order.
      const keys = [...byCwd.keys()].sort((a, b) => hashString(a) - hashString(b) || a.localeCompare(b));
      positions = layoutGroves(
        keys.map((k) => byCwd.get(k)!),
        basis,
      );
      break;
    }
    case "springs":
      positions = layoutSprings(embedded, basis);
      break;
  }

  if (strategy !== "pca") {
    for (const p of positions.values()) p.x *= ASPECT;
  }

  // The shared final pass: nothing overlaps, pinned trees never move.
  const points = items.map((it) => {
    const p = positions.get(it.id);
    return p ? { x: p.x, y: p.y, pinned: false, id: it.id } : { x: it.x, y: it.y, pinned: true, id: it.id };
  });
  relax(points, MIN_DIST, 30);
  for (const p of points) if (!p.pinned) positions.set(p.id, { x: p.x, y: p.y });
  return { positions, basis };
}

/**
 * Place one newly embedded tree without disturbing the rest.
 *
 * Under `pca` (and `wide`) it projects through the cached basis, as always.
 * The other strategies have no projection to reuse, so the newcomer lands
 * beside its nearest neighbor in embedding space (for `projects`, preferring
 * one in the same directory), on whichever side of it has the most room — a
 * stand-in until the next relayout.
 */
export function placeNewTree(
  strategy: LayoutStrategy,
  items: LayoutItem[],
  newId: string,
  basis: PcaBasis | null,
): { x: number; y: number } | null {
  const me = items.find((it) => it.id === newId);
  if (!me || !me.vec) return null;
  const others = items.filter((it) => it.id !== newId);

  /** Relax the newcomer against everyone else (pinned); score = room around it. */
  const settle = (seed: { x: number; y: number }): { x: number; y: number; room: number } => {
    const points = [
      { x: seed.x, y: seed.y, pinned: false },
      ...others.map((o) => ({ x: o.x, y: o.y, pinned: true })),
    ];
    relax(points, MIN_DIST, 30);
    const p = points[0]!;
    let room = Infinity;
    for (const o of others) room = Math.min(room, Math.hypot(p.x - o.x, p.y - o.y));
    return { x: p.x, y: p.y, room };
  };

  if (strategy === "pca" || strategy === "wide") {
    if (!basis) return null;
    const p = projectPca(basis, me.vec);
    if (strategy === "wide") p.x *= ASPECT;
    const { x, y } = settle(p);
    return { x, y };
  }

  const u = unit(me.vec);
  const embedded = others.filter((o) => o.vec !== null);
  const pool =
    strategy === "projects" && embedded.some((o) => o.cwd === me.cwd)
      ? embedded.filter((o) => o.cwd === me.cwd)
      : embedded;
  let best: LayoutItem | null = null;
  let bestSim = -Infinity;
  for (const o of pool) {
    const sim = dot(u, unit(o.vec!));
    if (sim > bestSim) {
      bestSim = sim;
      best = o;
    }
  }
  if (!best) return null;
  // Try a ring of spots around the neighbor and keep the roomiest; the ring
  // starts at an angle dealt from the id, so newcomers don't all queue up on
  // the same side.
  const start = (hashString(newId) % 360) * (Math.PI / 180);
  let chosen: { x: number; y: number; room: number } | null = null;
  for (let k = 0; k < 8; k++) {
    const angle = start + (k * Math.PI) / 4;
    const cand = settle({
      x: best.x + Math.cos(angle) * MIN_DIST,
      y: best.y + Math.sin(angle) * MIN_DIST,
    });
    if (!chosen || cand.room > chosen.room) chosen = cand;
  }
  return { x: chosen!.x, y: chosen!.y };
}
