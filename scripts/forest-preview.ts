#!/usr/bin/env node
/**
 * Render the forest against a set of fixed scenarios, so layout and drawing
 * changes can be reviewed without a daemon, a terminal size, or real sessions.
 *
 *   pnpm tsx scripts/forest-preview.ts --list              # scenarios
 *   pnpm tsx scripts/forest-preview.ts                     # every scenario
 *   pnpm tsx scripts/forest-preview.ts --scenario busy     # one scenario
 *   pnpm tsx scripts/forest-preview.ts --html forest.html  # side-by-side page
 *   pnpm tsx scripts/forest-preview.ts --json panes.json   # panes as HTML fragments
 *
 * Everything here is deterministic — fixed clock, fixed prompts, positions
 * from the same lexical layout + relax the daemon uses — so two runs differ
 * only when the drawing changed, and re-running never reshuffles the forest.
 */
import { writeFileSync } from "node:fs";
import { Canvas } from "../src/client/forest/canvas.js";
import { renderForest } from "../src/client/forest/view.js";
import { fitCamera, worldToCell, type Viewport } from "../src/client/forest/camera.js";
import { assignLexicalPositions } from "../src/layout/lexical.js";
import { relax } from "../src/layout/relax.js";
import type { Camera, TreeSummary } from "../src/shared/types.js";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

/**
 * Session names are the first user message, whitespace-collapsed and clipped
 * by the daemon — prompts, not slugs. Previews use real-shaped ones.
 */
const PROMPTS = [
  "add oauth token refresh",
  "the login flow returns 401 …",
  "audit the session cookies",
  "why is the canvas redrawing …",
  "profile the frame time",
  "memoize the layout pass",
  "write docs for the wire pro…",
  "add usage examples",
  "migrate the sqlite schema",
  "index user messages for sea…",
  "backfill embeddings",
  "extract the tokenizer",
  "the daemon leaks pty handles",
  "make the sidebar resizable",
  "add a --json flag",
  "review this diff",
  "ship it",
  "refactor the parser module",
  "fix the failing auth tests",
  "hi",
];

const REPOS = ["/home/dev/pines", "/home/dev/api-server", "/home/dev/website", "/home/dev/infra"];

interface Seed {
  id: string;
  name: string;
  status: TreeSummary["status"];
  seen: boolean;
  live: boolean;
  nodes: number;
  ageMin: number;
  cwd: string;
  parent?: string;
  x?: number;
  y?: number;
}

function tree(s: Seed): TreeSummary {
  return {
    treeId: s.id,
    sessionPath: `/sessions/${s.id}.jsonl`,
    sessionId: s.id,
    name: s.name,
    cwd: s.cwd,
    parentSessionPath: s.parent ? `/sessions/${s.parent}.jsonl` : null,
    status: s.status,
    seen: s.seen,
    leafId: "leaf",
    nodeCount: s.nodes,
    x: s.x ?? 0,
    y: s.y ?? 0,
    live: s.live,
    mtime: NOW - s.ageMin * 60_000,
  };
}

/** The hand-placed forest most scenarios use: three projects, mixed states. */
const WORKING: Seed[] = [
  { id: "auth", name: PROMPTS[0]!, x: -8.6, y: -4.0, status: "running", seen: true, live: true, nodes: 46, ageMin: 1, cwd: REPOS[0]! },
  { id: "login", name: PROMPTS[1]!, x: -4.6, y: -1.1, status: "waiting", seen: false, live: true, nodes: 18, ageMin: 4, cwd: REPOS[0]!, parent: "auth" },
  { id: "cookies", name: PROMPTS[2]!, x: -8.6, y: 1.7, status: "dormant", seen: true, live: false, nodes: 9, ageMin: 320, cwd: REPOS[0]!, parent: "auth" },
  { id: "perf", name: PROMPTS[3]!, x: 1.9, y: -5.2, status: "running", seen: true, live: true, nodes: 63, ageMin: 2, cwd: REPOS[1]! },
  { id: "frame", name: PROMPTS[4]!, x: 4.8, y: -2.6, status: "waiting", seen: true, live: true, nodes: 24, ageMin: 26, cwd: REPOS[1]!, parent: "perf" },
  { id: "memo", name: PROMPTS[5]!, x: 2.4, y: 0.4, status: "completed", seen: true, live: false, nodes: 31, ageMin: 90, cwd: REPOS[1]!, parent: "perf" },
  { id: "docs", name: PROMPTS[6]!, x: 8.9, y: 2.2, status: "dormant", seen: true, live: false, nodes: 12, ageMin: 1500, cwd: REPOS[2]! },
  { id: "readme", name: PROMPTS[7]!, x: 6.4, y: 4.3, status: "waiting", seen: false, live: true, nodes: 6, ageMin: 8, cwd: REPOS[2]! },
  { id: "schema", name: PROMPTS[8]!, x: -2.8, y: 3.6, status: "crashed", seen: false, live: false, nodes: 21, ageMin: 47, cwd: REPOS[1]! },
  { id: "fts", name: PROMPTS[9]!, x: -6.4, y: 5.1, status: "completed", seen: true, live: false, nodes: 15, ageMin: 210, cwd: REPOS[1]!, parent: "schema" },
  { id: "backfill", name: PROMPTS[10]!, x: 0.2, y: 5.8, status: "dormant", seen: true, live: false, nodes: 40, ageMin: 2600, cwd: REPOS[1]! },
  { id: "tokenizer", name: PROMPTS[11]!, x: 9.6, y: -4.6, status: "dormant", seen: true, live: false, nodes: 7, ageMin: 4300, cwd: REPOS[2]! },
];

