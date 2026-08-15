/**
 * Conversation view: ONE tree.
 *
 * The whole fork family merges back into a single message tree (merge.ts) —
 * forks are ordinary branch points, and each session's current end shows up
 * as a TIP: a node carrying that branch's live agent status. The side panel
 * lists only the tips ("agents on this tree"); everything else on screen is
 * a message.
 *
 * Enter on a tip attaches to that branch's agent. Enter anywhere else grows
 * a new branch there (a new session file + agent under the hood — plumbing
 * the user never sees).
 */
import type { NodeSummary, TreeDetail, TreeSummary } from "../../shared/types.js";
import {
  aContainerOf,
  aRowIndexOf,
  buildAsciiTree,
  type ATree,
  type ATreeRow,
} from "./asciitree.js";
import { familyOf, mergeConversation, type FamilyMember, type Tip } from "./merge.js";
import { buildSkeleton, type SkelNode } from "./convmap.js";

export interface ConvRow {
  a: ATreeRow;
  /** Sessions whose branch currently ends at this node (usually 0 or 1). */
  tips?: TreeSummary[];
}

/** One row of the "agents on this tree" panel, in transcript order. */
export interface PanelTip extends Tip {
  /** 1-based panel position (matches top-to-bottom order in the tree). */
  num: number;
  /**
   * The branch's HEAD: the user message that begins it — its identity.
   * A branch is named by where it diverged, not by its latest reply.
   * Absent for the original session (its head is the conversation's start).
   */
  headNodeId?: string;
  headExcerpt?: string;
}

export interface ConvView {
  rows: ConvRow[];
  /** Merged-tree leaf: the most recently active branch's end. */
  leafId: string | null;
  /** Flow mode: the session whose linear conversation the rows show. */
  flowTreeId: string | null;
  /** Node ids on the flow's path (root → tip); set only in flow mode. */
  flowPath?: Set<string>;
  /** Branches worth seeing, ordered as they appear in the transcript. */
  tips: PanelTip[];
  /** Dormant never-continued forks, by node — invisible until reused. */
  parkedAt: Map<string, TreeSummary[]>;
  parkedCount: number;
  /** Underlying ascii tree (search jumps probe elisions/folds through it). */
  atree: ATree;
  /** The merged tree itself (skeleton mini, ancestry walks). */
  detail: TreeDetail;
  /** Structural skeleton: roots, branch points, tips — the floating mini. */
  skel: SkelNode[];
  /** Family member tree ids in merge (first-writer) order, root first. */
  memberOrder: string[];
  /** Members whose detail hasn't loaded yet (view completes as they land). */
  pendingMembers: number;
}

export interface ConvViewInput {
  rootTreeId: string;
  detailOf: (treeId: string) => TreeDetail | undefined;
  summaryOf: (treeId: string) => TreeSummary | undefined;
  childrenOf: (sessionPath: string) => TreeSummary[];
  parentOf: (sessionPath: string) => TreeSummary | undefined;
  expandedRuns: Set<string>;
  unfolded: Set<string>;
  viewportH: number;
  now?: number;
  /** Called for family members whose detail isn't cached yet (async fetch). */
  wantDetail?: (treeId: string) => void;
  /**
   * Flow mode: show only this session's conversation — the linear path from
   * the root to its tip — instead of the whole merged family. The metro map
   * keeps the full structure (with the flow's route highlighted); the panel
   * keeps every agent, so jumping to one switches the flow.
   */
  flowTreeId?: string | null;
}

/**
 * The first node unique to a forked session: the child of its fork point on
 * its own path — the user message that began the branch. Null for parked
 * forks (nothing unique yet) and for the original session.
 */
export function branchHeadOf(m: FamilyMember): string | null {
  const forkPoint = m.summary.parentEntryId;
  const detail = m.detail;
  if (!forkPoint || !detail?.leafId) return null;
  let cur: string | null = detail.leafId;
  for (let guard = 0; cur && guard < 10_000; guard++) {
    const node: NodeSummary | undefined = detail.nodes[cur];
    if (!node) return null;
    if (node.parentId === forkPoint) return cur;
    cur = node.parentId;
  }
  return null;
}

