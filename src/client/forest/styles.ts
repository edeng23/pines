/**
 * The forest's visual options.
 *
 * Same layout, same status vocabulary, six different ways of reading the map:
 *
 *   classic        status dot + name, braille lineage threads (the original)
 *   canopy         a forester's plat: sunlit pines on graph paper
 *   constellation  a star chart: brightness by size, curved lineage arcs
 *   cards          one dense chip per tree: status bar, name, age
 *   contour        a topographic map — activity as elevation rings
 *
 * Adding a sixth is a matter of one object in this file: the renderer only
 * knows the `ForestStyle` contract.
 */
import type { TreeSummary } from "../../shared/types.js";
import type { Canvas } from "./canvas.js";
import { FAINT, GRID, MUTED } from "../theme.js";
import { statusGlyph, statusSgr } from "./status.js";
import { humanAge, treeTitle } from "./sidebar.js";
import {
  LabelPlacer,
  fitText,
  truncate,
  type DrawCtx,
  type ForestStyle,
  type ForestStyleId,
  type Point,
  type Rect,
} from "./style.js";

/** Selected markers get the whole name — the focused label must read fully. */
function shownName(ctx: { title: string; selected: boolean; nameMax: number }): string {
  return ctx.selected ? ctx.title : truncate(ctx.title, ctx.nameMax);
}

/**
 * Emphasis for a name: unseen work shouts, seen work sits back, and a
 * placeholder (an unnamed session showing its directory) never shouts at all.
 */
function nameSgr(c: { t: TreeSummary; fallback: boolean }): string {
  return c.fallback || c.t.seen ? MUTED : "1";
}

/** Draw a label, stopping cleanly at the right edge of the canvas. */
function label(canvas: Canvas, c: DrawCtx, x: number, y: number, text: string, sgr: string): void {
  const shown = fitText(text, x, c.vp.width);
  if (shown) canvas.text(x, y, shown, sgr, c.pickId);
}

/* ------------------------------- classic --------------------------------- */

const classic: ForestStyle = {
  id: "classic",
  name: "classic",
  blurb: "status dot + name, braille lineage threads",

  footprint(t, pos, o) {
    const label = o.selected
      ? ` ▸ ${treeTitle(t).title} `
      : ` ${truncate(treeTitle(t).title, o.nameMax)}`;
    return { x: pos.x, y: pos.y, w: 1 + label.length, h: 1 };
  },

  drawTree(canvas, c) {
    const sgr = statusSgr(c.t);
    canvas.set(
      c.pos.x,
      c.pos.y,
      statusGlyph(c.t, c.spinnerFrame),
      c.selected ? `7;${sgr}` : sgr,
      c.pickId,
    );
    if (c.selected) {
      label(canvas, c, c.pos.x + 1, c.pos.y, ` ▸ ${c.title} `, "1;7");
    } else if (c.roomy) {
      label(canvas, c, c.pos.x + 1, c.pos.y, ` ${shownName(c)}`, nameSgr(c));
    }
  },
};

/* -------------------------------- canopy --------------------------------- */

/**
 * Trees.
 *
 * Block glyphs, not braille: a cell of `█` is solid mass at any font size,
 * while braille dots scatter into confetti below about 18px — a filled
 * silhouette turns to mush at the seams between cells. Rows are drawn upward
 * from the tree's own cell, which carries the status glyph and acts as the
 * base of the trunk.
 *
 * Every sprite carries a tone map: `0` is lit, `1` is body, `2` is shadow.
 * The light comes from the upper left on every tree — a lit tip and edge, a
 * darker right flank — which is what turns a flat green triangle into
 * something with a sunny side. `trunk` is the column of the bitmap that
 * stands on the tree's own cell, so sizes of different widths line up.
 */
interface Sprite {
  rows: string[];
  tones: string[];
  trunk: number;
}

/**
 * Needled, for a session with a process behind it.
 *
 * Even the smallest is a whole tree: a forest of one-cell triangles reads as
 * punctuation, not as a wood. Size still varies — it is how the map shows you
 * which conversations went long — but the silhouette is always a pine.
 */
