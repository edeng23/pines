#!/usr/bin/env node
/**
 * Boot animation prototypes — four candidates for pines' first-boot splash,
 * all pure ANSI in the app's own visual language (glyphs, braille ground,
 * box-drawing, pine sprites). Watch and compare:
 *
 *   node scripts/boot-preview.mjs            # play all four, then a menu
 *   node scripts/boot-preview.mjs b          # play one (a|b|c|d)
 *   node scripts/boot-preview.mjs b --frame 20   # print one frame, no TTY
 *   node scripts/boot-preview.mjs a --agents 3     # germination, 3 lit crowns
 *
 * Any key skips the animation that's playing. Designed to mask daemon
 * startup (~1-2s) rather than add wait: the real integration would play
 * while the socket connects and cut to the forest the moment it's ready.
 */

/* ----------------------------- tiny canvas ----------------------------- */

const R = "\x1b[0m";
const sgr = (s) => (s ? `\x1b[${s}m` : "");

class Cv {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ch = Array.from({ length: h }, () => new Array(w).fill(" "));
    this.sg = Array.from({ length: h }, () => new Array(w).fill(""));
  }
  put(x, y, text, s = "") {
    x = Math.round(x);
    y = Math.round(y);
    if (y < 0 || y >= this.h) return;
    for (let i = 0; i < text.length; i++) {
      const cx = x + i;
      if (cx < 0 || cx >= this.w) continue;
      if (text[i] === " ") continue;
      this.ch[y][cx] = text[i];
      this.sg[y][cx] = s;
    }
  }
  lines() {
    return this.ch.map((row, y) => {
      let out = "";
      let cur = null;
      for (let x = 0; x < this.w; x++) {
        const s = this.sg[y][x];
        if (s !== cur) {
          out += (cur !== null ? R : "") + sgr(s);
          cur = s;
        }
        out += row[x];
      }
      return (out + (cur ? R : "")).replace(/\s+$/, "");
    });
  }
}

/* ------------------------------ palette -------------------------------- */

const MUT = "38;5;248";
const FNT = "38;5;240";
const TEAL = "1;38;5;44";
const YEL = "33";
const CYN = "36";
const G1 = "38;5;65"; // deep green
const G2 = "38;5;71"; // mid
const G3 = "38;5;108"; // pale
const TRUNK = "38;5;95";
const SPIN = ["◐", "◓", "◑", "◒"];

/* three-row block wordmark: p i n e s */
const MARK = [
  ["█▀▄ ", "█▀▀ ", "█   "],
  ["▀█▀ ", " █  ", "▄█▄ "],
  ["█▄ █ ", "█ ▀█ ", "█  █ "],
  ["█▀▀ ", "█▀▀ ", "▀▀▀ "],
  ["▄▀▀ ", "▀▀▄ ", "▄▄▀ "],
];
const MARK_W = MARK.reduce((n, l) => n + l[0].length, 0);
function drawMark(cv, x, y, upTo = MARK.length, s = "1;32") {
  let cx = x;
  for (let i = 0; i < MARK.length; i++) {
    if (i < upTo) for (let r = 0; r < 3; r++) cv.put(cx, y + r, MARK[i][r], s);
    cx += MARK[i][0].length;
  }
}

/* pine sprites, four growth stages (rows, bottom row is the trunk) */
const PINE = [
  [["▲", G2], ["╹", TRUNK]],
  [[" ▲", G3], ["▟█▙", G2], [" ╹", TRUNK]],
  [["  ▲", G3], [" ▟█▙", G2], ["▟███▙", G1], ["  ╹", TRUNK]],
  [["   ▲", G3], ["  ▟█▙", G2], [" ▟███▙", G2], ["▟█████▙", G1], ["   ╹", TRUNK]],
];
function drawPine(cv, x, y, stage, tint) {
  const rows = PINE[Math.max(0, Math.min(3, stage))];
  const h = rows.length;
  rows.forEach(([t, c], i) => cv.put(x, y - h + 1 + i, t, tint ?? c));
}
const BARE = [["\\ | /", FNT], [" \\|/", FNT], ["  |", FNT]];
function drawBare(cv, x, y) {
  BARE.forEach(([t, c], i) => cv.put(x, y - BARE.length + 1 + i, t, c));
}

