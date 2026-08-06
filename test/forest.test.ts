import { describe, expect, it } from "vitest";
import { Canvas } from "../src/client/forest/canvas.js";
import { InputRouter, type MouseEvent } from "../src/client/input.js";
import {
  cellToWorld,
  ensureVisible,
  fitCamera,
  worldToCell,
  zoomAt,
} from "../src/client/forest/camera.js";
import { renderForest } from "../src/client/forest/view.js";
import type { TreeDetail, TreeSummary } from "../src/shared/types.js";

function plainRows(canvas: Canvas): string[] {
  return canvas.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("canvas braille rasterizer", () => {
  it("draws a horizontal line as connected braille cells", () => {
    const c = new Canvas(10, 3);
    c.line(0, 1, 9, 1, null);
    const row = plainRows(c)[1]!;
    // Every cell along the line carries braille dots (no gaps).
    const cells = row.slice(0, 10).split("");
    expect(cells.every((ch) => ch >= "⠀" && ch <= "⣿")).toBe(true);
  });

  it("draws a diagonal with sub-cell resolution and respects glyph priority", () => {
    const c = new Canvas(8, 8);
    c.line(0, 0, 7, 7, null);
    c.set(3, 3, "X", null, 42);
    const rows = plainRows(c);
    expect(rows[3]![3]).toBe("X"); // glyphs win over braille
    expect(c.pickAt(3, 3)).toBe(42);
    expect(c.pickAt(0, 7)).toBe(-1);
    // The diagonal touches a run of cells from top-left to bottom-right.
    const touched = rows.filter((r) => /[⠀-⣿]/.test(r)).length;
    expect(touched).toBeGreaterThanOrEqual(6);
  });

  it("clips out-of-bounds drawing safely", () => {
    const c = new Canvas(4, 4);
    c.line(-10, -10, 20, 20, null);
    c.text(-5, 2, "hello", null);
    c.set(100, 100, "Z", null);
    expect(() => c.render()).not.toThrow();
  });
});

describe("SGR mouse parser", () => {
  function collect(bytes: string): { keys: string[]; mice: MouseEvent[] } {
    const router = new InputRouter();
    const keys: string[] = [];
    const mice: MouseEvent[] = [];
    router.on("key", (k) => keys.push(k));
    router.on("mouse", (m) => mice.push(m));
    router.feed(bytes);
    return { keys, mice };
  }

  it("parses press, release, drag, and wheel events (0-based coords)", () => {
    const { mice, keys } = collect(
      "\x1b[<0;10;5M" + "\x1b[<32;12;6M" + "\x1b[<0;12;6m" + "\x1b[<64;3;3M" + "\x1b[<65;3;3M",
    );
    expect(keys).toEqual([]);
    expect(mice.map((m) => m.kind)).toEqual(["press", "drag", "release", "wheel-up", "wheel-down"]);
    expect(mice[0]).toMatchObject({ x: 9, y: 4, button: 0 });
  });

  it("separates interleaved keys and mouse sequences, including split chunks", () => {
    const router = new InputRouter();
    const keys: string[] = [];
    const mice: MouseEvent[] = [];
    router.on("key", (k) => keys.push(k));
    router.on("mouse", (m) => mice.push(m));
    router.feed("ab\x1b[<0;2;");
    router.feed("2Mcd");
    expect(keys.join("")).toBe("abcd");
    expect(mice).toHaveLength(1);
  });

  it("passes non-mouse escape sequences through as keys", () => {
    const { keys, mice } = collect("\x1b[A\x1b[B");
    expect(mice).toHaveLength(0);
    expect(keys).toEqual(["\x1b[A", "\x1b[B"]);
  });

  it("separates coalesced keystrokes so prefix chords remain interceptable", () => {
    const { keys, mice } = collect("\x14fna");
    expect(mice).toHaveLength(0);
    expect(keys).toEqual(["\x14", "f", "n", "a"]);
  });
});

describe("camera", () => {
  const vp = { width: 100, height: 40 };

  it("round-trips world ↔ cell", () => {
    const cam = { cx: 5, cy: -3, zoom: 4 };
    const { x, y } = worldToCell(cam, vp, 7.5, -1.25);
    const { wx, wy } = cellToWorld(cam, vp, x, y);
    expect(wx).toBeCloseTo(7.5, 6);
    expect(wy).toBeCloseTo(-1.25, 6);
  });

  it("zoomAt keeps the point under the cursor fixed", () => {
    const cam = { cx: 0, cy: 0, zoom: 2 };
    const cursor = { x: 70, y: 10 };
    const before = cellToWorld(cam, vp, cursor.x, cursor.y);
    const zoomed = zoomAt(cam, vp, cursor.x, cursor.y, 1.5);
    const after = cellToWorld(zoomed, vp, cursor.x, cursor.y);
    expect(after.wx).toBeCloseTo(before.wx, 6);
    expect(after.wy).toBeCloseTo(before.wy, 6);
  });

  it("fitCamera contains all points in the viewport", () => {
    const pts = [
      { x: -10, y: -5 },
      { x: 25, y: 12 },
      { x: 3, y: 40 },
    ];
    const cam = fitCamera(pts, vp);
    for (const p of pts) {
      const c = worldToCell(cam, vp, p.x, p.y);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(vp.width);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(vp.height);
    }
  });
});

describe("ensureVisible (scroll-into-view-if-needed)", () => {
  const vp = { width: 100, height: 40 };
  const cam = { cx: 0, cy: 0, zoom: 2 };

  it("returns the same camera when the point is already comfortably visible", () => {
    expect(ensureVisible(cam, vp, 5, 5)).toBe(cam);
    expect(ensureVisible(cam, vp, 0, 0)).toBe(cam);
  });

  it("pans minimally so an off-screen point lands just inside the margin", () => {
    const wx = 200; // far right of the viewport at zoom 2
    const moved = ensureVisible(cam, vp, wx, 0);
    expect(moved).not.toBe(cam);
    expect(moved.zoom).toBe(cam.zoom); // never zooms
    const p = worldToCell(moved, vp, wx, 0);
    expect(p.x).toBeCloseTo(vp.width - 10, 5); // sits at the margin, not center
    // Vertical position untouched — only the necessary axis moves.
    expect(moved.cy).toBe(cam.cy);
  });

  it("pans on both axes when needed", () => {
    const moved = ensureVisible(cam, vp, -300, -300);
    const p = worldToCell(moved, vp, -300, -300);
    expect(p.x).toBeCloseTo(10, 5);
    expect(p.y).toBeCloseTo(4, 5);
  });
});

describe("label declutter + empty state", () => {
  function summary(id: string, name: string, x: number, y: number, extra: Partial<TreeSummary> = {}): TreeSummary {
    return {
      treeId: id, sessionPath: `/s/${id}`, sessionId: null, name, cwd: null,
      parentSessionPath: null, status: "dormant", seen: true, leafId: null,
      nodeCount: 1, x, y, live: false, mtime: 1, ...extra,
    };
  }

  it("drops the lower-priority label when two trees' names would overlap", () => {
    const vp = { width: 60, height: 20 };
    const c = new Canvas(vp.width, vp.height);
    // Two trees on the same row, 2 cells apart at zoom 2 — labels collide.
    renderForest(c, {
      trees: [summary("a", "alpha-tree", 0, 0), summary("b", "beta-tree", 1, 0, { seen: false })],
      camera: { cx: 0.5, cy: 0, zoom: 2 },
      vp, selectedId: null, spinnerFrame: 0,
    });
    const plain = c.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    // Unseen tree wins priority; the seen tree's label is dropped, glyph kept.
    expect(plain).toContain("beta-tree");
    expect(plain).not.toContain("alpha-tree");
  });

  it("still shows both labels when there is room", () => {
    const vp = { width: 80, height: 20 };
    const c = new Canvas(vp.width, vp.height);
    renderForest(c, {
      trees: [summary("a", "alpha-tree", -8, -3), summary("b", "beta-tree", 8, 3)],
      camera: { cx: 0, cy: 0, zoom: 2 },
      vp, selectedId: null, spinnerFrame: 0,
    });
    const plain = c.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("alpha-tree");
    expect(plain).toContain("beta-tree");
  });

  it("renders an empty-state hint when the forest has no trees", () => {
    const vp = { width: 80, height: 20 };
    const c = new Canvas(vp.width, vp.height);
    renderForest(c, {
      trees: [], camera: { cx: 0, cy: 0, zoom: 2 },
      vp, selectedId: null, spinnerFrame: 0,
    });
    const plain = c.render().map((r) => r.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(plain).toContain("the forest is empty");
    expect(plain).toContain("plant a tree");
  });
});

describe("forest render performance", () => {
  function fakeTree(i: number): TreeSummary {
    return {
      treeId: `t_${i}`,
      sessionPath: `/s/${i}.jsonl`,
      sessionId: null,
      name: `tree-${i}`,
      cwd: `/proj/${i % 7}`,
      parentSessionPath: i % 5 === 0 && i > 0 ? `/s/${i - 1}.jsonl` : null,
      status: (["running", "waiting", "dormant", "completed"] as const)[i % 4]!,
      seen: i % 3 === 0,
      leafId: null,
      nodeCount: 10,
      x: (i % 12) * 6,
      y: Math.floor(i / 12) * 6,
      live: i % 4 === 0,
      mtime: i,
    };
  }

  it("renders 120 trees on a 200x60 canvas well under the frame budget", () => {
    const trees = Array.from({ length: 120 }, (_, i) => fakeTree(i));
    const vp = { width: 200, height: 60 };
    const cam = fitCamera(trees, vp);
    // Warm up once, then measure.
    const canvas = new Canvas(vp.width, vp.height);
    renderForest(canvas, {
      trees, camera: cam, vp, selectedId: null, spinnerFrame: 0,
    });
    const t0 = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) {
      const c = new Canvas(vp.width, vp.height);
      renderForest(c, {
        trees, camera: cam, vp, selectedId: "t_5", spinnerFrame: i,
      });
      c.render();
    }
    const perFrame = (performance.now() - t0) / N;
    expect(perFrame).toBeLessThan(16);
  });
});