const PINE_XXL: Sprite = {
  trunk: 4,
  rows: ["    ▲    ", "   ▟█▙   ", "  ▟███▙  ", " ▟█████▙ ", "▟███████▙"],
  tones: ["    0    ", "   012   ", "  01112  ", " 0111112 ", "011111112"],
};
const PINE_XL: Sprite = {
  trunk: 3,
  rows: ["   ▲   ", "  ▟█▙  ", " ▟███▙ ", "▟█████▙"],
  tones: ["   0   ", "  012  ", " 01112 ", "0111112"],
};
const PINE_L: Sprite = {
  trunk: 2,
  rows: ["  ▲  ", " ▟█▙ ", "▟███▙"],
  tones: ["  0  ", " 012 ", "01112"],
};
const PINE_M: Sprite = { trunk: 1, rows: [" ▲ ", "▟█▙"], tones: [" 0 ", "012"] };
/** Only for a forest with no room left at all. */
const PINE_S: Sprite = { trunk: 0, rows: ["▲"], tones: ["1"] };

/** Bare: no process, no needles. Dormant work reads as winter wood. */
const BARE_XL: Sprite = {
  trunk: 2,
  rows: ["╲ │ ╱", " ╲│╱ ", "  │  "],
  tones: ["0 1 0", " 010 ", "  2  "],
};
const BARE_L: Sprite = {
  trunk: 2,
  rows: ["╲ │ ╱", " ╲│╱ "],
  tones: ["0 1 0", " 010 "],
};
const BARE_M: Sprite = { trunk: 1, rows: ["╲│╱", " │ "], tones: ["010", " 2 "] };
const BARE_S: Sprite = { trunk: 0, rows: ["╵"], tones: ["1"] };

const PINES: Sprite[] = [PINE_S, PINE_M, PINE_L, PINE_XL, PINE_XXL];
const BARES: Sprite[] = [BARE_S, BARE_M, BARE_L, BARE_XL, BARE_XL];

/** Lit / body / shadow, as a 256-color triple. */
type Palette = [string, string, string];

/**
 * Foliage comes in a few close greens, dealt out per tree: a real wood is
 * many near-greens, not one, and the variation is what makes a hillside of
 * pines read as alive instead of tiled. The pick is a hash of the tree id,
 * so a tree keeps its color for life and never flickers between frames.
 */
const FOLIAGE: Palette[] = [
  ["38;5;114", "38;5;71", "38;5;29"], // fresh pine
  ["38;5;150", "38;5;108", "38;5;65"], // dusty sage
  ["38;5;113", "38;5;70", "38;5;28"], // sunlit lime
];

/** Winter wood for dormant sessions: warm bark, dark heartwood. */
const BARK_TONES: Palette = ["38;5;180", "38;5;137", "38;5;95"];

/** A crashed session stands as burnt wood — ember red, unmistakable. */
const EMBER_TONES: Palette = ["38;5;203", "38;5;167", "38;5;124"];

