import { describe, expect, it } from "vitest";
import {
  aContainerOf,
  aRowIndexOf,
  buildAsciiTree,
} from "../src/client/tree/asciitree.js";
import type { NodeSummary, TreeDetail } from "../src/shared/types.js";

function node(
  id: string,
  parentId: string | null,
  kind: NodeSummary["kind"],
  children: string[],
  label: string | null = null,
): NodeSummary {
  return {
    id, parentId, kind, excerpt: `${kind} ${id}`, label,
    timestamp: "2026-07-25T10:00:00Z", children,
  };
}

/**
 *   u1 ─ a1 ─┬─ u2 ─ t1 t2 t3 ─ a2      (abandoned branch)
 *            └─ u3 ─ a4                  (active; a4 = leaf)
 */
function fixture(): TreeDetail {
  return {
    treeId: "t",
    leafId: "a4",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u2", "u3"]),
      u2: node("u2", "a1", "user", ["t1"]),
      t1: node("t1", "u2", "tool", ["t2"]),
      t2: node("t2", "t1", "tool", ["t3"]),
      t3: node("t3", "t2", "tool", ["a2"]),
      a2: node("a2", "t3", "assistant", []),
      u3: node("u3", "a1", "user", ["a4"]),
      a4: node("a4", "u3", "assistant", []),
    },
  };
}

