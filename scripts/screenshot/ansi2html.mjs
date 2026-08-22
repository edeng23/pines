#!/usr/bin/env node
/**
 * ANSI (from `tmux capture-pane -e -p`) -> a standalone HTML page that renders
 * the frame as a terminal window, for shot.sh to screenshot. The palette is
 * the one scripts/forest-preview.ts uses, so shots and previews match.
 *
 *   tmux capture-pane -t pines -e -p | node ansi2html.mjs --title "…" > out.html
 *
 * The page box is written to stderr as WxH: Chromium's screenshot viewport
 * runs ~110px shorter than --window-size, so the window is centred on a matte
 * with slack rather than fitted exactly.
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const title = flag("title", "pines");
const fontPx = Number(flag("font", 14));

const BG = "#0d1117";
const FG = "#d5dae1";

const BASE16 = [
  "#000000", "#cc4444", "#4caf50", "#c9a227", "#4a8cf7", "#a05fd6", "#3fb9c4", "#c8c8c8",
  "#6b6b6b", "#ff6b6b", "#7ee787", "#f2cc60", "#79b8ff", "#d2a8ff", "#76e3ea", "#ffffff",
];

function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const lvl = [0, 95, 135, 175, 215, 255];
    const to = (v) => lvl[v].toString(16).padStart(2, "0");
    return `#${to(Math.floor(i / 36))}${to(Math.floor(i / 6) % 6)}${to(i % 6)}`;
  }
  const g = (8 + (n - 232) * 10).toString(16).padStart(2, "0");
  return `#${g}${g}${g}`;
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const src = readFileSync(0, "utf8").replace(/\r/g, "").replace(/\n$/, "");

function renderLine(row) {
  let fg = null;
  let bg = null;
  let bold = false;
  let dim = false;
  let inverse = false;
  let italic = false;
  let out = "";
  let buf = "";

  const flush = () => {
    if (!buf) return;
    let f = fg ?? FG;
    let b = bg;
    if (inverse) {
      const nf = b ?? BG;
      b = f;
      f = nf;
    }
    const decls = [`color:${f}`];
    if (b) decls.push(`background:${b}`);
    if (bold) decls.push("font-weight:700");
    if (italic) decls.push("font-style:italic");
    if (dim) decls.push("opacity:.55");
    out += `<span style="${decls.join(";")}">${esc(buf)}</span>`;
    buf = "";
  };

  // Text is emitted with the style in effect when it was read, so every SGR
  // run must flush what came before it.
  const parts = row.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      buf += parts[i]
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      continue;
    }
    flush();
    const codes = parts[i].split(";").filter((c) => c !== "");
    if (codes.length === 0) codes.push("0");
    for (let j = 0; j < codes.length; j++) {
      const c = Number(codes[j]);
      if (c === 0) {
        fg = null; bg = null; bold = false; dim = false; inverse = false; italic = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 7) inverse = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 23) italic = false;
      else if (c === 27) inverse = false;
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (c >= 30 && c <= 37) fg = BASE16[c - 30];
      else if (c >= 90 && c <= 97) fg = BASE16[c - 90 + 8];
      else if (c >= 40 && c <= 47) bg = BASE16[c - 40];
      else if (c >= 100 && c <= 107) bg = BASE16[c - 100 + 8];
      else if ((c === 38 || c === 48) && codes[j + 1] === "5") {
        const col = xterm256(Number(codes[j + 2]));
        if (c === 38) fg = col; else bg = col;
        j += 2;
      } else if ((c === 38 || c === 48) && codes[j + 1] === "2") {
        const col = `rgb(${Number(codes[j + 2])},${Number(codes[j + 3])},${Number(codes[j + 4])})`;
        if (c === 38) fg = col; else bg = col;
        j += 4;
      }
    }
  }
  flush();
  return out || "&nbsp;";
}

const rows = src.split("\n");
const cols = Math.max(...rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, "").length));
const body = rows.map(renderLine).join("\n");

// Exact page box, so the screenshot needs no cropping.
// DejaVu Sans Mono advance = 1233/2048 em.
const CH = fontPx * (1233 / 2048);
const LH = Math.round(fontPx * 1.18);
// Chromium's screenshot viewport runs ~110px shorter than --window-size, so
// the page centers its window and carries slack rather than fitting exactly.
const W = Math.ceil(cols * CH) + 32 + 2 + 64;
const H = rows.length * LH + 31 + 30 + 2 + 240;
process.stderr.write(`${W}x${H}\n`);

process.stdout.write(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @font-face { font-family: "DejaVu Sans Mono"; src: local("DejaVu Sans Mono"); }
  html { height:100%; }
  body {
    margin:0; min-height:100vh; box-sizing:border-box;
    display:flex; align-items:center; justify-content:center; padding-top:110px;
    background:#06080b;
  }
  .wrap { display:inline-block; }
  .win {
    background:${BG};
    border:1px solid #21262d;
    border-radius:10px;
    box-shadow:0 18px 50px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4);
    overflow:hidden;
  }
  .bar {
    display:flex; align-items:center; gap:8px;
    padding:9px 13px;
    background:#161b22;
    border-bottom:1px solid #21262d;
  }
  .dot { width:11px; height:11px; border-radius:50%; display:block; }
  .t { font:12px/1 ui-sans-serif,system-ui,"DejaVu Sans",sans-serif; color:#7d8590; margin-left:8px; letter-spacing:.02em; }
  pre {
    margin:0; padding:14px 16px 16px;
    font-family:"DejaVu Sans Mono","Liberation Mono",monospace;
    font-size:${fontPx}px;
    line-height:${LH}px;
    color:${FG};
    white-space:pre;
    font-variant-ligatures:none;
    -webkit-font-smoothing:antialiased;
  }
</style>
<div class="wrap"><div class="win">
<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${esc(title)}</span></div>
<pre>${body}</pre>
</div></div>
`);
