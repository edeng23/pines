/**
 * Semantic layout coordinator: turns tree content into embeddings (worker
 * thread), embeddings into 2-d positions (PCA + overlap relaxation), and
 * keeps the forest stable — new trees project through the cached basis so
 * existing trees never jump; a full refit happens only on explicit relayout
 * or when the embedded population doubles.
 *
 * Embedding is chunk-based and incremental: each user message, summary, and
 * digest embeds once (cached in tree_chunks, keyed by entry id/content hash),
 * and the tree vector is a recency-weighted pool of the cached chunks — so a
 * growing session costs O(new messages) per change, and the pooled vector
 * tracks where the conversation *went*, not just how it started.
 */
import { Worker } from "node:worker_threads";
import { fitPca, projectPca, type PcaBasis } from "../layout/pca.js";
import { relax } from "../layout/relax.js";
import { parseSessionFile } from "../session/parser.js";
import {
  chunksForTree,
  deleteChunks,
  pruneUserChunks,
  upsertChunks,
  vectorOf,
  type DB,
} from "../store/db.js";
import { DEFAULT_EMBED_MODEL, loadConfig } from "../shared/config.js";
import {
  essenceChunks,
  poolChunks,
  validChunkKeys,
  MAX_SUMMARY_CHUNKS,
  MAX_USER_CHUNKS,
  USER_CHUNK_CACHE,
  type EssenceChunk,
} from "./essence.js";
import type { Supervisor, TreeRecord } from "./supervisor.js";

const DEBOUNCE_MS = 5000;
const MIN_TREES_FOR_PCA = 3;
/** Bump when chunking/pooling changes meaningfully: stale trees re-embed at startup. */
export const EMBED_VERSION = 2;
/** Stagger between startup backfill enqueues, so a big forest warms up gently. */
const BACKFILL_STAGGER_MS = 500;

export class SemanticLayout {
  private worker: Worker | null = null;
  private workerFailed = false;
  private modelReady = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingReqs = new Map<
    string,
    { treeId: string; chunks: EssenceChunk[] }
  >();
  private reqCounter = 0;
  /** Trees whose stale embeddings are being rebuilt at startup; refit when empty. */
  private backfill: Set<string> | null = null;

  constructor(
    private readonly deps: {
      db: DB;
      supervisor: Supervisor;
      log: (msg: string) => void;
      /** Broadcast a status toast to clients (used once for warmup/failure). */
      toast: (text: string) => void;
    },
  ) {}

  /** Schedule (re)embedding of a tree, debounced per tree. */
  enqueue(rec: TreeRecord): void {
    if (this.workerFailed || !rec.sessionPath) return;
    const prior = this.timers.get(rec.treeId);
    if (prior) clearTimeout(prior);
    this.timers.set(
      rec.treeId,
      setTimeout(() => {
        this.timers.delete(rec.treeId);
        void this.embed(rec);
      }, DEBOUNCE_MS),
    );
  }

  /**
   * Startup reconciliation: re-embed trees whose stored embedding predates the
   * current chunking scheme, and wipe everything if the model changed (vectors
   * from different models share no space). Called once by the daemon after
   * persisted trees are loaded.
   */
  enqueueStale(): void {
    const model = loadConfig().embedModel ?? DEFAULT_EMBED_MODEL;
    const stored = this.deps.db
      .prepare("SELECT value FROM meta WHERE key = 'embed_model'")
      .get() as { value: string } | undefined;
    if (stored && stored.value !== model) {
      this.deps.log(`embed model changed (${stored.value} → ${model}) — full re-embed`);
      this.deps.db.exec("DELETE FROM tree_chunks");
      this.deps.db.exec("UPDATE trees SET embedding = NULL, embedding_version = 0");
      this.deps.db.prepare("DELETE FROM meta WHERE key = 'pca_basis'").run();
    }
    this.deps.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(model);

    const stale = this.deps.db
      .prepare("SELECT tree_id FROM trees WHERE embedding IS NOT NULL AND embedding_version < ?")
      .all(EMBED_VERSION) as Array<{ tree_id: string }>;
    const recs = stale
      .map((row) => this.deps.supervisor.trees.get(row.tree_id))
      .filter((r): r is TreeRecord => r !== undefined);
    if (recs.length === 0) return;
    this.backfill = new Set(recs.map((r) => r.treeId));
    this.deps.log(`re-embedding ${recs.length} tree(s) with stale embeddings`);
    recs.forEach((rec, i) => {
      setTimeout(() => {
        if (!this.timers.has(rec.treeId)) this.enqueue(rec);
      }, i * BACKFILL_STAGGER_MS);
    });
  }

