/**
 * Conversation rendering: one ascii message tree with agent tips, plus the
 * agents panel (metro mini + one row per branch tip).
 *
 * ○ build me a parser for the pines forest
 * └─ · here's a first pass…
 *    ├─ ○ make it incremental — · 2m
 *    └─ ○ use embeddings instead — ● needs input · 40s
 */
import { clipAnsi, visibleLength } from "../ansi.js";
import { FAINT, MUTED } from "../theme.js";
import { branchTargetOf, type ConvView } from "./sessionview.js";
import type { TreeSummary } from "../../shared/types.js";
import { statusGlyph, statusSgr } from "../forest/view.js";

const RESET = "\x1b[0m";
import { renderConvMini, skelNodeFor } from "./convmap.js";
import { treeTitle, humanAge } from "../forest/sidebar.js";

function stateWord(t: TreeSummary): string {
  return t.status === "running"
    ? "working"
    : t.status === "waiting"
      ? t.seen
        ? "waiting"
        : "needs input"
      : t.status;
}

/**
 * Where the agents panel sits. `panelW` is the app's shared sidebar width
 * (same setting, same divider as the forest sidebar) — 0 hides the panel;
 * it also stays hidden while the tree has no forks worth mapping.
 */
export function convLayout(
  view: ConvView,
  width: number,
  height: number,
  panelW: number,
): { sideW: number; textH: number; mapTop: number; mapH: number; agentsTop: number } {
  // Narrow terminals cede more of the row to the transcript: the panel
  // duplicates status the tip suffixes already carry, the words do not.
  const cap = Math.max(24, Math.floor(width / (width < 100 ? 3 : 2)));
  const sideW = view.tips.length > 1 && panelW > 0 ? Math.min(panelW, cap) : 0;
  // The floating mini sits between the header and the agent rows; it only
  // draws when there's honest room for both.
  const wanted = Math.min(16, Math.max(6, view.tips.length * 2 + 2));
  const spare = height - (view.tips.length + 6);
  const mapH = sideW > 0 && spare >= 6 ? Math.min(wanted, spare) : 0;
  const mapTop = 2;
  const agentsTop = mapH > 0 ? mapTop + mapH + 1 : 2;
  return { sideW, textH: height, mapTop, mapH, agentsTop };
}

/**
 * Render the conversation: one ascii message tree; nodes where a session's
 * branch currently ends ("tips") carry that agent's status glyph and state.
 * The optional left panel lists the tips — agents, not messages.
 */
