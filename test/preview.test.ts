/**
 * The forest's preview pane: a cursorless, tail-anchored conversation body or
 * a cropped live screen, under a header that says which and why.
 */
import { describe, expect, it } from "vitest";
import {
  framePreview,
  previewHeader,
  previewScroll,
  renderConversationPreview,
  renderScreenPreview,
} from "../src/client/forest/preview.js";
import { buildConvView } from "../src/client/tree/sessionview.js";
import { visibleLength } from "../src/client/ansi.js";
import { loadUiState, DEFAULT_UI_STATE } from "../src/client/uistate.js";
import type { NodeSummary, TreeDetail, TreeSummary } from "../src/shared/types.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function node(
  id: string,
  parentId: string | null,
  kind: NodeSummary["kind"],
  children: string[],
): NodeSummary {
  return {
    id, parentId, kind, excerpt: `${kind} ${id}`, label: null,
    timestamp: "2026-07-25T10:00:00Z", children,
  };
}

/** A root u1→a1→u2→a2 and a fork at a1 continuing u3→a3 (two tips). */
function rootDetail(): TreeDetail {
  return {
    treeId: "root",
    leafId: "a2",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u2"]),
      u2: node("u2", "a1", "user", ["a2"]),
      a2: node("a2", "u2", "assistant", []),
    },
  };
}
function kidDetail(): TreeDetail {
  return {
    treeId: "kid",
    leafId: "a3",
    rootIds: ["u1"],
    nodes: {
      u1: node("u1", null, "user", ["a1"]),
      a1: node("a1", "u1", "assistant", ["u3"]),
      u3: node("u3", "a1", "user", ["a3"]),
      a3: node("a3", "u3", "assistant", []),
    },
  };
}
function summary(treeId: string, over: Partial<TreeSummary> = {}): TreeSummary {
  return {
    treeId,
    sessionPath: `/s/${treeId}.jsonl`,
    sessionId: null,
    name: null,
    cwd: "/w",
    parentSessionPath: null,
    status: "dormant",
    seen: true,
    leafId: null,
    nodeCount: 4,
    x: 0,
    y: 0,
    live: false,
    mtime: 100,
    ...over,
  };
}

function familyView(opts: { kidStatus?: TreeSummary["status"]; kidSeen?: boolean } = {}) {
  const summaries = [
    summary("root"),
    summary("kid", {
      parentSessionPath: "/s/root.jsonl",
      parentEntryId: "a1",
      mtime: 200,
      status: opts.kidStatus ?? "dormant",
      seen: opts.kidSeen ?? true,
      live: opts.kidStatus === "running" || opts.kidStatus === "waiting",
    }),
  ];
  const details = new Map<string, TreeDetail>([
    ["root", rootDetail()],
    ["kid", kidDetail()],
  ]);
  return buildConvView({
    rootTreeId: "root",
    detailOf: (id) => details.get(id),
    summaryOf: (id) => summaries.find((t) => t.treeId === id),
    childrenOf: (p) => summaries.filter((t) => t.parentSessionPath === p),
    parentOf: (p) => summaries.find((t) => t.sessionPath === p),
    expandedRuns: new Set(),
    unfolded: new Set(),
    viewportH: 0,
  });
}

describe("previewHeader", () => {
  const now = 1_000_000;
  it("names the conversation, its state and age, and what the pane shows", () => {
    const t = summary("root", { name: "fix the auth tests", status: "running", live: true, mtime: now - 60_000 });
    const h = strip(previewHeader({ tree: t, body: "conversation", width: 80, spinnerFrame: 0, now }));
    expect(h).toContain("fix the auth tests");
    expect(h).toContain("working");
    expect(h).toContain("1m");
    expect(h).toMatch(/conversation · v cycles\s*$/);
    expect(h.length).toBeLessThanOrEqual(80);
  });

  it("says when the screen was wanted but the conversation stands in", () => {
    const t = summary("root", { name: "x" });
    const h = strip(
      previewHeader({ tree: t, body: "conversation", fallback: true, width: 100, spinnerFrame: 0, now }),
    );
    expect(h).toContain("no live agent, showing conversation");
    const live = strip(previewHeader({ tree: t, body: "screen", width: 100, spinnerFrame: 0, now }));
    expect(live).toContain("live screen");
  });

  it("invites a selection when the cursor is on nothing, and clips when narrow", () => {
    expect(strip(previewHeader({ tree: null, body: "conversation", width: 60, spinnerFrame: 0, now }))).toContain(
      "select a conversation",
    );
    const t = summary("root", { name: "a very long conversation title that keeps going and going" });
    const h = previewHeader({ tree: t, body: "conversation", width: 30, spinnerFrame: 0, now });
    expect(visibleLength(h)).toBeLessThanOrEqual(30);
  });
});

