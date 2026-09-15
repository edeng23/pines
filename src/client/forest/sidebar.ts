/**
 * Agents-style sidebar: a linear, state-grouped list of every tree — the
 * triage inbox beside the spatial forest. Modeled on Claude Code's agents
 * view: groups by state first (needs input → working → recent), recency
 * within each group, one row per tree with status glyph, name, and age.
 *
 * Pure rendering: callers own selection, scrolling, and sizing.
 */
import { basename } from "node:path";
import type { TreeSummary } from "../../shared/types.js";
import { rowChip } from "../../shared/folders.js";
import { clipAnsi, visibleLength } from "../ansi.js";
import { statusGlyph, statusSgr } from "./status.js";
import { MASCOT, WORDMARK, WORDMARK_SGR } from "./wordmark.js";
import { FAINT, MUTED } from "../theme.js";

/**
 * Display title for a tree: its name (session name or derived first prompt);
 * before any prompt exists, the directory basename as a placeholder; the raw
 * id only as a last resort. `fallback` tells callers to render it lighter.
 */
export function treeTitle(t: TreeSummary): { title: string; fallback: boolean } {
  if (t.name) return { title: t.name, fallback: false };
  if (t.cwd) return { title: basename(t.cwd), fallback: true };
  return { title: t.treeId, fallback: true };
}

export interface SidebarRow {
  /**
   * header: a muted group caption · tree: one conversation · folder: a
   * selectable folder line · up: "back out of this folder" (drill) · tabs:
   * the folder tab strip (tabs).
   */
  kind: "header" | "tree" | "folder" | "up" | "tabs";
  treeId?: string;
  label?: string;
  /** folder/up/header rows: the folder path this row stands for (up: parent). */
  folder?: string | null;
  /** Indent level (tree layout nests trees under their folder). */
  depth?: number;
  /** folder rows: folded shut (children hidden) — or, in drill, "enterable". */
  collapsed?: boolean;
  count?: number;
  attention?: number;
  working?: number;
  /** tree rows: right-hand chip text (folder or directory); undefined = dir. */
  chip?: string;
}

/** One tab of the tabs layout's strip. */
export interface TabSpec {
  label: string;
  /** null = all. */
  tab: string | null;
  attention: number;
  working: number;
}

/**
 * One predicate for "this tree wants the user's eyes", shared by the
 * needs-input group and the header's ● counter so they can never disagree.
 * Dormant belongs here: an unseen result whose agent was LRU-evicted (or
 * died with the daemon) is still a result waiting on the user — the process
 * died, the notification must not.
 */
export function needsAttention(t: TreeSummary): boolean {
  return !t.seen && (t.status === "waiting" || t.status === "crashed" || t.status === "dormant");
}

/**
 * Group and order the forest for the list: trees needing attention first
 * (waiting-unseen and crashed-unseen), then live working trees, then
 * everything else — each group ordered by last interaction, newest first.
 * Archived trees (only present when the caller chooses to show them) sit in
 * their own group at the bottom regardless of status.
 */
export function sidebarRows(trees: TreeSummary[]): SidebarRow[] {
  return stateGroupRows(trees);
}

/**
 * The state grouping as rows, reusable under any folder layout. `headers`
 * off drops the captions (a folder section already names the group);
 * `chipBase` decides what the rows' chips say — a folder relative to the
 * one in view, else the directory (see rowChip).
 */