function paletteOf(t: TreeSummary): Palette {
  if (t.status === "crashed") return EMBER_TONES;
  if (t.status === "dormant") return BARK_TONES;
  let h = 2166136261;
  for (let i = 0; i < t.treeId.length; i++) {
    h ^= t.treeId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return FOLIAGE[(h >>> 0) % FOLIAGE.length]!;
}

/**
 * How big a tree grew, and how big this forest can afford to draw it.
 *
 * Conversation length sets the size — it is the only structural signal the
 * forest has at this zoom. Then the room between neighbors caps it: a packed
 * forest keeps its trees small rather than growing them into each other, and
 * zooming in lets them fill out again. The floor is a whole little pine; the
 * bare single glyph is reserved for forests with no room at all. The
 * five-row old-growth tier is earned twice over — a genuinely long session
 * in a genuinely open forest.
 */
function spriteFor(t: TreeSummary, bare: boolean, spacing: number): Sprite {
  const grown = t.nodeCount >= 100 ? 4 : t.nodeCount >= 35 ? 3 : t.nodeCount >= 12 ? 2 : 1;
  const room = spacing >= 15 ? 4 : spacing >= 11 ? 3 : spacing >= 7 ? 2 : spacing >= 4 ? 1 : 0;
  return (bare ? BARES : PINES)[Math.min(grown, room)]!;
}

/** Cell box a sprite fills, standing on (and excluding) its base row. */
function spriteRect(sprite: Sprite, pos: Point): Rect {
  const w = Math.max(...sprite.rows.map((r) => r.length));
  return {
    x: Math.round(pos.x) - sprite.trunk,
    y: Math.round(pos.y) - sprite.rows.length,
    w,
    h: sprite.rows.length,
  };
}

/**
 * Paint a sprite so its trunk stands on `pos` and its foliage grows upward,
 * each cell in its tone's color. Bold on selection: it reads as the whole
 * tree catching the light.
 */
function drawSprite(
  canvas: Canvas,
  sprite: Sprite,
  pos: Point,
  palette: Palette,
  pickId: number,
  bold = false,
): void {
  const box = spriteRect(sprite, pos);
  for (let r = 0; r < sprite.rows.length; r++) {
    const row = sprite.rows[r]!;
    const tones = sprite.tones[r]!;
    for (let i = 0; i < row.length; i++) {
      if (row[i] === " ") continue;
      const tone = palette[Number(tones[i]) as 0 | 1 | 2] ?? palette[1];
      canvas.set(box.x + i, box.y + r, row[i]!, bold ? `1;${tone}` : tone, pickId);
    }
  }
}

const canopy: ForestStyle = {
  id: "canopy",
  name: "canopy",
  blurb: "a forester's plat — sunlit pines on graph paper, surveyed lineage",

  underlay(canvas, ctx) {
    // Graph paper, ruled to the forest: wider squares when trees are packed
    // tightly, so the grid stays a backdrop instead of a texture.
    //
    // A middot rather than a braille dot. Braille would keep the paper in the
    // sub-cell layer, out of the way of everything — but its dot sits in the
    // cell's top-left corner and is small enough to vanish. A centered `·`
    // reads as a ruled point. Nothing else in this look draws braille, and
    // the underlay runs before edges and trees, so they still paint over it.
    const step = ctx.spacing < 8 ? 8 : 6;
    for (let y = 0; y < ctx.vp.height; y += step / 2) {
      for (let x = 0; x < ctx.vp.width; x += step) {
        canvas.set(x, Math.round(y), "·", GRID);
      }
    }
  },

  edge(canvas, a, b) {
    // Lineage as survey lines: across at the parent's row, then down (or up)
    // the child's column, ending under the child's trunk. Trees draw after
    // edges, so a line runs to the wood and disappears behind it. Drawn a
    // step brighter than the paper — parentage is information, the grid is
    // decoration, and the two should not read as the same thing.
    const ax = Math.round(a.x);
    const ay = Math.round(a.y);
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    // Half-open ranges, not step-until-equal: a run of zero length (parent and
    // child sharing a row or column) must draw nothing, not loop forever.
    for (let x = Math.min(ax, bx) + 1; x < Math.max(ax, bx); x++) {
      canvas.set(x, ay, "─", FAINT);
    }
    if (ax !== bx && ay !== by) {
      canvas.set(bx, ay, bx > ax ? (by > ay ? "╮" : "╯") : by > ay ? "╭" : "╰", FAINT);
    }
    for (let y = Math.min(ay, by) + 1; y < Math.max(ay, by); y++) {
      canvas.set(bx, y, "│", FAINT);
    }
  },

  // Foliage occupies real cells, so the whole tree is off limits to labels —
  // at exactly the size this forest will draw it.
  core: (t, pos, spacing) => {
    const bare = t.status !== "running" && t.status !== "waiting";
    const box = spriteRect(spriteFor(t, bare, spacing), pos);
    return { x: box.x, y: box.y, w: box.w, h: box.h + 1 };
  },

  footprint(t, pos, o) {
    const bare = t.status !== "running" && t.status !== "waiting";
    // Claim the tree as drawn, plus room for the name beside its base.
    const box = spriteRect(spriteFor(t, bare, o.spacing), pos);
    const label = ` ${o.selected ? treeTitle(t).title : truncate(treeTitle(t).title, o.nameMax)} `;
    const x = Math.min(box.x, Math.round(pos.x));
    return {
      x,
      y: box.y,
      w: Math.max(box.x + box.w - x, Math.round(pos.x) - x + 1 + label.length),
      h: box.h + 1,
    };
  },

  drawTree(canvas, c) {
    const sgr = statusSgr(c.t);
    const bare = c.t.status === "dormant" || c.t.status === "crashed";
    const sprite = spriteFor(c.t, bare, c.spacing);
    drawSprite(canvas, sprite, c.pos, paletteOf(c.t), c.pickId, c.selected);
    // Work you have not looked at yet lights the crown, so attention reads
    // from across the map without repainting the whole tree.
    if (!c.t.seen) {
      const box = spriteRect(sprite, c.pos);
      canvas.set(Math.round(c.pos.x), box.y, sprite.rows[0]!.trim()[0] ?? "▲", `1;${sgr}`, c.pickId);
    }
    // The base carries the state itself, so "working" animates at the roots.
    canvas.set(
      c.pos.x,
      c.pos.y,
      statusGlyph(c.t, c.spinnerFrame),
      c.selected ? `7;${sgr}` : sgr,
      c.pickId,
    );
    if (!c.speaks && !c.selected) return; // a quiet tree in a packed forest
    const text = ` ${shownName(c)} `;
    // A crowded tree still deserves its name: try the base row, then the row
    // above it, and only then stay anonymous.
    let row = c.pos.y;
    if (!c.roomy && !c.selected) {
      if (c.labels.claim(c.pos.x + 1, c.pos.y, text.length, c.t.treeId)) row = c.pos.y;
      else if (c.labels.claim(c.pos.x + 1, c.pos.y - 1, text.length, c.t.treeId)) row = c.pos.y - 1;
      else return;
    }
    label(canvas, c, c.pos.x + 1, row, text, c.selected ? "1;7" : nameSgr(c));
  },
};

/* ----------------------------- constellation ------------------------------ */

/** Stars brighten with session size; the state glyph still wins for live work. */
function starGlyph(t: TreeSummary, spinnerFrame: number): string {
  if (t.status === "running") return statusGlyph(t, spinnerFrame);
  if (t.status === "crashed") return "✸";
  if (t.status === "dormant") return t.nodeCount >= 12 ? "✧" : "·";
  return t.nodeCount >= 12 ? "✦" : "✧";
}

const constellation: ForestStyle = {
  id: "constellation",
  name: "constellation",
  blurb: "a star chart with curved lineage arcs",

  footprint(t, pos, o) {
    const label = `  ${o.selected ? treeTitle(t).title : truncate(treeTitle(t).title, o.nameMax)} `;
    return { x: pos.x, y: pos.y, w: 1 + label.length, h: 1 };
  },

  edge(canvas, a, b) {
    // A gentle arc instead of a straight thread: bow the line away from its
    // own midpoint so sibling lineages fan out instead of overlapping.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy * 2) || 1;
    // Control point: the midpoint pushed along the perpendicular (cell aspect
    // corrected, so the bow looks equally deep whatever the edge's angle).
    const bow = 0.16;
    const cx = mx - dy * 2 * bow;
    const cy = my + dx * 0.5 * bow;
    const steps = Math.max(8, Math.round(len));
    let px = a.x;
    let py = a.y;
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const qx = (1 - s) * (1 - s) * a.x + 2 * (1 - s) * s * cx + s * s * b.x;
      const qy = (1 - s) * (1 - s) * a.y + 2 * (1 - s) * s * cy + s * s * b.y;
      // Dash the arc by segment, so a long lineage reads as a thread.
      if (i % 4 !== 0) canvas.line(px, py, qx, qy, FAINT);
      px = qx;
      py = qy;
    }
  },

  drawTree(canvas, c) {
    const sgr = statusSgr(c.t);
    if (c.selected) halo(canvas, c.pos);
    canvas.set(
      c.pos.x,
      c.pos.y,
      starGlyph(c.t, c.spinnerFrame),
      c.selected ? `7;${sgr}` : c.t.seen ? sgr : `1;${sgr}`,
      c.pickId,
    );
    if (c.selected) {
      label(canvas, c, c.pos.x + 1, c.pos.y, ` ${c.title} `, "1;7");
    } else if (c.roomy) {
      label(canvas, c, c.pos.x + 1, c.pos.y, `  ${shownName(c)} `, nameSgr(c));
    }
  },
};

