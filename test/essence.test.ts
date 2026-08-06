/**
 * Essence extraction + pooling — the pure (model-free) half of the embedding
 * pipeline: chunk selection policy, stable/content-hashed chunk keys, the
 * tool-activity digest, and the recency-weighted pooling math.
 */
import { describe, expect, it } from "vitest";
import { parseSessionContent } from "../src/session/parser.js";
import {
  essenceChunks,
  poolChunks,
  toolsDigest,
  validChunkKeys,
  MAX_USER_CHUNKS,
} from "../src/daemon/essence.js";
import { header, msg, sessionInfo } from "./fixtures/sessions.js";

/** Assistant message whose content is toolCall parts (pi-ai shape). */
function toolCallMsg(
  id: string,
  parentId: string | null,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: `tc_${id}`, name: c.name, arguments: c.args })),
      timestamp: 0,
    },
  });
}

async function parse(lines: string[]) {
  return parseSessionContent(lines.join("\n") + "\n");
}

describe("essenceChunks", () => {
  it("selects newest user messages but always keeps the opening message", async () => {
    const lines = [header("/proj/a")];
    let prev: string | null = null;
    for (let i = 0; i < 40; i++) {
      const id = `u${String(i).padStart(4, "0")}`;
      lines.push(msg(id, prev, "user", `user message number ${i}`));
      prev = id;
    }
    const parsed = await parse(lines);
    const chunks = essenceChunks(null, parsed);
    const users = chunks.filter((c) => c.kind === "user");
    expect(users).toHaveLength(MAX_USER_CHUNKS + 1); // window + pinned opener
    expect(users[0]!.key).toBe("u0000"); // the opener leads
    expect(users.at(-1)!.key).toBe("u0039"); // ... and the newest closes
  });

  it("keys the meta chunk by content so a rename re-embeds exactly that chunk", async () => {
    const parsed = await parse([
      header("/proj/a"),
      msg("u1", null, "user", "hello"),
      sessionInfo("s1", "auth work"),
    ]);
    const before = essenceChunks(null, parsed).find((c) => c.kind === "meta")!;
    const after = essenceChunks("renamed tree", parsed).find((c) => c.kind === "meta")!;
    expect(before.key).toMatch(/^meta:/);
    expect(after.key).toMatch(/^meta:/);
    expect(before.key).not.toBe(after.key);
    // The user chunk is untouched by the rename.
    expect(essenceChunks("renamed tree", parsed).find((c) => c.kind === "user")!.key).toBe("u1");
  });

  it("produces identical user-chunk keys when re-parsing a grown file", async () => {
    const base = [header("/proj/a"), msg("u1", null, "user", "first prompt")];
    const grown = [...base, msg("a1", "u1", "assistant", "ok"), msg("u2", "a1", "user", "second prompt")];
    const k1 = essenceChunks(null, await parse(base)).find((c) => c.kind === "user")!.key;
    const users2 = essenceChunks(null, await parse(grown)).filter((c) => c.kind === "user");
    expect(users2.map((c) => c.key)).toEqual([k1, "u2"]);
  });

  it("skips empty sessions entirely", async () => {
    const parsed = await parse([header("/proj/a")]);
    expect(essenceChunks(null, parsed)).toHaveLength(0);
  });
});

describe("toolsDigest", () => {
  it("digests file paths and tool names with frequency ranking, stably", async () => {
    const lines = [
      header("/proj/a"),
      msg("u1", null, "user", "fix the daemon"),
      toolCallMsg("a1", "u1", [
        { name: "read", args: { path: "src/daemon/semantic.ts" } },
        { name: "edit", args: { path: "src/daemon/semantic.ts" } },
      ]),
      toolCallMsg("a2", "a1", [
        { name: "edit", args: { path: "src/daemon/semantic.ts" } },
        { name: "bash", args: { command: "pnpm test --run" } },
      ]),
    ];
    const parsed = await parse(lines);
    const digest = toolsDigest(parsed);
    expect(digest).toContain("src/daemon/semantic.ts");
    expect(digest).toContain("edit ×2");
    expect(digest).toContain("bash (pnpm)");
    // Same activity → same digest → same content-hashed chunk key.
    expect(toolsDigest(await parse(lines))).toBe(digest);
    const toolChunk = essenceChunks(null, parsed).find((c) => c.kind === "tools")!;
    expect(toolChunk.key).toMatch(/^tools:/);
  });

  it("is empty when no tools ran (no digest chunk emitted)", async () => {
    const parsed = await parse([header("/proj/a"), msg("u1", null, "user", "hi")]);
    expect(toolsDigest(parsed)).toBe("");
    expect(essenceChunks(null, parsed).some((c) => c.kind === "tools")).toBe(false);
  });
});

describe("validChunkKeys", () => {
  it("includes user messages that scrolled out of the pooling window", async () => {
    const lines = [header("/proj/a")];
    let prev: string | null = null;
    for (let i = 0; i < 40; i++) {
      const id = `u${String(i).padStart(4, "0")}`;
      lines.push(msg(id, prev, "user", `message ${i}`));
      prev = id;
    }
    const parsed = await parse(lines);
    const valid = validChunkKeys(null, parsed);
    // u0005 is far outside the newest-24 window but still a valid cached chunk.
    expect(valid.has("u0005")).toBe(true);
  });
});

/* ------------------------------- pooling math ------------------------------ */

/** Deterministic pseudo-random unit vector near a center direction. */
function clusterVec(center: number[], seed: number): Float32Array {
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff - 0.5;
  };
  const v = center.map((c) => c + rand() * 0.15);
  const norm = Math.hypot(...v);
  return new Float32Array(v.map((x) => x / norm));
}

function centerVec(dim: number, hot: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < 12; i++) v[(hot * 13 + i * 29) % dim] = 1;
  return v;
}

function cos(a: Float32Array, b: ArrayLike<number>): number {
  let dot = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(nb); // a is unit norm
}

describe("poolChunks", () => {
  const DIM = 384;
  const A = centerVec(DIM, 1); // opening topic
  const B = centerVec(DIM, 2); // where the chat drifted
  const C = centerVec(DIM, 3); // unrelated

  it("captures drift (leans to the recent topic) without forgetting the opening", () => {
    const chunks = [
      // Opens with 3 messages on topic A...
      ...[0, 1, 2].map((i) => ({ kind: "user", pos: i, vec: clusterVec(A, i + 1) })),
      // ...then spends 10 messages on topic B.
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => ({
        kind: "user",
        pos: i,
        vec: clusterVec(B, i + 1),
      })),
    ];
    const pooled = poolChunks(chunks)!;
    expect(pooled).not.toBeNull();
    // Unit norm out.
    let n = 0;
    for (const x of pooled) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 5);
    // Drift captured: closer to B than A...
    expect(cos(pooled, B)).toBeGreaterThan(cos(pooled, A));
    // ...opening not forgotten: still far closer to A than to unrelated C.
    expect(cos(pooled, A)).toBeGreaterThan(cos(pooled, C) + 0.1);
  });

  it("a single-message tree pools to essentially that message", () => {
    const only = clusterVec(A, 7);
    const pooled = poolChunks([{ kind: "user", pos: 0, vec: only }])!;
    expect(cos(pooled, Array.from(only))).toBeCloseTo(1, 5);
  });

  it("returns null for empty or degenerate input", () => {
    expect(poolChunks([])).toBeNull();
    const zero = new Float32Array(DIM);
    expect(poolChunks([{ kind: "user", pos: 0, vec: zero }])).toBeNull();
  });
});
