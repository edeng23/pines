/**
 * Folders in the sidebar — four interchangeable UX treatments of the same
 * data (a `folder` path on each tree), so the right one can be picked by
 * living with each for a while. `F` cycles them at runtime.
 *
 *   tree   collapsible folder sections, nested by path — the explorer.
 *   drill  one level at a time with a breadcrumb — the file manager.
 *   tabs   a workspace strip, one folder in view at a time — tmux/zellij.
 *   chips  the flat triage list stays; folders are chips plus a filter.
 *
 * Everything here is pure: rows in, rows out. The app owns the view state
 * (which folder is open, collapsed, filtered) and the cursor.
 */
import type { TreeSummary } from "../../shared/types.js";
import {
  folderAncestors,
  folderName,
  folderParent,
  inFolder,
  normalizeFolder,
  UNFILED_TAB,
} from "../../shared/folders.js";
import { needsAttention, stateGroupRows, type SidebarRow, type TabSpec } from "./sidebar.js";

export { UNFILED_TAB };

export type FolderUx = "tree" | "drill" | "tabs" | "chips";

export const FOLDER_UX_ORDER: readonly FolderUx[] = ["tree", "drill", "tabs", "chips"];

export const FOLDER_UX_INFO: Record<FolderUx, { title: string; blurb: string; hint: string }> = {
  tree: {
    title: "tree",
    blurb: "collapsible folder sections (f/← fold · → unfold)",
    hint: "f fold",
  },
  drill: {
    title: "drill",
    blurb: "one level at a time (→ enter folder · ← up)",
    hint: "→ enter · ← up",
  },
  tabs: {
    title: "tabs",
    blurb: "one folder in view (</> switch · 1-9 jump · f pick)",
    hint: "<> tab",
  },
  chips: {
    title: "chips",
    blurb: "flat list, folder chips (f filter)",
    hint: "f filter",
  },
};

export function isFolderUx(v: unknown): v is FolderUx {
  return typeof v === "string" && (FOLDER_UX_ORDER as readonly string[]).includes(v);
}

export function nextFolderUx(ux: FolderUx, dir: 1 | -1 = 1): FolderUx {
  const i = FOLDER_UX_ORDER.indexOf(ux);
  const n = FOLDER_UX_ORDER.length;
  return FOLDER_UX_ORDER[(i + dir + n) % n]!;
}

export interface FolderViewState {
  ux: FolderUx;
  /** tree: folder paths currently folded shut. */
  collapsed: Set<string>;
  /** drill: the folder being looked at (null = top level). */
  cwd: string | null;
  /** tabs: active tab — null = all, UNFILED_TAB, or a folder path. */
  tab: string | null;
  /** chips: active filter folder (null = everything). */
  filter: string | null;
}

export function emptyFolderView(ux: FolderUx = "tree"): FolderViewState {
  return { ux, collapsed: new Set(), cwd: null, tab: null, filter: null };
}

/* ------------------------------ folder index ------------------------------ */

export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  children: FolderNode[];
  /** Trees filed exactly here (not in subfolders). */
  direct: TreeSummary[];
  /** Trees here or anywhere beneath. */
  total: number;
  /** Trees here or beneath that want the user's eyes. */
  attention: number;
  /** Trees here or beneath with a working agent. */
  working: number;
}

export interface FolderIndex {
  roots: FolderNode[];
  byPath: Map<string, FolderNode>;
  unfiled: TreeSummary[];
  /** Every folder path, depth-first in display order. */
  paths: string[];
}

const byName = (a: FolderNode, b: FolderNode) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Build the folder hierarchy from the trees' folder paths. Ancestors that
 * hold no tree of their own still exist ("work/auth" implies "work").
 * Archived trees count nowhere: they leave the folder as they leave the
 * forest, and come back to it when un-archived.
 */
