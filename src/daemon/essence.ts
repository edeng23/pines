/**
 * Essence extraction: turns a parsed session into the chunks worth embedding
 * and pools their vectors into one tree-level embedding.
 *
 * What captures a chat's essence, in decreasing signal-per-byte:
 *  - name + labels (human-assigned meaning)
 *  - user messages (intent; assistant/tool *output* is noise at embedding size)
 *  - compaction/branch summaries (already-distilled history)
 *  - tool activity digest (which files/tools the agent actually touched)
 *
 * Chunks are keyed by entry id (stable in append-only session files) or by a
 * content hash for the digest chunks, so incremental ingest re-embeds only
 * what changed. Pooling is a recency-weighted spherical mean: late messages
 * dominate, but the opening message keeps a floor weight so a tree never
 * forgets what it set out to do.
 */
import { createHash } from "node:crypto";
import type { ParsedEntry, ParsedSession } from "../session/parser.js";

export interface EssenceChunk {
  key: string;
  kind: "meta" | "tools" | "user" | "summary";
  /** File-order index for recency weighting; -1 for the digest chunks. */
  pos: number;
  text: string;
}

/** Per-chunk clip: MiniLM sees ~256-512 tokens, so one chunk fits its window. */
const CHUNK_MAX_CHARS = 1500;
/** Pooling window: newest N user messages (the first is always kept too). */
export const MAX_USER_CHUNKS = 24;
/** Pooling window: newest N summaries. */
export const MAX_SUMMARY_CHUNKS = 8;
/** Storage cap for cached user-chunk vectors (see pruneUserChunks). */
export const USER_CHUNK_CACHE = 64;

function hash12(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function clip(text: string): string {
  return text.length <= CHUNK_MAX_CHARS ? text : text.slice(0, CHUNK_MAX_CHARS);
}

/** Tool-call parts of an assistant message ({type:"toolCall", name, arguments}). */
function toolCallsOf(entry: ParsedEntry): Array<{ name: string; args: Record<string, unknown> }> {
  if (entry.type !== "message" || entry.role !== "assistant") return [];
  const msg = entry.raw.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "toolCall" || typeof p.name !== "string") continue;
    calls.push({ name: p.name, args: (p.arguments as Record<string, unknown>) ?? {} });
  }
  return calls;
}

/**
 * Readable digest of the session's tool activity: which files were worked on
 * and which tools ran (with the leading word of bash commands). Frequency-
 * ranked and capped, so it embeds as one stable, meaningful chunk. Content is
 * ordered by count then name — the digest text (and thus its content-hash key)
 * only changes when tool activity actually changes.
 */
export function toolsDigest(parsed: ParsedSession): string {
  const paths = new Map<string, number>();
  const tools = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of parsed.entries) {
    for (const call of toolCallsOf(e)) {
      let toolKey = call.name;
      for (const argKey of ["path", "file_path", "filePath"]) {
        const v = call.args[argKey];
        if (typeof v === "string" && v) bump(paths, v);
      }
      if (typeof call.args.command === "string" && call.args.command) {
        const word = call.args.command.trim().split(/\s+/)[0] ?? "";
        if (word) toolKey = `${call.name} (${word.slice(0, 24)})`;
      }
      bump(tools, toolKey);
    }
  }
  if (paths.size === 0 && tools.size === 0) return "";
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  const parts: string[] = [];
  if (paths.size > 0) {
    parts.push(`worked on: ${top(paths, 20).map(([p]) => p).join(", ")}`);
  }
  if (tools.size > 0) {
    parts.push(`tools: ${top(tools, 16).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(", ")}`);
  }
  return clip(parts.join(" · "));
}

/**
 * The chunks that represent this session, already selected down to the
 * pooling window (newest user messages + first, newest summaries, digests).
 */
