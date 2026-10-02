/**
 * The forest's preview pane: what the right pane shows instead of the canopy
 * when you want to know what a conversation is about BEFORE attaching.
 *
 *  ┌ header: ◐ fix the auth tests · working · 3m          conversation · v screen
 *  │ ○ fix the auth tests
 *  │ └─ · looking at the failing suite…
 *  │    ├─ ○ try the mock first — ◐ working · 3m
 *  │    └─ ○ or fix the fixture — ● needs input · 1m
 *
 * Two bodies, one frame. The CONVERSATION body is the tree view's own
 * renderer (same tips, same metro map, same folds) with no cursor row and
 * the tail anchored at the leaf — it works for every tree, dormant ones
 * included. The SCREEN body is the live pi's visible screen as the daemon
 * hands it out (styled lines, cropped), the only view that shows streaming
 * text or a pending prompt. Pure functions: the app owns scroll and caches.
 */
import { clipAnsi, visibleLength } from "../ansi.js";
import { FAINT, MUTED } from "../theme.js";
import { renderConversation, convLayout, scrollTo } from "../tree/view.js";
import type { ConvView } from "../tree/sessionview.js";
import type { TreeSummary } from "../../shared/types.js";
import { humanAge, treeTitle } from "./sidebar.js";
import { statusGlyph, statusSgr } from "./view.js";

const RESET = "\x1b[0m";

export type PreviewBody = "conversation" | "screen";

function stateWord(t: TreeSummary): string {
  if (t.status === "running") return "working";
  if (t.status === "waiting") return t.seen ? "waiting" : "needs input";
  return t.status;
}

/**
 * The pane's first row: which conversation, its state, and what the pane is
 * showing. Right side explains the `v` cycle so the toggle is discoverable.
 */
export function previewHeader(opts: {
  tree: TreeSummary | null;
  body: PreviewBody;
  /** Screen body wanted, but no live agent: the conversation stands in. */
  fallback?: boolean;
  width: number;
  spinnerFrame: number;
  now: number;
}): string {
  const { tree } = opts;
  let left: string;
  if (!tree) {
    left = ` \x1b[${MUTED}mpreview — select a conversation${RESET}`;
  } else {
    const glyph = `\x1b[${statusSgr(tree)}m${statusGlyph(tree, opts.spinnerFrame)}${RESET}`;
    const bold = !tree.seen ? "\x1b[1m" : "";
    left =
      ` ${glyph} ${bold}${treeTitle(tree).title}${RESET}` +
      `\x1b[${MUTED}m · ${stateWord(tree)} · ${humanAge(tree.mtime, opts.now)}${RESET}`;
  }
  const what = opts.fallback
    ? "screen · no live agent, showing conversation"
    : opts.body === "screen"
      ? "live screen"
      : "conversation";
  const right = `\x1b[${MUTED}m${what} \x1b[${FAINT}m· v cycles${RESET} `;
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 1 > opts.width) {
    return clipAnsi(left, opts.width);
  }
  return `${left}${" ".repeat(opts.width - leftLen - rightLen)}${right}`;
}

/**
 * Where the conversation body scrolls to: the tail by default, nudged so the
 * leaf is on screen (a long parked branch can sit below the live one), then
 * the user's own offset on top — clamped so the view never shows past the
 * last row or before the first.
 */
export function previewScroll(view: ConvView, textH: number, offset: number): number {
  const total = view.rows.length;
  const maxScroll = Math.max(0, total - textH);
  let base = maxScroll;
  const leafIdx = view.rows.findIndex((r) => r.a.isLeaf);
  if (leafIdx >= 0) base = scrollTo(leafIdx, base, textH);
  return Math.max(0, Math.min(maxScroll, base + offset));
}

/** Conversation body: the tree view, cursorless, tail-anchored. */
export function renderConversationPreview(
  view: ConvView,
  opts: {
    width: number;
    height: number;
    panelW: number;
    spinnerFrame: number;
    now: number;
    /** User scroll offset (j/k, wheel); 0 = tail. */
    offset: number;
  },
): string[] {
  if (opts.height <= 0) return [];
  if (view.rows.length === 0) {
    const lines = [` \x1b[${MUTED}mloading conversation…${RESET}`];
    while (lines.length < opts.height) lines.push("");
    return lines;
  }
  const lay = convLayout(view, opts.width, opts.height, opts.panelW);
  const scroll = previewScroll(view, lay.textH, opts.offset);
  return renderConversation(view, {
    selected: -1, // no cursor: this is a peek, not a place
    scroll,
    height: opts.height,
    width: opts.width,
    panelW: opts.panelW,
    spinnerFrame: opts.spinnerFrame,
    now: opts.now,
  }).lines;
}

/**
 * Screen body: the daemon's styled lines, each clipped to the pane, padded
 * to the pane's height. The PTY is sized for the attached client, so a
 * narrower pane crops the right edge rather than reflowing pi.
 */
export function renderScreenPreview(
  lines: string[] | null,
  opts: { width: number; height: number },
): string[] {
  if (opts.height <= 0) return [];
  const out: string[] = [];
  if (!lines) {
    out.push(` \x1b[${MUTED}mwaiting for the screen…${RESET}`);
  } else {
    // Show the bottom of a taller screen: that is where pi's editor and the
    // latest output live.
    const start = Math.max(0, lines.length - opts.height);
    for (let i = start; i < lines.length && out.length < opts.height; i++) {
      out.push(clipAnsi(lines[i]!, opts.width));
    }
  }
  while (out.length < opts.height) out.push("");
  return out;
}

/** Header row plus body, exactly `height` rows, every row within `width`. */
export function framePreview(header: string, body: string[], height: number): string[] {
  const lines = [header, ...body.slice(0, Math.max(0, height - 1))];
  while (lines.length < height) lines.push("");
  return lines;
}
