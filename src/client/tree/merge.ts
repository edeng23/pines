/**
 * A conversation is ONE tree. Session files are plumbing.
 *
 * When a branch forks, pi materializes a new session file so the new branch
 * can carry its own agent — but the copy keeps the parent's entry ids up to
 * the fork point. That makes the whole family losslessly re-mergeable into a
 * single message tree: union the nodes by id and the fork shows up as an
 * ordinary branch point. This module does that merge, and remembers where
 * each session's leaf ("tip") landed so the view can pin live agent status
 * onto the branches.
 */
import type { NodeSummary, TreeDetail, TreeSummary } from "../../shared/types.js";

export interface FamilyMember {
  summary: TreeSummary;
  /** Absent while the detail is still being fetched; merged in when it lands. */
  detail?: TreeDetail;
}

export interface Tip {
  /** Merged-tree node the session currently ends at. */
  nodeId: string;
  summary: TreeSummary;
  /**
   * True when the tip sits mid-tree (its node has children): a fork that
   * was created but never continued. It holds no content of its own —
   * pure bookkeeping unless its agent is live or wants attention.
   */
  parked: boolean;
}

export interface MergedConversation {
  detail: TreeDetail;
  /** One tip per loaded session, in family (DFS) order. */
  tips: Tip[];
  /** node id → sessions ending there (a fresh fork shares its parent's node). */
  tipsAt: Map<string, TreeSummary[]>;
}

/**
 * The family a tree belongs to: walk up parentSessionPath to the original,
 * then collect every descendant depth-first. Sibling order is by session
 * path — a stable key, so merge order (and with it node ownership) never
 * shuffles just because activity bumped a file's mtime.
 */
export function familyOf(
  treeId: string,
  summaryOf: (treeId: string) => TreeSummary | undefined,
  childrenOf: (sessionPath: string) => TreeSummary[],
  parentOf: (sessionPath: string) => TreeSummary | undefined,
): TreeSummary[] {
  const start = summaryOf(treeId);
  if (!start) return [];
  let root: TreeSummary = start;
  const up = new Set<string>([root.treeId]);
  for (let guard = 0; guard < 64; guard++) {
    const parent = root.parentSessionPath ? parentOf(root.parentSessionPath) : undefined;
    if (!parent || up.has(parent.treeId)) break;
    up.add(parent.treeId);
    root = parent;
  }
  const out: TreeSummary[] = [];
  const seen = new Set<string>();
  const walk = (t: TreeSummary): void => {
    if (seen.has(t.treeId)) return;
    seen.add(t.treeId);
    out.push(t);
    for (const kid of [...childrenOf(t.sessionPath)].sort((a, b) =>
      a.sessionPath < b.sessionPath ? -1 : a.sessionPath > b.sessionPath ? 1 : 0,
    )) {
      walk(kid);
    }
  };
  walk(root);
  return out;
}

/**
 * Union the family's session trees into one. First writer wins per node id
 * (the original is merged first, so shared prefixes keep their canonical
 * content); children lists union, then sort by the child message's own
 * timestamp — branches sit in the order they were CREATED, an order nothing
 * (attaching, labeling, agent activity) can later disturb.
 *
 * The merged leafId — the path the ascii tree treats as "the story so far" —
 * is the tip of the most recently active loaded session.
 */
export function mergeConversation(members: FamilyMember[]): MergedConversation {
  const loaded = members.filter((m) => m.detail);
  const nodes: Record<string, NodeSummary> = {};
  const childOrder = new Map<string, string[]>();
  const rootIds: string[] = [];

  for (const m of loaded) {
    const d = m.detail!;
    for (const r of d.rootIds) if (!rootIds.includes(r)) rootIds.push(r);
    for (const [id, n] of Object.entries(d.nodes)) {
      const existing = nodes[id];
      if (!existing) {
        nodes[id] = { ...n, children: [...n.children] };
        childOrder.set(id, [...n.children]);
      } else {
        const order = childOrder.get(id)!;
        for (const c of n.children) if (!order.includes(c)) order.push(c);
      }
    }
  }
  for (const [id, order] of childOrder) {
    // Drop dangling child ids (a member's detail may still be in flight);
    // creation order among siblings (stable sort — union order breaks ties).
    nodes[id]!.children = order
      .filter((c) => nodes[c])
      .sort((a, b) => {
        const ta = nodes[a]!.timestamp;
        const tb = nodes[b]!.timestamp;
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
    for (const c of nodes[id]!.children) {
      if (nodes[c] && nodes[c]!.parentId == null && !rootIds.includes(c)) {
        nodes[c] = { ...nodes[c]!, parentId: id };
      }
    }
  }

  const tips: Tip[] = [];
  const tipsAt = new Map<string, TreeSummary[]>();
  for (const m of loaded) {
    const leaf = m.detail!.leafId;
    if (!leaf || !nodes[leaf]) continue;
    tips.push({ nodeId: leaf, summary: m.summary, parked: nodes[leaf]!.children.length > 0 });
    const at = tipsAt.get(leaf);
    if (at) at.push(m.summary);
    else tipsAt.set(leaf, [m.summary]);
  }

  // Story ends at the busiest recent branch: running beats waiting beats
  // dormant; recency breaks ties. Parked tips sit mid-tree and can never be
  // "the end of the story" — a label append touching an old file must not
  // yank the green ● into the middle of the conversation.
  const rank = (t: Tip): number =>
    t.parked
      ? -1
      : t.summary.status === "running"
        ? 3
        : !t.summary.seen
          ? 2
          : t.summary.live
            ? 1
            : 0;
  const activeTip = [...tips].sort(
    (a, b) => rank(b) - rank(a) || b.summary.mtime - a.summary.mtime,
  )[0];

  return {
    detail: {
      treeId: members[0]?.summary.treeId ?? "",
      leafId: activeTip?.nodeId ?? loaded[0]?.detail!.leafId ?? null,
      rootIds,
      nodes,
    },
    tips,
    tipsAt,
  };
}

/**
 * Aggregate a family into one forest-facing summary (the root's identity,
 * the family's most attention-worthy state). The forest shows conversations,
 * not session files.
 */
export function aggregateFamily(members: TreeSummary[]): TreeSummary {
  const root = members[0]!;
  const pick = (pred: (t: TreeSummary) => boolean): TreeSummary | undefined =>
    members.filter(pred).sort((a, b) => b.mtime - a.mtime)[0];
  const crashed = pick((t) => t.status === "crashed");
  const needsInput = pick((t) => t.status === "waiting" && !t.seen);
  const working = pick((t) => t.status === "running");
  const waiting = pick((t) => t.status === "waiting");
  const lead = crashed ?? needsInput ?? working ?? waiting ?? pick(() => true)!;
  return {
    ...root,
    status: lead.status,
    seen: lead.seen,
    live: members.some((t) => t.live),
    mtime: Math.max(...members.map((t) => t.mtime)),
    nodeCount: members.reduce((n, t) => n + t.nodeCount, 0),
    lastExitCode: lead.lastExitCode,
  };
}

/**
 * The member to attach to when the user targets the conversation as a whole:
 * whoever needs attention, else the most recently active.
 */
export function attentionMemberOf(members: TreeSummary[]): TreeSummary {
  const rank = (t: TreeSummary): number =>
    t.status === "crashed"
      ? 0
      : t.status === "waiting" && !t.seen
        ? 1
        : t.status === "running"
          ? 2
          : t.status === "waiting"
            ? 3
            : 4;
  return [...members].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)[0]!;
}