function ground(cv, y) {
  for (let x = 1; x < cv.w - 1; x += 6) cv.put(x, y, "⠁", FNT);
}

/* ---------------------------- animations -------------------------------- */
/* Each returns Frame[]: { lines, ms }. Layouts assume >= 70x20, centered. */

function animGermination(w, h, agents = 2) {
  const frames = [];
  const gy = Math.floor(h * 0.72);
  const cx = Math.floor(w / 2);
  const F = (ms, draw) => {
    const cv = new Cv(w, h);
    ground(cv, gy + 1);
    draw(cv);
    frames.push({ lines: cv.lines(), ms });
  };
  // seed falls
  for (let i = 0; i < 5; i++) {
    const y = Math.floor((gy - 3) * ((i + 1) / 5)) + 2;
    F(70, (cv) => cv.put(cx, Math.min(y, gy), "·", MUT));
  }
  // sprout and grow
  for (let s = 0; s < 4; s++) {
    for (let r = 0; r < 3; r++) F(110, (cv) => drawPine(cv, cx - s, gy, s));
  }
  // neighbors pop, staggered — a forest, not a tree
  const spots = [
    [cx - 18, 1], [cx + 14, 2], [cx - 30, 0], [cx + 26, 1], [cx + 38, 0], [cx - 40, 1],
  ];
  spots.forEach((_, k) => {
    F(120, (cv) => {
      drawPine(cv, cx - 3, gy, 3);
      spots.slice(0, k + 1).forEach(([sx, st]) => drawPine(cv, sx, gy, st));
    });
  });
  // The agents that never slept: their crowns light up (glyph above the ▲,
  // the same status language the forest speaks). Capped at 3 lit crowns —
  // the LINE carries the real number.
  const lit = [
    [spots[1], "◐", YEL],
    [spots[3], "●", TEAL],
    [spots[0], "◐", YEL],
  ].slice(0, Math.min(agents, 3));
  const crown = (cv, [sx, st], g, sgrc) =>
    cv.put(sx + st, gy - (st + 2), g, sgrc);
  // wordmark rises, letter by letter; crowns wake with it
  const my = Math.floor(h * 0.22);
  const forest = (cv, litCount) => {
    drawPine(cv, cx - 3, gy, 3);
    spots.forEach(([sx, st]) => drawPine(cv, sx, gy, st));
    lit.slice(0, litCount).forEach(([spot, g, sgrc]) => crown(cv, spot, g, sgrc));
  };
  const tag = "your conversations are trees";
  const slept =
    agents > 0 ? `${agents} agent${agents === 1 ? "" : "s"} never slept` : "";
  for (let k = 1; k <= MARK.length + 3; k++) {
    F(130, (cv) => {
      forest(cv, 0);
      drawMark(cv, cx - Math.floor(MARK_W / 2), my, k);
      if (k > MARK.length) cv.put(cx - Math.floor(tag.length / 2), my + 4, tag, MUT);
    });
  }
  // crowns wink on one by one, then the line lands
  lit.forEach((_, k) => {
    F(160, (cv) => {
      forest(cv, k + 1);
      drawMark(cv, cx - Math.floor(MARK_W / 2), my, MARK.length);
      cv.put(cx - Math.floor(tag.length / 2), my + 4, tag, MUT);
    });
  });
  if (slept) {
    F(150, (cv) => {
      forest(cv, lit.length);
      drawMark(cv, cx - Math.floor(MARK_W / 2), my, MARK.length);
      cv.put(cx - Math.floor(tag.length / 2), my + 4, tag, MUT);
      cv.put(cx - Math.floor(slept.length / 2), my + 5, slept, TEAL);
    });
  }
  frames.push({ ...frames[frames.length - 1], ms: 1100 });
  return frames;
}

