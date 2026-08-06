import { describe, expect, it } from "vitest";
import {
  buildLaneGraph,
  rowIndexOf,
  runContaining,
  selectableRows,
} from "../src/client/tree/lanegraph.js";
import type { NodeSummary, TreeDetail } from "../src/shared/types.js";

function node(
  id: string,
  parentId: string | null,
  kind: NodeSummary["kind"],
  children: string[],
  label: string | null = null,
): NodeSummary {
  return { id, parentId, kind, excerpt: `${kind} ${id}`, label, timestamp: "", children };
}

/**
 *   u1 ── a1 ── t1 ── t2 ── a2 ── u2 ── a3        (trunk, leaf a3)
 *          └─── u3 ── a4                          (abandoned branch)
 */
function fixture(): TreeDetail {
  return {
    treeId: "t",
    leafId: "a3",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["t1", "u3"], "plan-approved"),
      t1: node("t1", "a1", "tool", ["t2"]),
      t2: node("t2", "t1", "tool", ["a2"]),
      a2: node("a2", "t2", "assistant", ["u2"]),
      u2: node("u2", "a2", "user", ["a3"]),
      a3: node("a3", "u2", "assistant", []),
      u3: node("u3", "a1", "user", ["a4"]),
      a4: node("a4", "u3", "assistant", []),
    },
  };
}

describe("lane graph", () => {
  it("keeps the active path in lane 0, branches right, leaf last", () => {
    const g = buildLaneGraph(fixture());
    expect(g.laneCount).toBe(2);
    expect(g.leafId).toBe("a3");
    // The last row is the leaf, in lane 0.
    const last = g.rows[g.rows.length - 1]!;
    expect(last.nodeId).toBe("a3");
    expect(last.isLeaf).toBe(true);
    expect(last.gutter[0]!.ch).not.toBe(" ");
    // One connector row introduces the branch.
    const connectors = g.rows.filter((r) => r.kind === "connector");
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.gutter.map((c) => c.ch).join("")).toContain("├");
    expect(connectors[0]!.gutter.map((c) => c.ch).join("")).toContain("╮");
    // The abandoned branch (u3, a4) renders in lane 1 (column 2).
    const u3row = g.rows[rowIndexOf(g, "u3")]!;
    expect(u3row.gutter[2]!.ch).not.toBe(" ");
    expect(u3row.onTrunk).toBe(false);
    // While the branch is drawn, the trunk rail stays visible in lane 0.
    expect(u3row.gutter[0]!.ch).toBe("│");
  });

  it("collapses linear tool/assistant runs and expands them on demand", () => {
    const g = buildLaneGraph(fixture());
    // t1, t2, a2 are insignificant and linear → one elision row.
    const elisions = g.rows.filter((r) => r.kind === "elision");
    expect(elisions).toHaveLength(1);
    expect(elisions[0]!.count).toBe(3);
    expect(rowIndexOf(g, "t1")).toBe(-1);
    expect(runContaining(g, "t2")).toBe(elisions[0]!.runId);

    const expanded = buildLaneGraph(fixture(), { expanded: new Set([elisions[0]!.runId!]) });
    expect(rowIndexOf(expanded, "t1")).toBeGreaterThan(-1);
    expect(expanded.rows.filter((r) => r.kind === "elision")).toHaveLength(0);

    const showAll = buildLaneGraph(fixture(), { collapseRuns: false });
    expect(showAll.rows.filter((r) => r.kind === "elision")).toHaveLength(0);
    expect(rowIndexOf(showAll, "t2")).toBeGreaterThan(-1);
  });

  it("marks significant nodes: labels, users, branch points survive collapsing", () => {
    const g = buildLaneGraph(fixture());
    for (const id of ["u1", "a1", "u2", "u3", "a3"]) {
      expect(rowIndexOf(g, id), `row for ${id}`).toBeGreaterThan(-1);
    }
    const a1 = g.rows[rowIndexOf(g, "a1")]!;
    expect(a1.gutter.some((c) => c.ch === "◆")).toBe(true); // labeled glyph
  });

  it("keeps a labeled plumbing node visible instead of splicing it", () => {
    const detail = fixture();
    detail.nodes.m1 = node("m1", null, "custom", ["u1"], "Wiz");
    detail.nodes.m1!.excerpt = "model → gpt-x";
    detail.nodes.u1!.parentId = "m1";
    detail.rootIds = ["m1"];
    const g = buildLaneGraph(detail);
    expect(rowIndexOf(g, "m1")).toBeGreaterThan(-1); // labeled → survives
    const row = g.rows[rowIndexOf(g, "m1")]!;
    expect(row.gutter.some((c) => c.ch === "◆")).toBe(true);
  });

  it("splices unlabeled settings plumbing at the session head", () => {
    const detail = fixture();
    // Simulate pi's session opener: model_change + thinking_level_change.
    detail.nodes.mc = node("mc", null, "custom", ["tc"]);
    detail.nodes.tc = node("tc", "mc", "custom", ["u1"]);
    detail.nodes.u1!.parentId = "tc";
    detail.rootIds = ["mc"];
    const g = buildLaneGraph(detail);
    expect(rowIndexOf(g, "mc")).toBe(-1);
    expect(rowIndexOf(g, "tc")).toBe(-1);
    expect(g.rows[0]!.nodeId).toBe("u1"); // conversation starts the tree
  });

  it("splices out pines plumbing (custom) nodes, resolving the leaf upward", () => {
    const detail = fixture();
    // Simulate an in-place branch marker: custom leaf under a1.
    detail.nodes.c1 = node("c1", "a1", "custom", []);
    detail.nodes.a1!.children.push("c1");
    detail.leafId = "c1";
    const g = buildLaneGraph(detail);
    expect(rowIndexOf(g, "c1")).toBe(-1);
    expect(g.leafId).toBe("a1"); // leaf resolves to nearest real ancestor
    expect(g.rows[rowIndexOf(g, "a1")]!.isLeaf).toBe(true);
  });

  it("tolerates multiple roots and keeps selection rows navigable", () => {
    const detail: TreeDetail = {
      treeId: "t",
      leafId: "b1",
      rootIds: ["r1", "r2"],
      nodes: {
        r1: node("r1", null, "user", ["b1"]),
        b1: node("b1", "r1", "assistant", []),
        r2: node("r2", null, "user", []),
      },
    };
    const g = buildLaneGraph(detail);
    expect(rowIndexOf(g, "r1")).toBeGreaterThan(-1);
    expect(rowIndexOf(g, "r2")).toBeGreaterThan(-1);
    const sel = selectableRows(g);
    expect(sel.length).toBe(g.rows.filter((r) => r.kind !== "connector").length);
  });

  it("reuses lanes after a branch closes (width stays small)", () => {
    // Two sequential forks off the trunk — second fork should reuse lane 1.
    const detail: TreeDetail = {
      treeId: "t",
      leafId: "z",
      rootIds: ["u1"],
      nodes: {
        u1: node("u1", null, "user", ["f1"]),
        f1: node("f1", "u1", "assistant", ["m1", "b1"]),
        b1: node("b1", "f1", "user", []),
        m1: node("m1", "f1", "user", ["f2"]),
        f2: node("f2", "m1", "assistant", ["z", "b2"]),
        b2: node("b2", "f2", "user", []),
        z: node("z", "f2", "user", []),
      },
    };
    const g = buildLaneGraph(detail);
    expect(g.laneCount).toBe(2);
  });
});
