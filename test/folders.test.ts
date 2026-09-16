/**
 * Folders: the shared path helpers, the folder index, the sidebar's folder
 * sections built from one fixture forest, and the renderer's folder rows.
 */
import { describe, expect, it } from "vitest";
import {
  folderAncestors,
  folderName,
  folderParent,
  inFolder,
  normalizeFolder,
} from "../src/shared/folders.js";
import {
  emptyFolderView,
  folderIndex,
  folderKey,
  folderOfKey,
  folderRows,
  sidebarKeys,
} from "../src/client/forest/folders.js";
import {
  renderSidebar,
  sidebarOrder,
  sidebarScrollTo,
  type SidebarRow,
} from "../src/client/forest/sidebar.js";
import type { TreeSummary } from "../src/shared/types.js";

function tree(
  id: string,
  folder: string | null,
  extra: Partial<TreeSummary> = {},
): TreeSummary {
  return {
    treeId: id,
    sessionPath: `/s/${id}`,
    sessionId: null,
    name: `tree-${id}`,
    cwd: "/home/x/repo",
    parentSessionPath: null,
    status: "dormant",
    seen: true,
    leafId: null,
    nodeCount: 1,
    x: 0,
    y: 0,
    live: false,
    mtime: 100,
    folder,
    ...extra,
  };
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const kinds = (rows: SidebarRow[]) => rows.map((r) => `${r.kind}:${r.treeId ?? r.folder ?? r.label ?? ""}`);

// work/ has two trees (one needs input), work/auth one (working), side/ one,
// two unfiled (one newer), one archived under work.
const FOREST: TreeSummary[] = [
  tree("w1", "work", { status: "waiting", seen: false, mtime: 500 }),
  tree("w2", "work", { mtime: 200 }),
  tree("wa", "work/auth", { status: "running", live: true, mtime: 300 }),
  tree("s1", "side", { mtime: 50 }),
  tree("u1", null, { mtime: 400 }),
  tree("u2", null, { mtime: 100 }),
  tree("z", "work", { archived: true, mtime: 900 }),
];

describe("folder paths", () => {
  it("normalizes sloppy input and treats empties as unfiled", () => {
    expect(normalizeFolder(" Work / auth / ")).toBe("Work/auth");
    expect(normalizeFolder("a//b")).toBe("a/b");
    expect(normalizeFolder("  spaced   name ")).toBe("spaced name");
    expect(normalizeFolder("")).toBeNull();
    expect(normalizeFolder(" / ")).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
    expect(normalizeFolder(undefined)).toBeNull();
  });

  it("walks ancestors, names, parents, and containment", () => {
    expect(folderAncestors("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
    expect(folderName("a/b/c")).toBe("c");
    expect(folderParent("a/b/c")).toBe("a/b");
    expect(folderParent("a")).toBeNull();
    expect(inFolder("a/b", "a")).toBe(true);
    expect(inFolder("a", "a")).toBe(true);
    expect(inFolder("ab", "a")).toBe(false); // prefix ≠ ancestor
    expect(inFolder(null, "a")).toBe(false);
  });

  it("folder keys round-trip and never collide with tree ids", () => {
    expect(folderOfKey(folderKey("work/auth"))).toBe("work/auth");
    expect(folderOfKey("t_abc")).toBeNull();
    expect(folderOfKey(null)).toBeNull();
  });
});

describe("folder index", () => {
  it("builds the hierarchy with implied ancestors and subtree counts", () => {
    const idx = folderIndex(FOREST);
    expect(idx.paths).toEqual(["side", "work", "work/auth"]);
    const work = idx.byPath.get("work")!;
    expect(work.direct.map((t) => t.treeId)).toEqual(["w1", "w2"]); // archived z excluded
    expect(work.total).toBe(3); // w1, w2 + wa beneath
    expect(work.attention).toBe(1);
    expect(work.working).toBe(1);
    expect(work.children.map((c) => c.path)).toEqual(["work/auth"]);
    expect(idx.byPath.get("work/auth")!.depth).toBe(1);
    expect(idx.unfiled.map((t) => t.treeId)).toEqual(["u1", "u2"]);
  });

  it("keeps a folder alive when only archived trees remain in it", () => {
    const idx = folderIndex([tree("z", "old", { archived: true })]);
    expect(idx.paths).toEqual(["old"]);
    expect(idx.byPath.get("old")!.total).toBe(0);
  });
});

describe("folder sections", () => {
  it("folders first (nested, triage order inside), then unfiled in state groups", () => {
    const st = emptyFolderView();
    const rows = folderRows(FOREST, st);
    expect(kinds(rows)).toEqual([
      "folder:side",
      "tree:s1",
      "folder:work",
      "tree:w1", // needs input first…
      "tree:w2",
      "folder:work/auth",
      "tree:wa",
      "header:unfiled",
      "tree:u1",
      "tree:u2",
      "header:archived",
      "tree:z",
    ]);
    // Trees under a folder indent one step past it.
    expect(rows.find((r) => r.treeId === "w1")!.depth).toBe(1);
    expect(rows.find((r) => r.treeId === "wa")!.depth).toBe(2);
    // Folder rows carry the subtree counts the header shows.
    const work = rows.find((r) => r.kind === "folder" && r.folder === "work")!;
    expect(work.count).toBe(3);
    expect(work.attention).toBe(1);
    // Cursor stepping covers folders and trees alike; Tab-order is trees only.
    expect(sidebarKeys(rows)[0]).toBe("folder:side");
    expect(sidebarOrder(rows)).toEqual(["s1", "w1", "w2", "wa", "u1", "u2", "z"]);
  });

  it("a folded folder hides its trees and subfolders", () => {
    const st = emptyFolderView();
    st.collapsed.add("work");
    const rows = folderRows(FOREST, st);
    expect(kinds(rows)).toEqual([
      "folder:side",
      "tree:s1",
      "folder:work",
      "header:unfiled",
      "tree:u1",
      "tree:u2",
      "header:archived",
      "tree:z",
    ]);
    expect(rows[2]!.collapsed).toBe(true);
  });

  it("shows archived trees in their own bottom group when present", () => {
    const rows = folderRows(FOREST, emptyFolderView());
    // z is archived: it is not listed under work (folderIndex skips it) and,
    // being in the input, lands in the archived group after the unfiled ones.
    expect(kinds(rows).at(-1)).toBe("tree:z");
    expect(rows.at(-2)!.label).toBe("archived");
  });

  it("with no folders at all, the list is exactly the classic one", () => {
    const rows = folderRows([tree("a", null), tree("b", null, { status: "running" })], emptyFolderView());
    expect(kinds(rows)).toEqual(["header:working", "tree:b", "header:recent", "tree:a"]);
  });
});

describe("sidebar rendering of folder rows", () => {
  const trees = new Map(FOREST.map((t) => [t.treeId, t]));

  it("draws folder, up and tab rows at exact width and maps them for clicks", () => {
    const st = emptyFolderView();
    const rows = folderRows(FOREST, st);
    const out = renderSidebar({
      trees,
      rows,
      selectedId: "w1",
      selectedKey: folderKey("work"),
      width: 34,
      height: 14,
      scroll: 0,
      spinnerFrame: 0,
      now: 1000,
    });
    for (const l of out.lines) expect(plain(l).length).toBe(34);
    const workLine = out.lines.findIndex((l) => plain(l).includes("▾ work"));
    expect(workLine).toBeGreaterThanOrEqual(0);
    expect(out.lineToRow[workLine]).toMatchObject({ kind: "folder", folder: "work" });
    expect(out.lineToTree[workLine]).toBeNull();
    // Counts on the right: ●1 ◐1 3.
    expect(plain(out.lines[workLine]!)).toMatch(/●1 ◐1 3 $/);
    // The folder row is the highlighted one, not the tree the app still selects.
    expect(out.lines[workLine]).toContain("\x1b[7m");
    const w1Line = out.lines.findIndex((l) => plain(l).includes("tree-w1"));
    expect(out.lines[w1Line]).not.toContain("\x1b[7m");
    // Nested rows indent.
    expect(plain(out.lines[w1Line]!).startsWith("  ●")).toBe(true);
  });

  it("scrolls to keep a folder cursor in view", () => {
    const many = Array.from({ length: 30 }, (_, i) => tree(`t${i}`, `f${String(i).padStart(2, "0")}`));
    const rows = folderRows(many, emptyFolderView());
    const s = sidebarScrollTo(rows, folderKey("f29"), 0, 10);
    expect(s).toBeGreaterThan(0);
    const idx = rows.findIndex((r) => r.kind === "folder" && r.folder === "f29");
    expect(idx).toBeGreaterThanOrEqual(s);
    expect(idx).toBeLessThan(s + 10);
  });
});
