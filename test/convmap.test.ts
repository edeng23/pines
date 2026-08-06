import { describe, expect, it } from "vitest";
import {
  buildSkeleton,
  layoutMini,
  miniHitKey,
  renderConvMini,
  skelNodeFor,
} from "../src/client/tree/convmap.js";
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

function summary(treeId: string, over: Partial<TreeSummary> = {}): TreeSummary {
  return {
    treeId, sessionPath: `/s/${treeId}`, sessionId: null, name: treeId, cwd: "/w",
    parentSessionPath: null, status: "dormant", seen: true, leafId: null,
    nodeCount: 1, x: 0, y: 0, live: false, mtime: 1, ...over,
  };
}

/** Merged tree: u1 → a1 ─┬─ u2 → t1 → a2 (tip: root)
 *                        └─ u3 → a3       (tip: kid, working) */
function merged(): TreeDetail {
  return {
    treeId: "root",
    leafId: "a3",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u2", "u3"]),
      u2: node("u2", "a1", "user", ["t1"]),
      t1: node("t1", "u2", "tool", ["a2"]),
      a2: node("a2", "t1", "assistant", []),
      u3: node("u3", "a1", "user", ["a3"]),
      a3: node("a3", "u3", "assistant", []),
    },
  };
}

const tipsAt = () =>
  new Map([
    ["a2", [summary("root")]],
    ["a3", [summary("kid", { status: "running", live: true })]],
  ]);

describe("conversation mini", () => {
  it("skeleton vertices are branch segments headed by user messages", () => {
    const skel = buildSkeleton(merged(), tipsAt());
    // u1's exchange (u1→a1) is ONE vertex; the fan children are the user
    // turns u2 and u3 — never the replies.
    expect(skel.map((n) => [n.id, n.depth, n.parent])).toEqual([
      ["u1", 0, -1],
      ["u2", 1, 0],
      ["u3", 1, 0],
    ]);
    // Tips along a segment attach to its vertex.
    expect(skel[1]!.tips!.map((t) => t.treeId)).toEqual(["root"]);
    expect(skel[2]!.tips!.map((t) => t.treeId)).toEqual(["kid"]);
  });

  it("layout: depth = column, siblings on distinct rows, all in bounds", () => {
    const skel = buildSkeleton(merged(), tipsAt());
    const nodes = layoutMini(skel, 30, 10);
    const by = new Map(nodes.map((n) => [n.id, n]));
    expect(by.get("u1")!.x).toBeLessThan(by.get("u2")!.x);
    expect(by.get("u2")!.y).not.toBe(by.get("u3")!.y);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThan(29);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThan(10);
    }
  });

  it("renders clickable status-glyph tips, braille edges, and a cursor mark", () => {
    const skel = buildSkeleton(merged(), tipsAt());
    const { lines, hits } = renderConvMini(skel, {
      width: 30,
      height: 10,
      spinnerFrame: 0,
      cursorSkelId: "u3",
    });
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plain).toHaveLength(10);
    expect(plain.join("")).toMatch(/[╭╰├│┤┼]/); // rounded metro routes
    expect(plain.join("")).not.toMatch(/[⠁-⣿]/); // no braille dust
    expect(plain.join("")).toContain("◐"); // kid is working
    // Every tip is clickable at its cell, resolving to its node id.
    const nodes = layoutMini(skel, 30, 10);
    for (const n of nodes) {
      if (n.tips?.length) expect(hits.get(miniHitKey(n.x, n.y))).toBe(n.id);
    }
  });

  it("a lone sub-fork with an agent gets its own DEPTH-2 vertex, not absorption", () => {
    // u3's answer a3 has ONE continuation, u4 — but u4 heads another
    // agent's branch. The transcript lets it flow on; the map must nest it.
    const d = merged();
    d.nodes.a3!.children = ["u4"];
    d.nodes.u4 = node("u4", "a3", "user", ["a4"]);
    d.nodes.a4 = node("a4", "u4", "assistant", []);
    const tips = new Map([
      ["a2", [summary("root")]],
      ["a3", [summary("kid")]],
      ["a4", [summary("grandkid", { status: "running", live: true })]],
    ]);
    // Without heads: u4 absorbs into u3's segment (flat — the old bug).
    const flat = buildSkeleton(d, tips);
    expect(flat.map((n) => n.id)).not.toContain("u4");
    // With u4 declared a branch head, it nests as a child of u3's segment.
    const skel = buildSkeleton(d, tips, new Set(["u4"]));
    const u4 = skel.find((n) => n.id === "u4")!;
    const u3 = skel.findIndex((n) => n.id === "u3");
    expect(u4.depth).toBe(2);
    expect(u4.parent).toBe(u3);
    expect(u4.tips!.map((t) => t.treeId)).toEqual(["grandkid"]);
    // The parent segment keeps its own agent where it was.
    expect(skel[u3]!.tips!.map((t) => t.treeId)).toEqual(["kid"]);
  });

  it("skelNodeFor maps any message to its segment's head vertex", () => {
    const skel = buildSkeleton(merged(), tipsAt());
    const d = merged();
    expect(skelNodeFor(d, skel, "t1")).toBe("u2"); // inside u2's exchange
    expect(skelNodeFor(d, skel, "a1")).toBe("u1"); // the answer belongs to u1
    expect(skelNodeFor(d, skel, "a3")).toBe("u3");
    expect(skelNodeFor(d, skel, null)).toBeNull();
  });
});
