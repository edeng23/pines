import { describe, expect, it } from "vitest";
import {
  branchTargetOf,
  buildConvView,
  cRowIndexOf,
  exchangeEndOf,
  ownerOf,
  type ConvViewInput,
} from "../src/client/tree/sessionview.js";
import {
  aggregateFamily,
  attentionMemberOf,
  familyOf,
  mergeConversation,
} from "../src/client/tree/merge.js";
import type { NodeSummary, TreeDetail, TreeSummary } from "../src/shared/types.js";

function node(
  id: string,
  parentId: string | null,
  kind: NodeSummary["kind"],
  children: string[],
): NodeSummary {
  return {
    id, parentId, kind, excerpt: `${kind} ${id}`, label: null,
    timestamp: "2026-07-25T10:00:00Z", children,
  };
}

/**
 * The original session: u1 → a1 → u2 → a2 (leaf a2).
 * A fork at a1 copied u1→a1 into a new file and continued u3 → a3.
 * Same entry ids on the shared prefix — that's what makes merging lossless.
 */
function rootDetail(): TreeDetail {
  return {
    treeId: "root",
    leafId: "a2",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u2"]),
      u2: node("u2", "a1", "user", ["a2"]),
      a2: node("a2", "u2", "assistant", []),
    },
  };
}

function kidDetail(): TreeDetail {
  return {
    treeId: "kid",
    leafId: "a3",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u3"]),
      u3: node("u3", "a1", "user", ["a3"]),
      a3: node("a3", "u3", "assistant", []),
    },
  };
}

function summary(treeId: string, over: Partial<TreeSummary> = {}): TreeSummary {
  return {
    treeId,
    sessionPath: `/s/${treeId}.jsonl`,
    sessionId: null,
    name: null,
    cwd: "/w",
    parentSessionPath: null,
    status: "dormant",
    seen: true,
    leafId: null,
    nodeCount: 4,
    x: 0,
    y: 0,
    live: false,
    mtime: 100,
    ...over,
  };
}

const rootS = () => summary("root");
const kidS = (over: Partial<TreeSummary> = {}) =>
  summary("kid", { parentSessionPath: "/s/root.jsonl", parentEntryId: "a1", mtime: 200, ...over });

function lookups(summaries: TreeSummary[]) {
  return {
    summaryOf: (id: string) => summaries.find((t) => t.treeId === id),
    childrenOf: (p: string) => summaries.filter((t) => t.parentSessionPath === p),
    parentOf: (p: string) => summaries.find((t) => t.sessionPath === p),
  };
}

