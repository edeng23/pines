/** Core domain types shared by daemon, client, and tests. */

/**
 * Lifecycle status of a tree (a pi session).
 * - dormant:   session file on disk, no pi process attached
 * - running:   pi process is streaming (agent working)
 * - waiting:   pi process is idle, waiting for user input (agent_settled)
 * - completed: pi process exited cleanly after settling
 * - crashed:   pi process exited unexpectedly / nonzero
 */
export type TreeStatus = "dormant" | "running" | "waiting" | "completed" | "crashed";

/** Forest-level summary of one tree, streamed to clients. */
export interface TreeSummary {
  treeId: string;
  sessionPath: string;
  sessionId: string | null;
  name: string | null;
  cwd: string | null;
  parentSessionPath: string | null;
  status: TreeStatus;
  /** false = status change not yet acknowledged by a user visit (teal dot). */
  seen: boolean;
  leafId: string | null;
  nodeCount: number;
  /** World-space layout position (semantic when embeddings ready, lexical before). */
  x: number;
  y: number;
  /** Whether a live pi process is bound to this tree right now. */
  live: boolean;
  /** Archived trees are hidden from the forest and sidebar by default. */
  archived?: boolean;
  mtime: number;
  /** Exit code of the last agent process, if one has exited (crash triage). */
  lastExitCode?: number | null;
  /** Entry id in the PARENT session this tree forked from (fork-point chip). */
  parentEntryId?: string | null;
}

/** One node of a parsed session tree (client-facing projection). */
export interface NodeSummary {
  id: string;
  parentId: string | null;
  kind: "user" | "assistant" | "tool" | "compaction" | "branch_summary" | "custom" | "other";
  /** Short excerpt for display (first line of text content, truncated). */
  excerpt: string;
  label: string | null;
  timestamp: string;
  children: string[];
}

/** Full tree structure for the tree view. */
export interface TreeDetail {
  treeId: string;
  rootIds: string[];
  nodes: Record<string, NodeSummary>;
  leafId: string | null;
}

export interface SearchHit {
  treeId: string;
  entryId: string | null;
  kind: "name" | "user_msg" | "summary" | "label";
  snippet: string;
  rank: number;
}

/** One neighbor from a "similar trees" query (cosine over pooled embeddings). */
export interface SimilarHit {
  treeId: string;
  /** Cosine similarity in [-1, 1]; in practice the floor is ~0.25. */
  score: number;
}

export interface Camera {
  /** World-space center. */
  cx: number;
  cy: number;
  /** Cells per world unit (x axis); y compensates for the 1:2 cell aspect. */
  zoom: number;
}
