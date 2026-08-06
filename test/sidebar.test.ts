import { describe, expect, it } from "vitest";
import {
  humanAge,
  renderSidebar,
  sidebarHeaderH,
  sidebarOrder,
  sidebarRows,
  sidebarScrollTo,
} from "../src/client/forest/sidebar.js";
import type { TreeSummary } from "../src/shared/types.js";

function tree(id: string, status: TreeSummary["status"], seen: boolean, mtime: number): TreeSummary {
  return {
    treeId: id, sessionPath: `/s/${id}`, sessionId: null, name: `tree-${id}`, cwd: null,
    parentSessionPath: null, status, seen, leafId: null, nodeCount: 1,
    x: 0, y: 0, live: status === "running", mtime,
  };
}

describe("sidebar", () => {
  const trees = [
    tree("a", "dormant", true, 100),
    tree("b", "waiting", false, 50), // needs input (older)
    tree("c", "running", true, 200),
    tree("d", "waiting", false, 300), // needs input (newer)
    tree("e", "crashed", false, 10), // unseen crash → needs input
    tree("f", "completed", true, 400),
  ];

  it("groups by state (needs input → working → recent), recency within", () => {
    const rows = sidebarRows(trees);
    const headers = rows.filter((r) => r.kind === "header").map((r) => r.label);
    expect(headers).toEqual(["needs input", "working", "recent"]);
    expect(sidebarOrder(rows)).toEqual(["d", "b", "e", "c", "f", "a"]);
  });

  it("omits empty groups", () => {
    const rows = sidebarRows([tree("a", "dormant", true, 1)]);
    expect(rows.filter((r) => r.kind === "header").map((r) => r.label)).toEqual(["recent"]);
  });

  it("puts archived trees in their own bottom group regardless of status", () => {
    const archived = { ...tree("z", "waiting", false, 999), archived: true };
    const rows = sidebarRows([...trees, archived]);
    const headers = rows.filter((r) => r.kind === "header").map((r) => r.label);
    expect(headers).toEqual(["needs input", "working", "recent", "archived"]);
    // Despite being waiting-unseen (needs-input material) and newest, it sorts last.
    expect(sidebarOrder(rows).at(-1)).toBe("z");
  });

  it("renders rows at exact width with name, glyph, and age", () => {
    const rows = sidebarRows(trees);
    const { lines, lineToTree } = renderSidebar({
      trees: new Map(trees.map((t) => [t.treeId, t])),
      rows,
      selectedId: "d",
      width: 26,
      height: 12,
      scroll: 0,
      spinnerFrame: 0,
      now: 100_000,
    });
    expect(lines).toHaveLength(12);
    for (const line of lines) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBe(26);
    }
    // First tree row is 'd' (needs-input, newest) right after the header.
    expect(lineToTree[0]).toBeNull(); // header
    expect(lineToTree[1]).toBe("d");
    expect(lines[1]).toContain("tree-d");
    expect(lines[1]).toContain("\x1b[7m"); // selected → inverse
  });

  it("renders unnamed trees with the cwd basename dimmed, named ones with a dir chip", () => {
    const unnamed = { ...tree("u", "running", true, 100), name: null, cwd: "/home/x/myrepo" };
    const named = { ...tree("n", "dormant", true, 100), name: "fix the login flow", cwd: "/home/x/myrepo" };
    const rows = sidebarRows([unnamed, named]);
    const { lines } = renderSidebar({
      trees: new Map([["u", unnamed], ["n", named]]),
      rows, selectedId: null, width: 36, height: 8, scroll: 0, spinnerFrame: 0, now: 200_000,
    });
    const all = lines.join("\n");
    expect(all).toContain("myrepo"); // placeholder title for the unnamed…
    expect(all).toContain("fix the login flow"); // …real title for the named
    // Named row carries the dim dir chip.
    const namedLine = lines.find((l) => l.includes("fix the login"))!;
    expect(namedLine).toContain("myrepo");
  });

  it("mascot header: pine + version + counts top the list, never clickable", () => {
    const rows = sidebarRows(trees);
    const brand = { version: "0.1.0", pi: "0.82.0", home: "~/.pines" };
    const out = renderSidebar({
      trees: new Map(trees.map((t) => [t.treeId, t])),
      rows,
      selectedId: null,
      width: 34,
      height: 20,
      scroll: 0,
      spinnerFrame: 0,
      now: 1000,
      brand,
    });
    const h = sidebarHeaderH({ brand, width: 34, height: 20 });
    expect(h).toBe(6);
    const plain = out.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plain[0]).toContain("▲"); // the mascot's crown…
    expect(plain[0]).toContain("█▀▄ ▀█▀"); // …beside the block wordmark
    expect(plain[3]).toContain("v0.1.0 · pi 0.82.0");
    expect(plain[4]).toContain("●2"); // b + d wait unseen
    expect(plain[4]).toContain("◐1"); // c runs
    expect(plain[4]).toContain("6 trees");
    for (let i = 0; i < h; i++) expect(out.lineToTree[i]).toBeNull();
    // The list still starts right below and stays clickable.
    expect(plain[h]).toContain("needs input");
    // No brand (or no room) → no header at all.
    expect(sidebarHeaderH({ width: 34, height: 20 })).toBe(0);
    expect(sidebarHeaderH({ brand, width: 34, height: 12 })).toBe(0);
  });

  it("humanizes ages", () => {
    const now = 1_000_000_000;
    expect(humanAge(now - 5_000, now)).toBe("5s");
    expect(humanAge(now - 120_000, now)).toBe("2m");
    expect(humanAge(now - 7_200_000, now)).toBe("2h");
    expect(humanAge(now - 3 * 86_400_000, now)).toBe("3d");
  });

  it("keeps the selection (and its group header) in view when scrolling", () => {
    const many = Array.from({ length: 30 }, (_, i) => tree(`t${i}`, "dormant", true, i));
    const rows = sidebarRows(many);
    // Selecting the last (oldest) row scrolls down…
    const s1 = sidebarScrollTo(rows, "t0", 0, 10);
    expect(s1).toBeGreaterThan(0);
    // …and selecting the first row scrolls back up including the header.
    const s2 = sidebarScrollTo(rows, "t29", s1, 10);
    expect(s2).toBe(0);
  });
});
