import { describe, expect, it } from "vitest";
import {
  agglomerate,
  ASPECT,
  groveCount,
  LAYOUT_STRATEGIES,
  layoutForest,
  MIN_DIST,
  parseLayoutStrategy,
  placeNewTree,
  type LayoutItem,
  type LayoutStrategy,
} from "../src/layout/strategies.js";
import { syntheticForest, type SyntheticTree } from "./fixtures/embeddings.js";

function itemsOf(trees: SyntheticTree[]): LayoutItem[] {
  return trees.map((t) => ({ id: t.id, vec: t.vec, cwd: t.cwd, x: 0, y: 0 }));
}

/**
 * Mean silhouette of the 2-d positions against a labelling: how much closer
 * each tree sits to its own group than to the nearest other group. 1 is
 * perfectly separated, 0 is indistinguishable.
 */
function silhouette(
  pos: Map<string, { x: number; y: number }>,
  trees: SyntheticTree[],
  labelOf: (t: SyntheticTree) => string,
): number {
  let total = 0;
  for (const a of trees) {
    const pa = pos.get(a.id)!;
    const byLabel = new Map<string, number[]>();
    for (const b of trees) {
      if (b === a) continue;
      const pb = pos.get(b.id)!;
      const arr = byLabel.get(labelOf(b)) ?? [];
      arr.push(Math.hypot(pa.x - pb.x, pa.y - pb.y));
      byLabel.set(labelOf(b), arr);
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const own = mean(byLabel.get(labelOf(a)) ?? [0]);
    let other = Infinity;
    for (const [l, ds] of byLabel) if (l !== labelOf(a)) other = Math.min(other, mean(ds));
    total += (other - own) / Math.max(own, other);
  }
  return total / trees.length;
}

function minPairDistance(pos: Map<string, { x: number; y: number }>): number {
  const pts = [...pos.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
    }
  }
  return min;
}

const FOREST = syntheticForest({ count: 40, topics: 8, repos: 3 });

