/**
 * The forest's look: canopy — a forester's plat, sunlit pines on graph paper,
 * lineage surveyed in right angles. (Earlier versions offered several looks;
 * canopy is the one the project is named for, and now the only one.)
 */
import type { TreeSummary } from "../../shared/types.js";
import type { Canvas } from "./canvas.js";
import { FAINT, GRID, MUTED } from "../theme.js";
import { statusGlyph, statusSgr } from "./status.js";
import { treeTitle } from "./sidebar.js";
import {
  fitText,
  truncate,
  type DrawCtx,
  type ForestStyle,
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

/**
 * Trees.
 *
 * Block glyphs, not braille: a cell of `█` is solid mass at any font size,
 * while braille dots scatter into confetti below about 18px — a filled
 * silhouette turns to mush at the seams between cells. Rows are drawn upward
 * from the tree's own cell, which carries the status glyph and acts as the
 * base of the trunk.
 *
 * Every sprite carries a tone map: `0` is lit, `1` is body, `2` is shadow,
 * `3` is bark. The light comes from the upper left on every tree — a lit tip
 * and edge, a darker right flank — which is what turns a flat green triangle
 * into something with a sunny side. `trunk` is the column of the bitmap that
 * stands on the tree's own cell, so sizes of different widths line up.
 */
export interface Sprite {
  rows: string[];
  tones: string[];
  trunk: number;
}

/** Bare: only a crashed session loses its needles — burnt wood, unmistakable. */
const BARE_XL: Sprite = {
  trunk: 2,
  rows: ["╲ │ ╱", " ╲│╱ ", "  │  "],
  tones: ["0 1 0", " 010 ", "  2  "],
};
const BARE_M: Sprite = { trunk: 1, rows: ["╲│╱", " │ "], tones: ["010", " 2 "] };
const BARE_S: Sprite = { trunk: 0, rows: ["╵"], tones: ["1"] };
const BARE_L: Sprite = {
  trunk: 2,
  rows: ["╲ │ ╱", " ╲│╱ "],
  tones: ["0 1 0", " 010 "],
};

/** Lit / body / shadow / bark, as a 256-color quadruple. */
type Palette = [string, string, string, string];

/**
 * Foliage comes in a few close greens, dealt out per tree: a real wood is
 * many near-greens, not one, and the variation is what makes a hillside of
 * pines read as alive instead of tiled. The pick is a hash of the tree id,
 * so a tree keeps its color for life and never flickers between frames.
 * Bark is the forest's one non-green: it only ever shows on old growth.
 */
const FOLIAGE: Palette[] = [
  ["38;5;114", "38;5;71", "38;5;29", "38;5;137"], // fresh pine
  ["38;5;150", "38;5;108", "38;5;65", "38;5;137"], // dusty sage
  ["38;5;113", "38;5;70", "38;5;28", "38;5;137"], // sunlit lime
];

/**
 * A dormant session keeps its needles — the conversation is asleep, not dead;
 * a whole forest goes dormant on every daemon restart, and it must still read
 * as a forest. The green just goes muted, wintered-over.
 */
const WINTER_TONES: Palette = ["38;5;108", "38;5;65", "38;5;59", "38;5;95"];

/** A crashed session stands as burnt wood — ember red, unmistakable. */
const EMBER_TONES: Palette = ["38;5;203", "38;5;167", "38;5;124", "38;5;52"];

function treeSeed(treeId: string): number {
  let h = 2166136261;
  for (let i = 0; i < treeId.length; i++) {
    h ^= treeId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function paletteOf(t: TreeSummary): Palette {
  if (t.status === "crashed") return EMBER_TONES;
  if (t.status === "dormant") return WINTER_TONES;
  return FOLIAGE[treeSeed(t.treeId) % FOLIAGE.length]!;
}

/** Bare is reserved for the one state that means the tree burned. */
function isBare(t: TreeSummary): boolean {
  return t.status === "crashed";
}

/**
 * The widest crown a tree ever grows, in cells. Wide enough that no legal
 * (height, tier-break) plan ever repeats a row width — a repeated width
 * reads as a flat-sided column, not a pine skirt.
 */
const MAX_CROWN_W = 13;
/** The tallest crown, in rows (a trunk row can stand under it). */
const MAX_CROWN_H = 9;

/**
 * Crown rows the conversation has EARNED: logarithmic, one new row per
 * ~1.8× growth. Doubling is the unit of progress — early life changes fast,
 * old age changes slowly but never stops (a 400-message tree still out-grows
 * a 200-message one, where the old ladder froze everything at 100).
 */
export function earnedRows(nodeCount: number): number {
  const h = 1 + Math.floor(Math.log(Math.max(nodeCount, 3) / 3) / Math.log(1.8));
  return Math.max(1, Math.min(MAX_CROWN_H, h));
}

/**
 * Rows the forest has ROOM to draw at this spacing (incl. a trunk row).
 * Deliberately looser than the old five-sprite cap: a forest at ordinary
 * fit-zoom sits around spacing 8–14, and if tiers only unlocked past 15
 * the whole growth story would be invisible exactly where the user looks.
 */
function roomRows(spacing: number): number {
  if (spacing >= 19) return MAX_CROWN_H + 1;
  if (spacing >= 14) return 8;
  if (spacing >= 11) return 6;
  if (spacing >= 7) return 4;
  if (spacing >= 4) return 2;
  return 1;
}

/**
 * Grow a pine. One deterministic silhouette from (size, id, room):
 *
 * Strictly symmetric — bilateral, centered on its trunk — and built from
 * stacked triangle tiers, the classic conifer form. The crown widens row by
 * row; from six rows it BREAKS into a second tier (the width resets and
 * climbs again), and old trees stand on a visible bark trunk. The tree's id
 * chooses only symmetric character — an early or late tier break, a shown
 * or hidden trunk — never a lean, so every tree is unmistakably a tree and
 * no two elders match. Same inputs, same sprite: nothing ever flickers.
 */
export function pineSprite(nodeCount: number, treeId: string, spacing: number): Sprite {
  const seed = treeSeed(treeId);
  const room = roomRows(spacing);
  const earned = earnedRows(nodeCount);
  // An elder is an elder at EVERY zoom. Trunk-worthiness comes from what the
  // tree EARNED, not from what the map has room to draw — so when crowding
  // shrinks the crown, the bark still shows, and a small tree standing on a
  // trunk is how a packed map says "old growth". (Most, not all, elders
  // grow one — the id decides, like everything else about a tree's look.)
  const trunkEligible = earned >= 8 && seed % 3 !== 0;
  const total = Math.min(earned + (trunkEligible ? 1 : 0), room);
  const showTrunk = trunkEligible && total >= 4;
  const h = showTrunk ? total - 1 : Math.min(earned, room);
  if (h <= 1) return { trunk: 0, rows: ["▲"], tones: ["1"] };

  const widths: number[] = [1];
  let w = 1;
  const breakAt = h >= 6 ? 3 + (seed % 2) : -1;
  for (let r = 1; r < h; r++) {
    if (r === breakAt) {
      w = Math.max(3, w - 4); // the crown resets: a new tier begins
    } else {
      w = Math.min(w + 2, MAX_CROWN_W);
    }
    widths.push(w);
  }

  const maxW = Math.max(...widths);
  const trunk = Math.floor((maxW - 1) / 2);
  const rows: string[] = [];
  const tones: string[] = [];
  const centered = (body: string, tone: string): void => {
    const pad = " ".repeat((maxW - body.length) / 2);
    rows.push(pad + body + pad);
    tones.push(pad + tone + pad);
  };
  for (const width of widths) {
    if (width === 1) centered("▲", "0");
    else centered("▟" + "█".repeat(width - 2) + "▙", "0" + "1".repeat(width - 2) + "2");
  }
  if (showTrunk) centered("▐█▌", "333");
  return { trunk, rows, tones };
}

/**
 * How big this forest can afford to draw a tree.
 *
 * Conversation length sets the size — it is the only structural signal the
 * forest has at this zoom. Then the room between neighbors caps it: a packed
 * forest keeps its trees small rather than growing them into each other, and
 * zooming in lets them fill out again. Crashed trees stand as bare burnt
 * wood, sized to the same room.
 */
function spriteFor(t: TreeSummary, bare: boolean, spacing: number): Sprite {
  if (bare) {
    const h = Math.min(earnedRows(t.nodeCount), roomRows(spacing));
    return h <= 1 ? BARE_S : h <= 2 ? BARE_M : h <= 4 ? BARE_L : BARE_XL;
  }
  return pineSprite(t.nodeCount, t.treeId, spacing);
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
      const tone = palette[Number(tones[i]) as 0 | 1 | 2 | 3] ?? palette[1];
      canvas.set(box.x + i, box.y + r, row[i]!, bold ? `1;${tone}` : tone, pickId);
    }
  }
}

export const canopy: ForestStyle = {
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
    const box = spriteRect(spriteFor(t, isBare(t), spacing), pos);
    return { x: box.x, y: box.y, w: box.w, h: box.h + 1 };
  },

  footprint(t, pos, o) {
    // Claim the tree as drawn, plus room for the name beside its base.
    const box = spriteRect(spriteFor(t, isBare(t), o.spacing), pos);
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
    const sprite = spriteFor(c.t, isBare(c.t), c.spacing);
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