function animBranching(w, h) {
  const frames = [];
  const x0 = Math.floor(w / 2) - 22;
  const y0 = Math.floor(h / 2) - 5;
  const F = (ms, steps, spinFrame = 0, dim = false, mark = 0) => {
    const cv = new Cv(w, h);
    const base = dim ? FNT : null;
    const rows = [
      ["○", base ?? CYN, 0],
      ["└─ ·", base ?? MUT, 1],
      ["   ○", base ?? CYN, 2],
      ["   └─ ·", base ?? MUT, 3],
      ["      ├─ ○", base ?? CYN, 4],
      ["      │  └─ ·", base ?? MUT, 5],
      ["      ├─ ○", base ?? CYN, 6],
      ["      │  └─ SPIN1", base ?? MUT, 7],
      ["      └─ ○", base ?? CYN, 8],
      ["         └─ SPIN2", base ?? MUT, 9],
    ];
    rows.forEach(([text, s, step], i) => {
      if (step >= steps) return;
      let t = text;
      if (t.includes("SPIN1")) {
        cv.put(x0, y0 + i, t.replace("SPIN1", ""), s);
        const done1 = steps >= 12;
        cv.put(x0 + t.indexOf("SPIN1"), y0 + i, done1 ? "●" : SPIN[spinFrame % 4], dim ? FNT : done1 ? TEAL : YEL);
        if (done1 && !dim && mark === 0) cv.put(x0 + t.indexOf("SPIN1") + 2, y0 + i, "needs input", TEAL);
        return;
      }
      if (t.includes("SPIN2")) {
        cv.put(x0, y0 + i, t.replace("SPIN2", ""), s);
        cv.put(x0 + t.indexOf("SPIN2"), y0 + i, SPIN[(spinFrame + 2) % 4], dim ? FNT : YEL);
        if (!dim && steps >= 12 && mark === 0) cv.put(x0 + t.indexOf("SPIN2") + 2, y0 + i, "working", YEL);
        return;
      }
      cv.put(x0, y0 + i, t, s);
    });
    if (mark > 0) {
      const mx = x0 + 22;
      drawMark(cv, mx, y0 + 2, mark);
      if (mark > MARK.length) {
        cv.put(mx, y0 + 6, "every conversation a tree", MUT);
        cv.put(mx, y0 + 7, "every branch, its own agent", MUT);
      }
    }
    frames.push({ lines: cv.lines(), ms });
  };
  for (let s = 1; s <= 10; s++) F(s <= 2 ? 260 : 170, s);
  for (let k = 0; k < 8; k++) F(110, 10, k); // agents think
  for (let k = 8; k < 12; k++) F(130, 12, k); // one settles → needs input
  for (let m = 1; m <= MARK.length + 2; m++) F(120, 12, m + 10, false, m);
  frames.push({ ...frames[frames.length - 1], ms: 1000 });
  return frames;
}