describe("layout strategies (experimental comparison set)", () => {
  it("parses only known strategy ids", () => {
    for (const s of LAYOUT_STRATEGIES) expect(parseLayoutStrategy(s.id)).toBe(s.id);
    expect(parseLayoutStrategy("tsne")).toBeUndefined();
    expect(parseLayoutStrategy(undefined)).toBeUndefined();
    expect(parseLayoutStrategy(42)).toBeUndefined();
  });

  it.each(LAYOUT_STRATEGIES.map((s) => s.id))(
    "%s: places every embedded tree, finite, apart, pinning the unembedded",
    (strategy) => {
      const items = itemsOf(FOREST);
      // One tree without a vector, sitting somewhere already.
      items.push({ id: "bare", vec: null, cwd: "/home/dev/repo-0", x: 3, y: 4 });
      const { positions, basis } = layoutForest(strategy, items);
      expect(basis).not.toBeNull();
      expect(positions.size).toBe(FOREST.length);
      expect(positions.has("bare")).toBe(false);
      for (const p of positions.values()) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(Math.abs(p.x)).toBeLessThan(200);
        expect(Math.abs(p.y)).toBeLessThan(200);
      }
      // Overlap relaxation is the shared last word, and it honors the pin.
      expect(minPairDistance(positions)).toBeGreaterThan(MIN_DIST * 0.8);
      for (const p of positions.values()) {
        expect(Math.hypot(p.x - 3, p.y - 4)).toBeGreaterThan(MIN_DIST * 0.8);
      }
    },
  );

  it.each(LAYOUT_STRATEGIES.map((s) => s.id))("%s: is deterministic", (strategy) => {
    const a = layoutForest(strategy, itemsOf(FOREST)).positions;
    const b = layoutForest(strategy, itemsOf(FOREST)).positions;
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("declines with too few embedded trees", () => {
    const items = itemsOf(FOREST.slice(0, 2));
    for (const s of LAYOUT_STRATEGIES) {
      const { positions, basis } = layoutForest(s.id, items);
      expect(positions.size).toBe(0);
      expect(basis).toBeNull();
    }
  });

  it("widened strategies span more sideways than the baseline", () => {
    const extent = (strategy: LayoutStrategy) => {
      const pos = layoutForest(strategy, itemsOf(FOREST)).positions;
      let x = 0;
      let y = 0;
      for (const p of pos.values()) {
        x = Math.max(x, Math.abs(p.x));
        y = Math.max(y, Math.abs(p.y));
      }
      return x / y;
    };
    const base = extent("pca");
    expect(extent("wide")).toBeGreaterThan(base * ASPECT * 0.85);
  });

  it("groves and springs separate topics better than the baseline", () => {
    const byTopic = (t: SyntheticTree) => String(t.topic);
    const score = (s: LayoutStrategy) => silhouette(layoutForest(s, itemsOf(FOREST)).positions, FOREST, byTopic);
    const base = score("pca");
    expect(score("groves")).toBeGreaterThan(base);
    expect(score("springs")).toBeGreaterThan(base);
  });

  it("projects separate working directories better than anything else", () => {
    const byCwd = (t: SyntheticTree) => t.cwd;
    const score = (s: LayoutStrategy) => silhouette(layoutForest(s, itemsOf(FOREST)).positions, FOREST, byCwd);
    const projects = score("projects");
    for (const s of LAYOUT_STRATEGIES) {
      if (s.id === "projects") continue;
      expect(projects).toBeGreaterThan(score(s.id));
    }
    expect(projects).toBeGreaterThan(0.5);
  });

  it("topic groves put each tree in a grove with its own topic", () => {
    const units = FOREST.map((t) => {
      const n = Math.hypot(...t.vec);
      return t.vec.map((v) => v / n);
    });
    const labels = agglomerate(units, 8);
    expect(new Set(labels).size).toBe(8);
    // Each grove is (nearly) pure: its majority topic covers most members.
    const groves = new Map<number, number[]>();
    labels.forEach((l, i) => (groves.get(l) ?? groves.set(l, []).get(l)!).push(FOREST[i]!.topic));
    for (const topics of groves.values()) {
      const counts = new Map<number, number>();
      for (const t of topics) counts.set(t, (counts.get(t) ?? 0) + 1);
      expect(Math.max(...counts.values()) / topics.length).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("grove count grows gently with the forest", () => {
    expect(groveCount(2)).toBe(1);
    expect(groveCount(4)).toBe(2);
    expect(groveCount(40)).toBe(6);
    expect(groveCount(400)).toBe(12);
  });

  it.each(LAYOUT_STRATEGIES.map((s) => s.id))(
    "%s: a newcomer lands beside its closest match without moving anyone",
    (strategy) => {
      const items = itemsOf(FOREST);
      const { positions, basis } = layoutForest(strategy, items);
      for (const it of items) {
        const p = positions.get(it.id)!;
        it.x = p.x;
        it.y = p.y;
      }
      const before = new Map(items.map((it) => [it.id, { x: it.x, y: it.y }]));
      // A new conversation on topic 0 (the same topic as s0, s8, s16, …),
      // drawn from the same generator so it lives in the same space.
      const extra = syntheticForest({ count: 41, topics: 8, repos: 3 })[40]!;
      const newcomer: LayoutItem = { id: "new", vec: extra.vec, cwd: extra.cwd, x: 0, y: 0 };
      items.push(newcomer);
      const placed = placeNewTree(strategy, items, "new", basis);
      expect(placed).not.toBeNull();
      expect(Number.isFinite(placed!.x) && Number.isFinite(placed!.y)).toBe(true);
      // Nobody else moved.
      for (const it of items) if (it.id !== "new") expect(before.get(it.id)).toEqual({ x: it.x, y: it.y });
      // It has room, and — for the strategies that anchor a newcomer to its
      // closest match — its nearest neighbor on the map talks about the
      // same thing. (The baseline projects instead, and a projection of a
      // blob can land anywhere in it: that is the complaint this set of
      // strategies exists to answer.)
      let best: SyntheticTree | null = null;
      let bestD = Infinity;
      for (const t of FOREST) {
        const p = positions.get(t.id)!;
        const d = Math.hypot(p.x - placed!.x, p.y - placed!.y);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      expect(bestD).toBeGreaterThan(0);
      if (strategy !== "pca" && strategy !== "wide") {
        expect(bestD).toBeGreaterThan(MIN_DIST * 0.8);
        expect(best!.topic).toBe(extra.topic);
      }
    },
  );
});
