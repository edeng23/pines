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
import { clipAnsi, visibleLength } from "../ansi.js";
import { statusGlyph, statusSgr } from "./status.js";
import { MASCOT, WORDMARK, WORDMARK_SGR } from "./wordmark.js";
import { MUTED } from "../theme.js";

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
  kind: "header" | "tree";
  treeId?: string;
  label?: string;
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
    rows.push({ kind: "header", label });
    for (const t of group) rows.push({ kind: "tree", treeId: t.treeId });
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
} {
  const { trees, rows, selectedId, width, height, scroll, spinnerFrame, now } = input;
  const lines: string[] = [];
  const lineToTree: (string | null)[] = [];

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
    for (let i = 0; i < headerH; i++) lineToTree.push(null);
  }
  const listH = height - headerH;

  if (rows.length === 0) {
    lines.push(pad(""), pad(` \x1b[${MUTED}m(no trees yet)\x1b[0m`));
    lineToTree.push(null, null);
  }

  for (let i = scroll; i < Math.min(rows.length, scroll + listH); i++) {
    const row = rows[i]!;
    if (row.kind === "header") {
      lines.push(pad(` \x1b[${MUTED}m${row.label}\x1b[0m`));
      lineToTree.push(null);
      continue;
    }
    const t = trees.get(row.treeId!);
    if (!t) {
      lines.push(pad(""));
      lineToTree.push(null);
      continue;
    }
    const selected = t.treeId === selectedId;
    const glyph = statusGlyph(t, spinnerFrame);
    const sgr = statusSgr(t);
    const age = humanAge(t.mtime, now);
    const { title, fallback } = treeTitle(t);
    // ` ✻ title…… dir 12m ` — title flexes; the directory is a light label
    // (Claude Agents keeps cwd as metadata, never the name).
    // The row template costs exactly 5 cells of chrome (edges, glyph, gaps):
    // reserve no more than that, every spare cell belongs to the title.
    const avail = Math.max(4, width - 5 - age.length);
    let dirChip = width >= 32 && t.name && t.cwd ? basename(t.cwd).slice(0, 10) : "";
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
        ` \x1b[${sgr}m${glyph}\x1b[0m \x1b[${nameSgr}m${shownName}\x1b[0m ${chip}\x1b[${MUTED}m${age}\x1b[0m `,
      ),
    );
    lineToTree.push(t.treeId);
  }

  while (lines.length < height) {
    lines.push(pad(""));
    lineToTree.push(null);
  }
  return { lines, lineToTree };
}

/** Clamp scroll so the selected row stays visible. */
export function sidebarScrollTo(
  rows: SidebarRow[],
  selectedId: string | null,
  scroll: number,
  height: number,
): number {
  if (!selectedId) return Math.max(0, Math.min(scroll, rows.length - height));
  const idx = rows.findIndex((r) => r.treeId === selectedId);
  if (idx < 0) return scroll;
  // Keep the group header above the selection visible when it's adjacent.
  const top = idx > 0 && rows[idx - 1]!.kind === "header" ? idx - 1 : idx;
  if (top < scroll) return top;
  if (idx >= scroll + height) return idx - height + 1;
  return scroll;
}