describe("ascii tree", () => {
  it("naive: stanzas at margin, fork children in creation order", () => {
    const t = buildAsciiTree(fixture());
    const shape = t.rows.map((r) => `${r.prefix}${r.kind === "node" ? r.nodeId : "⋯"}`);
    expect(shape).toEqual([
      "u1", //          user at margin
      "└─ a1", //       reply stanza
      "   ├─ u2", //    first-created branch first
      "   │  └─ ⋯", //  its tool run + closing reply elide inside its stanza
      "   └─ u3", //    later branch last (also the active one here)
      "      └─ a4",
    ]);
    const leafRow = t.rows[aRowIndexOf(t, "a4")]!;
    expect(leafRow.isLeaf).toBe(true);
    expect(leafRow.onActive).toBe(true);
    expect(t.folded).toBe(false);
  });

  it("branch order is stable: activating the first-created branch does not move it", () => {
    // Same tree, but the ACTIVE leaf is inside the first branch (u2's a2).
    const d = fixture();
    d.leafId = "a2";
    const t = buildAsciiTree(d);
    // u2 stays first even though it is now active; u3 stays last.
    expect(aRowIndexOf(t, "u2")).toBeLessThan(aRowIndexOf(t, "u3"));
    expect(t.rows[aRowIndexOf(t, "u2")]!.onActive).toBe(true);
    expect(t.rows[aRowIndexOf(t, "a2")]!.isLeaf).toBe(true);
  });

  it("re-answer: the first answer keeps the stanza; the retry is a branch, active or not", () => {
    // u1 answered twice: a1 (original), a1b (re-answer, currently active).
    const d: TreeDetail = {
      treeId: "t",
      leafId: "a1b",
      rootIds: ["u1"],
      nodes: {
        u1: node("u1", null, "user", ["a1", "a1b"]),
        a1: node("a1", "u1", "assistant", []),
        a1b: node("a1b", "u1", "assistant", []),
      },
    };
    const t = buildAsciiTree(d);
    expect(aRowIndexOf(t, "a1")).toBeLessThan(aRowIndexOf(t, "a1b"));
    expect(t.rows[aRowIndexOf(t, "a1b")]!.isLeaf).toBe(true);
  });

  it("chains do not staircase: a long fork-free session stays at two levels", () => {
    const nodes: Record<string, NodeSummary> = {};
    let prev: string | null = null;
    const order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const u = `u${i}`, a = `a${i}`;
      nodes[u] = node(u, prev ?? null, "user", [a]);
      nodes[a] = node(a, u, "assistant", []);
      if (prev) nodes[prev]!.children = [u];
      order.push(u, a);
      prev = a;
    }
    const t = buildAsciiTree({ treeId: "t", leafId: prev, rootIds: ["u0"], nodes });
    const maxPrefix = Math.max(...t.rows.map((r) => r.prefix.length));
    expect(maxPrefix).toBe(3); // "└─ " only — no accumulation
  });

  /** fixture() with a longer abandoned branch (3 user turns) so it can fold. */
  function bigFixture(): TreeDetail {
    const f = fixture();
    f.nodes.a2!.children = ["u2b"];
    f.nodes.u2b = node("u2b", "a2", "user", ["a2b"]);
    f.nodes.a2b = node("a2b", "u2b", "assistant", ["u2c"]);
    f.nodes.u2c = node("u2c", "a2b", "user", ["a2c"]);
    f.nodes.a2c = node("a2c", "u2c", "assistant", []);
    return f;
  }

  it("folds large non-active branches when the tree exceeds the viewport", () => {
    const t = buildAsciiTree(bigFixture(), { viewportH: 4, now: Date.parse("2026-07-25T12:00:00Z") });
    expect(t.folded).toBe(true);
    const fold = t.rows.find((r) => r.kind === "fold")!;
    expect(fold.foldId).toBe("u2");
    expect(fold.foldMsgs).toBe(9);
    expect(fold.foldAge).toBe("2h");
    // Active path is never folded.
    expect(aRowIndexOf(t, "a4")).toBeGreaterThan(-1);
    expect(aRowIndexOf(t, "t1")).toBe(-1);
    expect(aContainerOf(t, "t1")).toEqual({ kind: "fold", id: "u2" });
  });

  it("respects manual unfolds and elision expansion", () => {
    const t = buildAsciiTree(bigFixture(), { viewportH: 4, unfolded: new Set(["u2"]) });
    expect(t.rows.find((r) => r.kind === "fold")).toBeUndefined();
    expect(aRowIndexOf(t, "u2")).toBeGreaterThan(-1);
    const elision = t.rows.find((r) => r.kind === "elision")!;
    expect(elision.count).toBe(4); // t1 t2 t3 + the closing assistant reply
    const t2 = buildAsciiTree(fixture(), {
      viewportH: 0,
      expandedRuns: new Set([elision.runId!]),
    });
    expect(aRowIndexOf(t2, "t2")).toBeGreaterThan(-1);
  });

  it("scale rules pin the active path to its margin across many forks", () => {
    // 8 forks along the trunk; naive would drift 8 levels right.
    const nodes: Record<string, NodeSummary> = {};
    let prev: string | null = null;
    for (let i = 0; i < 8; i++) {
      const u = `u${i}`, a = `a${i}`, b = `b${i}`, b2 = `c${i}`;
      nodes[u] = node(u, prev, "user", [a]);
      nodes[a] = node(a, u, "assistant", [b, `u${i + 1}`]);
      nodes[b] = node(b, a, "user", [b2]);
      nodes[b2] = node(b2, b, "assistant", []);
      prev = a;
    }
    nodes[`u8`] = node("u8", "a7", "user", []);
    const detail: TreeDetail = { treeId: "t", leafId: "u8", rootIds: ["u0"], nodes };

    const naive = buildAsciiTree(detail, { viewportH: 0 });
    const naiveMax = Math.max(
      ...naive.rows.filter((r) => r.onActive).map((r) => r.prefix.length),
    );
    const pinned = buildAsciiTree(detail, { viewportH: 10 });
    const pinnedMax = Math.max(
      ...pinned.rows.filter((r) => r.onActive).map((r) => r.prefix.length),
    );
    expect(naiveMax).toBeGreaterThan(20); // staircase exists naively…
    expect(pinnedMax).toBeLessThanOrEqual(3); // …and is gone under scale rules
    // Side branches still render, indented with ├─.
    expect(pinned.rows.some((r) => r.prefix.includes("├─"))).toBe(true);
  });

  it("small trees never fold regardless of foldable branches", () => {
    const t = buildAsciiTree(fixture(), { viewportH: 50 });
    expect(t.folded).toBe(false);
  });
});