export function folderIndex(trees: TreeSummary[]): FolderIndex {
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  const unfiled: TreeSummary[] = [];
  const ensure = (path: string): FolderNode => {
    let node = byPath.get(path);
    if (node) return node;
    const parent = folderParent(path);
    node = {
      path,
      name: folderName(path),
      depth: parent ? parent.split("/").length : 0,
      children: [],
      direct: [],
      total: 0,
      attention: 0,
      working: 0,
    };
    byPath.set(path, node);
    if (parent) ensure(parent).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const t of trees) {
    const f = normalizeFolder(t.folder);
    if (!f) {
      unfiled.push(t);
      continue;
    }
    if (t.archived) {
      ensure(f); // the folder still exists, the tree just isn't counted
      continue;
    }
    ensure(f).direct.push(t);
    for (const anc of folderAncestors(f)) {
      const n = ensure(anc);
      n.total++;
      if (needsAttention(t)) n.attention++;
      if (t.status === "running") n.working++;
    }
  }
  const paths: string[] = [];
  const walk = (nodes: FolderNode[]) => {
    nodes.sort(byName);
    for (const n of nodes) {
      paths.push(n.path);
      walk(n.children);
    }
  };
  walk(roots);
  return { roots, byPath, unfiled, paths };
}

/* --------------------------------- scope ---------------------------------- */

/**
 * The trees a mode puts in view — on the canvas AND in the list. Tree mode
 * scopes nothing (folding is a list affair); the other three narrow the
 * forest to the folder in focus.
 */
export function scopeTrees(trees: TreeSummary[], st: FolderViewState): TreeSummary[] {
  const scope = scopeFolder(st);
  if (scope === undefined) return trees;
  if (scope === UNFILED_TAB) return trees.filter((t) => !normalizeFolder(t.folder));
  return trees.filter((t) => inFolder(normalizeFolder(t.folder), scope));
}

/** The folder a mode is focused on: undefined = no scoping at all. */
export function scopeFolder(st: FolderViewState): string | undefined {
  switch (st.ux) {
    case "tree":
      return undefined;
    case "drill":
      return st.cwd ?? undefined;
    case "tabs":
      return st.tab ?? undefined;
    case "chips":
      return st.filter ?? undefined;
  }
}

/** Where a tree created right now should be filed (the folder in focus). */
export function folderForNewTree(st: FolderViewState): string | null {
  const f = scopeFolder(st);
  return f === undefined || f === UNFILED_TAB ? null : f;
}

/* ---------------------------------- rows ---------------------------------- */

/** Selection key of a row: tree ids for trees, "folder:<path>" for folders. */
export function rowKey(row: SidebarRow): string | null {
  if (row.kind === "tree") return row.treeId ?? null;
  if (row.kind === "folder") return folderKey(row.folder!);
  return null;
}

export function folderKey(path: string): string {
  return `folder:${path}`;
}

/** Inverse of folderKey: the path when the key names a folder, else null. */
export function folderOfKey(key: string | null): string | null {
  return key && key.startsWith("folder:") ? key.slice("folder:".length) : null;
}

/** Keys of every selectable row (trees and folders) in list order. */
export function sidebarKeys(rows: SidebarRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (k) out.push(k);
  }
  return out;
}

/** Rows for the sidebar under a folder UX. `trees` is the already-scoped set. */
export function folderRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  switch (st.ux) {
    case "tree":
      return treeModeRows(trees, st);
    case "drill":
      return drillModeRows(trees, st);
    case "tabs":
      return tabsModeRows(trees, st);
    case "chips":
      return chipsModeRows(trees, st);
  }
}

/** The canonical triage order within a group: attention → working → recent. */
function triageSort(group: TreeSummary[]): TreeSummary[] {
  const rank = (t: TreeSummary) => (needsAttention(t) ? 0 : t.status === "running" ? 1 : 2);
  return [...group].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
}

