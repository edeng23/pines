#!/usr/bin/env node
/**
 * Render the sidebar under each of the four folder layouts, side by side,
 * from one fixed forest — so the alternatives can be compared without a
 * daemon or real sessions, and the comparison can be pasted into a PR.
 *
 *   pnpm tsx scripts/folders-preview.ts               # all four
 *   pnpm tsx scripts/folders-preview.ts --ux drill    # one layout
 *   pnpm tsx scripts/folders-preview.ts --width 30 --height 22
 *   pnpm tsx scripts/folders-preview.ts --plain       # no colors
 *
 * Deterministic: fixed clock, fixed trees, fixed view state (drill inside
 * "work", tabs on "work", chips filtered to nothing).
 */
import {
  emptyFolderView,
  FOLDER_UX_INFO,
  FOLDER_UX_ORDER,
  folderKey,
  folderRows,
  scopeTrees,
  tabSpecs,
  type FolderUx,
  type FolderViewState,
} from "../src/client/forest/folders.js";
import { renderSidebar } from "../src/client/forest/sidebar.js";
import type { TreeSummary } from "../src/shared/types.js";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const MIN = 60_000;

interface Seed {
  id: string;
  name: string;
  folder: string | null;
  status?: TreeSummary["status"];
  seen?: boolean;
  live?: boolean;
  ageMin: number;
  cwd?: string;
}

function tree(s: Seed): TreeSummary {
  return {
    treeId: s.id,
    sessionPath: `/sessions/${s.id}.jsonl`,
    sessionId: s.id,
    name: s.name,
    cwd: s.cwd ?? "/home/dev/pines",
    parentSessionPath: null,
    status: s.status ?? "dormant",
    seen: s.seen ?? true,
    leafId: "leaf",
    nodeCount: 12,
    x: 0,
    y: 0,
    live: s.live ?? false,
    mtime: NOW - s.ageMin * MIN,
    folder: s.folder,
  };
}

const FOREST: TreeSummary[] = [
  tree({ id: "a1", name: "add oauth token refresh", folder: "work/auth", status: "waiting", seen: false, live: true, ageMin: 3 }),
  tree({ id: "a2", name: "audit the session cookies", folder: "work/auth", ageMin: 240 }),
  tree({ id: "p1", name: "profile the frame time", folder: "work/perf", status: "running", live: true, ageMin: 1 }),
  tree({ id: "p2", name: "memoize the layout pass", folder: "work/perf", ageMin: 95, cwd: "/home/dev/api-server" }),
  tree({ id: "w1", name: "migrate the sqlite schema", folder: "work", status: "waiting", seen: true, live: true, ageMin: 30 }),
  tree({ id: "s1", name: "write docs for the wire pro…", folder: "side", ageMin: 1500, cwd: "/home/dev/website" }),
  tree({ id: "s2", name: "add usage examples", folder: "side", status: "crashed", seen: false, ageMin: 45, cwd: "/home/dev/website" }),
  tree({ id: "u1", name: "review this diff", folder: null, status: "running", live: true, ageMin: 8 }),
  tree({ id: "u2", name: "hi", folder: null, ageMin: 3000, cwd: "/home/dev/infra" }),
];

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const WIDTH = Number(opt("width") ?? 34);
const HEIGHT = Number(opt("height") ?? 18);
const PLAIN = args.includes("--plain");
const only = opt("ux");

function viewFor(ux: FolderUx): FolderViewState {
  const st = emptyFolderView(ux);
  if (ux === "drill") st.cwd = "work";
  if (ux === "tabs") st.tab = "work";
  return st;
}

function renderOne(ux: FolderUx): string[] {
  const st = viewFor(ux);
  const scoped = scopeTrees(FOREST, st);
  const rows = folderRows(scoped, st);
  const out = renderSidebar({
    trees: new Map(scoped.map((t) => [t.treeId, t])),
    rows,
    selectedId: "a1",
    selectedKey: ux === "tree" ? folderKey("work/perf") : null,
    width: WIDTH,
    height: HEIGHT,
    scroll: 0,
    spinnerFrame: 0,
    now: NOW,
    tabs: ux === "tabs" ? { specs: tabSpecs(FOREST), active: st.tab } : undefined,
  });
  const info = FOLDER_UX_INFO[ux];
  const title = ` ${FOLDER_UX_ORDER.indexOf(ux) + 1}. ${info.title}`.padEnd(WIDTH);
  const blurb = ` ${info.blurb}`.slice(0, WIDTH).padEnd(WIDTH);
  const lines = [
    `\x1b[1m${title}\x1b[0m`,
    `\x1b[2m${blurb}\x1b[0m`,
    "─".repeat(WIDTH),
    ...out.lines,
  ];
  return PLAIN ? lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")) : lines;
}

const uxes = only ? [only as FolderUx] : [...FOLDER_UX_ORDER];
const panes = uxes.map(renderOne);
const h = Math.max(...panes.map((p) => p.length));
const outLines: string[] = [];
for (let i = 0; i < h; i++) {
  outLines.push(panes.map((p) => p[i] ?? " ".repeat(WIDTH)).join(PLAIN ? " │ " : " \x1b[2m│\x1b[0m "));
}
process.stdout.write(outLines.join("\n") + "\n");