describe("conversation preview", () => {
  it("renders the whole fork family as one tree with both tips, no cursor row", () => {
    const view = familyView({ kidStatus: "waiting", kidSeen: false });
    const lines = renderConversationPreview(view, {
      width: 80,
      height: 12,
      panelW: 0,
      spinnerFrame: 0,
      now: 1000,
      offset: 0,
    });
    expect(lines).toHaveLength(12);
    const text = lines.map(strip).join("\n");
    expect(text).toContain("user u1");
    expect(text).toContain("user u2");
    expect(text).toContain("user u3"); // the fork is on the same tree
    expect(text).toContain("needs input"); // the kid's tip carries live state
    // A peek has no cursor: nothing is rendered inverse.
    expect(lines.some((l) => l.includes("\x1b[7m"))).toBe(false);
    for (const l of lines) expect(visibleLength(l)).toBeLessThanOrEqual(80);
  });

  it("shows the agents panel when there is more than one tip and room for it", () => {
    const view = familyView({ kidStatus: "running" });
    const lines = renderConversationPreview(view, {
      width: 100,
      height: 14,
      panelW: 32,
      spinnerFrame: 0,
      now: 1000,
      offset: 0,
    });
    expect(lines.map(strip).join("\n")).toContain("agents on this tree — 2");
  });

  it("anchors at the tail with the leaf on screen; offsets move the window and clamp", () => {
    const view = familyView();
    const total = view.rows.length;
    const textH = 3;
    const tail = previewScroll(view, textH, 0);
    expect(tail).toBe(Math.max(0, total - textH));
    const leafIdx = view.rows.findIndex((r) => r.a.isLeaf);
    expect(leafIdx).toBeGreaterThanOrEqual(tail);
    expect(leafIdx).toBeLessThan(tail + textH);
    expect(previewScroll(view, textH, -1)).toBe(tail - 1);
    expect(previewScroll(view, textH, -99)).toBe(0);
    expect(previewScroll(view, textH, 99)).toBe(tail);
    // Everything fits: no scrolling at all.
    expect(previewScroll(view, 50, -5)).toBe(0);
  });

  it("says it is loading while the detail has not arrived", () => {
    const empty = familyView();
    empty.rows = [];
    const lines = renderConversationPreview(empty, {
      width: 40, height: 3, panelW: 0, spinnerFrame: 0, now: 0, offset: 0,
    });
    expect(strip(lines[0]!)).toContain("loading conversation");
    expect(lines).toHaveLength(3);
  });
});

describe("screen preview", () => {
  it("clips each daemon line to the pane and pads to the height", () => {
    const lines = renderScreenPreview(["\x1b[1mREADY\x1b[0m cwd=/some/long/path", "tick 1"], {
      width: 12,
      height: 4,
    });
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(visibleLength(l)).toBeLessThanOrEqual(12);
    expect(strip(lines[0]!)).toBe("READY cwd=/…");
    expect(strip(lines[1]!)).toBe("tick 1");
    expect(lines[2]).toBe("");
  });

  it("shows the bottom of a taller screen — where pi's editor is", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `row ${i}`);
    const lines = renderScreenPreview(rows, { width: 20, height: 3 });
    expect(lines.map(strip)).toEqual(["row 7", "row 8", "row 9"]);
  });

  it("waits visibly before the first screen lands", () => {
    const lines = renderScreenPreview(null, { width: 40, height: 2 });
    expect(strip(lines[0]!)).toContain("waiting for the screen");
  });
});

describe("framePreview", () => {
  it("is exactly `height` rows: header first, body cut or padded", () => {
    expect(framePreview("H", ["a", "b", "c"], 3)).toEqual(["H", "a", "b"]);
    expect(framePreview("H", ["a"], 4)).toEqual(["H", "a", "", ""]);
  });
});

describe("ui state", () => {
  it("defaults the forest pane to the canvas", () => {
    expect(DEFAULT_UI_STATE.forestPane).toBe("canvas");
    // No ui.json in a test home: the loader falls back to defaults.
    expect(loadUiState().forestPane).toBe("canvas");
  });
});
