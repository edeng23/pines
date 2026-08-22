import { describe, expect, it } from "vitest";
import { fitPca, projectPca } from "../src/layout/pca.js";
import { relax } from "../src/layout/relax.js";
import { assignLexicalPositions, isSanePosition } from "../src/layout/lexical.js";

/** Deterministic pseudo-random 384-d cluster around a center direction. */
function clusterVec(center: number[], seed: number): number[] {
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff - 0.5;
  };
  return center.map((c) => c + rand() * 0.15);
}

function centerVec(dim: number, hot: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < 12; i++) v[(hot * 13 + i * 29) % dim] = 1;
  return v;
}

describe("PCA layout", () => {
  it("keeps synthetic clusters separated in 2-d (intra < inter distance)", () => {
    const DIM = 384;
    const centers = [centerVec(DIM, 1), centerVec(DIM, 2), centerVec(DIM, 3)];
    const perCluster = 8;
    const vectors: number[][] = [];
    const labels: number[] = [];
    centers.forEach((c, ci) => {
      for (let i = 0; i < perCluster; i++) {
        vectors.push(clusterVec(c, ci * 100 + i + 1));
        labels.push(ci);
      }
    });

    const basis = fitPca(vectors);
    const pts = vectors.map((v) => projectPca(basis, v));

    let intra = 0,
      intraN = 0,
      inter = 0,
      interN = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (labels[i] === labels[j]) {
          intra += d;
          intraN++;
        } else {
          inter += d;
          interN++;
        }
      }
    }
    expect(intra / intraN).toBeLessThan(inter / interN);
  });

  it("is deterministic (same input → identical basis and projections)", () => {
    const vectors = Array.from({ length: 10 }, (_, i) => clusterVec(centerVec(64, 1), i + 1));
    const a = fitPca(vectors);
    const b = fitPca(vectors);
    expect(a).toEqual(b);
    const pa = projectPca(a, vectors[3]!);
    const pb = projectPca(b, vectors[3]!);
    expect(pa).toEqual(pb);
  });
});

describe("relax", () => {
  it("separates overlapping movable points to at least minDist, staying bounded", () => {
    const pts = [
      { x: 0, y: 0, pinned: false },
      { x: 0.1, y: 0, pinned: false },
      { x: 0, y: 0.1, pinned: false },
    ];
    relax(pts, 2, 60);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y)).toBeGreaterThan(1.5);
      }
      expect(Math.hypot(pts[i]!.x, pts[i]!.y)).toBeLessThan(20);
    }
  });

  it("separates a movable point EXACTLY coincident with a pinned one without exploding", () => {
    // Regression: the coincident branch once divided by the synthesized zero
    // distance, flinging points ~1e9 units away and blanking the forest.
    const pts = [
      { x: -27.57, y: -4.88, pinned: true },
      { x: -27.57, y: -4.88, pinned: false },
    ];
    relax(pts, 3.6, 40);
    const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
    expect(d).toBeGreaterThan(1.5);
    expect(Math.hypot(pts[1]!.x, pts[1]!.y)).toBeLessThan(100);
  });

  it("never moves pinned points", () => {
    const pts = [
      { x: 0, y: 0, pinned: true },
      { x: 0.01, y: 0, pinned: false },
    ];
    relax(pts, 3, 40);
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
    expect(Math.hypot(pts[1]!.x, pts[1]!.y)).toBeGreaterThan(1);
  });
});

describe("isSanePosition", () => {
  it("accepts normal layout coordinates and rejects corruption", () => {
    expect(isSanePosition(0, 0)).toBe(true);
    expect(isSanePosition(-87.3, 42.1)).toBe(true);
    // The pre-fix relax() explosion wrote positions like this into DBs.
    expect(isSanePosition(-1557382692.74, -902529357.54)).toBe(false);
    expect(isSanePosition(NaN, 0)).toBe(false);
    expect(isSanePosition(0, Infinity)).toBe(false);
  });
});

describe("lexical layout", () => {
  it("clusters trees sharing a cwd and leaves positioned trees alone", () => {
    const mk = (id: string, cwd: string, x = 0, y = 0) => ({
      treeId: id,
      cwd,
      mtime: id.charCodeAt(2),
      x,
      y,
    });
    const trees = [
      mk("t_a1", "/proj/a"),
      mk("t_a2", "/proj/a"),
      mk("t_b1", "/proj/b"),
      mk("t_b2", "/proj/b"),
      mk("t_fixed", "/proj/c", 5, 5),
    ];
    const changed = assignLexicalPositions(trees);
    expect(changed.map((t) => t.treeId)).not.toContain("t_fixed");
    // Same-cwd trees are closer to each other than to the other cluster.
    const d = (a: (typeof trees)[0], b: (typeof trees)[0]) => Math.hypot(a.x - b.x, a.y - b.y);
    const [a1, a2, b1, b2] = trees;
    expect(d(a1!, a2!)).toBeLessThan(d(a1!, b1!));
    expect(d(b1!, b2!)).toBeLessThan(d(b1!, a2!));
    // Nothing left at the unpositioned sentinel.
    for (const t of trees) expect(t.x !== 0 || t.y !== 0).toBe(true);
  });

  it("packs a forest at its own pitch, not into distant colonies", () => {
    // Zoom-to-fit frames the whole spread, so what a tree is drawn at is set
    // by spread ÷ neighbor distance — not by either one alone. Anchors used
    // to sit on a fixed wide spiral, which put three projects 90 units apart
    // with their trees 3 apart, and the fit collapsed every tree to a glyph.
    const trees = Array.from({ length: 24 }, (_, i) => ({
      treeId: `t_${i}`,
      cwd: `/proj/p${i % 3}`,
      mtime: i,
      x: 0,
      y: 0,
      pinned: false,
    }));
    assignLexicalPositions(trees);
    relax(trees, 3.6, 40);
    const near = trees.map((t, i) =>
      Math.min(
        ...trees.filter((_, j) => j !== i).map((o) => Math.hypot(t.x - o.x, t.y - o.y)),
      ),
    );
    near.sort((a, b) => a - b);
    const pitch = near[Math.floor(near.length / 2)]!;
    const span = Math.max(
      Math.max(...trees.map((t) => t.x)) - Math.min(...trees.map((t) => t.x)),
      Math.max(...trees.map((t) => t.y)) - Math.min(...trees.map((t) => t.y)),
    );
    // Even density over a disc puts this near √N; the old layout was past 20.
    expect(span / pitch).toBeLessThan(9);
    // …and the trees still keep a tree's worth of room between them.
    expect(pitch).toBeGreaterThan(3);
  });
});