  private async embed(rec: TreeRecord): Promise<void> {
    if (this.workerFailed || !rec.sessionPath) return;
    try {
      const parsed = await parseSessionFile(rec.sessionPath);
      const chunks = essenceChunks(rec.name ?? parsed.name, parsed);
      if (chunks.length === 0) {
        this.settleBackfill(rec.treeId);
        return;
      }

      // Diff cached chunks against the full valid-key universe (not the capped
      // pooling selection) so windows scrolling past a chunk doesn't churn it.
      // Vanished keys cover renames and file shrink/fork flows.
      const cached = new Set(
        chunksForTree(this.deps.db, rec.treeId).map((c) => c.chunk_key),
      );
      const valid = validChunkKeys(rec.name ?? parsed.name, parsed);
      const stale = [...cached].filter((k) => !valid.has(k));
      if (stale.length > 0) deleteChunks(this.deps.db, rec.treeId, stale);

      const pending = chunks.filter((c) => !cached.has(c.key));
      if (pending.length === 0) {
        // Nothing new to embed; repool only if something actually changed.
        const row = this.deps.db
          .prepare("SELECT embedding_version FROM trees WHERE tree_id = ?")
          .get(rec.treeId) as { embedding_version: number } | undefined;
        if (stale.length > 0 || (row && row.embedding_version < EMBED_VERSION)) {
          this.repool(rec.treeId);
        } else {
          this.settleBackfill(rec.treeId);
        }
        return;
      }

      const worker = this.ensureWorker();
      if (!worker) {
        this.settleBackfill(rec.treeId);
        return;
      }
      const reqId = `r${++this.reqCounter}`;
      this.pendingReqs.set(reqId, { treeId: rec.treeId, chunks: pending });
      worker.postMessage({ reqId, texts: pending.map((c) => c.text) });
    } catch (err) {
      this.deps.log(`embed prep failed for ${rec.treeId}: ${String(err)}`);
      this.settleBackfill(rec.treeId);
    }
  }

