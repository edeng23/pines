/**
 * Synthetic embeddings shaped like the real thing: a forest of conversations
 * about a handful of topics, spread over a few repositories.
 *
 * Sentence embeddings share a large common direction (every vector has a
 * positive cosine with every other), and topics are offsets on top of it —
 * which is exactly why a PCA of them looks like one blob. The generator
 * reproduces that so layouts are judged against realistic density, not a
 * neatly separable toy. Deterministic: same options → same vectors.
 */

export interface SyntheticTree {
  id: string;
  vec: number[];
  cwd: string;
  topic: number;
}

export interface SyntheticOptions {
  count: number;
  topics: number;
  repos: number;
  dim?: number;
  seed?: number;
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff - 0.5;
  };
}

function topicCenter(dim: number, topic: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < 12; i++) v[(topic * 13 + i * 29 + 7) % dim] = 1;
  return v;
}

export function syntheticForest(opts: SyntheticOptions): SyntheticTree[] {
  const dim = opts.dim ?? 384;
  const rand = rng(opts.seed ?? 7);
  const common = new Array<number>(dim).fill(0).map(() => rand());
  const centers = Array.from({ length: opts.topics }, (_, t) => topicCenter(dim, t));
  const out: SyntheticTree[] = [];
  for (let i = 0; i < opts.count; i++) {
    const topic = i % opts.topics;
    // Repositories roughly follow topics, but not exactly: every seventh
    // conversation is about a topic that belongs to another repo.
    const repo = i % 7 === 6 ? (i + 1) % opts.repos : Math.floor((topic * opts.repos) / opts.topics) % opts.repos;
    const c = centers[topic]!;
    const vec = new Array<number>(dim);
    for (let d = 0; d < dim; d++) vec[d] = common[d]! * 2.2 + c[d]! * 0.9 + rand() * 0.5;
    out.push({ id: `s${i}`, vec, cwd: `/home/dev/repo-${repo}`, topic });
  }
  return out;
}
