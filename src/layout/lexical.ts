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

/**
 * World distance between neighboring trees — the pitch the whole forest is
 * built to, and the floor the overlap relaxation enforces (the daemon relaxes
 * with this, so the two never drift apart).
 */
export const PITCH = 3.6;

/**
 * Phyllotaxis coefficient for `r = SPIRAL * sqrt(i)`. A spiral laid out this
 * way has uniform density, and its nearest-neighbor distance comes out at
 * ~1.9× the coefficient — so deriving it from PITCH is what makes trees land
 * a tree-width apart instead of at some unrelated scale.
 */
const SPIRAL = PITCH / 1.9;

/**
 * Air between neighborhoods, as a multiple of the even-density radius. Just
 * enough that a project reads as its own stand of trees; any more and the
 * forest is mostly the gaps, which is what zoom-to-fit ends up framing.
 */
const CLUSTER_AIR = 1.25;

/** Trees ring their anchor at the forest's own pitch — one even wood. */
const RING_SPACING = SPIRAL;

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

  // Anchor per cluster on a phyllotaxis spiral, ordered by key hash so anchors
  // are stable regardless of discovery order. Anchors of clusters that already
  // have placed trees reuse their centroid.
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

  // The forest grows outward from the middle at ONE density: a neighborhood's
  // anchor sits at the radius where the trees placed before it have already
  // filled the disc (`r ∝ √filled`), so the next stand lands against the last
  // one instead of out in a field of its own. That ratio — a tree-width
  // between trees, a stand-width between stands — is what zoom-to-fit frames,
  // and it is why the forest opens on trees with room to be trees rather than
  // on a scatter of far-apart dots. (Anchors used to sit on a fixed wide
  // spiral, so three projects could span 90 world units of mostly nothing.)
  let filled = trees.length - unplaced.length;
  let slot = placedByCwd.size;

  keys.forEach((key) => {
    const members = clusters.get(key)!;
    let ax: number;
    let ay: number;
    const placed = placedByCwd.get(key);
    if (placed && placed.n > 0) {
      ax = placed.x / placed.n;
      ay = placed.y / placed.n;
    } else {
      // Radius from how full the forest already is, angle from the golden
      // turn: two stands never take the same slot, and each new one settles
      // just outside the wood rather than starting a distant colony.
      const r = CLUSTER_AIR * SPIRAL * Math.sqrt(filled + members.length / 2);
      const theta = slot++ * GOLDEN_ANGLE;
      ax = r * Math.cos(theta);
      ay = r * Math.sin(theta);
    }
    filled += members.length;

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