/** Braille ring around the focused star. */
function halo(canvas: Canvas, pos: Point): void {
  const rx = 2.2;
  const ry = 1.1;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    canvas.dot(
      Math.round((pos.x + rx * Math.cos(a)) * 2),
      Math.round((pos.y + ry * Math.sin(a)) * 4),
      FAINT,
    );
  }
}

/* --------------------------------- cards ---------------------------------- */

function chipText(c: {
  title: string;
  selected: boolean;
  t: TreeSummary;
  now: number;
  nameMax: number;
}): { name: string; age: string } {
  return {
    name: c.selected ? c.title : truncate(c.title, Math.min(16, c.nameMax)),
    age: humanAge(c.t.mtime, c.now),
  };
}

const cards: ForestStyle = {
  id: "cards",
  name: "cards",
  blurb: "dense chips: status bar, name, age",

  footprint(t, pos, o) {
    const { name, age } = chipText({
      title: treeTitle(t).title,
      selected: o.selected,
      t,
      now: o.now,
      nameMax: o.nameMax,
    });
    // ▌ ◐ name 12m
    return { x: pos.x, y: pos.y, w: 2 + 2 + name.length + 1 + age.length + 1, h: 1 };
  },

  drawTree(canvas, c) {
    const sgr = statusSgr(c.t);
    const { name, age } = chipText(c);
    // A chip is only worth drawing whole: near the right edge, shrink the
    // name, and when even that runs out fall back to the bare status glyph
    // rather than a half-chip bleeding off the canvas.
    const chrome = 3 + 1 + age.length + 1; // ▌ glyph space … space age space
    const nameRoom = c.vp.width - Math.round(c.pos.x) - chrome;
    const shown = truncate(name, Math.min(name.length, nameRoom));
    if ((!c.roomy && !c.selected) || nameRoom < 4) {
      canvas.set(c.pos.x, c.pos.y, statusGlyph(c.t, c.spinnerFrame), sgr, c.pickId);
      return;
    }
    const inv = c.selected ? "7;" : "";
    let x = c.pos.x;
    // Status bar on the leading edge: a colored spine the eye can scan down.
    canvas.set(x++, c.pos.y, "▌", `${inv}${sgr}`, c.pickId);
    canvas.set(x++, c.pos.y, statusGlyph(c.t, c.spinnerFrame), `${inv}${sgr}`, c.pickId);
    canvas.set(x++, c.pos.y, " ", c.selected ? "7" : null, c.pickId);
    canvas.text(x, c.pos.y, shown, c.selected ? "1;7" : c.fallback ? MUTED : c.t.seen ? "0" : "1", c.pickId);
    x += shown.length;
    canvas.set(x++, c.pos.y, " ", c.selected ? "7" : null, c.pickId);
    canvas.text(x, c.pos.y, age, c.selected ? "7" : MUTED, c.pickId);
    x += age.length;
    canvas.set(x, c.pos.y, " ", c.selected ? "7" : null, c.pickId);
  },
};

