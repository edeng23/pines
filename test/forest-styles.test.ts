import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Canvas } from "../src/client/forest/canvas.js";
import { renderForest } from "../src/client/forest/view.js";
import { DEFAULT_STYLE_ID, FOREST_STYLES, forestStyle, nextStyleId } from "../src/client/forest/styles.js";
import { LabelPlacer } from "../src/client/forest/style.js";
import { buildLaneGraph } from "../src/client/tree/lanegraph.js";
import { loadUiState } from "../src/client/uistate.js";
import type { NodeSummary, TreeDetail, TreeSummary } from "../src/shared/types.js";

const NOW = 1_700_000_000_000;

function tree(over: Partial<TreeSummary> & { treeId: string }): TreeSummary {
  return {
    sessionPath: `/s/${over.treeId}`,
    sessionId: null,
    name: over.treeId,
    cwd: "/w",
    parentSessionPath: null,
    status: "dormant",
    seen: true,
    leafId: null,
    nodeCount: 20,
    x: 0,
    y: 0,
    live: false,
    mtime: NOW - 60_000,
    ...over,
  };
}

/** One tree of every state, spread far enough apart to all get labels. */
const FOREST: TreeSummary[] = [
  tree({ treeId: "working", status: "running", live: true, x: -6, y: -4, nodeCount: 60 }),
  tree({ treeId: "unseen", status: "waiting", seen: false, live: true, x: 6, y: -4 }),
  tree({ treeId: "acked", status: "waiting", x: -6, y: 4, nodeCount: 8 }),
  tree({ treeId: "done", status: "completed", x: 6, y: 4 }),
  tree({ treeId: "broke", status: "crashed", seen: false, x: 0, y: 0, parentSessionPath: "/s/working" }),
  tree({ treeId: "sleeping", status: "dormant", x: 0, y: 8, nodeCount: 3 }),
];

function render(styleId: string, zoom: number, trees = FOREST, selectedId = "unseen") {
  const vp = { width: 80, height: 24 };
  const canvas = new Canvas(vp.width, vp.height);
  const pick = renderForest(canvas, {
    trees,
    camera: { cx: 0, cy: 0, zoom },
    vp,
    selectedId,
    spinnerFrame: 0,
    style: styleId,
    now: NOW,
  });
  const plain = canvas.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  return { canvas, pick, plain, text: plain.join("\n") };
}

describe("forest styles", () => {
  it("offers five looks with unique ids and cycles through them", () => {
    expect(FOREST_STYLES).toHaveLength(5);
    expect(new Set(FOREST_STYLES.map((s) => s.id)).size).toBe(5);
    let id = FOREST_STYLES[0]!.id;
    const seen = new Set<string>();
    for (let i = 0; i < FOREST_STYLES.length; i++) {
      seen.add(id);
      id = nextStyleId(id);
    }
    expect(seen.size).toBe(FOREST_STYLES.length);
    expect(id).toBe(FOREST_STYLES[0]!.id); // wraps back around
    expect(nextStyleId(FOREST_STYLES[0]!.id, -1)).toBe(FOREST_STYLES.at(-1)!.id);
  });

  it("falls back to classic for an unknown style id", () => {
    expect(forestStyle("nonsense").id).toBe("classic");
    expect(forestStyle(null).id).toBe("classic");
  });

  for (const style of FOREST_STYLES) {
    describe(style.id, () => {
      it("draws every tree's marker and keeps it clickable", () => {
        const { canvas, pick } = render(style.id, 2);
        const hits = new Set<string>();
        for (let y = 0; y < 24; y++) {
          for (let x = 0; x < 80; x++) {
            const id = canvas.pickAt(x, y);
            if (id >= 0) hits.add(pick.get(id)!);
          }
        }
        for (const t of FOREST) expect(hits).toContain(t.treeId);
      });

      it("always spells out the selected tree's name", () => {
        expect(render(style.id, 2).text).toContain("unseen");
        // Even when a neighbor sits right on top of it.
        const crowded = [
          tree({ treeId: "unseen", status: "waiting", seen: false, live: true, x: 0, y: 0 }),
          tree({ treeId: "neighborly", status: "running", live: true, x: 0.4, y: 0.1 }),
        ];
        expect(render(style.id, 2, crowded).text).toContain("unseen");
      });

      it("keeps drawing the tree marker and name at mid zoom (no lane minis)", () => {
        // The sprite is the representation at every zoom — mid zoom must
        // show the same marker language, never dangling topology dots.
        const solo = [tree({ treeId: "unseen", status: "waiting", seen: false, live: true })];
        const { text } = render(style.id, 6, solo);
        expect(text).toContain("unseen");
      });

      it("survives lineage edges that share a row or a column", () => {
        // Right-angle edges once looped forever on a zero-length run.
        const aligned = [
          tree({ treeId: "p", x: -4, y: 0 }),
          tree({ treeId: "same-row", x: 4, y: 0, parentSessionPath: "/s/p" }),
          tree({ treeId: "same-col", x: -4, y: 5, parentSessionPath: "/s/p" }),
          tree({ treeId: "same-cell", x: -4, y: 0, parentSessionPath: "/s/p" }),
        ];
        expect(() => render(style.id, 2, aligned, "p")).not.toThrow();
      });

      it("never lets a long label swallow a neighbor's marker", () => {
        // The selected tree has a name far longer than the gap to its
        // neighbor: the neighbor must still own cells of its own.
        const pair = [
          tree({ treeId: "a-very-long-tree-name-indeed", status: "running", live: true, x: -1, y: 0 }),
          tree({ treeId: "neighbor", status: "waiting", seen: false, x: 1, y: 0 }),
        ];
        const { canvas, pick } = render(style.id, 3, pair, "a-very-long-tree-name-indeed");
        const owners = new Set<string>();
        for (let y = 0; y < 24; y++) {
          for (let x = 0; x < 80; x++) {
            const id = canvas.pickAt(x, y);
            if (id >= 0) owners.add(pick.get(id)!);
          }
        }
        expect(owners).toContain("neighbor");
      });
    });
  }
});