export function stateGroupRows(
  trees: TreeSummary[],
  opts: { headers?: boolean; chipBase?: string | null; depth?: number } = {},
): SidebarRow[] {
  const needsInput: TreeSummary[] = [];
  const working: TreeSummary[] = [];
  const recent: TreeSummary[] = [];
  const archived: TreeSummary[] = [];
  for (const t of trees) {
    if (t.archived) archived.push(t);
    else if (needsAttention(t)) needsInput.push(t);
    else if (t.status === "running") working.push(t);
    else recent.push(t);
  }
  const byRecency = (a: TreeSummary, b: TreeSummary) => b.mtime - a.mtime;
  needsInput.sort(byRecency);
  working.sort(byRecency);
  recent.sort(byRecency);
  archived.sort(byRecency);

  const rows: SidebarRow[] = [];
  const push = (label: string, group: TreeSummary[]) => {
    if (group.length === 0) return;
    if (opts.headers !== false) rows.push({ kind: "header", label });
    for (const t of group) {
      rows.push({
        kind: "tree",
        treeId: t.treeId,
        depth: opts.depth,
        chip: opts.chipBase === undefined ? undefined : rowChip(t, opts.chipBase),
      });
    }
  };
  push("needs input", needsInput);
  push("working", working);
  push("recent", recent);
  push("archived", archived);
  return rows;
}

/** Tree ids in list order (selection stepping). */
export function sidebarOrder(rows: SidebarRow[]): string[] {
  return rows.filter((r) => r.kind === "tree").map((r) => r.treeId!);
}