export function essenceChunks(name: string | null, parsed: ParsedSession): EssenceChunk[] {
  const chunks: EssenceChunk[] = [];

  const metaText = [name ?? parsed.name ?? "", ...parsed.labels.values()]
    .filter(Boolean)
    .join("\n");
  if (metaText.trim()) {
    chunks.push({ key: `meta:${hash12(metaText)}`, kind: "meta", pos: -1, text: clip(metaText) });
  }

  const digest = toolsDigest(parsed);
  if (digest.trim()) {
    chunks.push({ key: `tools:${hash12(digest)}`, kind: "tools", pos: -1, text: digest });
  }

  const users: EssenceChunk[] = [];
  const summaries: EssenceChunk[] = [];
  parsed.entries.forEach((e, pos) => {
    if (!e.text.trim()) return;
    if (e.type === "message" && e.role === "user") {
      users.push({ key: e.id, kind: "user", pos, text: clip(e.text) });
    } else if (e.type === "compaction" || e.type === "branch_summary") {
      summaries.push({ key: e.id, kind: "summary", pos, text: clip(e.text) });
    }
  });

  // Newest-N window, but the opening message always stays in: it anchors what
  // the tree set out to do even when the window has scrolled far past it.
  const userWindow = users.slice(-MAX_USER_CHUNKS);
  if (users.length > MAX_USER_CHUNKS) userWindow.unshift(users[0]!);
  chunks.push(...userWindow, ...summaries.slice(-MAX_SUMMARY_CHUNKS));
  return chunks;
}

/**
 * Chunk keys that are currently valid for this session — the full universe,
 * not the capped selection, so a cached chunk that merely scrolled out of the
 * pooling window is not churned. Used to diff away stale rows (renames, file
 * shrink/fork flows).
 */
export function validChunkKeys(name: string | null, parsed: ParsedSession): Set<string> {
  const keys = new Set<string>();
  for (const c of essenceChunks(name, parsed)) keys.add(c.key);
  for (const e of parsed.entries) {
    if (!e.text.trim()) continue;
    if (e.type === "message" && e.role === "user") keys.add(e.id);
    else if (e.type === "compaction" || e.type === "branch_summary") keys.add(e.id);
  }
  return keys;
}

/** Recency decay per step back from the newest user message. */
const USER_DECAY = 0.85;
/** The opening message never drops below this weight. */
const FIRST_USER_FLOOR = 0.5;
/** Any pooled user message keeps at least a whisper of weight. */
const USER_FLOOR = 0.05;
const SUMMARY_TOP = 0.9;
const SUMMARY_DECAY = 0.8;
const META_WEIGHT = 1.0;
const TOOLS_WEIGHT = 0.6;

/**
 * Recency-weighted spherical mean of unit chunk vectors → unit tree vector.
 * Returns null when there is nothing to pool (or the sum degenerates).
 */
export function poolChunks(
  chunks: Array<{ kind: string; pos: number; vec: Float32Array }>,
): Float32Array | null {
  if (chunks.length === 0) return null;
  const dim = chunks[0]!.vec.length;
  const sum = new Float32Array(dim);

  const users = chunks.filter((c) => c.kind === "user").sort((a, b) => a.pos - b.pos);
  const summaries = chunks.filter((c) => c.kind === "summary").sort((a, b) => a.pos - b.pos);

  const add = (vec: Float32Array, w: number) => {
    for (let i = 0; i < dim; i++) sum[i]! += vec[i]! * w;
  };
  users.forEach((c, i) => {
    const recency = Math.pow(USER_DECAY, users.length - 1 - i);
    add(c.vec, Math.max(recency, i === 0 ? FIRST_USER_FLOOR : USER_FLOOR));
  });
  summaries.forEach((c, j) => {
    add(c.vec, SUMMARY_TOP * Math.pow(SUMMARY_DECAY, summaries.length - 1 - j));
  });
  for (const c of chunks) {
    if (c.kind === "meta") add(c.vec, META_WEIGHT);
    else if (c.kind === "tools") add(c.vec, TOOLS_WEIGHT);
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-6) return null;
  for (let i = 0; i < dim; i++) sum[i]! /= norm;
  return sum;
}
