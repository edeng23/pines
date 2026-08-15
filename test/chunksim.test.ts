/**
 * Chunk-set similarity: weighted symmetric Chamfer over cached chunk vectors,
 * two-stage ranking, and evidence. The headline behavior: a multi-topic
 * session matches BOTH of its topics' trees — the case pooled averaging
 * structurally cannot get right, because its blended vector sits between the
 * clusters, near neither.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkSimilarity, rankSimilar, weighedWindow, type WeightedChunk } from "../src/daemon/chunksim.js";
import { poolChunks } from "../src/daemon/essence.js";
import { openDb, upsertChunks, upsertTree } from "../src/store/db.js";

const DIM = 8;

function axis(i: number): Float32Array {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
}

function wc(key: string, kind: string, weight: number, vec: Float32Array): WeightedChunk {
  return { key, kind, weight, vec };
}

describe("chunkSimilarity", () => {
  it("scores identical sets at 1 and orthogonal sets at 0, staying in cosine range", () => {
    const a = [wc("a1", "user", 1, axis(0)), wc("a2", "user", 0.85, axis(1))];
    const same = chunkSimilarity(a, a)!;
    expect(same.score).toBeCloseTo(1, 5);
    const b = [wc("b1", "user", 1, axis(4)), wc("b2", "user", 0.85, axis(5))];
    const cross = chunkSimilarity(a, b)!;
    expect(cross.score).toBeCloseTo(0, 5);
  });

  it("a mixed-topic set matches a pure set far better than their pooled vectors do", () => {
    const pureX = [wc("x1", "user", 0.85, axis(0)), wc("x2", "user", 1, axis(0))];
    const mixed = [wc("mx", "user", 1, axis(0)), wc("my", "user", 1, axis(4))];
    const chunkScore = chunkSimilarity(mixed, pureX)!.score;
    const pooledCos = (() => {
      const p1 = poolChunks(pureX.map((c, i) => ({ kind: "user", pos: i, vec: c.vec })))!;
      const p2 = poolChunks(mixed.map((c, i) => ({ kind: "user", pos: i, vec: c.vec })))!;
      let dot = 0;
      for (let i = 0; i < DIM; i++) dot += p1[i]! * p2[i]!;
      return dot;
    })();
    expect(chunkScore).toBeGreaterThan(pooledCos);
    // From pureX's side every chunk finds a perfect match — the sub-topic is
    // fully recognized even though half of `mixed` is about something else.
    expect(chunkScore).toBeGreaterThan(0.7);
  });

  it("surfaces the top contributing pairs as evidence, weighted", () => {
    const a = [wc("big", "user", 1, axis(0)), wc("small", "user", 0.05, axis(1))];
    const b = [wc("bigB", "user", 1, axis(0)), wc("smallB", "user", 0.05, axis(1))];
    const { matches } = chunkSimilarity(a, b)!;
    // Both pairs match at cosine 1, but the heavy pair contributes more.
    expect(matches[0]).toMatchObject({ aKey: "big", bKey: "bigB", score: 1 });
    expect(matches.find((m) => m.aKey === "small")).toMatchObject({ bKey: "smallB" });
  });

  it("returns null for empty sets and for vectors from another model (dim mismatch)", () => {
    const a = [wc("a", "user", 1, axis(0))];
    expect(chunkSimilarity(a, [])).toBeNull();
    expect(chunkSimilarity([], a)).toBeNull();
    const other = [wc("o", "user", 1, new Float32Array(16))];
    expect(chunkSimilarity(a, other)).toBeNull();
  });
});

describe("rankSimilar (two-stage, on a real store)", () => {
  function build() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "pines-chunksim-")), "pines.db"));
    const add = (id: string, chunks: Array<{ key: string; kind: string; pos: number; vec: Float32Array }>) => {
      upsertTree(db, { tree_id: id, session_path: `/s/${id}.jsonl` });
      if (chunks.length > 0) {
        upsertChunks(
          db,
          id,
          chunks.map((c) => ({ chunkKey: c.key, kind: c.kind, pos: c.pos, embedding: Buffer.from(c.vec.buffer) })),
        );
        const pooled = poolChunks(chunks.map((c) => ({ kind: c.kind, pos: c.pos, vec: c.vec })))!;
        db.prepare("UPDATE trees SET embedding = ? WHERE tree_id = ?").run(Buffer.from(pooled.buffer), id);
      }
    };
    return { db, add };
  }

  it("ranks by chunk match, attaches resolved evidence, keeps chunkless trees pooled", async () => {
    const { db, add } = build();
    add("t_anchor", [
      { key: "a_x", kind: "user", pos: 0, vec: axis(0) },
      { key: "a_x2", kind: "user", pos: 1, vec: axis(0) },
    ]);
    add("t_sameTopic", [
      { key: "s_x", kind: "user", pos: 0, vec: axis(0) },
    ]);
    add("t_offTopic", [{ key: "o_y", kind: "user", pos: 0, vec: axis(4) }]);
    // Chunkless but with a pooled embedding on the anchor's topic (e.g. a
    // tree embedded by an older version whose chunks were wiped).
    upsertTree(db, { tree_id: "t_pooledOnly", session_path: "/s/p.jsonl" });
    db.prepare("UPDATE trees SET embedding = ? WHERE tree_id = ?").run(
      Buffer.from(axis(0).buffer),
      "t_pooledOnly",
    );

    const hits = await rankSimilar(db, "t_anchor", {
      resolveText: async (treeId, key) => `${treeId}:${key}`,
    });
    const ids = hits.map((h) => h.treeId);
    expect(ids).toContain("t_sameTopic");
    expect(ids).toContain("t_pooledOnly");
    expect(ids).not.toContain("t_offTopic"); // orthogonal: below every floor
    expect(ids).not.toContain("t_anchor");

    const same = hits.find((h) => h.treeId === "t_sameTopic")!;
    expect(same.score).toBeCloseTo(1, 5);
    // Top receipt = highest contribution = the NEWER (heavier) anchor chunk.
    expect(same.evidence![0]).toMatchObject({
      a: "t_anchor:a_x2",
      b: "t_sameTopic:s_x",
      kindA: "user",
      kindB: "user",
    });
    // The pooled-only hit is honest but receipt-less.
    expect(hits.find((h) => h.treeId === "t_pooledOnly")!.evidence).toBeUndefined();
    db.close();
  });

  it("rescues a multi-topic neighbor the pooled floor would have dropped", async () => {
    const { db, add } = build();
    add("t_anchor", [
      { key: "a_x", kind: "user", pos: 0, vec: axis(0) },
      { key: "a_x2", kind: "user", pos: 1, vec: axis(0) },
    ]);
    // One old X turn buried under three newer Y turns: pooled cosine with the
    // anchor lands ~0.23 — under the 0.25 floor the old ranking applied.
    add("t_mixed", [
      { key: "m_x", kind: "user", pos: 0, vec: axis(0) },
      { key: "m_y1", kind: "user", pos: 1, vec: axis(4) },
      { key: "m_y2", kind: "user", pos: 2, vec: axis(4) },
      { key: "m_y3", kind: "user", pos: 3, vec: axis(4) },
    ]);

    const hits = await rankSimilar(db, "t_anchor", {});
    const mixed = hits.find((h) => h.treeId === "t_mixed");
    expect(mixed).toBeDefined();
    expect(mixed!.score).toBeGreaterThan(0.25);
    db.close();
  });

  it("weighedWindow applies the pooling window and weights to cached rows", () => {
    const { db, add } = build();
    add("t_w", [
      { key: "meta:m", kind: "meta", pos: -1, vec: axis(2) },
      { key: "u0", kind: "user", pos: 0, vec: axis(0) },
      { key: "u1", kind: "user", pos: 1, vec: axis(1) },
    ]);
    const set = weighedWindow(db, "t_w");
    const byKey = new Map(set.map((c) => [c.key, c]));
    expect(byKey.get("meta:m")!.weight).toBe(1);
    expect(byKey.get("u1")!.weight).toBe(1); // newest user
    expect(byKey.get("u0")!.weight).toBeCloseTo(0.85, 5); // one step back
    expect(weighedWindow(db, "t_missing")).toEqual([]);
    db.close();
  });
});
