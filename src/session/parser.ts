/**
 * Session JSONL → tree. This is the isolation layer around pi's session format:
 * all @earendil-works imports for *reading* sessions live here (R3), and the
 * parser tolerates a torn trailing line (a live pi may be mid-append, R8).
 */
import { readFileSync, statSync } from "node:fs";
import type { NodeSummary, TreeDetail } from "../shared/types.js";

/* Lazy import: pulling the pi package costs ~1.5s, pay it once on first parse. */
type PiSessionModule = typeof import("@earendil-works/pi-coding-agent");
let piModule: Promise<PiSessionModule> | undefined;
function pi(): Promise<PiSessionModule> {
  piModule ??= import("@earendil-works/pi-coding-agent");
  return piModule;
}

export interface ParsedHeader {
  sessionId: string | null;
  cwd: string | null;
  parentSession: string | null;
}

export interface ParsedEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  role: string | null;
  text: string;
  raw: Record<string, unknown>;
}

export interface ParsedSession {
  header: ParsedHeader;
  entries: ParsedEntry[];
  /** Entry ids in file order (append order). */
  order: string[];
  name: string | null;
  labels: Map<string, string>;
  leafId: string | null;
  /** Byte offset of the end of the last complete line (ingest cursor). */
  completeBytes: number;
  firstUserText: string | null;
  summaries: string[];
}

/**
 * Extract display text from a pi message-ish object. Content is a string or
 * an array of blocks — text, thinking {thinking}, toolCall {name}, image.
 * An assistant turn that only thinks and calls tools has no text block, so
 * fall through: text, else the tool calls, else the thinking, else images.
 */
function textOf(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (!Array.isArray(obj)) return "";
  const texts: string[] = [];
  const calls: string[] = [];
  const thinking: string[] = [];
  let images = 0;
  for (const part of obj) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string" && p.text.trim()) texts.push(p.text);
    else if (p.type === "toolCall") calls.push(`${String(p.name ?? "tool")}(…)`);
    else if (typeof p.thinking === "string" && p.thinking.trim()) thinking.push(p.thinking);
    else if (p.type === "image") images += 1;
  }
  if (texts.length > 0) return texts.join(" ");
  if (calls.length > 0) return calls.join(", ");
  if (thinking.length > 0) return thinking.join(" ");
  if (images > 0) return images === 1 ? "[image]" : `[${images} images]`;
  return "";
}

function entryText(raw: Record<string, unknown>): { role: string | null; text: string } {
  const type = raw.type as string;
  if (type === "message") {
    const msg = raw.message as Record<string, unknown> | undefined;
    const role = (msg?.role as string) ?? null;
    return { role, text: textOf(msg?.content).trim() };
  }
  if (type === "compaction" || type === "branch_summary") {
    return { role: null, text: String(raw.summary ?? "").trim() };
  }
  if (type === "custom_message") {
    return { role: "custom", text: textOf(raw.content).trim() };
  }
  if (type === "session_info") {
    return { role: null, text: String(raw.name ?? "").trim() };
  }
  // Settings bookkeeping that pi records as tree entries. Normally spliced
  // out of the lane graph; readable when surfaced (e.g. labeled).
  if (type === "model_change") {
    return { role: null, text: `model → ${String(raw.modelId ?? "?")}` };
  }
  if (type === "thinking_level_change") {
    return { role: null, text: `thinking → ${String(raw.thinkingLevel ?? "?")}` };
  }
  if (type === "active_tools_change") {
    return { role: null, text: "active tools changed" };
  }
  return { role: null, text: "" };
}

/**
 * Parse raw JSONL content. Lines are split on LF only; an incomplete trailing
 * line is ignored and excluded from `completeBytes`.
 */
