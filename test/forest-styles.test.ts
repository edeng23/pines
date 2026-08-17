import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Canvas } from "../src/client/forest/canvas.js";
import { renderForest } from "../src/client/forest/view.js";
import { earnedRows, pineSprite } from "../src/client/forest/styles.js";
import { LabelPlacer } from "../src/client/forest/style.js";
import { loadUiState } from "../src/client/uistate.js";
import type { TreeSummary } from "../src/shared/types.js";

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

function render(zoom: number, trees = FOREST, selectedId = "unseen") {
  const vp = { width: 80, height: 24 };
  const canvas = new Canvas(vp.width, vp.height);
  const pick = renderForest(canvas, {
    trees,
    camera: { cx: 0, cy: 0, zoom },
    vp,
    selectedId,
    spinnerFrame: 0,
  });
  const plain = canvas.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
  return { canvas, pick, plain, text: plain.join("\n") };
}

describe("canopy", () => {
  it("draws every tree's marker and keeps it clickable", () => {
    const { canvas, pick } = render(2);
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
    expect(render(2).text).toContain("unseen");
    // Even when a neighbor sits right on top of it.
    const crowded = [
      tree({ treeId: "unseen", status: "waiting", seen: false, live: true, x: 0, y: 0 }),
      tree({ treeId: "neighborly", status: "running", live: true, x: 0.4, y: 0.1 }),
    ];
    expect(render(2, crowded).text).toContain("unseen");
  });

  it("keeps drawing the tree marker and name at mid zoom (no lane minis)", () => {
    // The sprite is the representation at every zoom — mid zoom must
    // show the same marker language, never dangling topology dots.
    const solo = [tree({ treeId: "unseen", status: "waiting", seen: false, live: true })];
    const { text } = render(6, solo);
    expect(text).toContain("unseen");
  });

  it("keeps a dormant tree's needles and strips only a crashed one bare", () => {
    // A whole forest goes dormant on every daemon restart: it must still
    // read as a forest of pines, not a burn site of winter wood.
    const sleeping = [tree({ treeId: "sleeper", status: "dormant", nodeCount: 40 })];
    expect(render(6, sleeping, null).text).toMatch(/[▲▟█▙]/);
    const burned = [tree({ treeId: "burned", status: "crashed", nodeCount: 40 })];
    const burnedText = render(6, burned, null).text;
    expect(burnedText).toMatch(/[╲╱]/);
    expect(burnedText).not.toMatch(/[▟█▙]/);
  });

  it("survives lineage edges that share a row or a column", () => {
    // Right-angle edges once looped forever on a zero-length run.
    const aligned = [
      tree({ treeId: "p", x: -4, y: 0 }),
      tree({ treeId: "same-row", x: 4, y: 0, parentSessionPath: "/s/p" }),
      tree({ treeId: "same-col", x: -4, y: 5, parentSessionPath: "/s/p" }),
      tree({ treeId: "same-cell", x: -4, y: 0, parentSessionPath: "/s/p" }),
    ];
    expect(() => render(2, aligned, "p")).not.toThrow();
  });

  it("never lets a long label swallow a neighbor's marker", () => {
    // The selected tree has a name far longer than the gap to its
    // neighbor: the neighbor must still own cells of its own.
    const pair = [
      tree({ treeId: "a-very-long-tree-name-indeed", status: "running", live: true, x: -1, y: 0 }),
      tree({ treeId: "neighbor", status: "waiting", seen: false, x: 1, y: 0 }),
    ];
    const { canvas, pick } = render(3, pair, "a-very-long-tree-name-indeed");
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

  it("keeps a packed forest legible and still names the unseen tree", () => {
    const { text, plain } = render(2, packed, null);
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

  it("never draws a marker on top of a neighbor's name", () => {
    // Two trees a row apart: any marker taller than one row (canopy's
    // crown) used to land in the middle of the other's label.
    const pair = [
      tree({ treeId: "upper", name: "upper-tree-name", x: 0, y: -0.7, status: "running", live: true }),
      tree({ treeId: "lower", name: "lower-tree-name", x: 0.3, y: 0.7, status: "waiting", seen: false }),
    ];
    const { text } = render(3, pair, "lower");
    expect(text).toContain("lower-tree-name"); // selected: always intact
  });
});

describe("pine generator", () => {
  const SIZES = [1, 5, 15, 40, 90, 200, 420];
  const IDS = ["t_a1", "t_b2", "t_c3", "t_d4"];

  it("is deterministic: same inputs, same sprite, nothing ever flickers", () => {
    for (const n of SIZES) {
      expect(pineSprite(n, "t_a1", 30)).toEqual(pineSprite(n, "t_a1", 30));
    }
  });

  it("every row of every tree is a strictly symmetric pine row", () => {
    for (const n of SIZES) {
      for (const id of IDS) {
        const s = pineSprite(n, id, 30);
        for (const row of s.rows) {
          const lead = row.length - row.trimStart().length;
          const trail = row.length - row.trimEnd().length;
          expect(lead).toBe(trail); // bilateral, centered on the trunk
          expect(row.trim()).toMatch(/^(▲|▐█▌|▟█*▙)$/u); // tip, bark, or crown row
        }
      }
    }
  });

  it("growth never tops out: more conversation is never a smaller tree", () => {
    for (const id of IDS) {
      let prev = 0;
      for (const n of SIZES) {
        const rows = pineSprite(n, id, 99).rows.length;
        expect(rows).toBeGreaterThanOrEqual(prev);
        prev = rows;
      }
    }
    // The old ladder froze at 100; the log curve keeps climbing past it.
    const earned = [6, 12, 24, 48, 96, 190, 380].map(earnedRows);
    for (let i = 1; i < earned.length; i++) expect(earned[i]!).toBeGreaterThan(earned[i - 1]!);
  });

  it("old crowns break into stacked tiers; the tree's id deals the character", () => {
    const widths = (id: string) =>
      pineSprite(400, id, 30).rows.map((r) => r.trim().length);
    // Somewhere in an elder's crown the width RESETS — the second tier.
    const hasBreak = (ws: number[]) => ws.some((w, i) => i > 0 && w < ws[i - 1]! && ws[i - 1]! > 3);
    for (const id of IDS) expect(hasBreak(widths(id))).toBe(true);
    // And ids produce distinct elders (break position and/or trunk differ).
    const distinct = new Set(IDS.map((id) => widths(id).join(",")));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("a packed forest keeps its trees small; zoom hands the tiers back", () => {
    expect(pineSprite(400, "t_a1", 5).rows.length).toBeLessThanOrEqual(2);
    expect(pineSprite(400, "t_a1", 9).rows.length).toBeLessThanOrEqual(4);
    expect(pineSprite(400, "t_a1", 30).rows.length).toBeGreaterThanOrEqual(8);
  });

  it("tiers appear at ordinary fit-zoom, not only zoomed all the way in", () => {
    // The original cap gated the whole growth story behind spacing >= 15,
    // which made a 150-message tree look exactly like it always had at the
    // zoom people actually use. Spacing ~12 must already show the break.
    const widths = pineSprite(150, "t_a1", 12).rows.map((r) => r.trim().length);
    expect(widths.some((w, i) => i > 0 && w < widths[i - 1]!)).toBe(true);
  });

  it("an elder is never smaller than a younger tree at the same spacing", () => {
    // The trunk is a bonus row under the crown, never traded against it —
    // paying a crown row for bark once made an old tree draw SMALLER than
    // a young one at mid zoom.
    const maxW = (s: { rows: string[] }) => Math.max(...s.rows.map((r) => r.trim().length));
    for (const sp of [7, 9, 12, 15, 20]) {
      for (const id of IDS) {
        const young = pineSprite(40, id, sp);
        const elder = pineSprite(400, id, sp);
        expect(elder.rows.length).toBeGreaterThanOrEqual(young.rows.length);
        expect(maxW(elder)).toBeGreaterThanOrEqual(maxW(young));
      }
    }
  });

  it("an elder is an elder at every zoom: the bark shows even when cramped", () => {
    // t_b2 is trunk-eligible (id-dealt); crowding shrinks its crown but the
    // trunk stays — a small tree standing on bark reads as old growth.
    const cramped = pineSprite(400, "t_b2", 8);
    expect(cramped.rows.at(-1)!.trim()).toBe("▐█▌");
    // A young tree at the same spacing shows no bark anywhere.
    const young = pineSprite(20, "t_b2", 8);
    expect(young.rows.every((r) => !r.includes("▐"))).toBe(true);
  });
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

  it("ignores unknown keys, like the retired forestStyle of older versions", () => {
    const home = mkdtempSync(join(tmpdir(), "pines-ui-"));
    process.env.PINES_HOME = home;
    writeFileSync(
      join(home, "ui.json"),
      JSON.stringify({ forestStyle: "cards", sidebarVisible: false, sidebarWidth: 40 }),
    );
    const ui = loadUiState();
    expect(ui.sidebarVisible).toBe(false);
    expect(ui.sidebarWidth).toBe(40);
    expect("forestStyle" in ui).toBe(false);
  });
});