describe("crowding", () => {
  /** Twenty trees packed into a few cells of each other. */
  const packed = Array.from({ length: 20 }, (_, i) =>
    tree({
      treeId: `packed-${i}`,
      name: `a session about thing ${i}`,
      status: i === 0 ? "waiting" : "dormant",
      seen: i !== 0,
      live: i === 0,
      x: (i % 5) * 1.2 - 3,
      y: Math.floor(i / 5) * 1.2 - 2,
      mtime: NOW - i * 60_000,
    }),
  );

  for (const style of FOREST_STYLES) {
    it(`${style.id} keeps a packed forest legible and still names the unseen tree`, () => {
      const { text, plain } = render(style.id, 2, packed, null);
      // The one tree waiting on the user is named even in the crush.
      expect(text).toContain("a sessio");
      // …but the map does not become a wall of text: far fewer names than
      // trees, and no row is packed edge to edge with them.
      const names = (text.match(/a session about thing/g) ?? []).length;
      expect(names).toBeLessThan(packed.length);
      // Letters only: a backdrop of grid dots is not clutter, names are.
      const busiest = Math.max(...plain.map((r) => (r.match(/[a-z]/g) ?? []).length));
      expect(busiest).toBeLessThan(48);
    });

    it(`${style.id} never draws a marker on top of a neighbor's name`, () => {
      // Two trees a row apart: any marker taller than one row (canopy's
      // crown) used to land in the middle of the other's label.
      const pair = [
        tree({ treeId: "upper", name: "upper-tree-name", x: 0, y: -0.7, status: "running", live: true }),
        tree({ treeId: "lower", name: "lower-tree-name", x: 0.3, y: 0.7, status: "waiting", seen: false }),
      ];
      const { text } = render(style.id, 3, pair, "lower");
      expect(text).toContain("lower-tree-name"); // selected: always intact
    });
  }
});

describe("label placer", () => {
  it("claims rectangles all-or-nothing", () => {
    const p = new LabelPlacer();
    p.reserve(10, 5, 4);
    expect(p.claimRect({ x: 0, y: 4, w: 12, h: 2 })).toBe(false); // row 5 blocked
    expect(p.claimRect({ x: 0, y: 4, w: 8, h: 1 })).toBe(true);
    expect(p.claim(4, 4, 2)).toBe(false); // now taken by the rect above
  });

  it("lets a tree claim across its own reservation but not a stranger's", () => {
    const p = new LabelPlacer();
    p.reserve(5, 0, 1, "mine");
    p.reserve(9, 0, 1, "theirs");
    expect(p.claimRect({ x: 4, y: 0, w: 4, h: 1 }, "mine")).toBe(true);
    expect(p.claimRect({ x: 8, y: 0, w: 4, h: 1 }, "mine")).toBe(false);
  });
});

describe("ui state", () => {
  const prev = process.env.PINES_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.PINES_HOME;
    else process.env.PINES_HOME = prev;
  });

  it("keeps a known style, migrates blueprint, falls back for unknowns", () => {
    const home = mkdtempSync(join(tmpdir(), "pines-ui-"));
    process.env.PINES_HOME = home;
    writeFileSync(join(home, "ui.json"), JSON.stringify({ forestStyle: "classic" }));
    expect(loadUiState().forestStyle).toBe("classic");
    // blueprint was absorbed into canopy — a saved pick follows it there.
    writeFileSync(join(home, "ui.json"), JSON.stringify({ forestStyle: "blueprint" }));
    expect(loadUiState().forestStyle).toBe("canopy");
    writeFileSync(join(home, "ui.json"), JSON.stringify({ forestStyle: "from-the-future" }));
    expect(loadUiState().forestStyle).toBe(DEFAULT_STYLE_ID);
  });
});