function animMetro(w, h) {
  const frames = [];
  const x0 = Math.floor(w / 2) - 26;
  const y0 = Math.floor(h / 2) - 4;
  const L1 = "38;5;73", L2 = "38;5;108", L3 = "38;5;110", L4 = "38;5;139";
  // scripted drawing ops in order: [x, y, ch, sgr]
  const ops = [];
  ops.push([x0, y0 + 3, "○", CYN]);
  for (let i = 1; i <= 4; i++) ops.push([x0 + i, y0 + 3, "─", FNT]);
  ops.push([x0 + 5, y0 + 3, "┤", FNT]);
  // lane 1 up
  ops.push([x0 + 5, y0 + 2, "│", L1], [x0 + 5, y0 + 1, "╭", L1]);
  for (let i = 6; i <= 14; i++) ops.push([x0 + i, y0 + 1, "─", L1]);
  ops.push([x0 + 15, y0 + 1, "·", MUT]);
  // lane 2 straight
  for (let i = 6; i <= 14; i++) ops.push([x0 + i, y0 + 3, "─", L2]);
  ops.push([x0 + 15, y0 + 3, "·", MUT]);
  // lane 2 sub-branch
  for (let i = 16; i <= 22; i++) ops.push([x0 + i, y0 + 3, "─", L2]);
  ops.push([x0 + 23, y0 + 3, "╮", L2], [x0 + 23, y0 + 4, "╰", L2]);
  for (let i = 24; i <= 28; i++) ops.push([x0 + i, y0 + 4, "─", L2]);
  ops.push([x0 + 29, y0 + 4, "S", YEL]); // spinner placeholder
  // lane 3 down
  ops.push([x0 + 5, y0 + 4, "│", L3], [x0 + 5, y0 + 5, "╰", L3]);
  for (let i = 6; i <= 14; i++) ops.push([x0 + i, y0 + 5, "─", L3]);
  ops.push([x0 + 15, y0 + 5, "T", TEAL]); // teal station placeholder
  const drawUpTo = (cv, n, spinFrame) => {
    ops.slice(0, n).forEach(([x, y, ch, s]) => {
      if (ch === "S") cv.put(x, y, SPIN[spinFrame % 4], YEL);
      else if (ch === "T") cv.put(x, y, "●", TEAL);
      else cv.put(x, y, ch, s);
    });
  };
  const F = (ms, n, spinFrame = 0, mark = 0) => {
    const cv = new Cv(w, h);
    drawUpTo(cv, n, spinFrame);
    if (mark > 0) {
      const mx = x0 + 34;
      drawMark(cv, mx, y0 + 1, mark, "1;32");
      if (mark > MARK.length) {
        cv.put(mx, y0 + 5, "agents on every line", MUT);
        cv.put(mx, y0 + 6, "attach anywhere", MUT);
      }
    }
    frames.push({ lines: cv.lines(), ms });
  };
  for (let n = 1; n <= ops.length; n += 2) F(45, n, Math.floor(n / 3));
  for (let k = 0; k < 6; k++) F(110, ops.length, k);
  for (let m = 1; m <= MARK.length + 2; m++) F(120, ops.length, m + 6, m);
  frames.push({ ...frames[frames.length - 1], ms: 1000 });
  return frames;
}

function animDawn(w, h) {
  const frames = [];
  const gy = Math.floor(h * 0.68);
  const cx = Math.floor(w / 2);
  const spots = [cx - 34, cx - 18, cx - 2, cx + 16, cx + 32];
  const stages = [2, 3, 1, 3, 2];
  const F = (ms, draw) => {
    const cv = new Cv(w, h);
    ground(cv, gy + 1);
    ground(cv, gy + 3);
    draw(cv);
    frames.push({ lines: cv.lines(), ms });
  };
  // silhouettes fade in one by one (winter wood)
  for (let k = 1; k <= spots.length; k++) {
    F(150, (cv) => spots.slice(0, k).forEach((x) => drawBare(cv, x, gy)));
  }
  F(400, (cv) => spots.forEach((x) => drawBare(cv, x, gy)));
  // dawn: trees green up left to right
  for (let k = 1; k <= spots.length; k++) {
    for (let r = 0; r < 2; r++) {
      F(130, (cv) => {
        spots.forEach((x, i) => {
          if (i < k) drawPine(cv, x, gy, stages[i]);
          else drawBare(cv, x, gy);
        });
      });
    }
  }
  // agents wake: status glyphs on two crowns
  for (let k = 0; k < 10; k++) {
    F(110, (cv) => {
      spots.forEach((x, i) => drawPine(cv, x, gy, stages[i]));
      cv.put(spots[1] + 1, gy - PINE[stages[1]].length, SPIN[k % 4], YEL);
      if (k > 4) cv.put(spots[3] + 1, gy - PINE[stages[3]].length, "●", TEAL);
    });
  }
  // wordmark + the line
  const tag = "the forest is waking — 2 agents never stopped";
  for (let t = 4; t <= tag.length + 6; t += 3) {
    F(60, (cv) => {
      spots.forEach((x, i) => drawPine(cv, x, gy, stages[i]));
      cv.put(spots[1] + 1, gy - PINE[stages[1]].length, "◐", YEL);
      cv.put(spots[3] + 1, gy - PINE[stages[3]].length, "●", TEAL);
      drawMark(cv, cx - Math.floor(MARK_W / 2), Math.floor(h * 0.16), MARK.length);
      cv.put(cx - Math.floor(tag.length / 2), Math.floor(h * 0.16) + 4, tag.slice(0, t), MUT);
    });
  }
  frames.push({ ...frames[frames.length - 1], ms: 1100 });
  return frames;
}