  private ensureWorker(): Worker | null {
    if (this.workerFailed) return null;
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL("./embed-worker.js", import.meta.url), {
        env: {
          ...process.env,
          PINES_EMBED_MODEL: loadConfig().embedModel ?? DEFAULT_EMBED_MODEL,
        },
      });
    } catch (err) {
      this.workerFailed = true;
      this.deps.log(`embed worker failed to start: ${String(err)} — lexical layout only`);
      return null;
    }
    this.worker.unref();
    // Progress stays out of the user's face: warming and success are log
    // lines; only the downgrade to lexical layout is worth a toast.
    this.deps.log("semantic layout warming…");
    this.worker.on("message", (msg: Record<string, unknown>) => {
      if (msg.ready) {
        this.modelReady = true;
        this.deps.log("semantic layout ready");
        return;
      }
      if (msg.fatal) {
        this.workerFailed = true;
        this.pendingReqs.clear();
        this.backfill = null;
        this.deps.log(`embed worker fatal: ${String(msg.fatal)} — lexical layout only`);
        this.deps.toast("semantic layout unavailable — arranging lexically");
        return;
      }
      const reqId = typeof msg.reqId === "string" ? msg.reqId : null;
      if (!reqId) return;
      const req = this.pendingReqs.get(reqId);
      this.pendingReqs.delete(reqId);
      if (!req) return;
      if (msg.error) {
        // Keep the previous pooled vector — a stale essence beats none.
        this.deps.log(`embed failed for ${req.treeId}: ${String(msg.error)}`);
        this.settleBackfill(req.treeId);
        return;
      }
      if (Array.isArray(msg.vectors)) {
        this.onVectors(req, msg.vectors as number[][]);
      }
    });
    this.worker.on("error", (err) => {
      this.workerFailed = true;
      this.pendingReqs.clear();
      this.deps.log(`embed worker error: ${err.message} — lexical layout only`);
    });
    return this.worker;
  }

  private onVectors(req: { treeId: string; chunks: EssenceChunk[] }, vectors: number[][]): void {
    if (vectors.length !== req.chunks.length) {
      this.deps.log(`embed reply shape mismatch for ${req.treeId}`);
      return;
    }
    upsertChunks(
      this.deps.db,
      req.treeId,
      req.chunks.map((c, i) => ({
        chunkKey: c.key,
        kind: c.kind,
        pos: c.pos,
        embedding: Buffer.from(new Float32Array(vectors[i]!).buffer),
      })),
    );
    pruneUserChunks(this.deps.db, req.treeId, USER_CHUNK_CACHE);
    this.repool(req.treeId);
  }

  /**
   * Recompute the pooled tree vector from cached chunks and re-place the tree.
   * Reading back from the DB (rather than the worker reply) makes overlapping
   * embeds for one tree converge on the full-file state regardless of order.
   */
  private repool(treeId: string): void {
    const rows = chunksForTree(this.deps.db, treeId);
    const users = rows.filter((r) => r.kind === "user");
    const userWindow = new Set(
      users
        .slice(-MAX_USER_CHUNKS)
        .concat(users.length > 0 ? [users[0]!] : [])
        .map((r) => r.chunk_key),
    );
    const summaries = rows.filter((r) => r.kind === "summary");
    const summaryWindow = new Set(summaries.slice(-MAX_SUMMARY_CHUNKS).map((r) => r.chunk_key));
    const pooled = poolChunks(
      rows
        .filter(
          (r) =>
            r.kind === "meta" ||
            r.kind === "tools" ||
            (r.kind === "user" && userWindow.has(r.chunk_key)) ||
            (r.kind === "summary" && summaryWindow.has(r.chunk_key)),
        )
        .map((r) => ({ kind: r.kind, pos: r.pos, vec: vectorOf(r.embedding) })),
    );
    if (!pooled) {
      this.settleBackfill(treeId);
      return;
    }
    const blob = Buffer.from(pooled.buffer);
    this.deps.db
      .prepare("UPDATE trees SET embedding = ?, embedding_version = ? WHERE tree_id = ?")
      .run(blob, EMBED_VERSION, treeId);
    this.placeTree(treeId);
    this.settleBackfill(treeId);
  }

  /** Mark one backfilled tree settled; refit once when the whole set drains. */
  private settleBackfill(treeId: string): void {
    if (!this.backfill?.delete(treeId)) return;
    if (this.backfill.size === 0) {
      this.backfill = null;
      this.deps.log("stale-embedding backfill drained — refitting basis");
      this.refit();
    }
  }

  private loadBasis(): { basis: PcaBasis; fitCount: number } | null {
    const row = this.deps.db.prepare("SELECT value FROM meta WHERE key = 'pca_basis'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as { basis: PcaBasis; fitCount: number };
    } catch {
      return null;
    }
  }

  private saveBasis(basis: PcaBasis, fitCount: number): void {
    this.deps.db
      .prepare("INSERT INTO meta (key, value) VALUES ('pca_basis', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ basis, fitCount }));
  }

  private embeddedRows(): Array<{ tree_id: string; embedding: Buffer }> {
    return this.deps.db
      .prepare("SELECT tree_id, embedding FROM trees WHERE embedding IS NOT NULL")
      .all() as Array<{ tree_id: string; embedding: Buffer }>;
  }

  /** Place one newly-embedded tree without disturbing the rest. */
  private placeTree(treeId: string): void {
    const rows = this.embeddedRows();
    if (rows.length < MIN_TREES_FOR_PCA) return; // not enough signal yet

    let stored = this.loadBasis();
    if (!stored || rows.length >= stored.fitCount * 2) {
      this.refit(rows);
      return;
    }

    const row = rows.find((r) => r.tree_id === treeId);
    const rec = this.deps.supervisor.trees.get(treeId);
    if (!row || !rec) return;
    const pos = projectPca(stored.basis, vectorOf(row.embedding));

    const points = [...this.deps.supervisor.trees.values()].map((t) => ({
      x: t === rec ? pos.x : t.x,
      y: t === rec ? pos.y : t.y,
      pinned: t !== rec,
      rec: t,
    }));
    relax(points);
    const placed = points.find((p) => p.rec === rec)!;
    rec.x = placed.x;
    rec.y = placed.y;
    this.deps.supervisor.notify(rec);
  }

  /** Refit the basis and reproject every embedded tree (non-embedded pinned). */
  refit(rows = this.embeddedRows()): void {
    if (rows.length < MIN_TREES_FOR_PCA) return;
    const vectors = rows.map((r) => vectorOf(r.embedding));
    const basis = fitPca(vectors);
    this.saveBasis(basis, rows.length);

    const byId = new Map(rows.map((r, i) => [r.tree_id, vectors[i]!]));
    const points: Array<{ x: number; y: number; pinned: boolean; rec: TreeRecord }> = [];
    for (const rec of this.deps.supervisor.trees.values()) {
      const vec = byId.get(rec.treeId);
      if (vec) {
        const pos = projectPca(basis, vec);
        points.push({ x: pos.x, y: pos.y, pinned: false, rec });
      } else {
        points.push({ x: rec.x, y: rec.y, pinned: true, rec });
      }
    }
    relax(points);
    for (const p of points) {
      if (p.pinned) continue;
      if (p.rec.x !== p.x || p.rec.y !== p.y) {
        p.rec.x = p.x;
        p.rec.y = p.y;
        this.deps.supervisor.notify(p.rec);
      }
    }
    this.deps.log(`semantic refit over ${rows.length} embedded tree(s)`);
  }

  async dispose(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pendingReqs.clear();
    await this.worker?.terminate();
  }
}