describe("merge", () => {
  it("familyOf finds the whole family from any member, root first", () => {
    const l = lookups([rootS(), kidS()]);
    expect(familyOf("kid", l.summaryOf, l.childrenOf, l.parentOf).map((t) => t.treeId)).toEqual([
      "root",
      "kid",
    ]);
    expect(familyOf("root", l.summaryOf, l.childrenOf, l.parentOf).map((t) => t.treeId)).toEqual([
      "root",
      "kid",
    ]);
  });

  it("merges a family into ONE tree: the fork is an ordinary branch point", () => {
    const m = mergeConversation([
      { summary: rootS(), detail: rootDetail() },
      { summary: kidS(), detail: kidDetail() },
    ]);
    // a1 now has both continuations as children — one tree, two branches.
    expect(m.detail.nodes.a1!.children.sort()).toEqual(["u2", "u3"]);
    expect(m.detail.rootIds).toEqual(["u1"]);
    expect(Object.keys(m.detail.nodes).sort()).toEqual(["a1", "a2", "a3", "u1", "u2", "u3"]);
    // Each session's end is a tip on the merged tree; both are true ends.
    expect(m.tips.map((t) => [t.summary.treeId, t.nodeId, t.parked])).toEqual([
      ["root", "a2", false],
      ["kid", "a3", false],
    ]);
    // The story ends at the most recently active branch (kid, mtime 200).
    expect(m.detail.leafId).toBe("a3");
  });

  it("merged siblings sit in CREATION order (message timestamps), immune to mtime churn", () => {
    // The fork's branch head u3 was written BEFORE the root's own follow-up
    // u2. Whatever the member merge order (kid's mtime is newer), the fan
    // must read u3 then u2 — and never reshuffle when activity bumps mtimes.
    const root = rootDetail();
    root.nodes.u2!.timestamp = "2026-07-25T12:00:00Z";
    const kid = kidDetail();
    kid.nodes.u3!.timestamp = "2026-07-25T11:00:00Z";
    for (const kidMtime of [200, 50]) {
      const m = mergeConversation([
        { summary: rootS(), detail: root },
        { summary: kidS({ mtime: kidMtime }), detail: kid },
      ]);
      expect(m.detail.nodes.a1!.children).toEqual(["u3", "u2"]);
    }
  });

  it("a live branch outranks a newer dormant one for the active path", () => {
    const m = mergeConversation([
      { summary: rootS(), detail: rootDetail() },
      { summary: kidS({ status: "running", live: true, mtime: 50 }), detail: kidDetail() },
    ]);
    expect(m.detail.leafId).toBe("a3");
  });

  it("a fresh fork with no new messages tips an INNER node of the parent", () => {
    // Fork at a1, nothing typed yet: its leaf is a1 — a node mid-branch.
    const freshFork: TreeDetail = {
      treeId: "kid",
      leafId: "a1",
      rootIds: ["u1"],
      nodes: {
        u1: node("u1", null, "user", ["a1"]),
        a1: node("a1", "u1", "assistant", []),
      },
    };
    const m = mergeConversation([
      { summary: rootS(), detail: rootDetail() },
      { summary: kidS(), detail: freshFork },
    ]);
    expect(m.tipsAt.get("a1")!.map((t) => t.treeId)).toEqual(["kid"]);
    expect(m.tips.find((t) => t.summary.treeId === "kid")!.parked).toBe(true);
    expect(m.detail.nodes.a1!.children).toEqual(["u2"]); // parent's branch intact
  });

  it("aggregateFamily surfaces the most attention-worthy member", () => {
    const agg = aggregateFamily([
      rootS(),
      kidS({ status: "waiting", seen: false, live: true, mtime: 500 }),
    ]);
    expect(agg.treeId).toBe("root"); // identity/position = the root's
    expect(agg.status).toBe("waiting");
    expect(agg.seen).toBe(false);
    expect(agg.live).toBe(true);
    expect(agg.mtime).toBe(500);
  });

  it("attentionMemberOf prefers needs-input over working over recent", () => {
    const working = kidS({ treeId: "w", sessionPath: "/s/w", status: "running", mtime: 900 });
    const needs = kidS({ treeId: "n", sessionPath: "/s/n", status: "waiting", seen: false, mtime: 10 });
    expect(attentionMemberOf([rootS(), working, needs]).treeId).toBe("n");
    expect(attentionMemberOf([rootS(), working]).treeId).toBe("w");
  });
});