/** Compact age like Claude Agents: 45s, 12m, 3h, 5d. */
export function humanAge(mtime: number, now: number): string {
  const s = Math.max(0, Math.floor((now - mtime) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface SidebarRenderInput {
  trees: Map<string, TreeSummary>;
  rows: SidebarRow[];
  selectedId: string | null;
  width: number;
  height: number;
  scroll: number;
  spinnerFrame: number;
  now: number;
  /** When present, a mascot header (pine + name/version/status) tops the list. */
  brand?: { version: string; pi: string; home: string };
  /**
   * Selected folder key ("folder:<path>") when the cursor sits on a folder
   * row instead of a tree; wins over selectedId for highlighting.
   */
  selectedKey?: string | null;
  /** tabs layout: the strip's tabs and which is active. */
  tabs?: { specs: TabSpec[]; active: string | null };
}

/** Cell spans of the tab strip, for click-to-switch. */
export interface TabSpan {
  x0: number;
  x1: number;
  tab: string | null;
}

/**
 * Render the tab strip on one line: ` all │ work●2 │ side ` with the active
 * tab inverted. Returns the line (unpadded) and each tab's cell span.
 */
export function renderTabStrip(
  specs: TabSpec[],
  active: string | null,
  width: number,
): { line: string; spans: TabSpan[] } {
  let line = " ";
  let x = 1;
  const spans: TabSpan[] = [];
  specs.forEach((s, i) => {
    if (i > 0) {
      line += `\x1b[${FAINT}m│\x1b[0m`;
      x += 1;
    }
    const dot = s.attention > 0 ? `●${s.attention}` : s.working > 0 ? `◐${s.working}` : "";
    const text = ` ${s.label}${dot} `;
    const isActive = s.tab === active;
    const dotSgr = s.attention > 0 ? "1;38;5;44" : "33";
    const body = isActive
      ? `\x1b[7m${text}\x1b[0m`
      : `\x1b[0m ${s.label}${dot ? `\x1b[${dotSgr}m${dot}\x1b[0m` : ""} `;
    spans.push({ x0: x, x1: x + text.length - 1, tab: s.tab });
    line += body;
    x += text.length;
  });
  if (x > width) line = clipAnsi(line, width);
  return { line, spans };
}

/** Rows the mascot header consumes (0 when it doesn't fit or isn't wanted). */
export function sidebarHeaderH(input: {
  brand?: unknown;
  width: number;
  height: number;
}): number {
  return input.brand && input.height >= 16 && input.width >= 30 ? 6 : 0;
}

/**
 * Render the sidebar as `height` lines of exactly `width` visible columns.
 * Returns the lines plus a per-line map to tree ids (mouse hit-testing).
 */
export function renderSidebar(input: SidebarRenderInput): {
  lines: string[];
  lineToTree: (string | null)[];
  /** Per-line row (folder/up/tabs rows are click targets too). */
  lineToRow: (SidebarRow | null)[];
  /** Cell spans of the tab strip, when one was drawn. */
  tabSpans: TabSpan[];
  /** Screen line of the tab strip, when one was drawn. */
  tabLine: number | null;
} {
  const { trees, rows, selectedId, width, height, scroll, spinnerFrame, now } = input;
  const lines: string[] = [];
  const lineToTree: (string | null)[] = [];
  const lineToRow: (SidebarRow | null)[] = [];
  let tabSpans: TabSpan[] = [];
  let tabLine: number | null = null;
  const selectedFolder = input.selectedKey?.startsWith("folder:")
    ? input.selectedKey.slice("folder:".length)
    : null;

  const pad = (s: string) => {
    const clipped = clipAnsi(s, width);
    return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
  };

  // Mascot header: the pine and the canopy-gradient wordmark, with live
  // counts — the same at-a-glance block Claude Agents keeps in its top-left.
  const headerH = sidebarHeaderH(input);
  if (headerH > 0 && input.brand) {
    const b = input.brand;
    let unseen = 0;
    let running = 0;
    for (const t of trees.values()) {
      if (needsAttention(t)) unseen++;
      if (t.status === "running") running++;
    }
    const counts = [
      unseen > 0 ? `\x1b[1;38;5;44m●${unseen}\x1b[0m` : "",
      running > 0 ? `\x1b[33m◐${running}\x1b[0m` : "",
      `\x1b[${MUTED}m${trees.size} tree${trees.size === 1 ? "" : "s"}\x1b[0m`,
    ]
      .filter(Boolean)
      .join(`\x1b[${MUTED}m · \x1b[0m`);
    const G = (s: string, c: string) => `\x1b[${c}m${s}\x1b[0m`;
    const mast = (i: number) => G(MASCOT[i]![0], MASCOT[i]![1]);
    const mark = (i: number) => G(WORDMARK[i]!, WORDMARK_SGR[i]!);
    lines.push(
      pad(` ${mast(0)}   ${mark(0)}`),
      pad(` ${mast(1)}  ${mark(1)}`),
      pad(` ${mast(2)} ${mark(2)}`),
      pad(` ${mast(3)}   \x1b[${MUTED}mv${b.version} · pi ${b.pi}\x1b[0m`),
      pad(` ${counts}`),
      pad(""),
    );
    for (let i = 0; i < headerH; i++) {
      lineToTree.push(null);
      lineToRow.push(null);
    }
  }
  const listH = height - headerH;

  if (rows.length === 0) {
    lines.push(pad(""), pad(` \x1b[${MUTED}m(no trees yet)\x1b[0m`));
    lineToTree.push(null, null);
    lineToRow.push(null, null);
  }

  for (let i = scroll; i < Math.min(rows.length, scroll + listH); i++) {
    const row = rows[i]!;
    if (row.kind === "header") {
      lines.push(pad(` \x1b[${MUTED}m${row.label}\x1b[0m`));
      lineToTree.push(null);
      lineToRow.push(row);
      continue;
    }
    if (row.kind === "tabs") {
      const strip = renderTabStrip(input.tabs?.specs ?? [], input.tabs?.active ?? null, width);
      tabSpans = strip.spans;
      tabLine = lines.length;
      lines.push(pad(strip.line));
      lineToTree.push(null);
      lineToRow.push(row);
      continue;
    }
    if (row.kind === "up") {
      const target = row.folder ?? "top level";
      lines.push(pad(` \x1b[${MUTED}m◂ ..  ${truncate(target, width - 8)}\x1b[0m`));
      lineToTree.push(null);
      lineToRow.push(row);
      continue;
    }
    if (row.kind === "folder") {
      // ` ▾ work            ●2 ◐1 7 ` — the caret says folded/open (or, in
      // drill, "enterable"); counts on the right mirror the header's.
      const selected = row.folder === selectedFolder;
      const indent = " ".repeat(row.depth ?? 0);
      const caret = row.collapsed ? "▸" : "▾";
      const counts = [
        row.attention ? `\x1b[1;38;5;44m●${row.attention}\x1b[0m` : "",
        row.working ? `\x1b[33m◐${row.working}\x1b[0m` : "",
        `\x1b[${MUTED}m${row.count ?? 0}\x1b[0m`,
      ]
        .filter(Boolean)
        .join(" ");
      const countsW = visibleLength(counts);
      const nameW = Math.max(4, width - 5 - indent.length - countsW);
      const name = truncate(row.label ?? row.folder ?? "", nameW).padEnd(nameW);
      const nameSgr = selected ? "7" : "1";
      lines.push(
        pad(` ${indent}\x1b[${MUTED}m${caret}\x1b[0m \x1b[${nameSgr}m${name}\x1b[0m ${counts} `),
      );
      lineToTree.push(null);
      lineToRow.push(row);
      continue;
    }
    const t = trees.get(row.treeId!);
    if (!t) {
      lines.push(pad(""));
      lineToTree.push(null);
      lineToRow.push(null);
      continue;
    }
    const selected = t.treeId === selectedId && !selectedFolder;
    const glyph = statusGlyph(t, spinnerFrame);
    const sgr = statusSgr(t);
    const age = humanAge(t.mtime, now);
    const { title, fallback } = treeTitle(t);
    const indent = " ".repeat(row.depth ?? 0);
    // ` ✻ title…… dir 12m ` — title flexes; the directory is a light label
    // (Claude Agents keeps cwd as metadata, never the name).
    // The row template costs exactly 5 cells of chrome (edges, glyph, gaps):
    // reserve no more than that, every spare cell belongs to the title.
    const avail = Math.max(4, width - 5 - age.length - indent.length);
    // The chip: the folder when the layout shows folders as chips, else
    // the directory — either way garnish, never at the title's expense.
    const chipText = row.chip ?? (t.cwd ? basename(t.cwd) : "");
    let dirChip = width >= 32 && t.name && chipText ? chipText.slice(0, 10) : "";
    // The title is the information; the chip is garnish. A title that would
    // be cropped to make room for the chip wins the space instead.
    if (dirChip && title.length > avail - (dirChip.length + 1)) dirChip = "";
    const chipW = dirChip ? dirChip.length + 1 : 0;
    const nameW = Math.max(4, avail - chipW);
    const shownName = title.length > nameW ? title.slice(0, nameW - 1) + "…" : title.padEnd(nameW);
    const nameSgr = selected ? "7" : fallback ? MUTED : t.seen ? "0" : "1";
    const chip = dirChip ? `\x1b[${MUTED}m${dirChip}\x1b[0m ` : "";
    lines.push(
      pad(
        ` ${indent}\x1b[${sgr}m${glyph}\x1b[0m \x1b[${nameSgr}m${shownName}\x1b[0m ${chip}\x1b[${MUTED}m${age}\x1b[0m `,
      ),
    );
    lineToTree.push(t.treeId);
    lineToRow.push(row);
  }

  while (lines.length < height) {
    lines.push(pad(""));
    lineToTree.push(null);
    lineToRow.push(null);
  }
  return { lines, lineToTree, lineToRow, tabSpans, tabLine };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Clamp scroll so the selected row stays visible. `selectedId` is a tree id
 * or a folder key ("folder:<path>") — whichever row the cursor is on.
 */
export function sidebarScrollTo(
  rows: SidebarRow[],
  selectedId: string | null,
  scroll: number,
  height: number,
): number {
  if (!selectedId) return Math.max(0, Math.min(scroll, rows.length - height));
  const folder = selectedId.startsWith("folder:") ? selectedId.slice("folder:".length) : null;
  const idx = rows.findIndex((r) =>
    folder !== null ? r.kind === "folder" && r.folder === folder : r.kind === "tree" && r.treeId === selectedId,
  );
  if (idx < 0) return scroll;
  // Keep the group header above the selection visible when it's adjacent.
  const top = idx > 0 && rows[idx - 1]!.kind === "header" ? idx - 1 : idx;
  if (top < scroll) return top;
  if (idx >= scroll + height) return idx - height + 1;
  return scroll;
}
