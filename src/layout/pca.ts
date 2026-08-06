/**
 * PCA projection: 384-d embeddings → 2-d forest coordinates.
 *
 * Deterministic power iteration for the top-2 principal components. The basis
 * (mean + two components) is cached; new trees project through the cached
 * basis so existing trees never move when a tree is added.
 */

export interface PcaBasis {
  mean: number[];
  c1: number[];
  c2: number[];
  /** Scale applied after projection so the forest spans sensible world units. */
  scale: number;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Deterministic unit start vector (no Math.random — reproducible layouts). */
function seedVector(d: number, seed: number): number[] {
  const v = new Array<number>(d);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < d; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    v[i] = state / 0xffffffff - 0.5;
  }
  const n = norm(v);
  for (let i = 0; i < d; i++) v[i]! /= n;
  return v;
}

/**
 * Power-iterate the covariance of `vectors` (n×d, centered internally) for the
 * top component orthogonal to `deflate` (if given).
 */
function topComponent(
  centered: number[][],
  d: number,
  deflate: number[] | null,
  seed: number,
): number[] {
  let v = seedVector(d, seed);
  for (let iter = 0; iter < 60; iter++) {
    // w = Cov · v computed as Σ x (x·v) without materializing the d×d matrix.
    const w = new Array<number>(d).fill(0);
    for (const x of centered) {
      const p = dot(x, v);
      for (let i = 0; i < d; i++) w[i]! += x[i]! * p;
    }
    if (deflate) {
      const p = dot(w, deflate);
      for (let i = 0; i < d; i++) w[i]! -= deflate[i]! * p;
    }
    const n = norm(w);
    if (n < 1e-12) break;
    for (let i = 0; i < d; i++) w[i]! /= n;
    v = w;
  }
  return v;
}

export function fitPca(vectors: Float32Array[] | number[][], targetSpan = 30): PcaBasis {
  const n = vectors.length;
  const d = vectors[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i]! += (v[i] as number) / n;
  const centered = (vectors as ArrayLike<number>[]).map((v) => {
    const c = new Array<number>(d);
    for (let i = 0; i < d; i++) c[i] = (v[i] as number) - mean[i]!;
    return c;
  });

  const c1 = topComponent(centered, d, null, 42);
  const c2 = topComponent(centered, d, c1, 1337);

  // Scale so the projected point cloud spans roughly `targetSpan` world units.
  let maxAbs = 1e-9;
  for (const x of centered) {
    maxAbs = Math.max(maxAbs, Math.abs(dot(x, c1)), Math.abs(dot(x, c2)));
  }
  return { mean, c1, c2, scale: targetSpan / (2 * maxAbs) };
}

export function projectPca(basis: PcaBasis, v: ArrayLike<number>): { x: number; y: number } {
  const d = basis.mean.length;
  const c = new Array<number>(d);
  for (let i = 0; i < d; i++) c[i] = (v[i] as number) - basis.mean[i]!;
  return { x: dot(c, basis.c1) * basis.scale, y: dot(c, basis.c2) * basis.scale };
}