/** A grown forest, placed the way the daemon places one: cluster, then relax. */
function grownForest(count: number, repos: number): TreeSummary[] {
  const trees: TreeSummary[] = [];
  for (let i = 0; i < count; i++) {
    const status: TreeSummary["status"] =
      i === 0 || i === 6 ? "running"
      : i === 1 || i === 9 ? "waiting"
      : i === 4 ? "crashed"
      : i % 5 === 3 ? "completed"
      : "dormant";
    trees.push(
      tree({
        id: `g${i}`,
        name: PROMPTS[(i * 7) % PROMPTS.length]!,
        cwd: REPOS[i % repos]!,
        status,
        seen: !(i === 1 || i === 4 || i === 12),
        live: status === "running" || status === "waiting",
        nodes: [4, 12, 28, 60, 140, 9, 33, 17][i % 8]!,
        ageMin: (i + 1) * 13,
        parent: i % 6 === 4 ? `g${i - 3}` : undefined,
      }),
    );
  }
  assignLexicalPositions(trees);
  relax(trees, 3.6, 40);
  return trees;
}

/** A single lineage: one session that got branched three ways. */
function branchedForest(): TreeSummary[] {
  const seeds: Seed[] = [
    { id: "root", name: PROMPTS[18]!, x: 0, y: -3, status: "completed", seen: true, live: false, nodes: 52, ageMin: 180, cwd: REPOS[0]! },
    { id: "b1", name: "…try it without the mock", x: -6.5, y: 1, status: "running", seen: true, live: true, nodes: 22, ageMin: 3, cwd: REPOS[0]!, parent: "root" },
    { id: "b2", name: "…what if we cache the token", x: 0, y: 2.4, status: "waiting", seen: false, live: true, nodes: 14, ageMin: 6, cwd: REPOS[0]!, parent: "root" },
    { id: "b3", name: "…roll back and start over", x: 6.5, y: 1.2, status: "dormant", seen: true, live: false, nodes: 8, ageMin: 400, cwd: REPOS[0]!, parent: "root" },
    { id: "b2a", name: "…now add the refresh timer", x: 2.6, y: 6.2, status: "completed", seen: true, live: false, nodes: 11, ageMin: 60, cwd: REPOS[0]!, parent: "b2" },
  ];
  return seeds.map(tree);
}

/* ------------------------------- scenarios -------------------------------- */

export interface Scenario {
  id: string;
  /** Short title for the pane. */
  label: string;
  /** What this scenario puts under pressure. */
  blurb: string;
  trees: TreeSummary[];
  vp: Viewport;
  selectedId: string | null;
  /** Omit for zoom-to-fit — exactly what pressing `0` gives you. */
  zoom?: number;
}

const working = WORKING.map(tree);