describe("conversation view", () => {
  function harness(over: Partial<ConvViewInput> = {}): ConvViewInput {
    const summaries = [rootS(), kidS()];
    const details = new Map<string, TreeDetail>([
      ["root", rootDetail()],
      ["kid", kidDetail()],
    ]);
    const l = lookups(summaries);
    return {
      rootTreeId: "root",
      detailOf: (id) => details.get(id),
      ...l,
      expandedRuns: new Set(),
      unfolded: new Set(),
      viewportH: 0,
      ...over,
    };
  }

  it("renders one tree with a tip per session, and no session rows at all", () => {
    const v = buildConvView(harness());
    // Every row is a message row of the ONE merged tree.
    expect(v.rows.every((r) => r.a.kind !== undefined)).toBe(true);
    const tipRows = v.rows.filter((r) => r.tips?.length);
    expect(tipRows.map((r) => [r.a.nodeId, r.tips![0]!.treeId])).toEqual(
      expect.arrayContaining([
        ["a2", "root"],
        ["a3", "kid"],
      ]),
    );
    expect(v.tips.map((t) => t.num)).toEqual([1, 2]);
    expect(v.leafId).toBe("a3"); // kid is more recent
    expect(v.pendingMembers).toBe(0);
  });

  it("flow mode shows one session's path only, keeping the full map and panel", () => {
    const v = buildConvView(harness({ flowTreeId: "kid" }));
    const shownNodes = v.rows.map((r) => r.a.nodeId).filter(Boolean);
    // Only the kid's conversation: shared prefix + its own turns. The
    // root's divergent exchange (u2 → a2) leaves the transcript entirely.
    expect(shownNodes).toEqual(expect.arrayContaining(["u1", "a1", "u3", "a3"]));
    expect(shownNodes).not.toContain("u2");
    expect(shownNodes).not.toContain("a2");
    expect(v.leafId).toBe("a3");
    expect(v.flowTreeId).toBe("kid");
    expect(v.flowPath).toEqual(new Set(["u1", "a1", "u3", "a3"]));
    // The metro map keeps the WHOLE structure; the panel keeps every agent.
    expect(v.detail.nodes["a2"]).toBeDefined();
    expect(v.tips.map((t) => t.summary.treeId)).toEqual(
      expect.arrayContaining(["root", "kid"]),
    );
    // Flowing the root hides the kid's turns instead.
    const r = buildConvView(harness({ flowTreeId: "root" }));
    const rootNodes = r.rows.map((row) => row.a.nodeId).filter(Boolean);
    expect(rootNodes).toContain("a2");
    expect(rootNodes).not.toContain("u3");
    // An unknown flow session falls back to the full tree.
    const f = buildConvView(harness({ flowTreeId: "nope" }));
    expect(f.flowTreeId).toBeNull();
    expect(f.rows.map((row) => row.a.nodeId).filter(Boolean)).toContain("u2");
  });

  it("flow mode survives a root whose parentId points outside the family", () => {
    // toTreeDetail legally produces roots that keep a verbatim parentId not
    // present in the file — the upward walk must stop at the family's edge,
    // not crash the rebuild on a dangling ancestor.
    const dangling = rootDetail();
    dangling.nodes["u1"] = { ...dangling.nodes["u1"]!, parentId: "gone0000" };
    const v = buildConvView(
      harness({
        detailOf: (id) => (id === "root" ? dangling : kidDetail()),
        flowTreeId: "root",
      }),
    );
    const shown = v.rows.map((r) => r.a.nodeId).filter(Boolean);
    expect(shown).toEqual(expect.arrayContaining(["u1", "a1", "u2", "a2"]));
    expect(v.flowPath!.has("gone0000")).toBe(false);
  });

  it("streams in: missing member details are requested, view stays usable", () => {
    const wanted: string[] = [];
    const v = buildConvView(
      harness({
        detailOf: (id) => (id === "root" ? rootDetail() : undefined),
        wantDetail: (id) => wanted.push(id),
      }),
    );
    expect(wanted).toEqual(["kid"]);
    expect(v.pendingMembers).toBe(1);
    expect(cRowIndexOf(v, "a2")).toBeGreaterThan(-1); // root renders meanwhile
  });

  it("ownerOf resolves the session file containing a node (root preferred)", () => {
    const v = buildConvView(harness());
    const details = new Map([
      ["root", rootDetail()],
      ["kid", kidDetail()],
    ]);
    const detailOf = (id: string) => details.get(id);
    expect(ownerOf(v, "u2", detailOf)).toBe("root"); // only in root
    expect(ownerOf(v, "u3", detailOf)).toBe("kid"); // only in kid
    expect(ownerOf(v, "a1", detailOf)).toBe("root"); // shared → root wins
  });

  it("tips are never elided or folded away, even in tiny viewports", () => {
    // Force fold mode with a 3-row viewport: the kid tip must stay visible.
    const v = buildConvView(harness({ viewportH: 3 }));
    expect(cRowIndexOf(v, "a3")).toBeGreaterThan(-1);
    expect(cRowIndexOf(v, "a2")).toBeGreaterThan(-1);
  });

  it("fork-lineage cycles terminate", () => {
    const a = summary("a", { parentSessionPath: "/s/b.jsonl" });
    const b = summary("b", { parentSessionPath: "/s/a.jsonl" });
    const l = lookups([a, b]);
    const v = buildConvView(
      harness({
        rootTreeId: "a",
        detailOf: () => rootDetail(),
        ...l,
      }),
    );
    expect(v.tips.length).toBeGreaterThan(0);
  });
});

describe("parked forks and panel order", () => {
  function withParked(over: Partial<ConvViewInput> = {}): ConvViewInput {
    // kid2 forked at a1 and never continued: parked, dormant.
    const summaries = [
      summary("root"),
      summary("kid", { parentSessionPath: "/s/root.jsonl", parentEntryId: "a1", mtime: 200 }),
      summary("kid2", { parentSessionPath: "/s/root.jsonl", parentEntryId: "a1", mtime: 300 }),
    ];
    const parkedDetail: TreeDetail = {
      treeId: "kid2",
      leafId: "a1",
      rootIds: ["u1"],
      nodes: {
        u1: { ...rootDetail().nodes.u1! },
        a1: { ...rootDetail().nodes.a1!, children: [] },
      },
    };
    const details = new Map<string, TreeDetail>([
      ["root", rootDetail()],
      ["kid", kidDetail()],
      ["kid2", parkedDetail],
    ]);
    const l = {
      summaryOf: (id: string) => summaries.find((t) => t.treeId === id),
      childrenOf: (p: string) => summaries.filter((t) => t.parentSessionPath === p),
      parentOf: (p: string) => summaries.find((t) => t.sessionPath === p),
    };
    return {
      rootTreeId: "root",
      detailOf: (id) => details.get(id),
      ...l,
      expandedRuns: new Set(),
      unfolded: new Set(),
      viewportH: 0,
      ...over,
    };
  }

  it("a dormant never-continued fork leaves the transcript and panel", () => {
    const v = buildConvView(withParked());
    // a1 carries no tip decoration; the parked fork is counted, resumable.
    expect(v.rows.find((r) => r.a.nodeId === "a1")?.tips).toBeUndefined();
    expect(v.tips.map((t) => t.summary.treeId).sort()).toEqual(["kid", "root"]);
    expect(v.parkedCount).toBe(1);
    expect(v.parkedAt.get("a1")!.map((t) => t.treeId)).toEqual(["kid2"]);
  });

  it("a parked fork that needs attention stays visible", () => {
    const v = buildConvView(withParked());
    expect(v.tips).toHaveLength(2);
    // Same shape, but kid2's agent now wants input: it must surface.
    const hot = summary("kid2", {
      parentSessionPath: "/s/root.jsonl",
      parentEntryId: "a1",
      mtime: 300,
      status: "waiting",
      seen: false,
    });
    const base = withParked();
    const attention = buildConvView({
      ...base,
      summaryOf: (id) => (id === "kid2" ? hot : base.summaryOf(id)),
      childrenOf: (p) => base.childrenOf(p).map((t) => (t.treeId === "kid2" ? hot : t)),
    });
    expect(attention.tips).toHaveLength(3);
    expect(attention.rows.find((r) => r.a.nodeId === "a1")?.tips?.length).toBe(1);
  });

  it("panel order follows the transcript top to bottom, not creation order", () => {
    const v = buildConvView(withParked());
    const rowIdx = (nodeId: string) => v.rows.findIndex((r) => r.a.nodeId === nodeId);
    const order = v.tips.map((t) => rowIdx(t.nodeId));
    expect([...order].sort((a, b) => a - b)).toEqual(order); // ascending
    expect(v.tips.map((t) => t.num)).toEqual([1, 2]);
  });
});