const ANIMS = {
  a: { name: "A · germination", make: animGermination },
  b: { name: "B · the branching cursor", make: animBranching },
  c: { name: "C · metro lines energize", make: animMetro },
  d: { name: "D · dawn over the forest", make: animDawn },
};

/* ------------------------------- player --------------------------------- */

const out = process.stdout;
const args = process.argv.slice(2);
const frameAt = args.includes("--frame") ? Number(args[args.indexOf("--frame") + 1]) : null;
const AGENTS = args.includes("--agents") ? Number(args[args.indexOf("--agents") + 1]) : 2;
const pick = (args.find((a) => /^[abcd]$/.test(a)) ?? null);

const W = out.columns ?? 100;
const H = out.rows ?? 28;

if (frameAt !== null) {
  // Static frame dump (no TTY needed): for screenshots and eyeballing.
  const key = pick ?? "b";
  const frames = ANIMS[key].make(W, H, AGENTS);
  const f = frames[Math.max(0, Math.min(frames.length - 1, frameAt))];
  out.write(f.lines.join("\n") + "\n");
  process.exit(0);
}

let skip = false;
let quit = false;
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b) => {
    if (b[0] === 3 || b[0] === 113) quit = true; // ctrl-c / q
    skip = true;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function play(key) {
  const frames = ANIMS[key].make(W, H, AGENTS);
  skip = false;
  for (const f of frames) {
    if (skip || quit) break;
    out.write("\x1b[H\x1b[2J" + f.lines.map((l) => l + "\x1b[K").join("\r\n"));
    out.write(`\x1b[${H};1H\x1b[38;5;240m ${ANIMS[key].name} — any key skips\x1b[0m`);
    await sleep(f.ms);
  }
}

async function main() {
  out.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
  const order = pick ? [pick] : ["a", "b", "c", "d"];
  for (const k of order) {
    if (quit) break;
    await play(k);
  }
  // replay menu
  while (!quit) {
    out.write("\x1b[H\x1b[2J");
    const cy = Math.floor(H / 2) - 3;
    const menu = [
      "which one felt right?",
      "",
      "a  germination        b  the branching cursor",
      "c  metro energize     d  dawn over the forest",
      "",
      "q  quit",
    ];
    menu.forEach((l, i) => out.write(`\x1b[${cy + i};${Math.floor(W / 2) - 24}H${i === 0 ? "\x1b[1m" : "\x1b[38;5;248m"}${l}\x1b[0m`));
    const key = await new Promise((r) => process.stdin.once("data", (b) => r(String(b))));
    if (key === "q" || key.charCodeAt(0) === 3) break;
    if (/^[abcd]$/.test(key)) await play(key);
  }
  out.write("\x1b[?25h\x1b[?1049l");
  process.exit(0);
}

void main();