export const SCENARIOS: Scenario[] = [
  {
    id: "working",
    label: "a working day",
    blurb: "twelve sessions across three projects — two agents running, two waiting on you",
    trees: working,
    vp: { width: 96, height: 24 },
    selectedId: "login",
  },
  {
    id: "quiet",
    label: "a quiet forest",
    blurb: "five sessions in one repo: the common case, and the one with room to breathe",
    trees: grownForest(5, 1),
    vp: { width: 96, height: 24 },
    selectedId: "g1",
  },
  {
    id: "busy",
    label: "a busy month",
    blurb: "forty sessions across four repos. Packed this tight only live and unseen work gets a name — zoom in and the rest come back",
    trees: grownForest(40, 4),
    vp: { width: 96, height: 26 },
    selectedId: "g1",
  },
  {
    id: "branches",
    label: "one session, branched",
    blurb: "a conversation branched three ways: lineage edges are the whole picture here",
    trees: branchedForest(),
    vp: { width: 96, height: 22 },
    selectedId: "b2",
  },
  {
    id: "narrow",
    label: "80-column terminal",
    blurb: "the working day again, in the 47 columns left over once the sidebar is open",
    trees: working,
    vp: { width: 47, height: 22 },
    selectedId: "login",
    zoom: 1.7,
  },
  {
    id: "structure",
    label: "zoomed in",
    blurb:
      "mid zoom, where each tree opens into the shape of its conversation — the trunk, the forks, the leaf carrying the status color",
    trees: branchedForest(),
    vp: { width: 96, height: 34 },
    selectedId: "b2",
    zoom: 5,
  },
  {
    id: "first-run",
    label: "first run",
    blurb: "a single session, freshly started — what a new user sees before anything else",
    trees: [working[1]!],
    vp: { width: 96, height: 18 },
    selectedId: "login",
    zoom: 8,
  },
];

function cameraFor(sc: Scenario): Camera {
  // Zoom-to-fit unless the scenario is specifically about another zoom level.
  return sc.zoom ? { ...fitCamera(sc.trees, sc.vp), zoom: sc.zoom } : fitCamera(sc.trees, sc.vp);
}

function frame(sc: Scenario): string[] {
  const canvas = new Canvas(sc.vp.width, sc.vp.height);
  const camera = cameraFor(sc);
  renderForest(canvas, {
    trees: sc.trees,
    camera,
    vp: sc.vp,
    selectedId: sc.selectedId,
    spinnerFrame: 1,
  });
  return canvas.render();
}

/* ------------------------------ ANSI → HTML ------------------------------- */

function xterm256(n: number): string {
  if (n < 16) {
    const base = [
      "#000000", "#cc4444", "#4caf50", "#c9a227", "#4a8cf7", "#a05fd6", "#3fb9c4", "#c8c8c8",
      "#6b6b6b", "#ff6b6b", "#7ee787", "#f2cc60", "#79b8ff", "#d2a8ff", "#76e3ea", "#ffffff",
    ];
    return base[n]!;
  }
  if (n < 232) {
    const i = n - 16;
    const lvl = [0, 95, 135, 175, 215, 255];
    const to = (v: number) => lvl[v]!.toString(16).padStart(2, "0");
    return `#${to(Math.floor(i / 36))}${to(Math.floor(i / 6) % 6)}${to(i % 6)}`;
  }
  const g = (8 + (n - 232) * 10).toString(16).padStart(2, "0");
  return `#${g}${g}${g}`;
}

const BG = "#0d1117";
const FG = "#d5dae1";

interface Cell {
  ch: string;
  fg: string;
  bold: boolean;
  inverse: boolean;
}

/** Parse a rendered frame into a styled cell grid. */
function toCells(rows: string[]): Cell[][] {
  return rows.map((row) => {
    const cells: Cell[] = [];
    let fg = FG;
    let bold = false;
    let inverse = false;
    const parts = row.split(/\x1b\[([0-9;]*)m/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        for (const ch of parts[i]!) cells.push({ ch, fg, bold, inverse });
        continue;
      }
      const codes = parts[i]!.split(";").filter((c) => c !== "");
      for (let j = 0; j < codes.length; j++) {
        const code = Number(codes[j]);
        if (code === 0) {
          fg = FG;
          bold = false;
          inverse = false;
        } else if (code === 1) bold = true;
        else if (code === 7) inverse = true;
        else if (code === 38 && codes[j + 1] === "5") {
          fg = xterm256(Number(codes[j + 2]));
          j += 2;
        } else if (code >= 30 && code <= 37) fg = xterm256(code - 30);
        else if (code >= 90 && code <= 97) fg = xterm256(code - 90 + 8);
      }
    }
    return cells;
  });
}

interface Bounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/**
 * The box worth showing: where the trees actually are, plus room for their
 * names. Derived from tree positions rather than from ink, so the graph-paper
 * backdrop never inflates the crop and every pane shows the same window.
 */
function treeBounds(sc: Scenario): Bounds {
  const camera = cameraFor(sc);
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (const t of sc.trees) {
    const p = worldToCell(camera, sc.vp, t.x, t.y);
    r0 = Math.min(r0, p.y);
    r1 = Math.max(r1, p.y);
    c0 = Math.min(c0, p.x);
    // Names run to the right of the marker; mid zoom adds the mini's width.
    c1 = Math.max(c1, p.x + Math.min((t.name ?? "").length + 4, 24));
  }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // Past the semantic-zoom threshold a tree is a whole mini, not a glyph, so
  // the window has to open up around its center.
  const mid = camera.zoom >= 3;
  const padY = mid ? 9 : 3;
  return {
    r0: clamp(Math.round(r0) - padY, 0, sc.vp.height - 1),
    r1: clamp(Math.round(r1) + padY, 0, sc.vp.height - 1),
    c0: clamp(Math.round(c0) - (mid ? 8 : 4), 0, sc.vp.width - 1),
    c1: clamp(Math.round(c1) + (mid ? 8 : 2), 0, sc.vp.width - 1),
  };
}