/**
 * Follow the current exchange to its end: from `nodeId`, walk the original
 * continuation (first child) through tool calls and replies, stopping before
 * the next user turn. Branching from a question then lands AFTER its answer —
 * a user message begins the new branch; it never displaces the reply.
 */
export function exchangeEndOf(detail: TreeDetail, nodeId: string): string {
  let cur = nodeId;
  for (let guard = 0; guard < 10_000; guard++) {
    const first = detail.nodes[cur]?.children?.[0];
    const next = first ? detail.nodes[first] : undefined;
    if (!next) return cur;
    if (next.kind === "user" || next.kind === "compaction" || next.kind === "branch_summary") {
      return cur;
    }
    cur = first!;
  }
  return cur;
}

export interface BranchTarget {
  nodeId: string;
  /** True when the selected message itself stays OUT of the new branch. */
  excludesSelected: boolean;
}

/**
 * Where a branch grown at `nodeId` actually forks from.
 *
 * A reply (or tool run): the end of its exchange — branching from an answer
 * lands after it. A USER message: its parent — the question is not part of
 * the new branch, so your next message replaces it as a sibling (the way
 * editing a message works in chat UIs) and the old answer can never read as
 * answering the new question. A root question has nothing before it and
 * falls back to exchange end.
 */
export function branchTargetOf(detail: TreeDetail, nodeId: string): BranchTarget {
  const node = detail.nodes[nodeId];
  if (node?.kind === "user" && node.parentId && detail.nodes[node.parentId]) {
    return { nodeId: node.parentId, excludesSelected: true };
  }
  return { nodeId: exchangeEndOf(detail, nodeId), excludesSelected: false };
}