describe("branch identity and exchange snapping", () => {
  it("branches are named by the user message that begins them", () => {
    const summaries = [rootS(), kidS()];
    const details = new Map<string, TreeDetail>([
      ["root", rootDetail()],
      ["kid", kidDetail()],
    ]);
    const l = {
      summaryOf: (id: string) => summaries.find((t) => t.treeId === id),
      childrenOf: (p: string) => summaries.filter((t) => t.parentSessionPath === p),
      parentOf: (p: string) => summaries.find((t) => t.sessionPath === p),
    };
    const v = buildConvView({
      rootTreeId: "root",
      detailOf: (id) => details.get(id),
      ...l,
      expandedRuns: new Set(),
      unfolded: new Set(),
      viewportH: 0,
    });
    const kidTip = v.tips.find((t) => t.summary.treeId === "kid")!;
    expect(kidTip.headNodeId).toBe("u3"); // the user turn that began the branch
    expect(kidTip.headExcerpt).toBe("user u3");
    // The original session has no divergence point — no head.
    expect(v.tips.find((t) => t.summary.treeId === "root")!.headNodeId).toBeUndefined();
  });

  it("exchangeEndOf follows question → tools → reply, stopping before users", () => {
    const d: TreeDetail = {
      treeId: "t",
      leafId: "a1",
      rootIds: ["u1"],
      nodes: {
        u1: node("u1", null, "user", ["t1"]),
        t1: node("t1", "u1", "tool", ["a1"]),
        a1: node("a1", "t1", "assistant", ["u2"]),
        u2: node("u2", "a1", "user", []),
      },
    };
    expect(exchangeEndOf(d, "u1")).toBe("a1"); // question snaps past its answer
    expect(exchangeEndOf(d, "t1")).toBe("a1"); // mid-run too
    expect(exchangeEndOf(d, "a1")).toBe("a1"); // a reply is already the end
    expect(exchangeEndOf(d, "u2")).toBe("u2"); // nothing to follow
  });

  it("branchTargetOf: a question branches BESIDE itself, a reply after itself", () => {
    const d: TreeDetail = {
      treeId: "t",
      leafId: "a1",
      rootIds: ["u1"],
      nodes: {
        u1: node("u1", null, "user", ["t1"]),
        t1: node("t1", "u1", "tool", ["a1"]),
        a1: node("a1", "t1", "assistant", ["u2"]),
        u2: node("u2", "a1", "user", []),
      },
    };
    // A user message forks from its parent — the question is NOT part of
    // the new branch (chat-edit semantics), so the old answer can never
    // read as answering the new question.
    expect(branchTargetOf(d, "u2")).toEqual({ nodeId: "a1", excludesSelected: true });
    // A reply (or mid-run tool) still branches after its exchange.
    expect(branchTargetOf(d, "a1")).toEqual({ nodeId: "a1", excludesSelected: false });
    expect(branchTargetOf(d, "t1")).toEqual({ nodeId: "a1", excludesSelected: false });
    // A root question has nothing before it: falls back to exchange end.
    expect(branchTargetOf(d, "u1")).toEqual({ nodeId: "a1", excludesSelected: false });
  });
});