/* -------------------------------- contour --------------------------------- */

const contour: ForestStyle = {
  id: "contour",
  name: "contour",
  blurb: "topographic — activity as elevation rings",

  footprint(t, pos, o) {
    const label = ` ${o.selected ? treeTitle(t).title : truncate(treeTitle(t).title, o.nameMax)} `;
    return { x: pos.x, y: pos.y, w: 2 + label.length, h: 1 };
  },

  underlay(canvas, ctx) {
    // Elevation = activity. A live agent (or work you haven't looked at yet)
    // raises the ground around it into contours; everything settled is flat
    // map. Rings stay in the faintest gray there is — contours belong *under*
    // the labels, never around them.
    //
    // Ring size and count follow how much room the forest has: a crowded map
    // gets one tight ring per live tree instead of two wide ones, so contours
    // never turn into static.
    const step = Math.max(0.7, Math.min(1.15, ctx.spacing / 6));
    const maxRings = ctx.spacing >= 9 ? 2 : 1;
    for (const { t, pos } of ctx.visible) {
      const rings = Math.min(maxRings, !t.seen ? 2 : t.live ? 1 : 0);
      for (let r = rings; r >= 1; r--) {
        ring(canvas, pos, step * r, r === 1 && !t.seen ? statusSgr(t) : GRID);
      }
    }
  },

  drawTree(canvas, c) {
    const sgr = statusSgr(c.t);
    canvas.set(
      c.pos.x,
      c.pos.y,
      statusGlyph(c.t, c.spinnerFrame),
      c.selected ? `7;${sgr}` : sgr,
      c.pickId,
    );
    if (c.selected) {
      label(canvas, c, c.pos.x + 1, c.pos.y, ` ${c.title} `, "1;7");
    } else if (c.roomy) {
      label(canvas, c, c.pos.x + 1, c.pos.y, ` ${shownName(c)} `, nameSgr(c));
    }
  },
};

/** One contour ring, drawn in the braille layer so labels always win. */
function ring(canvas: Canvas, pos: Point, r: number, sgr: string): void {
  const steps = Math.max(28, Math.round(r * 34));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    canvas.dot(
      Math.round((pos.x + r * 2 * Math.cos(a)) * 2),
      Math.round((pos.y + r * Math.sin(a)) * 4),
      sgr,
    );
  }
}

/* -------------------------------- registry -------------------------------- */

export const FOREST_STYLES: ForestStyle[] = [
  classic,
  canopy,
  constellation,
  cards,
  contour,
];

// The plat is the forest's face: it is what the project is named for.
export const DEFAULT_STYLE_ID: ForestStyleId = "canopy";

export function forestStyle(id: string | null | undefined): ForestStyle {
  return FOREST_STYLES.find((s) => s.id === id) ?? FOREST_STYLES[0]!;
}

/** Next style in the list, wrapping — the `v` key's cycle order. */
export function nextStyleId(id: string, dir = 1): ForestStyleId {
  const i = FOREST_STYLES.findIndex((s) => s.id === id);
  const n = FOREST_STYLES.length;
  return FOREST_STYLES[(((i < 0 ? 0 : i) + dir) % n + n) % n]!.id;
}