export function buildConvView(input: ConvViewInput): ConvView {
  const family = familyOf(
    input.rootTreeId,
    input.summaryOf,
    input.childrenOf,
    input.parentOf,
  );
  const members = family.map((summary) => {
    const detail = input.detailOf(summary.treeId);
    if (!detail) input.wantDetail?.(summary.treeId);
    return { summary, detail };
  });
  const pendingMembers = members.filter((m) => !m.detail).length;
  const merged = mergeConversation(members);

  // A dormant fork parked mid-tree adds no content — it is bookkeeping, not
  // conversation. It leaves the transcript, the panel and the mini entirely;
  // Enter on its node quietly RESUMES it instead of minting another file.
  const shown = merged.tips.filter((t) => !t.parked || t.summary.live || !t.summary.seen);
  const parkedAt = new Map<string, TreeSummary[]>();
  let parkedCount = 0;
  for (const t of merged.tips) {
    if (shown.includes(t)) continue;
    parkedCount++;
    const at = parkedAt.get(t.nodeId);
    if (at) at.push(t.summary);
    else parkedAt.set(t.nodeId, [t.summary]);
  }
  const shownAt = new Map<string, TreeSummary[]>();
  for (const t of shown) {
    const at = shownAt.get(t.nodeId);
    if (at) at.push(t.summary);
    else shownAt.set(t.nodeId, [t.summary]);
  }

  // FLOW MODE: prune the transcript to one session's path — root to that
  // session's tip, shared prefix included. The full merged detail stays in
  // the view (ancestry walks, branch targets, the metro map all use it);
  // only what the transcript RENDERS narrows.
  let renderDetail = merged.detail;
  let flowTreeId: string | null = null;
  let flowPath: Set<string> | undefined;
  if (input.flowTreeId) {
    const tip = merged.tips.find((t) => t.summary.treeId === input.flowTreeId);
    if (tip) {
      flowTreeId = input.flowTreeId;
      flowPath = new Set<string>();
      let cur: string | null = tip.nodeId;
      for (let guard = 0; cur && guard < 100_000; guard++) {
        flowPath.add(cur);
        cur = merged.detail.nodes[cur]?.parentId ?? null;
      }
      const nodes: Record<string, NodeSummary> = {};
      for (const id of flowPath) {
        const n = merged.detail.nodes[id]!;
        nodes[id] = { ...n, children: n.children.filter((c) => flowPath!.has(c)) };
      }
      renderDetail = {
        treeId: merged.detail.treeId,
        leafId: tip.nodeId,
        rootIds: merged.detail.rootIds.filter((r) => flowPath!.has(r)),
        nodes,
      };
    }
  }

  const atree = buildAsciiTree(renderDetail, {
    expandedRuns: input.expandedRuns,
    unfolded: input.unfolded,
    viewportH: input.viewportH,
    now: input.now,
    keep: new Set([...shownAt.keys()].filter((id) => !flowPath || flowPath.has(id))),
  });

  const rows: ConvRow[] = atree.rows.map((a) => ({
    a,
    tips: a.nodeId ? shownAt.get(a.nodeId) : undefined,
  }));

  // Panel order = transcript order: row k in the panel is the k-th agent
  // you meet reading the tree top to bottom (creation order is history,
  // not geography).
  const rowIndexOf = new Map<string, number>();
  atree.rows.forEach((r, i) => {
    if (r.nodeId && !rowIndexOf.has(r.nodeId)) rowIndexOf.set(r.nodeId, i);
  });
  const headByTree = new Map<string, string>();
  for (const m of members) {
    const head = branchHeadOf(m);
    if (head) headByTree.set(m.summary.treeId, head);
  }
  const tips: PanelTip[] = [...shown]
    .sort(
      (a, b) =>
        (rowIndexOf.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) -
        (rowIndexOf.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((t, i) => {
      const headNodeId = headByTree.get(t.summary.treeId);
      const head = headNodeId ? merged.detail.nodes[headNodeId] : undefined;
      // A resumed-but-untyped branch has no head yet: name it by where it
      // sits, not by the root's title (which would read as a duplicate).
      const atNode = t.summary.parentEntryId
        ? merged.detail.nodes[t.summary.parentEntryId]
        : undefined;
      return {
        ...t,
        num: i + 1,
        headNodeId,
        headExcerpt: head
          ? head.excerpt || head.kind
          : atNode
            ? `at: ${atNode.excerpt || atNode.kind}`
            : undefined,
      };
    });

  // Branch heads of the agents on display: each splits a map segment so its
  // agent's dot hangs off its own branch, nested under its parent's.
  const shownTreeIds = new Set(shown.map((t) => t.summary.treeId));
  const heads = new Set(
    [...headByTree].filter(([id]) => shownTreeIds.has(id)).map(([, h]) => h),
  );
  const skel = buildSkeleton(merged.detail, shownAt, heads);

  return {
    rows,
    // In flow mode the "story so far" ends at the flow's own tip.
    leafId: renderDetail.leafId,
    flowTreeId,
    flowPath,
    tips,
    parkedAt,
    parkedCount,
    atree,
    detail: merged.detail,
    skel,
    memberOrder: family.map((t) => t.treeId),
    pendingMembers,
  };
}

/** Row index of a node id (cursor placement, tip jumps, search). */
export function cRowIndexOf(view: ConvView, nodeId: string | null | undefined): number {
  if (!nodeId) return -1;
  return view.rows.findIndex((r) => r.a.nodeId === nodeId);
}

/**
 * Which family session's file contains `nodeId` (labels/branches target it).
 * Walks MERGE order (root first): the first writer's copy is the one the
 * merged view displays, so writes must land there to be visible.
 */
export function ownerOf(
  view: ConvView,
  nodeId: string,
  detailOf: (treeId: string) => TreeDetail | undefined,
): string | undefined {
  for (const id of view.memberOrder) {
    if (detailOf(id)?.nodes[nodeId]) return id;
  }
  return undefined;
}

export { aContainerOf, aRowIndexOf };