function cellsToHtml(grid: Cell[][], b: Bounds): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [];
  for (let r = b.r0; r <= b.r1; r++) {
    const row = grid[r] ?? [];
    let line = "";
    let run = "";
    let cur: Cell | null = null;
    const flush = () => {
      if (!run || !cur) return;
      const fg = cur.inverse ? BG : cur.fg;
      const bg = cur.inverse ? cur.fg : null;
      line += `<span style="color:${fg}${bg ? `;background:${bg}` : ""}${cur.bold ? ";font-weight:700" : ""}">${esc(run)}</span>`;
      run = "";
    };
    for (let c = b.c0; c <= b.c1; c++) {
      const cell = row[c] ?? { ch: " ", fg: FG, bold: false, inverse: false };
      if (!cur || cell.fg !== cur.fg || cell.bold !== cur.bold || cell.inverse !== cur.inverse) {
        flush();
        cur = cell;
      }
      run += cell.ch;
    }
    flush();
    out.push(line || "&nbsp;");
  }
  return out.join("\n");
}

/** Render one scenario, cropped to its content box. */
function scenarioPane(sc: Scenario): string {
  return cellsToHtml(toCells(frame(sc)), treeBounds(sc));
}

/** Every pane, keyed by scenario, for embedding in a page of your own. */
function panesJson(): string {
  const panes: Record<string, string> = {};
  const dims: Record<string, { cols: number; rows: number }> = {};
  for (const sc of SCENARIOS) {
    const pane = scenarioPane(sc);
    panes[sc.id] = pane;
    dims[sc.id] = {
      cols: Math.max(...pane.split("\n").map((l) => l.replace(/<[^>]*>/g, "").length)),
      rows: pane.split("\n").length,
    };
  }
  return JSON.stringify(
    {
      scenarios: SCENARIOS.map((sc) => ({
        id: sc.id,
        label: sc.label,
        blurb: sc.blurb,
        cols: sc.vp.width,
        rows: sc.vp.height,
        trees: sc.trees.length,
        crop: dims[sc.id],
      })),
      panes,
    },
    null,
    2,
  );
}

function html(): string {
  const blocks = SCENARIOS.map(
    (sc) =>
      `<section><h2>${sc.label}</h2><p>${sc.blurb}</p><figure><pre>${scenarioPane(sc)}</pre></figure></section>`,
  ).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>pines · forest</title>
<style>
 body{background:${BG};color:${FG};font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:32px}
 h1{font-size:20px;font-weight:600}
 h2{font-size:16px;margin:36px 0 2px;text-transform:lowercase}
 p{color:#8b949e;margin:0 0 12px}
 pre{font:12px/1.15 ui-monospace,SFMono-Regular,Menlo,monospace;background:${BG};border:1px solid #21262d;border-radius:8px;padding:12px;overflow-x:auto}
 figure{margin:0}
</style>
<h1>pines · forest</h1>
${blocks}`;
}

/* --------------------------------- main ----------------------------------- */

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const htmlOut = flag("html");
const jsonOut = flag("json");
const onlyScenario = flag("scenario");

if (argv.includes("--list")) {
  process.stdout.write("scenarios:\n");
  for (const sc of SCENARIOS) {
    process.stdout.write(
      `  ${sc.id.padEnd(11)} ${`${sc.vp.width}×${sc.vp.height}`.padEnd(7)} ${sc.trees.length
        .toString()
        .padStart(2)} trees  ${sc.blurb}\n`,
    );
  }
} else if (jsonOut) {
  writeFileSync(jsonOut, panesJson());
  process.stdout.write(`wrote ${jsonOut}\n`);
} else if (htmlOut) {
  writeFileSync(htmlOut, html());
  process.stdout.write(`wrote ${htmlOut}\n`);
} else {
  const scenarios = onlyScenario
    ? SCENARIOS.filter((sc) => sc.id === onlyScenario)
    : SCENARIOS;
  for (const sc of scenarios) {
    process.stdout.write(`\n\x1b[1m${sc.label}\x1b[0m \x1b[2m— ${sc.blurb}\x1b[0m\n`);
    process.stdout.write(frame(sc).join("\n") + "\n");
  }
}