function folderRow(n: FolderNode, st: FolderViewState, opts: { collapsed?: boolean } = {}): SidebarRow {
  return {
    kind: "folder",
    folder: n.path,
    label: n.name,
    depth: n.depth,
    collapsed: opts.collapsed ?? st.collapsed.has(n.path),
    count: n.total,
    attention: n.attention,
    working: n.working,
  };
}

/**
 * tree: folders first (explorer convention), each a section that folds
 * shut; a folder's trees sit under it in triage order, one indent step
 * in; subfolders nest. Unfiled trees follow in the classic state groups.
 */
function treeModeRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  const idx = folderIndex(trees);
  const rows: SidebarRow[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const n of nodes) {
      const collapsed = st.collapsed.has(n.path);
      rows.push(folderRow(n, st, { collapsed }));
      if (collapsed) continue;
      for (const t of triageSort(n.direct)) {
        rows.push({ kind: "tree", treeId: t.treeId, depth: n.depth + 1 });
      }
      walk(n.children);
    }
  };
  walk(idx.roots);
  const rest = trees.filter((t) => !normalizeFolder(t.folder) || t.archived);
  if (idx.roots.length > 0 && rest.some((t) => !t.archived)) {
    rows.push({ kind: "header", label: "unfiled" });
    rows.push(...stateGroupRows(rest.filter((t) => !t.archived), { headers: false }));
    rows.push(...stateGroupRows(rest.filter((t) => t.archived)));
  } else {
    rows.push(...stateGroupRows(rest));
  }
  return rows;
}

/**
 * drill: one level. Subfolders of the current folder as rows, then the
 * trees filed directly here in the usual state groups. Inside a folder
 * an `up` row leads back out (← does the same).
 */
function drillModeRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  const idx = folderIndex(trees);
  const rows: SidebarRow[] = [];
  const here = st.cwd ? idx.byPath.get(st.cwd) : undefined;
  const subs = st.cwd ? (here?.children ?? []) : idx.roots;
  if (st.cwd) rows.push({ kind: "up", folder: folderParent(st.cwd), label: st.cwd });
  for (const n of subs) rows.push({ ...folderRow(n, st), depth: 0, collapsed: true });
  const direct = st.cwd
    ? trees.filter((t) => normalizeFolder(t.folder) === st.cwd)
    : idx.unfiled;
  rows.push(...stateGroupRows(direct));
  return rows;
}

/**
 * The tab strip: all · <top-level folders> · unfiled (only when both
 * folders and unfiled trees exist — otherwise "all" already is that).
 */
export function tabSpecs(allTrees: TreeSummary[]): TabSpec[] {
  const idx = folderIndex(allTrees);
  const live = allTrees.filter((t) => !t.archived);
  const specs: TabSpec[] = [
    {
      label: "all",
      tab: null,
      attention: live.filter(needsAttention).length,
      working: live.filter((t) => t.status === "running").length,
    },
  ];
  for (const n of idx.roots) {
    specs.push({ label: n.name, tab: n.path, attention: n.attention, working: n.working });
  }
  const unfiled = idx.unfiled.filter((t) => !t.archived);
  if (idx.roots.length > 0 && unfiled.length > 0) {
    specs.push({
      label: "unfiled",
      tab: UNFILED_TAB,
      attention: unfiled.filter(needsAttention).length,
      working: unfiled.filter((t) => t.status === "running").length,
    });
  }
  return specs;
}

/** tabs: the strip, then the active tab's trees in the classic groups. */
function tabsModeRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  const rows: SidebarRow[] = [{ kind: "tabs" }];
  rows.push(...stateGroupRows(trees, { chipBase: st.tab }));
  return rows;
}

/** chips: the classic list, folder chips on the rows, a header when filtered. */
function chipsModeRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  const rows: SidebarRow[] = [];
  if (st.filter) rows.push({ kind: "header", label: `▾ ${st.filter}`, folder: st.filter });
  rows.push(...stateGroupRows(trees, { chipBase: st.filter }));
  return rows;
}
