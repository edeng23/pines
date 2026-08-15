/**
 * Chunk-set similarity: compare two trees by MATCHING their essence chunks
 * instead of comparing one blended vector per tree.
 *
 * Pooling averages a session into a single point, which erases sub-topics: a
 * conversation that is half auth and half parser lands *between* the two
 * clusters, similar to nothing. Matching chunk sets fixes that — each side's
 * chunks find their best counterpart on the other side (a weighted symmetric
 * Chamfer score, ColBERT-style late interaction) — and it makes every score
 * explainable for free: the top contributing pairs ARE the receipts.
 *
 * Used as stage 2 of the `similar` request: the pooled cosine (cheap, whole
 * forest) shortlists candidates; this re-ranks them and attaches evidence.
 * The pooled vector keeps its other job (map layout) untouched.
 */
import {
  chunksForTree,
  similarTrees,
  vectorOf,
  type DB,
} from "../store/db.js";
import { selectChunkWindow, weighChunks } from "./essence.js";
import type { SimilarEvidence, SimilarHit } from "../shared/types.js";

export interface WeightedChunk {
  key: string;
  kind: string;
  weight: number;
  vec: Float32Array;
}

/**
 * A tree's scorable chunk set: the cached rows, narrowed to the same pooling
 * window and weighed by the same importance formula the pooled vector uses.
 * Empty when the tree never embedded (model cold / lexical-only).
 */
export function weighedWindow(db: DB, treeId: string): WeightedChunk[] {
  const rows = selectChunkWindow(chunksForTree(db, treeId));
  return weighChunks(rows.map((r) => ({ kind: r.kind, pos: r.pos, row: r }))).map(
    ({ chunk, weight }) => ({
      key: chunk.row.chunk_key,
      kind: chunk.kind,
      weight,
      vec: vectorOf(chunk.row.embedding),
    }),
  );
}

export interface ChunkMatch {
  aKey: string;
  bKey: string;
  aKind: string;
  bKind: string;
  /** Raw cosine of the pair. */
  score: number;
  /** score × mean pair weight — what the pair contributed to the ranking. */
  contribution: number;
}

export interface ChunkSimResult {
  /** Weighted symmetric Chamfer score, in cosine's [-1, 1] range. */
  score: number;
  /** Top contributing pairs, by contribution, deduped. */
  matches: ChunkMatch[];
}

/**
 * Weighted symmetric Chamfer: each chunk of A meets its best match in B
 * (weighted mean over A), and vice versa; the score is the mean of the two
 * directions. Weights are normalized per side, so the result stays in
 * cosine's range and a low-weight tail can't drown the signal.
 */
export function chunkSimilarity(
  a: WeightedChunk[],
  b: WeightedChunk[],
  topK = 3,
): ChunkSimResult | null {
  if (a.length === 0 || b.length === 0) return null;
  const dim = a[0]!.vec.length;
  const bSame = b.filter((c) => c.vec.length === dim);
  if (bSame.length === 0) return null; // stale vectors from another model

  const pairs = new Map<string, ChunkMatch>();
  const note = (x: WeightedChunk, y: WeightedChunk, cos: number, flipped: boolean) => {
    const [ac, bc] = flipped ? [y, x] : [x, y];
    const key = `${ac.key}|${bc.key}`;
    if (pairs.has(key)) return;
    pairs.set(key, {
      aKey: ac.key,
      bKey: bc.key,
      aKind: ac.kind,
      bKind: bc.kind,
      score: cos,
      contribution: cos * ((ac.weight + bc.weight) / 2),
    });
  };

  const direction = (from: WeightedChunk[], to: WeightedChunk[], flipped: boolean): number => {
    let acc = 0;
    let wSum = 0;
    for (const c of from) {
      let best = -Infinity;
      let bestTo: WeightedChunk | undefined;
      for (const t of to) {
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += c.vec[i]! * t.vec[i]!;
        if (dot > best) {
          best = dot;
          bestTo = t;
        }
      }
      if (!bestTo) continue;
      acc += best * c.weight;
      wSum += c.weight;
      note(c, bestTo, best, flipped);
    }
    return wSum > 0 ? acc / wSum : 0;
  };

  const aSame = a.filter((c) => c.vec.length === dim);
  const score = (direction(aSame, bSame, false) + direction(bSame, aSame, true)) / 2;
  const matches = [...pairs.values()]
    .sort((x, y) => y.contribution - x.contribution)
    .slice(0, topK);
  return { score, matches };
}

/** Stage-1 shortlist size: cheap pooled cosine narrows the field to this. */
const CANDIDATES = 32;
/**
 * Stage-1 floor, deliberately BELOW the final 0.25: pooled vectors under-score
 * exactly the multi-topic sessions stage 2 exists to catch — a strict stage-1
 * floor would filter them before the honest scorer ever saw them.
 */
const STAGE1_FLOOR = 0.1;
/** Final floor, same bar the pooled-only ranking used. */
const MIN_SCORE = 0.25;

/** Resolve a chunk key to a display excerpt (undefined = drop the pair). */
export type ChunkTextResolver = (
  treeId: string,
  chunkKey: string,
) => Promise<string | undefined>;

/**
 * The `similar` ranking: pooled shortlist → chunk-set re-rank → evidence.
 * Candidates without cached chunks keep their stage-1 pooled score with no
 * evidence (the model may be cold) — `s` degrades, never goes blank.
 */
export async function rankSimilar(
  db: DB,
  treeId: string,
  opts: { k?: number; resolveText?: ChunkTextResolver } = {},
): Promise<SimilarHit[]> {
  const k = opts.k ?? 8;
  const shortlist = similarTrees(db, treeId, CANDIDATES, STAGE1_FLOOR);
  if (shortlist.length === 0) return [];

  const anchor = weighedWindow(db, treeId);
  const scored: Array<{ treeId: string; score: number; matches: ChunkMatch[] }> = [];
  for (const cand of shortlist) {
    const theirs = anchor.length > 0 ? weighedWindow(db, cand.tree_id) : [];
    const sim = anchor.length > 0 ? chunkSimilarity(anchor, theirs) : null;
    if (sim) scored.push({ treeId: cand.tree_id, score: sim.score, matches: sim.matches });
    else if (cand.score >= MIN_SCORE) {
      // No chunk sets to match (cold model, chunkless tree): the pooled
      // score is still an honest cosine — keep it, without receipts.
      scored.push({ treeId: cand.tree_id, score: cand.score, matches: [] });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const top = scored.filter((s) => s.score >= MIN_SCORE).slice(0, k);

  const hits: SimilarHit[] = [];
  for (const s of top) {
    let evidence: SimilarEvidence[] | undefined;
    if (opts.resolveText && s.matches.length > 0) {
      evidence = [];
      for (const m of s.matches) {
        const a = await opts.resolveText(treeId, m.aKey);
        const b = await opts.resolveText(s.treeId, m.bKey);
        // A pruned or vanished chunk has no text to show — drop the pair
        // rather than presenting an id as an explanation.
        if (a && b) evidence.push({ a, b, kindA: m.aKind, kindB: m.bKind, score: m.score });
      }
      if (evidence.length === 0) evidence = undefined;
    }
    hits.push({ treeId: s.treeId, score: s.score, ...(evidence ? { evidence } : {}) });
  }
  return hits;
}