export function renderConversation(
  view: ConvView,
  opts: {
    selected: number;
    scroll: number;
    height: number;
    width: number;
    /** Shared sidebar width (0 = hidden); see convLayout. */
    panelW: number;
    spinnerFrame: number;
    now: number;
  },
): { lines: string[]; miniHits?: Map<string, string> } {
  const lay = convLayout(view, opts.width, opts.height, opts.panelW);
  const withMap = view.rows.length > lay.textH;
  const textW = opts.width - (lay.sideW ? lay.sideW + 2 : 0) - (withMap ? 2 : 0);
  const lines: string[] = [];
  const end = Math.min(view.rows.length, opts.scroll + lay.textH);

  for (let i = opts.scroll; i < end; i++) {
    const { a: row, tips } = view.rows[i]!;
    const isSel = i === opts.selected;
    const prefix = `\x1b[${FAINT}m${row.prefix}${RESET}`;
    let body = "";

    if (row.kind === "node" && row.node) {
      const n = row.node;
      const tip = tips?.[0];
      // Messages keep their role glyph ALWAYS — a user turn stays ○ no
      // matter what agents are parked on it. Agent status is a suffix.
      const glyph = row.isLeaf
        ? "\x1b[32m●" + RESET
        : n.label
          ? "\x1b[33m◆" + RESET
          : n.kind === "user"
            ? "\x1b[36m○" + RESET
            : `\x1b[${MUTED}m·${RESET}`;
      const excerpt = n.excerpt || n.kind;
      const textSgr = isSel
        ? "7"
        : row.onActive
          ? n.kind === "user" || row.isLeaf
            ? "1"
            : "0"
          : tip && !tip.seen
            ? "1"
            : n.kind === "user"
              ? "36"
              : MUTED;
      body = `${glyph} \x1b[${textSgr}m${excerpt}${RESET}`;
      if (n.label) body += ` \x1b[33m[${n.label}]${RESET}`;
      if (tips?.length) {
        const t = tips[0]!;
        const g = `\x1b[${statusSgr(t)}m${statusGlyph(t, opts.spinnerFrame)}${RESET}`;
        // The default state stays quiet: a dormant, seen agent is just a
        // glyph and an age. Only states that want something (working,
        // needs input, crashed) earn a word — so the words mean something.
        const quiet = t.status === "dormant" && t.seen;
        const boldSt = !t.seen ? "\x1b[1m" : "";
        const word = quiet
          ? ""
          : `${boldSt}\x1b[${!t.seen ? "0" : MUTED}m${stateWord(t)}${RESET}\x1b[${MUTED}m · `;
        body += ` \x1b[${FAINT}m—${RESET} ${g} ${word}\x1b[${MUTED}m${humanAge(t.mtime, opts.now)}${RESET}`;
        if (tips.length > 1) body += ` \x1b[${MUTED}m(+${tips.length - 1})${RESET}`;
        if (isSel) body += ` \x1b[${MUTED}m(⏎ ${t.live ? "attach" : "resume"})${RESET}`;
      } else if (isSel && row.nodeId) {
        const target = branchTargetOf(view.detail, row.nodeId);
        const parkedHere =
          view.parkedAt.get(target.nodeId)?.length ?? view.parkedAt.get(row.nodeId)?.length;
        body += parkedHere
          ? ` \x1b[${MUTED}m(⏎ continue from here — reuses a parked agent)${RESET}`
          : target.excludesSelected
            ? ` \x1b[${MUTED}m(⏎ new branch before this message — it stays out)${RESET}`
            : ` \x1b[${MUTED}m(⏎ new branch + agent from here)${RESET}`;
      }
    } else if (row.kind === "elision") {
      const sgr = isSel ? "7" : MUTED;
      const tools = row.toolCount ?? 0;
      const replies = (row.count ?? 0) - tools;
      const what =
        tools && replies
          ? `${tools} tool ${tools === 1 ? "call" : "calls"} · ${replies} ${replies === 1 ? "reply" : "replies"}`
          : tools
            ? `${tools} tool ${tools === 1 ? "call" : "calls"}`
            : `${replies} ${replies === 1 ? "reply" : "replies"}`;
      body = `\x1b[${sgr}m⚙ ⋯ ${what}${RESET}`;
      if (isSel) body += ` \x1b[${MUTED}m(⏎ expands)${RESET}`;
    } else if (row.kind === "fold") {
      const sgr = isSel ? "7" : MUTED;
      const age = row.foldAge ? ` · ${row.foldAge}` : "";
      body =
        `\x1b[${sgr}m○ ${row.foldExcerpt}${RESET} ` +
        `\x1b[${MUTED}m· ${row.foldMsgs} msgs${age}${RESET} \x1b[${FAINT}m[+]${RESET}`;
    }

    lines.push(clipAnsi(` ${prefix}${body}`, textW));
  }
  while (lines.length < lay.textH) lines.push("");

  if (withMap) {
    const total = view.rows.length;
    for (let j = 0; j < lay.textH; j++) {
      const lo = Math.floor((j / lay.textH) * total);
      const hi = Math.max(lo + 1, Math.floor(((j + 1) / lay.textH) * total));
      let ch = "│";
      let sgr = FAINT;
      for (let d = lo; d < hi; d++) {
        const r = view.rows[d]!;
        if (r.tips?.length) {
          ch = "●";
          sgr = statusSgr(r.tips[0]!);
          break;
        }
        if (r.a.kind === "fold" || r.a.prefix.includes("├─")) {
          ch = "┿";
          sgr = MUTED;
        }
      }
      const inView = hi > opts.scroll && lo < opts.scroll + lay.textH;
      if (inView && ch === "│") {
        ch = "█";
        sgr = "48;5;238;" + MUTED;
      }
      const line = lines[j]!;
      const pad = Math.max(0, textW - visibleLength(line));
      lines[j] = line + " ".repeat(pad) + ` \x1b[${sgr}m${ch}${RESET}`;
    }
  }

  // Agents panel: the floating mini of the tree (skeleton: root, branch
  // points, agent tips — the forest's visual language) above one row per
  // branch tip. Agents, not messages: selecting jumps to that exact node.
  let miniHits: Map<string, string> | undefined;
  if (lay.sideW > 0) {
    const side: string[] = [];
    const n = view.tips.length;
    const flowTag = view.flowTreeId ? ` \x1b[1m· flow${RESET}\x1b[${MUTED}m` : "";
    side.push(
      clipAnsi(`\x1b[${MUTED}m agents on this tree — ${n}${flowTag}${RESET}`, lay.sideW),
    );
    side.push("");
    const selRow = view.rows[opts.selected]?.a;
    const selNode = selRow?.nodeId;
    const selIdx = view.tips.findIndex((t) => t.nodeId === selNode);
    if (lay.mapH > 0) {
      const cursorSkelId = skelNodeFor(
        view.detail,
        view.skel,
        selRow?.nodeId ?? selRow?.runId ?? selRow?.foldId,
      );
      const mini = renderConvMini(view.skel, {
        width: lay.sideW,
        height: lay.mapH,
        spinnerFrame: opts.spinnerFrame,
        cursorSkelId,
        // Flow mode: the shown session's route reads bold on the map.
        routeIds: view.flowPath
          ? new Set(view.skel.filter((s) => view.flowPath!.has(s.id)).map((s) => s.id))
          : undefined,
      });
      miniHits = mini.hits;
      for (const l of mini.lines) side.push(l);
      side.push("");
    }
    view.tips.forEach((t, i) => {
      const s = t.summary;
      const here = i === selIdx;
      const glyph = `\x1b[${statusSgr(s)}m${statusGlyph(s, opts.spinnerFrame)}${RESET}`;
      // A branch is named by the user message that began it, not by its
      // latest reply — divergence is identity.
      const label = t.headExcerpt ?? treeTitle(s).title;
      const quiet = s.status === "dormant" && s.seen;
      const info = quiet
        ? `\x1b[${MUTED}m· ${humanAge(s.mtime, opts.now)}${RESET}`
        : `\x1b[${MUTED}m· ${stateWord(s)} · ${humanAge(s.mtime, opts.now)}${RESET}`;
      const nameSgr = !s.seen ? "1" : here ? "1" : s.live ? "0" : MUTED;
      const line = ` ${glyph} \x1b[${nameSgr}m${label}${RESET} ${info}`;
      if (here) {
        const clipped = clipAnsi(line, lay.sideW);
        const fill = Math.max(0, lay.sideW - visibleLength(clipped));
        side.push(`\x1b[48;5;236m${clipped}${" ".repeat(fill)}${RESET}`);
      } else {
        side.push(clipAnsi(line, lay.sideW));
      }
    });
    if (view.parkedCount > 0) {
      side.push(
        clipAnsi(
          `\x1b[${FAINT}m ⊘ ${view.parkedCount} parked agent${view.parkedCount === 1 ? "" : "s"} mid-tree${RESET}`,
          lay.sideW,
        ),
      );
    }
    if (view.pendingMembers > 0) {
      side.push("");
      side.push(clipAnsi(`\x1b[${FAINT}m loading ${view.pendingMembers} branch…${RESET}`, lay.sideW));
    }
    side.push("");
    side.push(clipAnsi(`\x1b[${FAINT}m click a branch to go there${RESET}`, lay.sideW));
    for (let j = 0; j < lay.textH; j++) {
      const sd = side[j] ?? "";
      const fill = Math.max(0, lay.sideW - visibleLength(sd));
      lines[j] = `${sd}${" ".repeat(fill)}\x1b[${FAINT}m│${RESET} ${lines[j] ?? ""}`;
    }
  }

  return { lines, miniHits };
}

/** Clamp scroll so `selected` stays inside the viewport. */
export function scrollTo(selected: number, scroll: number, height: number): number {
  if (selected < scroll) return selected;
  if (selected >= scroll + height) return selected - height + 1;
  return scroll;
}
