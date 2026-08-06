/**
 * Cold-start forest layout: no embeddings needed, deterministic, instant.
 *
 * Trees cluster by cwd (shared project → shared neighborhood); cluster
 * anchors sit on a phyllotaxis spiral (evenly spread, no grid artifacts),
 * and trees within a cluster ring around the anchor by recency.
 *
 * Only unpositioned trees (x=0, y=0) are placed — semantic layout (M5) and
 * user relayouts overwrite positions later; existing trees never move here.
 */

export interface Positionable {
  treeId: string;
  cwd: string | null;
  mtime: number;
  x: number;
  y: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CLUSTER_SPACING = 14;
const RING_SPACING = 3.2;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Sanity bound for persisted world coordinates. Real layouts live within
 * ~±100; anything beyond this is corruption (e.g. the pre-fix relax()
 * divide-by-zero wrote positions around ±1.5e9 into people's databases) and
 * should be re-placed rather than trusted — one such tree makes zoom-to-fit
 * frame a viewport a billion units wide.
 */
export const MAX_SANE_COORD = 10_000;

export function isSanePosition(x: number, y: number): boolean {
  return (
    Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= MAX_SANE_COORD && Math.abs(y) <= MAX_SANE_COORD
  );
}

export function assignLexicalPositions(trees: Positionable[]): Positionable[] {
  const unplaced = trees.filter((t) => t.x === 0 && t.y === 0);
  if (unplaced.length === 0) return [];

  // Cluster key: cwd (or a bucket for unknown).
  const clusters = new Map<string, Positionable[]>();
  for (const t of unplaced) {
    const key = t.cwd ?? "~unknown";
    let arr = clusters.get(key);
    if (!arr) clusters.set(key, (arr = []));
    arr.push(t);
  }

  // Anchor per cluster on a deterministic phyllotaxis spiral, ordered by key
  // hash so anchors are stable regardless of discovery order. Anchors of
  // clusters that already have placed trees reuse their centroid.
  const placedByCwd = new Map<string, { x: number; y: number; n: number }>();
  for (const t of trees) {
    if (t.x === 0 && t.y === 0) continue;
    const key = t.cwd ?? "~unknown";
    const c = placedByCwd.get(key) ?? { x: 0, y: 0, n: 0 };
    c.x += t.x;
    c.y += t.y;
    c.n++;
    placedByCwd.set(key, c);
  }

  const keys = [...clusters.keys()].sort((a, b) => hashString(a) - hashString(b));
  const changed: Positionable[] = [];

  keys.forEach((key) => {
    const members = clusters.get(key)!;
    let ax: number;
    let ay: number;
    const placed = placedByCwd.get(key);
    if (placed && placed.n > 0) {
      ax = placed.x / placed.n;
      ay = placed.y / placed.n;
    } else {
      // Spiral slot derived purely from the key hash: stable regardless of
      // discovery order, and a wide slot range keeps distinct clusters from
      // landing on the same anchor (exact collisions are still safe — the
      // overlap relaxation separates them).
      const idx = 1 + (hashString(key) % 97);
      const r = CLUSTER_SPACING * Math.sqrt(1 + (idx % 12));
      const theta = idx * GOLDEN_ANGLE;
      ax = r * Math.cos(theta);
      ay = r * Math.sin(theta);
    }

    // Members ring around the anchor by recency (newest closest).
    members.sort((a, b) => b.mtime - a.mtime);
    members.forEach((t, mi) => {
      if (mi === 0 && !placed) {
        t.x = ax;
        t.y = ay;
      } else {
        const ringIdx = placed ? mi + placed.n : mi;
        const r = RING_SPACING * Math.sqrt(ringIdx + 1);
        const theta = ringIdx * GOLDEN_ANGLE + hashString(t.treeId) % 7;
        t.x = ax + r * Math.cos(theta);
        t.y = ay + r * Math.sin(theta);
      }
      // (0,0) is the "unpositioned" sentinel — nudge exact zeros off it.
      if (t.x === 0 && t.y === 0) t.x = 0.001;
      changed.push(t);
    });
  });

  return changed;
}
