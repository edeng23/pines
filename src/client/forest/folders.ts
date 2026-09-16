/**
 * Folders in the sidebar: collapsible sections, nested by path — the
 * explorer layout (aerc, neomutt, tmux choose-tree, neo-tree). Chosen over
 * a drill-down, a tab strip and a flat chips-plus-filter list after trying
 * all four side by side; see docs/FOLDERS-UX.md for the comparison.
 *
 * Everything here is pure: rows in, rows out. The app owns the view state
 * (which folders are folded) and the cursor.
 */
import type { TreeSummary } from "../../shared/types.js";
import { folderAncestors, folderName, folderParent, normalizeFolder } from "../../shared/folders.js";
import { needsAttention, stateGroupRows, type SidebarRow } from "./sidebar.js";

export interface FolderViewState {
  /** Folder paths currently folded shut (persisted in ui.json). */
  collapsed: Set<string>;
}

export function emptyFolderView(): FolderViewState {
  return { collapsed: new Set() };
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

/** The canonical triage order within a group: attention → working → recent. */
function triageSort(group: TreeSummary[]): TreeSummary[] {
  const rank = (t: TreeSummary) => (needsAttention(t) ? 0 : t.status === "running" ? 1 : 2);
  return [...group].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
}

function folderRow(n: FolderNode, collapsed: boolean): SidebarRow {
  return {
    kind: "folder",
    folder: n.path,
    label: n.name,
    depth: n.depth,
    collapsed,
    count: n.total,
    attention: n.attention,
    working: n.working,
  };
}

/**
 * The sidebar's rows: folders first (explorer convention), each a section
 * that folds shut; a folder's trees sit under it in triage order, one
 * indent step in; subfolders nest. Unfiled trees follow in the classic
 * state groups (needs input → working → recent), archived last.
 */
export function folderRows(trees: TreeSummary[], st: FolderViewState): SidebarRow[] {
  const idx = folderIndex(trees);
  const rows: SidebarRow[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const n of nodes) {
      const collapsed = st.collapsed.has(n.path);
      rows.push(folderRow(n, collapsed));
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