export async function parseSessionContent(content: string): Promise<ParsedSession> {
  const { migrateSessionEntries } = await pi();

  const header: ParsedHeader = { sessionId: null, cwd: null, parentSession: null };
  let headerRaw: Record<string, unknown> | undefined;
  const rawEntries: Record<string, unknown>[] = [];
  let completeBytes = 0;
  let cursor = 0;

  while (cursor < content.length) {
    const nl = content.indexOf("\n", cursor);
    if (nl < 0) break; // torn tail — a writer is mid-append
    const line = content.slice(cursor, nl);
    const lineEnd = nl + 1;
    cursor = lineEnd;
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      completeBytes = Buffer.byteLength(content.slice(0, lineEnd), "utf8");
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // A malformed complete line should not appear in an append-only file;
      // stop advancing the cursor so a future re-read can retry.
      break;
    }
    completeBytes = Buffer.byteLength(content.slice(0, lineEnd), "utf8");
    if (obj.type === "session") {
      headerRaw = obj;
      header.sessionId = (obj.id as string) ?? null;
      header.cwd = (obj.cwd as string) ?? null;
      header.parentSession = (obj.parentSession as string) ?? null;
    } else {
      rawEntries.push(obj);
    }
  }

  // Let pi migrate v1/v2 shapes in place. The header MUST be in the array —
  // version detection reads it (headerless input would be "migrated" as v1,
  // rewriting every id). Unknown future entry types (e.g. the newer "leaf"
  // pointer) pass through untouched.
  try {
    const fileEntries = headerRaw ? [headerRaw, ...rawEntries] : rawEntries;
    migrateSessionEntries(fileEntries as unknown as Parameters<typeof migrateSessionEntries>[0]);
  } catch {
    // Migration is best-effort; raw v3 files don't need it.
  }

  const entries: ParsedEntry[] = [];
  const order: string[] = [];
  const labels = new Map<string, string>();
  let name: string | null = null;
  let leafFromLeafEntry: string | null | undefined;
  let firstUserText: string | null = null;
  const summaries: string[] = [];

  for (const raw of rawEntries) {
    const type = raw.type as string;
    if (type === "leaf") {
      // Newer agent-core persists the active leaf pointer as an entry.
      leafFromLeafEntry = (raw.targetId as string | null) ?? null;
      continue;
    }
    if (type === "label") {
      const target = raw.targetId as string;
      const label = raw.label as string | undefined;
      if (label) labels.set(target, label);
      else labels.delete(target);
      continue;
    }
    if (type === "session_info") {
      name = (raw.name as string) ?? name;
      continue;
    }
    const id = raw.id as string | undefined;
    if (!id) continue;
    const { role, text } = entryText(raw);
    if (type === "compaction" || type === "branch_summary") {
      if (text) summaries.push(text);
    }
    if (role === "user" && firstUserText === null && text) firstUserText = text;
    entries.push({
      id,
      parentId: (raw.parentId as string | null) ?? null,
      type,
      timestamp: (raw.timestamp as string) ?? "",
      role,
      text,
      raw,
    });
    order.push(id);
  }

  // Leaf: an explicit leaf entry wins; otherwise the last appended tree entry
  // (pi reconstructs the leaf the same way on load).
  const leafId =
    leafFromLeafEntry !== undefined ? leafFromLeafEntry : (order[order.length - 1] ?? null);

  return { header, entries, order, name, labels, leafId, completeBytes, firstUserText, summaries };
}

export interface CachedParse {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession;
}

const cache = new Map<string, CachedParse>();
const CACHE_MAX = 64;

export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const st = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const parsed = await parseSessionContent(readFileSync(path, "utf8"));
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return parsed;
}

/** Which entry types appear as nodes in tree views. */
function nodeKind(e: ParsedEntry): NodeSummary["kind"] {
  if (e.type === "message") {
    if (e.role === "user") return "user";
    if (e.role === "assistant") return "assistant";
    if (e.role === "toolResult") return "tool";
    return "other";
  }
  if (e.type === "compaction") return "compaction";
  if (e.type === "branch_summary") return "branch_summary";
  if (e.type === "custom" || e.type === "custom_message") return "custom";
  // Settings changes are plumbing, not conversation: give them the same
  // spliceable kind as pines' own markers so trees don't open with a stack
  // of unreadable bookkeeping rows.
  if (
    e.type === "model_change" ||
    e.type === "thinking_level_change" ||
    e.type === "active_tools_change"
  ) {
    return "custom";
  }
  return "other";
}

const EXCERPT_LEN = 80;

export function toTreeDetail(treeId: string, parsed: ParsedSession): TreeDetail {
  const nodes: Record<string, NodeSummary> = {};
  const rootIds: string[] = [];
  for (const e of parsed.entries) {
    nodes[e.id] = {
      id: e.id,
      parentId: e.parentId,
      kind: nodeKind(e),
      excerpt: e.text.replace(/\s+/g, " ").slice(0, EXCERPT_LEN),
      label: parsed.labels.get(e.id) ?? null,
      timestamp: e.timestamp,
      children: [],
    };
  }
  for (const e of parsed.entries) {
    if (e.parentId && nodes[e.parentId]) {
      nodes[e.parentId]!.children.push(e.id);
    } else {
      rootIds.push(e.id);
    }
  }
  return { treeId, rootIds, nodes, leafId: parsed.leafId };
}
