/**
 * Interactive client: Forest ⇄ Tree ⇄ Node view stack.
 *
 * Forest is the main view — a zoomable/pannable canvas where each tree shows
 * color-coded status; wheel zooms about the cursor, drag pans, click selects.
 * Enter descends (forest → tree → attached pi); Esc ascends. Attaching to a
 * node hands the terminal to the real pi TUI (raw passthrough) with a Ctrl+t
 * prefix for getting back out; the agent keeps running either way.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { DaemonClient } from "./daemon-client.js";
import { pinesHome } from "../shared/paths.js";
import { startBoot } from "./boot.js";
import type { SearchHit, SimilarEvidence, TreeDetail, TreeSummary, Camera } from "../shared/types.js";
import {
  InputRouter,
  MOUSE_ENABLE,
  MOUSE_DISABLE,
  GUEST_INPUT_ENABLE,
  GUEST_INPUT_DISABLE,
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  SYNC_BEGIN,
  SYNC_END,
  type MouseEvent,
} from "./input.js";
import { Canvas } from "./forest/canvas.js";
import {
  ensureVisible,
  fitCamera,
  worldToCell,
  zoomAt,
  clampZoom,
  OPEN_TREE_ZOOM,
  type Viewport,
} from "./forest/camera.js";
import { renderForest, statusGlyph, statusSgr, SPINNER_FRAMES } from "./forest/view.js";
import {
  humanAge,
  renderSidebar,
  sidebarHeaderH,
  sidebarOrder,
  sidebarRows,
  sidebarScrollTo,
  treeTitle,
} from "./forest/sidebar.js";
import { loadUiState, saveUiState } from "./uistate.js";
import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  type KeyId,
} from "@earendil-works/pi-tui";

import { loadConfig, prefixByte } from "../shared/config.js";
import { clipAnsi, visibleLength } from "./ansi.js";
import { FAINT, MUTED } from "./theme.js";
import {
  aContainerOf,
  branchHeadOf,
  branchTargetOf,
  buildConvView,
  cRowIndexOf,
  ownerOf,
  type ConvView,
} from "./tree/sessionview.js";
import {
  aggregateFamily,
  attentionMemberOf,
  familyOf,
} from "./tree/merge.js";
import { renderConversation, convLayout, scrollTo } from "./tree/view.js";

const CONFIGURED_PREFIX = loadConfig().prefixKey;
const PREFIX_KEY = (
  prefixByte(CONFIGURED_PREFIX) === undefined
    ? Key.ctrl("t")
    : CONFIGURED_PREFIX!.trim().toLowerCase()
) as KeyId;


/**
 * Pi enables Kitty keyboard reporting in terminals such as iTerm2. Convert
 * those enhanced sequences back to the legacy values used by Pines' own UI.
 */
export function normalizeUiKey(key: string): string {
  if (isKeyRelease(key)) return "";
  const printable = decodeKittyPrintable(key);
  if (printable !== undefined) return printable;
  const parsed = parseKey(key);
  if (parsed?.length === 1) return parsed;
  if (parsed === Key.escape || parsed === Key.esc) return "\x1b";
  if (parsed === Key.enter || parsed === Key.return) return "\r";
  if (parsed === Key.tab) return "\t";
  if (parsed === Key.backspace) return "\x7f";
  if (parsed === Key.up) return "\x1b[A";
  if (parsed === Key.down) return "\x1b[B";
  if (parsed === Key.right) return "\x1b[C";
  if (parsed === Key.left) return "\x1b[D";
  if (parsed === Key.ctrl("c")) return "\x03";
  if (parsed === Key.ctrl("x")) return "\x18";
  // Line editing in overlays: Cmd+Backspace arrives as ctrl+u (iTerm2/Ghostty
  // "natural editing") or super+backspace (kitty protocol); Option+Backspace
  // as alt+backspace. Collapse them onto the classic readline control bytes.
  if (parsed === Key.ctrl("u") || parsed === Key.super("backspace")) return "\x15";
  if (parsed === Key.ctrl("w") || parsed === Key.alt("backspace")) return "\x17";
  return key;
}

type ViewMode =
  | { kind: "forest" }
  | {
      kind: "tree";
      /** Family root: ONE conversation = one tree, whatever forked inside. */
      rootId: string;
      view: ConvView;
      expandedRuns: Set<string>;
      unfolded: Set<string>;
      selected: number;
      scroll: number;
      /** Flow mode: show one session's conversation instead of the full tree. */
      flowOnly: boolean;
      /** Which session's flow (follows the cursor's branch); null = root. */
      flowTreeId: string | null;
    }
  | { kind: "attached"; treeId: string };

type Overlay =
  | { kind: "search"; query: string; hits: SearchHit[]; selected: number; timer: NodeJS.Timeout | null }
  | {
      kind: "menu";
      title: string;
      options: string[];
      selected: number;
      onPick: (index: number) => void;
      /** Per-option detail lines, rendered under the list for the selection. */
      detail?: (string[] | undefined)[];
    }
  | {
      kind: "input";
      title: string;
      value: string;
      placeholder: string;
      onSubmit: (value: string) => void;
    };

export async function runApp(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "pines: interactive mode needs a TTY (use 'pines spawn/status' otherwise)\n",
    );
    process.exitCode = 1;
    return;
  }

  const out = process.stdout;
  const stdin = process.stdin;

  const vp = (): Viewport => ({
    width: out.columns ?? 80,
    height: (out.rows ?? 24) - 1, // last row = status bar
  });
  const attachSize = () => ({ cols: out.columns ?? 80, rows: (out.rows ?? 24) - 1 });

  /* ---------------------------- sidebar geometry --------------------------- */

  const ui = loadUiState();
  const MIN_SIDEBAR = 20;

  /** Sidebar width in cells; 0 when hidden, not in forest, or too narrow. */
  function sidebarW(): number {
    if (mode.kind !== "forest" || !ui.sidebarVisible) return 0;
    const width = out.columns ?? 80;
    if (width < 60) return 0; // not enough room for two useful panes
    return Math.max(MIN_SIDEBAR, Math.min(ui.sidebarWidth, Math.floor(width / 2)));
  }

  /**
   * The tree view's agents panel shares the sidebar system: same width
   * setting, same divider, same S/[/] keys. 0 = hidden or no room.
   */
  function treePanelW(): number {
    if (mode.kind !== "tree" || !ui.sidebarVisible) return 0;
    const width = out.columns ?? 80;
    if (width < 60) return 0;
    return Math.max(MIN_SIDEBAR, Math.min(ui.sidebarWidth, Math.floor(width / 2)));
  }

  /** X cell where the forest canvas starts (after sidebar + divider). */
  function canvasX(): number {
    const w = sidebarW();
    return w > 0 ? w + 1 : 0;
  }

  /** Viewport of the forest canvas (right pane). */
  function forestVp(): Viewport {
    const v = vp();
    return { width: v.width - canvasX(), height: v.height };
  }

  // The splash grows while the daemon connects — masking startup, never
  // adding to it. finish() plays the ending with the live agent count.
  const boot = startBoot(out, stdin);
  const client = await DaemonClient.connect(attachSize());
  const forest = new Map<string, TreeSummary>();
  for (const t of client.helloOk.forest) forest.set(t.treeId, t);

  // Mascot header facts: our version, the bundled pi's, and where state
  // lives — shortened to ~ like a shell prompt.
  const brand = (() => {
    try {
      const req = createRequire(import.meta.url);
      const pkg = req("../../package.json") as {
        version: string;
        dependencies?: Record<string, string>;
      };
      const home = pinesHome().replace(homedir(), "~");
      return {
        version: pkg.version,
        // The daemon launches pi and is the one honest source for which
        // version that is (bundled manifest, or a probed piBin override).
        // The declared dependency is only the fallback while it probes.
        pi:
          client.helloOk.piVersion ??
          pkg.dependencies?.["@earendil-works/pi-coding-agent"] ??
          "?",
        home,
      };
    } catch {
      return undefined;
    }
  })();

  let mode: ViewMode = { kind: "forest" };
  let overlay: Overlay | null = null;
  // Session-local peek at archived trees ('.'); intentionally not persisted —
  // every launch starts with a clean forest.
  let showArchived = false;

  /** Trees the forest canvas and sidebar currently show. */
  function visibleTrees(): TreeSummary[] {
    const all = [...forest.values()];
    return showArchived ? all : all.filter((t) => !t.archived);
  }

  /* --------------------- conversations (fork families) --------------------- */

  const summaryOf = (id: string) => forest.get(id);
  const childrenOf = (sessionPath: string) =>
    [...forest.values()].filter((t) => t.parentSessionPath === sessionPath);
  const parentOf = (sessionPath: string) =>
    [...forest.values()].find((t) => t.sessionPath === sessionPath);

  /** Family root id of any member (walks fork lineage up to the original). */
  function familyRootId(treeId: string): string {
    return familyOf(treeId, summaryOf, childrenOf, parentOf)[0]?.treeId ?? treeId;
  }

  /** All family members, DFS, root first. */
  function familyMembers(treeId: string): TreeSummary[] {
    return familyOf(familyRootId(treeId), summaryOf, childrenOf, parentOf);
  }

  /**
   * The forest shows CONVERSATIONS: one aggregate summary per fork family
   * (session files are plumbing). Identity/position come from the family
   * root; status is the family's most attention-worthy member.
   */
  // Grouping walks the family lineage per tree (quadratic-ish), and callers
  // ask several times per frame — memoize on the forest's edit version.
  let forestVersion = 0;
  let convCache: { version: number; archived: boolean; out: TreeSummary[] } | null = null;
  function conversations(): TreeSummary[] {
    if (
      convCache &&
      convCache.version === forestVersion &&
      convCache.archived === showArchived
    ) {
      return convCache.out;
    }
    const grouped = new Map<string, TreeSummary[]>();
    for (const t of visibleTrees()) {
      const rootId = familyRootId(t.treeId);
      const arr = grouped.get(rootId);
      if (arr) arr.push(t);
      else grouped.set(rootId, [t]);
    }
    const out: TreeSummary[] = [];
    for (const rootId of grouped.keys()) {
      const members = familyMembers(rootId).filter(
        (t) => showArchived || !t.archived,
      );
      if (members.length === 0) continue;
      out.push(aggregateFamily(members));
    }
    convCache = { version: forestVersion, archived: showArchived, out };
    return out;
  }

  /** Attach targeting a conversation: pick the member that needs you most. */
  function attachConversation(treeId: string): void {
    const members = familyMembers(treeId);
    void attach(members.length > 1 ? attentionMemberOf(members).treeId : treeId);
  }

  let camera: Camera = fitCamera(conversations(), forestVp());
  let sidebarScroll = 0;
  let sidebarLineToTree: (string | null)[] = [];
  let dividerDrag = false;
  // Start with the most attention-worthy tree selected so ↵/a/x work
  // immediately; tab continues from it.
  let selectedId: string | null = listOrder()[0] ?? null;
  let spinnerFrame = 0;
  let prefixArmed = false;
  let toast: { text: string; until: number } | null = null;
  let dragging: { lastX: number; lastY: number } | null = null;
  let lastClick: { treeId: string; at: number; pane: "canvas" | "sidebar" } | null = null;
  let creatingTree = false;

  let pickMap = new Map<number, string>();

  /* ------------------------------- rendering ------------------------------- */

  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued || mode.kind === "attached") return;
    renderQueued = true;
    setImmediate(() => {
      renderQueued = false;
      draw();
    });
  }

  function statusCounts(): string {
    let running = 0,
      waiting = 0,
      unseen = 0,
      crashed = 0,
      archived = 0;
    for (const t of forest.values()) {
      if (t.archived) {
        archived++;
        continue;
      }
      if (t.status === "running") running++;
      if (t.status === "waiting") {
        waiting++;
        if (!t.seen) unseen++;
      }
      if (t.status === "crashed") crashed++;
    }
    const n = conversations().length;
    const parts: string[] = [`${n} ${n === 1 ? "tree" : "trees"}`];
    if (running) parts.push(`\x1b[33m◐${running}\x1b[0m`);
    // Bold when any of the waiting agents is one you haven't seen yet.
    if (waiting) parts.push(`\x1b[${unseen > 0 ? "1;" : ""}38;5;44m●${waiting}\x1b[0m`);
    if (crashed) parts.push(`\x1b[31m●${crashed}\x1b[0m`);
    if (archived) parts.push(`\x1b[${MUTED}m${archived} archived\x1b[0m`);
    return parts.join(" · ");
  }

  function statusBar(hints: string): string {
    const now = Date.now();
    const toastPart = toast && toast.until > now ? ` \x1b[7m ${toast.text} \x1b[0m` : "";
    let left = ` \x1b[1mpines\x1b[0m ${breadcrumb()} · ${statusCounts()}${toastPart}`;
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    // Clickable zoom-to-fit button (forest only). Cell range is remembered
    // for the mouse handler; the '0' key does the same thing.
    fitButton = null;
    if (mode.kind === "forest" && !overlay) {
      const x0 = strip(left).length + 1;
      const label = "[⛶ fit]";
      fitButton = { x0, x1: x0 + label.length - 1 };
      left += ` \x1b[36m${label}\x1b[0m`;
    }
    const plainLen = strip(left).length;
    const width = out.columns ?? 80;
    // Never exceed the row: wrapped status bars push the whole frame around.
    let h = hints;
    const avail = width - 1 - plainLen - 1;
    if (h.length > avail) h = avail > 1 ? h.slice(0, avail - 1) + "…" : "";
    const pad = Math.max(1, width - plainLen - h.length - 1);
    // A long toast can make the left side alone overflow — clip the whole
    // line as the last line of defense (and drop the button if it got cut).
    const line = clipAnsi(`${left}${" ".repeat(pad)}\x1b[${MUTED}m${h}\x1b[0m`, width - 1);
    if (fitButton && fitButton.x1 >= width - 1) fitButton = null;
    return line;
  }

  function breadcrumb(): string {
    if (mode.kind === "forest") return "forest";
    if (mode.kind === "tree") {
      const t = forest.get(mode.rootId);
      return `forest ▸ ${t ? treeTitle(t).title : mode.rootId}`;
    }
    return `forest ▸ ${attachedName(mode.treeId)} ▸ pi`;
  }

  /**
   * "conversation ▸ branch" for an attached member session — the member
   * file's own title is plumbing; the user thinks in conversations and
   * branch heads.
   */
  function attachedName(memberId: string): string {
    const t = forest.get(memberId);
    const rootId = familyRootId(memberId);
    const conv = forest.get(rootId) ?? t;
    const title = conv ? treeTitle(conv).title : memberId;
    if (t && t.treeId !== rootId) {
      const detail = sessionDetails.get(t.treeId);
      const head = branchHeadOf({ summary: t, detail });
      const excerpt = head ? detail?.nodes[head]?.excerpt : null;
      if (excerpt) return `${title} ▸ ${truncateStr(excerpt, 24)}`;
    }
    return title;
  }

  let lastCanvas: Canvas | null = null;
  /** Cell range of the [⛶ fit] button on the status row (forest mode only). */
  let fitButton: { x0: number; x1: number } | null = null;

  function draw(): void {
    if (mode.kind === "attached") return;
    const view = vp();
    let body: string[];
    let hints: string;
    if (mode.kind === "forest") {
      const cvp = forestVp();
      const canvas = new Canvas(cvp.width, cvp.height);
      pickMap = renderForest(canvas, {
        trees: conversations(),
        camera,
        vp: cvp,
        selectedId,
        spinnerFrame,
      });
      lastCanvas = canvas; // retained for mouse hit-testing
      body = canvas.render();
      const sw = sidebarW();
      if (sw > 0) {
        const convs = conversations();
        const rows = sidebarRows(convs);
        const headerH = sidebarHeaderH({ brand, width: sw, height: view.height });
        sidebarScroll = sidebarScrollTo(rows, selectedId, sidebarScroll, view.height - headerH);
        const sb = renderSidebar({
          trees: new Map(convs.map((t) => [t.treeId, t])),
          rows,
          selectedId,
          width: sw,
          height: view.height,
          scroll: sidebarScroll,
          spinnerFrame,
          now: Date.now(),
          brand,
        });
        sidebarLineToTree = sb.lineToTree;
        body = body.map((row, i) => `${sb.lines[i]}\x1b[${FAINT}m│\x1b[0m${row}`);
      } else {
        sidebarLineToTree = [];
      }
      // Ordered by importance — narrow terminals truncate from the right.
      hints =
        "→ open · ↵ attach · / search · s similar · n new · r rename · ± zoom · S sidebar · q quit ";
    } else {
      body = renderTreeBody(view);
      // The selected row explains what ⏎ does there; keep the bar terse and
      // front-load what narrow terminals would otherwise cut off.
      hints = "⏎ attach/branch · ← forest · f flow · ⇥ next branch · b branch · / search · L label · r rename · ↑↓ move ";
    }
    if (overlay) {
      composeOverlay(body, view);
      hints =
        overlay.kind === "search"
          ? "type to search · ↑/↓ select · ↵ jump · esc close "
          : "↑/↓ select · ↵ choose · esc close ";
    }
    const frame =
      SYNC_BEGIN +
      "\x1b[H" +
      body.map((row) => row + "\x1b[K").join("\r\n") +
      "\r\n" +
      statusBar(hints) +
      "\x1b[K" +
      SYNC_END;
    out.write(frame);
  }

  function composeOverlay(body: string[], view: Viewport): void {
    if (!overlay) return;
    const boxW = Math.min(74, view.width - 4);
    const margin = Math.floor((view.width - boxW) / 2);
    const pad = " ".repeat(margin);
    const inner = boxW - 2;
    const lines: string[] = [];
    const bar = (s: string) => {
      const clipped = clipAnsi(s, inner);
      const fill = Math.max(0, inner - visibleLength(clipped));
      return `${pad}\x1b[0m│${clipped}\x1b[0m${" ".repeat(fill)}│`;
    };
    lines.push(`${pad}\x1b[0m╭${"─".repeat(inner)}╮`);
    if (overlay.kind === "search") {
      lines.push(bar(` \x1b[1m/\x1b[0m ${overlay.query}\x1b[7m \x1b[0m`));
      lines.push(`${pad}├${"─".repeat(inner)}┤`);
      const hits = overlay.hits.slice(0, 12);
      if (hits.length === 0) {
        lines.push(bar(overlay.query ? ` \x1b[${MUTED}mno matches\x1b[0m` : ` \x1b[${MUTED}mtype to search all conversations\x1b[0m`));
      }
      const selected = overlay.selected;
      hits.forEach((h, i) => {
        const t = forest.get(familyRootId(h.treeId));
        const name = truncateStr(t ? treeTitle(t).title : h.treeId, 16).padEnd(16);
        const cursor = i === selected ? "\x1b[7m" : "";
        const kind = h.kind === "user_msg" ? "▸" : h.kind === "summary" ? "⑂" : h.kind === "label" ? "◆" : "≡";
        lines.push(bar(` ${cursor}${kind} \x1b[36m${name}\x1b[0m${cursor} ${truncateStr(h.snippet, inner - 24)}`));
      });
    } else if (overlay.kind === "input") {
      lines.push(bar(` \x1b[1m${overlay.title}\x1b[0m`));
      lines.push(`${pad}├${"─".repeat(inner)}┤`);
      const shown = overlay.value
        ? `${overlay.value}\x1b[7m \x1b[0m`
        : `\x1b[7m \x1b[0m\x1b[${MUTED}m${overlay.placeholder}\x1b[0m`;
      lines.push(bar(` ${shown}`));
    } else {
      lines.push(bar(` \x1b[1m${overlay.title}\x1b[0m`));
      lines.push(`${pad}├${"─".repeat(inner)}┤`);
      overlay.options.forEach((opt, i) => {
        const cursor = i === (overlay as { selected: number }).selected ? "\x1b[7m" : "";
        lines.push(bar(` ${cursor} ${opt} \x1b[0m`));
      });
      // The selected option's receipts (e.g. WHY a similar hit scored what
      // it did) live under the list, so the list itself stays scannable.
      const detail = overlay.detail?.[overlay.selected];
      if (detail?.length) {
        lines.push(`${pad}├${"─".repeat(inner)}┤`);
        for (const d of detail) lines.push(bar(` ${d}`));
      }
    }
    lines.push(`${pad}\x1b[0m╰${"─".repeat(inner)}╯`);
    const top = Math.max(1, Math.floor((view.height - lines.length) / 3));
    for (let i = 0; i < lines.length && top + i < body.length; i++) {
      body[top + i] = lines[i]!;
    }
  }

  function truncateStr(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
  }

  /** Readline-style backward word delete (Ctrl+W / Option+Backspace). */
  function deleteWordBack(s: string): string {
    return s.trimEnd().replace(/\S+$/, "");
  }

  function renderTreeBody(view: Viewport): string[] {
    if (mode.kind !== "tree") return [];
    const lay = convLayout(mode.view, view.width, view.height, treePanelW());
    mode.scroll = scrollTo(mode.selected, mode.scroll, lay.textH);
    const { lines, miniHits } = renderConversation(mode.view, {
      selected: mode.selected,
      scroll: mode.scroll,
      height: view.height,
      width: view.width,
      panelW: treePanelW(),
      spinnerFrame,
      now: Date.now(),
    });
    lastMiniHits = miniHits;
    return lines;
  }

  /** Mini-map cell → tip number, captured at render for click-to-jump. */
  let lastMiniHits: Map<string, string> | undefined;

  /** Session detail cache shared by the session view + forest topo. */
  const sessionDetails = new Map<string, TreeDetail>();
  const detailInFlight = new Set<string>();
  function fetchDetail(treeId: string, force = false): void {
    if ((!force && sessionDetails.has(treeId)) || detailInFlight.has(treeId)) return;
    detailInFlight.add(treeId);
    void client
      .request({ t: "get_tree", id: client.rid(), treeId })
      .then((res) => {
        if (res.ok && res.tree) {
          sessionDetails.set(treeId, res.tree);
          rebuildConv();
          requestRender();
        }
      })
      .catch(() => {}) // transient; re-requested next rebuild if still missing
      .finally(() => detailInFlight.delete(treeId));
  }

  /** Rebuild the conversation view in place, keeping the cursor put. */
  function rebuildConv(focus?: { nodeId?: string; toLeaf?: boolean }): void {
    if (mode.kind !== "tree") return;
    // No explicit focus: stay on the row under the cursor (live updates
    // rebuild the view constantly — the cursor must not jump around).
    const m = mode; // narrowed alias: closures below must not re-widen it
    if (!focus) {
      const cur = m.view.rows[m.selected]?.a;
      if (cur) focus = { nodeId: cur.nodeId ?? cur.runId ?? cur.foldId ?? undefined };
    }
    const build = () =>
      buildConvView({
        rootTreeId: m.rootId,
        detailOf: (id) => sessionDetails.get(id),
        summaryOf,
        childrenOf,
        parentOf,
        expandedRuns: m.expandedRuns,
        unfolded: m.unfolded,
        viewportH: vp().height,
        wantDetail: fetchDetail,
        flowTreeId: m.flowOnly ? (m.flowTreeId ?? m.rootId) : null,
      });
    m.view = build();
    const findFocus = () => {
      if (!focus?.nodeId || focus.toLeaf) return -1;
      const id = focus.nodeId;
      return m.view.rows.findIndex(
        (r) => r.a.nodeId === id || r.a.runId === id || r.a.foldId === id,
      );
    };
    let idx = findFocus();
    // Flow mode: a jump (search, panel, 1-9) may target a node on another
    // branch — the flow follows the cursor, so switch to that node's session
    // and rebuild once more rather than losing the jump.
    if (idx < 0 && focus?.nodeId && m.flowOnly && m.view.detail.nodes[focus.nodeId]) {
      const owner = ownerOf(m.view, focus.nodeId, (id) => sessionDetails.get(id));
      if (owner && owner !== m.flowTreeId) {
        m.flowTreeId = owner;
        m.view = build();
        idx = findFocus();
      }
    }
    if (idx < 0) idx = cRowIndexOf(m.view, m.view.leafId);
    m.selected = idx >= 0 ? idx : Math.max(0, m.view.rows.length - 1);
  }

  function showToast(text: string): void {
    toast = { text, until: Date.now() + 3000 };
    requestRender();
    setTimeout(() => requestRender(), 3100);
  }

  /* ----------------------------- data fetching ----------------------------- */

  /**
   * Open the CONVERSATION any member belongs to — one tree per family,
   * always. Details of other members stream in as they load.
   */
  async function openTree(treeId: string, selectNodeId?: string | null): Promise<void> {
    const rootId = familyRootId(treeId);
    const res = await client.request({ t: "get_tree", id: client.rid(), treeId: rootId });
    if (!res.ok || !res.tree) {
      showToast(`open failed: ${res.err ?? "no tree"}`);
      return;
    }
    sessionDetails.set(rootId, res.tree);
    const treeMode: ViewMode & { kind: "tree" } = {
      kind: "tree",
      rootId,
      view: {
        rows: [],
        leafId: null,
        flowTreeId: null,
        tips: [],
        atree: { rows: [], leafId: null, folded: false },
        detail: { treeId: rootId, leafId: null, rootIds: [], nodes: {} },
        skel: [],
        parkedAt: new Map(),
        parkedCount: 0,
        memberOrder: [],
        pendingMembers: 0,
      },
      expandedRuns: new Set(),
      unfolded: new Set(),
      selected: 0,
      scroll: 0,
      flowOnly: false,
      flowTreeId: null,
    };
    mode = treeMode;
    rebuildConv();
    // A search jump may target a node hidden in a run or folded branch.
    if (selectNodeId) {
      for (
        let guard = 0;
        guard < 4 && cRowIndexOf(treeMode.view, selectNodeId) < 0;
        guard++
      ) {
        const box = aContainerOf(treeMode.view.atree, selectNodeId);
        if (!box) break;
        (box.kind === "run" ? treeMode.expandedRuns : treeMode.unfolded).add(box.id);
        rebuildConv();
      }
      rebuildConv({ nodeId: selectNodeId });
    }
    // Ack only the root: branches keep their needs-input state until you
    // actually attach to them — opening the tree is looking, not answering.
    client.send({ t: "ack_seen", treeId: rootId });
    requestRender();
  }

  /* -------------------------------- overlays ------------------------------- */

  function openSearch(): void {
    overlay = { kind: "search", query: "", hits: [], selected: 0, timer: null };
    requestRender();
  }

  /** Quartile cue for a cosine score (practical range ~0.25–1). */
  function scoreBar(score: number): string {
    const filled = score >= 0.8 ? 4 : score >= 0.6 ? 3 : score >= 0.45 ? 2 : 1;
    return "▰".repeat(filled) + "▱".repeat(4 - filled);
  }

  async function openSimilar(): Promise<void> {
    if (!selectedId) return;
    const treeId = selectedId;
    const anchor = forest.get(treeId);
    const res = await client.request({ t: "similar", id: client.rid(), treeId });
    if (!res.ok) {
      showToast(`similar failed: ${res.err ?? "unknown error"}`);
      return;
    }
    // Hits are session files; the user thinks in conversations. Fold each
    // hit to its family root, keep the best-scoring member per family (the
    // list arrives ranked, so first wins — its evidence rides along), and
    // drop the anchor's own family — a fork of the same conversation is not
    // a find.
    const seen = new Set<string>([familyRootId(treeId)]);
    const hits: { rootId: string; score: number; evidence?: SimilarEvidence[] }[] = [];
    for (const h of res.similar ?? []) {
      const rootId = familyRootId(h.treeId);
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      hits.push({ rootId, score: h.score, evidence: h.evidence });
    }
    if (hits.length === 0) {
      showToast("no similar conversations yet (semantic layout may still be warming)");
      return;
    }
    const options = hits.map((h) => {
      const t = forest.get(h.rootId);
      const name = truncateStr(t ? treeTitle(t).title : h.rootId, 30).padEnd(30);
      const cwd = t?.cwd ? t.cwd.split("/").pop() ?? "" : "";
      return `${scoreBar(h.score)} \x1b[36m${name}\x1b[0m \x1b[${MUTED}m${cwd}\x1b[0m`;
    });
    // The receipts: each hit's top matching chunk pairs, shown for the
    // selected row. ⚙ marks a match coming from tool activity (same files)
    // rather than conversation topic — worth knowing which kind of similar.
    const detail = hits.map((h) =>
      h.evidence?.map((e) => {
        const tools = e.kindA === "tools" && e.kindB === "tools";
        const mark = tools ? "⚙ " : "";
        const room = 30;
        return (
          `\x1b[${MUTED}m${mark}“${truncateStr(e.a, room)}” ↔ “${truncateStr(e.b, room)}”` +
          ` · ${e.score.toFixed(2)}\x1b[0m`
        );
      }),
    );
    overlay = {
      kind: "menu",
      title: `similar to ${anchor ? treeTitle(anchor).title : treeId}`,
      options,
      detail,
      selected: 0,
      onPick: (i) => {
        const hit = hits[i];
        if (!hit) return;
        const t = forest.get(hit.rootId);
        if (t) {
          selectedId = t.treeId;
          camera = { ...camera, cx: t.x, cy: t.y };
        }
        requestRender();
      },
    };
    requestRender();
  }

  function runSearch(): void {
    if (overlay?.kind !== "search") return;
    const q = overlay.query;
    if (!q.trim()) {
      overlay.hits = [];
      requestRender();
      return;
    }
    void client
      .request({ t: "search", id: client.rid(), query: q })
      .then((res) => {
        if (overlay?.kind !== "search" || overlay.query !== q) return;
        overlay.hits = res.ok ? (res.hits ?? []) : [];
        overlay.selected = 0;
        requestRender();
      })
      .catch(() => {});
  }

  function onOverlayKey(key: string): void {
    if (!overlay) return;
    if (key === "\x1b" || key === "\x03") {
      overlay = null;
      requestRender();
      return;
    }
    if (overlay.kind === "input") {
      if (key === "\r") {
        const submit = overlay.onSubmit;
        const value = overlay.value.trim();
        overlay = null;
        submit(value);
        requestRender();
        return;
      }
      if (key === "\x7f" || key === "\b") {
        overlay.value = overlay.value.slice(0, -1);
      } else if (key === "\x15") {
        overlay.value = "";
      } else if (key === "\x17") {
        overlay.value = deleteWordBack(overlay.value);
      } else if (!key.startsWith("\x1b")) {
        const printable = [...key].filter((ch) => ch >= " " && ch !== "\x7f").join("");
        overlay.value += printable;
      }
      requestRender();
      return;
    }
    if (overlay.kind === "menu") {
      if (key === "j" || key === "\x1b[B") overlay.selected = Math.min(overlay.options.length - 1, overlay.selected + 1);
      else if (key === "k" || key === "\x1b[A") overlay.selected = Math.max(0, overlay.selected - 1);
      else if (key === "\r") {
        const pick = overlay.onPick;
        const idx = overlay.selected;
        overlay = null;
        pick(idx);
        return;
      } else if (/^[1-9]$/.test(key)) {
        const idx = Number(key) - 1;
        if (idx < overlay.options.length) {
          const pick = overlay.onPick;
          overlay = null;
          pick(idx);
          return;
        }
      }
      requestRender();
      return;
    }
    // Search overlay.
    if (key === "\x1b[B") overlay.selected = Math.min(Math.max(overlay.hits.length - 1, 0), overlay.selected + 1);
    else if (key === "\x1b[A") overlay.selected = Math.max(0, overlay.selected - 1);
    else if (key === "\r") {
      const hit = overlay.hits[overlay.selected];
      overlay = null;
      if (hit) {
        const t = forest.get(hit.treeId);
        if (t) {
          selectedId = t.treeId;
          camera = { ...camera, cx: t.x, cy: t.y };
        }
        void openTree(hit.treeId, hit.entryId);
      }
      requestRender();
      return;
    } else if (key === "\x7f" || key === "\b") {
      overlay.query = overlay.query.slice(0, -1);
      scheduleSearch();
    } else if (key === "\x15") {
      overlay.query = "";
      scheduleSearch();
    } else if (key === "\x17") {
      overlay.query = deleteWordBack(overlay.query);
      scheduleSearch();
    } else if (!key.startsWith("\x1b")) {
      const printable = [...key].filter((ch) => ch >= " " && ch !== "\x7f").join("");
      if (printable) {
        overlay.query += printable;
        scheduleSearch();
      }
    }
    requestRender();
  }

  function scheduleSearch(): void {
    if (overlay?.kind !== "search") return;
    if (overlay.timer) clearTimeout(overlay.timer);
    overlay.timer = setTimeout(runSearch, 150);
  }

  function openHelp(): void {
    const prefixName = PREFIX_KEY;
    overlay = {
      kind: "menu",
      title: "pines keys",
      options: [
        "arrows   ↑/↓ select · → go deeper (forest→tree→pi) · ← go back up",
        "sidebar  S=toggle  [/]=width  drag divider=resize  ↵/dbl-click=attach",
        "forest   wheel/±=zoom  drag/hjkl=pan  click/tab=select  ↵=attach",
        "forest   a=attach  n=new tree + attach  x=kill agent  R=relayout",
        "forest   o=jump to attention  0=fit all  r/L=rename tree",
        "forest   A/ctrl+x=archive/unarchive tree  .=show/hide archived",
        "forest   s=similar conversations (semantic neighbors of the selection)",
        "tree     j/k=move  ↵/→ = attach at a ● tip (an agent lives there), or grow",
        "tree     a branch: after a reply — or BESIDE a question (it stays out)",
        "tree     f=flow (one branch's conversation) ⇄ full tree",
        "tree     Tab/shift+Tab=next/prev branch (in flow: switches the flow)  1-9=nth",
        "tree     b=branch menu  L=label  r=rename this tree (its forest name)",
        `pi view  ${prefixName} ←/d=tree  ${prefixName} f=forest  ${prefixName} n=next attention`,
        `pi view  ${prefixName} ${prefixName}=send ${prefixName} to pi itself`,
        "search   / from forest or tree · ↑/↓ select · ↵ jump",
      ],
      selected: 0,
      onPick: () => {},
    };
    requestRender();
  }

  /** {owning session file, node id} under the cursor, if on a message row. */
  function selectedNode(): { treeId: string; nodeId: string } | undefined {
    if (mode.kind !== "tree") return undefined;
    const row = mode.view.rows[mode.selected];
    if (row?.a.kind === "node" && row.a.nodeId) {
      const owner = ownerOf(mode.view, row.a.nodeId, (id) => sessionDetails.get(id));
      if (owner) return { treeId: owner, nodeId: row.a.nodeId };
    }
    return undefined;
  }

  function openBranchMenu(): void {
    if (mode.kind !== "tree") return;
    const sel = selectedNode();
    if (!sel) {
      showToast("select a message first (⋯/[+] rows expand with enter)");
      return;
    }
    const node = sessionDetails.get(sel.treeId)?.nodes[sel.nodeId];
    // A reply branches after its exchange. A user message branches from its
    // PARENT — the question stays out of the new branch (sibling question,
    // chat-edit style); re-answering (keep the question, fresh answer) is
    // the explicit menu case.
    const target = branchTargetOf(mode.view.detail, sel.nodeId);
    const snapped = target.nodeId;
    const snapOwner =
      snapped === sel.nodeId
        ? sel.treeId
        : (ownerOf(mode.view, snapped, (id) => sessionDetails.get(id)) ?? sel.treeId);
    const canReanswer = snapped !== sel.nodeId;
    const options = target.excludesSelected
      ? [
          "branch + agent — a sibling branch; this question stays out",
          "branch only — a dormant sibling branch",
          ...(canReanswer ? ["re-answer — keep this question, get a fresh answer"] : []),
        ]
      : [
          "branch + agent — your next message continues this exchange",
          "branch only — a dormant branch after this exchange",
          ...(canReanswer ? ["re-answer — discard nothing, ask this question again"] : []),
        ];
    overlay = {
      kind: "menu",
      // A question's branch lands BESIDE it, not after — say so up front.
      title: `branch ${target.excludesSelected ? "beside" : "after"}: ${truncateStr(node?.excerpt || sel.nodeId, 48)}`,
      options,
      selected: 0,
      onPick: (idx) => {
        if (idx === 2) {
          void forkAtNode(sel.treeId, sel.nodeId, { spawn: true, attach: true });
        } else {
          void forkAtNode(snapOwner, snapped, { spawn: idx === 0, attach: idx === 0 });
        }
      },
    };
    requestRender();
  }

  function labelFlow(): void {
    if (mode.kind !== "tree") return;
    const sel = selectedNode();
    if (!sel) {
      showToast("select a message first (⋯/[+] rows expand with enter)");
      return;
    }
    const selNode = sessionDetails.get(sel.treeId)?.nodes[sel.nodeId];
    const current = selNode?.label ?? "";
    overlay = {
      kind: "input",
      title: `label: ${truncateStr(selNode?.excerpt || sel.nodeId, 34)}${current ? ` [${current}]` : ""}`,
      value: "",
      placeholder: current ? "empty clears the label" : "type a label",
      onSubmit: (label) => {
        void client
          .request({
            t: "set_label",
            id: client.rid(),
            treeId: sel.treeId,
            nodeId: sel.nodeId,
            label: label || null,
          })
          .then((res) => {
            if (!res.ok) showToast(`label failed: ${res.err}`);
            else fetchDetail(sel.treeId, true); // rebuild keeps the cursor here
            requestRender();
          });
      },
    };
    requestRender();
  }

  /**
   * Name the tree (its forest label): `r` anywhere, `L` in the forest.
   * In the tree view the conversation is the target — no selection needed.
   */
  function renameTreeFlow(): void {
    const treeId = mode.kind === "tree" ? mode.rootId : mode.kind === "forest" ? selectedId : null;
    if (!treeId) {
      showToast("select a tree first (↑/↓ or click)");
      return;
    }
    const current = forest.get(treeId)?.name ?? "";
    overlay = {
      kind: "input",
      title: `rename tree${current ? `: ${truncateStr(current, 48)}` : ""}`,
      value: "",
      placeholder: current ? "empty keeps the current name" : "type a name",
      onSubmit: (name) => {
        if (!name) return;
        void client
          .request({ t: "rename_tree", id: client.rid(), treeId, name })
          .then((res) => {
            if (!res.ok) showToast(`rename failed: ${res.err}`);
            else showToast(`renamed to ${name}`);
            requestRender();
          });
      },
    };
    requestRender();
  }

  /**
   * Archive toggle for the selected tree: archived trees keep their session
   * file and stay searchable but leave the canvas and sidebar ('.' reveals
   * them; resuming or A again brings one back).
   */
  async function archiveFlow(): Promise<void> {
    if (mode.kind !== "forest" || !selectedId) {
      if (mode.kind === "forest") showToast("select a tree first (↑/↓ or click)");
      return;
    }
    const treeId = selectedId;
    const t = forest.get(treeId);
    if (!t) return;
    const archiving = !t.archived;
    // A conversation archives as a WHOLE — leaving members behind would
    // resurface the family under a branch's identity.
    const members = familyMembers(treeId);
    if (archiving && members.some((m) => m.live)) {
      showToast("a branch has a live agent — kill it first (x)");
      return;
    }
    // The row is about to leave the list — pick the selection's landing spot now.
    const order = sidebarOrder(sidebarRows(conversations()));
    const idx = order.indexOf(treeId);
    for (const m of members) {
      const res = await client.request({
        t: "set_archived",
        id: client.rid(),
        treeId: m.treeId,
        archived: archiving,
      });
      if (!res.ok) {
        showToast(`${archiving ? "archive" : "unarchive"} failed: ${res.err}`);
        return;
      }
    }
    showToast(`${archiving ? "archived" : "unarchived"} ${treeTitle(t).title}${archiving && !showArchived ? " (. shows archived)" : ""}`);
    if (archiving && !showArchived && selectedId === treeId) {
      selectedId = order[idx + 1] ?? order[idx - 1] ?? null;
    }
    requestRender();
  }

  /**
   * Grow a new branch at a node. Under the hood this materializes a new
   * session file (so the branch can carry its own agent, in parallel, never
   * blocking anyone) — but visually it is just a new branch of the SAME
   * tree. The forest never gains an item from this.
   */
  async function forkAtNode(
    treeId: string,
    nodeId: string,
    opts: { spawn: boolean; attach: boolean },
  ): Promise<void> {
    const res = await client.request({
      t: "branch",
      id: client.rid(),
      treeId,
      nodeId,
      mode: "new-tree",
      spawn: opts.spawn,
    });
    if (!res.ok) {
      showToast(`fork failed: ${res.err}`);
      requestRender();
      return;
    }
    if (opts.attach && res.newTreeId) {
      await attach(res.newTreeId);
      return;
    }
    showToast(opts.spawn ? "new branch — agent running in parallel" : "new branch (dormant)");
    if (mode.kind === "tree") rebuildConv(); // cursor stays on the branch point
    requestRender();
  }

  /* ------------------------------ attach/detach ---------------------------- */

  async function attach(treeId: string): Promise<void> {
    const rec = forest.get(treeId);
    if (!rec) return;
    if (!rec.live) {
      const res = await client.request({ t: "resume_tree", id: client.rid(), treeId });
      if (!res.ok) {
        showToast(`resume failed: ${res.err}`);
        return;
      }
    }
    const res = await client.request<import("../shared/protocol.js").AttachOk>({
      t: "attach",
      id: client.rid(),
      treeId,
      ...attachSize(),
    });
    if (!("snapshot" in res)) {
      showToast(`attach failed: ${(res as { err?: string }).err}`);
      return;
    }
    mode = { kind: "attached", treeId };
    client.send({ t: "ack_seen", treeId });
    // Pi renders inside pines' alternate screen. The pines client remains
    // alive and intercepts its prefix while the daemon owns the real pi PTY.
    out.write(MOUSE_DISABLE + GUEST_INPUT_ENABLE);
    // Pin pi's scrolling to rows 1..N-1 (its PTY is sized rows-1): the bottom
    // row stays ours for the status bar instead of scrolling away with pi.
    out.write(`\x1b[2J\x1b[1;${(out.rows ?? 24) - 1}r\x1b[H`);
    out.write(Buffer.from(res.snapshot, "base64").toString("utf8"));
    drawAttachedBar();
  }

  /**
   * The bottom row stays pines' own while attached (pi is sized rows-1):
   * breadcrumb + the prefix escapes, else there is no visible way out.
   * Cursor save/restore keeps pi's cursor untouched; throttled on output.
   */
  let attachedBarTimer: NodeJS.Timeout | null = null;
  function drawAttachedBar(): void {
    if (mode.kind !== "attached") return;
    const name = attachedName(mode.treeId);
    const width = out.columns ?? 80;
    const row = out.rows ?? 24;
    const left = ` \x1b[1mpines\x1b[0m ▸ ${name} ▸ pi`;
    const hints = "ctrl+t ← tree · ctrl+t f forest · ctrl+t n next · ctrl+t ctrl+t sends ctrl+t ";
    const plainLen = visibleLength(left);
    let h = hints;
    const avail = width - 1 - plainLen - 1;
    if (h.length > avail) h = avail > 1 ? h.slice(0, avail - 1) + "…" : "";
    const pad = Math.max(1, width - plainLen - h.length - 1);
    out.write(
      SYNC_BEGIN +
        "\x1b7" + // save cursor
        `\x1b[${row};1H\x1b[K` +
        `${left}${" ".repeat(pad)}\x1b[${MUTED}m${h}\x1b[0m` +
        "\x1b8" + // restore cursor
        SYNC_END,
    );
  }
  function scheduleAttachedBar(): void {
    if (attachedBarTimer) return;
    attachedBarTimer = setTimeout(() => {
      attachedBarTimer = null;
      drawAttachedBar();
    }, 120);
  }

  function detachToTree(): void {
    if (mode.kind !== "attached") return;
    const treeId = mode.treeId;
    client.send({ t: "detach", treeId });
    out.write("\x1b[r" + GUEST_INPUT_DISABLE + MOUSE_ENABLE); // reset scroll region
    mode = { kind: "forest" };
    // Back out to the CONVERSATION, cursor on the branch we were just in.
    void openTree(treeId, forest.get(treeId)?.leafId ?? null);
  }

  function detachToForest(): void {
    if (mode.kind !== "attached") return;
    client.send({ t: "detach", treeId: mode.treeId });
    out.write("\x1b[r" + GUEST_INPUT_DISABLE + MOUSE_ENABLE); // reset scroll region
    mode = { kind: "forest" };
    requestRender();
  }

  /* ------------------------------ event wiring ----------------------------- */

  client.on("forest_update", ({ upsert, remove }) => {
    forestVersion++;
    let newest: TreeSummary | undefined;
    for (const t of upsert ?? []) {
      const prev = forest.get(t.treeId);
      forest.set(t.treeId, t);
      if (!prev && !t.parentSessionPath && (!newest || t.mtime > newest.mtime)) newest = t;
      if (prev && prev.mtime !== t.mtime) {
        // Session view renders from cached details: refresh (not delete —
        // the stale rows keep the screen steady until the fetch lands).
        if (sessionDetails.has(t.treeId)) fetchDetail(t.treeId, true);
      }
      // Surface crashes as they happen — a red dot alone explains nothing.
      if (prev && prev.status !== "crashed" && t.status === "crashed") {
        const exit = t.lastExitCode != null ? ` (exit ${t.lastExitCode})` : "";
        showToast(`agent crashed: ${treeTitle(t).title}${exit} — see ~/.pines/daemon.log`);
      }
    }
    for (const id of remove ?? []) {
      forest.delete(id);
      if (selectedId === id) selectedId = null;
    }
    // A newly discovered/spawned tree should be visibly present, not silently
    // placed outside the current camera. Preserve zoom; center only when it
    // spawned out of view — a visible one shouldn't yank the camera.
    if (newest) {
      selectedId = newest.treeId;
      if (ensureVisible(camera, forestVp(), newest.x, newest.y) !== camera) {
        camera = { ...camera, cx: newest.x, cy: newest.y };
      }
    }
    // Selection is a conversation: normalize member ids to the family root
    // (the startup pick can land on a member ingested before its parent).
    if (selectedId) {
      const root = familyRootId(selectedId);
      if (root !== selectedId && forest.has(root)) selectedId = root;
    }
    // Tips read live status straight from these summaries.
    if (mode.kind === "tree") rebuildConv();
    requestRender();
  });

  client.on("output", (treeId, data) => {
    if (mode.kind === "attached" && mode.treeId === treeId) {
      out.write(data);
      scheduleAttachedBar();
    }
  });

  client.on("agent_exit", (treeId, code) => {
    if (mode.kind === "attached" && mode.treeId === treeId) {
      out.write(`\r\n\x1b[${MUTED}m[agent exited (${code}) — Ctrl+t f returns to the forest]\x1b[0m\r\n`);
    }
  });

  client.on("toast", ({ text }) => showToast(text));

  client.on("close", () => {
    cleanup();
    process.stderr.write("\npines: daemon connection closed\n");
    process.exit(0);
  });

  out.on("resize", () => {
    if (mode.kind === "attached") {
      client.send({ t: "resize", treeId: mode.treeId, ...attachSize() });
      scheduleAttachedBar();
    } else {
      // Full clear: cells outside the new frame would otherwise linger.
      out.write("\x1b[2J");
      requestRender();
    }
  });

  /* Spinner: animate only while a running tree exists and we're rendering. */
  const spinnerTimer = setInterval(() => {
    if (mode.kind === "attached") return;
    let anyRunning = false;
    for (const t of forest.values()) if (t.status === "running" && t.live) anyRunning = true;
    if (anyRunning) {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      requestRender();
    }
  }, 125);
  spinnerTimer.unref();

  function cleanup(): void {
    clearInterval(spinnerTimer);
    stdin.setRawMode(false);
    stdin.pause();
    out.write(GUEST_INPUT_DISABLE + MOUSE_DISABLE + ALT_SCREEN_LEAVE + "\x1b[0m");
  }

  function quit(): never {
    cleanup();
    client.close();
    process.exit(0);
  }

  /* ------------------------------ interactions ----------------------------- */

  /** One canonical ordering everywhere: the sidebar's visible list order. */
  function listOrder(): string[] {
    return sidebarOrder(sidebarRows(conversations()));
  }


  /** Move the selection through the sidebar's list order (no wrap). */
  function stepSidebarSelection(dir: 1 | -1): void {
    const order = sidebarOrder(sidebarRows(conversations()));
    if (order.length === 0) return;
    const idx = order.indexOf(selectedId ?? "");
    const next =
      idx < 0
        ? dir === 1
          ? 0
          : order.length - 1
        : Math.max(0, Math.min(order.length - 1, idx + dir));
    selectedId = order[next]!;
    const t = forest.get(selectedId);
    if (t) camera = ensureVisible(camera, forestVp(), t.x, t.y);
    requestRender();
  }

  function cycleSelection(dir: 1 | -1 = 1): void {
    // Tab walks the SAME order the sidebar displays, wrapping at the ends —
    // what you see is what you cycle.
    const orderList = listOrder();
    if (orderList.length === 0) return;
    const idx = orderList.indexOf(selectedId ?? "");
    selectedId = orderList[(idx + dir + orderList.length) % orderList.length]!;
    // Scroll-into-view-if-needed: the camera only moves when the next tree
    // is outside the viewport, and then only far enough to reveal it.
    const t = forest.get(selectedId);
    if (t) camera = ensureVisible(camera, forestVp(), t.x, t.y);
    requestRender();
  }

  function jumpToAttention(): void {
    // The top of the list IS the most attention-worthy tree.
    const targetId = listOrder()[0];
    const target = targetId ? forest.get(targetId) : undefined;
    if (!target) return;
    selectedId = target.treeId;
    // Center-if-outside: an intentional jump centers on a far-away target,
    // but an already-visible one just gets the selection highlight.
    if (ensureVisible(camera, forestVp(), target.x, target.y) !== camera) {
      camera = { ...camera, cx: target.x, cy: target.y };
    }
    requestRender();
  }


  async function newTreeFlow(): Promise<void> {
    if (creatingTree) return;
    creatingTree = true;
    try {
      const res = await client.request({
        t: "spawn_tree",
        id: client.rid(),
        cwd: process.cwd(),
      });
      if (!res.ok || !res.newTreeId) {
        showToast(`spawn failed: ${res.err ?? "no tree id"}`);
        return;
      }
      selectedId = res.newTreeId;
      const rec = forest.get(res.newTreeId);
      if (rec) camera = { ...camera, cx: rec.x, cy: rec.y };
      await attach(res.newTreeId);
    } catch (err) {
      showToast(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      creatingTree = false;
      requestRender();
    }
  }

  /**
   * Where keyboard zoom should aim: the selected tree when it's on screen,
   * else the content centroid, else the viewport center. Zooming toward the
   * middle of nowhere just produces an empty screen.
   */
  function zoomAnchorCell(view: Viewport): { x: number; y: number } {
    const inView = (p: { x: number; y: number }) =>
      p.x >= 0 && p.x < view.width && p.y >= 0 && p.y < view.height;
    const sel = selectedId ? forest.get(selectedId) : undefined;
    if (sel) {
      const p = worldToCell(camera, view, sel.x, sel.y);
      if (inView(p)) return p;
    }
    const trees = visibleTrees();
    if (trees.length > 0) {
      const cx = trees.reduce((s, t) => s + t.x, 0) / trees.length;
      const cy = trees.reduce((s, t) => s + t.y, 0) / trees.length;
      const p = worldToCell(camera, view, cx, cy);
      if (inView(p)) return p;
    }
    return { x: view.width / 2, y: view.height / 2 };
  }

  function onForestKey(key: string): void {
    const pan = 8 / camera.zoom;
    const view = forestVp();
    switch (key) {
      case "q":
      case "\x03":
        quit();
        break;
      // Miller-columns navigation on arrows: ↑/↓ select, → descends into the
      // selected tree, ← is already at the top level. Panning stays on hjkl
      // (and drag): arrows navigate, letters move the camera.
      case "h":
        camera = { ...camera, cx: camera.cx - pan };
        break;
      case "l":
        camera = { ...camera, cx: camera.cx + pan };
        break;
      case "k":
        camera = { ...camera, cy: camera.cy - pan };
        break;
      case "j":
        camera = { ...camera, cy: camera.cy + pan };
        break;
      case "\x1b[A":
        if (sidebarW() > 0) stepSidebarSelection(-1);
        else cycleSelection(-1);
        return;
      case "\x1b[B":
        if (sidebarW() > 0) stepSidebarSelection(1);
        else cycleSelection(1);
        return;
      case "\x1b[C":
        if (selectedId) void openTree(selectedId);
        return;
      case "\x1b[D":
        return; // already at the root of the hierarchy
      case "\r":
        // Claude Agents muscle memory: Enter jumps straight into the session.
        if (selectedId) attachConversation(selectedId);
        return;
      case "S":
        // Blind-toggling while auto-hidden would flip an invisible state.
        if ((out.columns ?? 80) < 60) {
          showToast("terminal too narrow for the sidebar (needs ≥60 cols)");
          return;
        }
        ui.sidebarVisible = !ui.sidebarVisible;
        saveUiState(ui);
        out.write("\x1b[2J");
        requestRender();
        return;
      case "[":
      case "]": {
        if (sidebarW() === 0) return;
        const width = out.columns ?? 80;
        ui.sidebarWidth = Math.max(
          MIN_SIDEBAR,
          Math.min(Math.floor(width / 2), ui.sidebarWidth + (key === "]" ? 2 : -2)),
        );
        saveUiState(ui);
        out.write("\x1b[2J");
        requestRender();
        return;
      }
      case "+":
      case "=": {
        const a = zoomAnchorCell(view);
        camera = zoomAt(camera, view, a.x, a.y, 1.3);
        break;
      }
      case "-":
      case "_": {
        const a = zoomAnchorCell(view);
        camera = zoomAt(camera, view, a.x, a.y, 1 / 1.3);
        break;
      }
      case "0":
        camera = fitCamera(conversations(), forestVp());
        break;
      case "\t":
        cycleSelection();
        return;
      case "o":
        jumpToAttention();
        return;
      case "a":
        if (selectedId) attachConversation(selectedId);
        return;
      case "n":
        void newTreeFlow();
        return;
      case "/":
        openSearch();
        return;
      case "s":
        void openSimilar();
        return;
      case "?":
        openHelp();
        return;
      case "r":
      case "L":
        void renameTreeFlow();
        return;
      case "A":
      case "\x18": // Ctrl+X — Claude Agents muscle memory for archive
        void archiveFlow();
        return;
      case ".": {
        showArchived = !showArchived;
        const n = [...forest.values()].filter((t) => t.archived).length;
        showToast(showArchived ? `showing archived (${n})` : "hiding archived");
        // Don't leave the selection pointing at a tree that just vanished.
        if (!showArchived && selectedId && forest.get(selectedId)?.archived) selectedId = null;
        requestRender();
        return;
      }
      case "R":
        client.send({ t: "relayout", id: client.rid() });
        showToast("relayout requested");
        return;
      case "x": {
        if (!selectedId) return;
        const live = familyMembers(selectedId).filter((m) => m.live);
        if (live.length === 0) {
          showToast("no live agent in this conversation");
          return;
        }
        const victim = attentionMemberOf(live);
        client.send({ t: "kill_agent", treeId: victim.treeId });
        const kt = forest.get(selectedId);
        showToast(`killed agent of ${kt ? treeTitle(kt).title : selectedId}`);
        return;
      }
      default:
        return;
    }
    requestRender();
  }

  /** Panel/mini click (or 1-9 by panel order): cursor to that branch tip. */
  function gotoTipNode(nodeId: string, treeId?: string): void {
    if (mode.kind !== "tree") return;
    // In flow mode the flow follows the cursor: jumping to another branch's
    // tip switches the shown conversation to that session.
    if (mode.flowOnly) {
      const tid = treeId ?? mode.view.tips.find((t) => t.nodeId === nodeId)?.summary.treeId;
      if (tid) mode.flowTreeId = tid;
    }
    rebuildConv({ nodeId });
    requestRender();
  }

  /** Attach to the agent at a tip; several sessions on one node = tiny menu. */
  function attachTip(tips: TreeSummary[]): void {
    if (tips.length === 1) {
      void attach(tips[0]!.treeId);
      return;
    }
    const headOf = (id: string) =>
      mode.kind === "tree"
        ? mode.view.tips.find((p) => p.summary.treeId === id)?.headExcerpt
        : undefined;
    overlay = {
      kind: "menu",
      title: "several agents end at this message — attach which?",
      options: tips.map(
        (t) =>
          `${headOf(t.treeId) ?? treeTitle(t).title} · ${t.status === "running" ? "working" : t.status} · ${humanAge(t.mtime, Date.now())}`,
      ),
      selected: 0,
      onPick: (idx) => {
        const t = tips[idx];
        if (t) void attach(t.treeId);
      },
    };
    requestRender();
  }

  function onTreeKey(key: string): void {
    if (mode.kind !== "tree") return;
    switch (key) {
      case "\x1b":
      case "q":
      case "\x1b[D":
        // ← ascends: tree → forest. One conversation = one level.
        mode = { kind: "forest" };
        requestRender();
        return;
      case "\x03":
        quit();
        break;
      case "j":
      case "\x1b[B":
        mode.selected = Math.min(mode.view.rows.length - 1, mode.selected + 1);
        requestRender();
        return;
      case "k":
      case "\x1b[A":
        mode.selected = Math.max(0, mode.selected - 1);
        requestRender();
        return;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        {
          const tip = mode.view.tips[Number(key) - 1];
          if (tip) gotoTipNode(tip.nodeId, tip.summary.treeId);
        }
        return;
      case "\t":
      case "\x1b[Z": {
        // Cycle the branches: cursor to the next/previous tip — and in flow
        // mode that IS switching flows, since the flow follows the cursor.
        const tips = mode.view.tips;
        if (tips.length === 0) return;
        const selNode = mode.view.rows[mode.selected]?.a.nodeId;
        const flowId = mode.flowTreeId;
        const at = mode.flowOnly
          ? tips.findIndex((t) => t.summary.treeId === flowId)
          : tips.findIndex((t) => t.nodeId === selNode);
        const dir = key === "\t" ? 1 : -1;
        const next = tips[(((at < 0 ? 0 : at) + dir) % tips.length + tips.length) % tips.length]!;
        gotoTipNode(next.nodeId, next.summary.treeId);
        if (mode.flowOnly) {
          const s = next.summary;
          showToast(`flow ${next.num}/${tips.length}: ${next.headExcerpt ?? treeTitle(s).title}`);
        }
        return;
      }
      case "\r":
      case "\x1b[C": {
        // ⏎/→: open ⋯/[+] rows; attach at a tip (an agent lives there);
        // anywhere else, grow a new branch + agent from that message.
        const row = mode.view.rows[mode.selected];
        if (!row) return;
        if (row.a.kind === "elision" && row.a.runId) {
          const runId = row.a.runId;
          if (mode.expandedRuns.has(runId)) mode.expandedRuns.delete(runId);
          else mode.expandedRuns.add(runId);
          rebuildConv({ nodeId: runId });
          requestRender();
          return;
        }
        if (row.a.kind === "fold" && row.a.foldId) {
          mode.unfolded.add(row.a.foldId);
          rebuildConv({ nodeId: row.a.foldId });
          requestRender();
          return;
        }
        if (row.a.kind === "node" && row.a.nodeId) {
          if (row.tips?.length) {
            attachTip(row.tips);
            return;
          }
          // Where the new branch forks from: a reply branches after its
          // exchange; a USER message branches from its parent — the question
          // stays out, so the next message replaces it as a sibling (the way
          // editing a message works in chat UIs).
          const snapped = branchTargetOf(mode.view.detail, row.a.nodeId).nodeId;
          // An unused fork already parked here? Resume it instead of
          // minting yet another session file for the same spot.
          const parked =
            mode.view.parkedAt.get(snapped) ?? mode.view.parkedAt.get(row.a.nodeId);
          if (parked?.length) {
            showToast("resuming a parked fork from this message");
            void attach(parked[0]!.treeId);
            return;
          }
          const owner = ownerOf(mode.view, snapped, (id) => sessionDetails.get(id));
          if (owner) void forkAtNode(owner, snapped, { spawn: true, attach: true });
          return;
        }
        return;
      }
      case "b":
        openBranchMenu();
        return;
      case "L":
        void labelFlow();
        return;
      case "r":
        void renameTreeFlow();
        return;
      case "f": {
        // Flow ⇄ full tree. The flow is the cursor's branch: the session of
        // the tip under the cursor, else the session owning the cursor's node.
        mode.flowOnly = !mode.flowOnly;
        if (mode.flowOnly) {
          const row = mode.view.rows[mode.selected];
          const nodeId = row?.a.nodeId;
          mode.flowTreeId =
            row?.tips?.[0]?.treeId ??
            (nodeId ? ownerOf(mode.view, nodeId, (id) => sessionDetails.get(id)) : undefined) ??
            mode.rootId;
        }
        rebuildConv();
        showToast(
          mode.flowOnly
            ? "flow — this branch's conversation only (f: back to the full tree)"
            : "full tree",
        );
        requestRender();
        return;
      }
      case "S":
        ui.sidebarVisible = !ui.sidebarVisible;
        saveUiState(ui);
        out.write("\x1b[2J");
        requestRender();
        return;
      case "[":
      case "]": {
        const width = out.columns ?? 80;
        ui.sidebarWidth = Math.max(
          MIN_SIDEBAR,
          Math.min(Math.floor(width / 2), ui.sidebarWidth + (key === "]" ? 2 : -2)),
        );
        saveUiState(ui);
        out.write("\x1b[2J");
        requestRender();
        return;
      }
      case "/":
        openSearch();
        return;
      case "?":
        openHelp();
        return;
      default:
        return;
    }
  }

  function onForestMouse(ev: MouseEvent): void {
    const view = vp();
    // Status-row clicks: the [⛶ fit] button; nothing else down there is a target.
    if (ev.y >= view.height) {
      if (
        ev.kind === "press" &&
        ev.button === 0 &&
        fitButton &&
        ev.x >= fitButton.x0 &&
        ev.x <= fitButton.x1
      ) {
        camera = fitCamera(conversations(), forestVp());
        requestRender();
      }
      return;
    }

    const sw = sidebarW();
    if (sw > 0) {
      // Divider drag resizes the split; width persists on release.
      if (dividerDrag) {
        if (ev.kind === "drag") {
          ui.sidebarWidth = Math.max(MIN_SIDEBAR, Math.min(Math.floor(view.width / 2), ev.x));
          requestRender();
        } else if (ev.kind === "release") {
          dividerDrag = false;
          saveUiState(ui);
          out.write("\x1b[2J");
          requestRender();
        }
        return;
      }
      if (ev.kind === "press" && ev.button === 0 && ev.x === sw) {
        dividerDrag = true;
        return;
      }
      if (ev.x < sw) {
        onSidebarMouse(ev);
        return;
      }
    }

    // Canvas events are in canvas-local coordinates.
    const cvp = forestVp();
    const cx = ev.x - canvasX();
    if (ev.kind === "wheel-up" || ev.kind === "wheel-down") {
      const factor = ev.kind === "wheel-up" ? 1.25 : 0.8;
      camera = zoomAt(camera, cvp, cx, ev.y, factor);
      // Deep zoom on a selected/hovered tree opens it.
      if (camera.zoom >= OPEN_TREE_ZOOM) {
        const target = selectedId ?? hitTest(cx, ev.y);
        if (target) {
          camera = { ...camera, zoom: clampZoom(6) };
          void openTree(target);
          return;
        }
      }
      requestRender();
      return;
    }
    if (ev.kind === "press" && ev.button === 0) {
      dragging = { lastX: cx, lastY: ev.y };
      const hit = hitTest(cx, ev.y);
      if (hit) {
        const now = Date.now();
        if (
          lastClick &&
          lastClick.pane === "canvas" &&
          lastClick.treeId === hit &&
          now - lastClick.at < 350
        ) {
          lastClick = null;
          void openTree(hit);
          return;
        }
        lastClick = { treeId: hit, at: now, pane: "canvas" };
        selectedId = hit;
        requestRender();
      }
      return;
    }
    if (ev.kind === "drag" && dragging) {
      const dx = cx - dragging.lastX;
      const dy = ev.y - dragging.lastY;
      dragging = { lastX: cx, lastY: ev.y };
      camera = {
        ...camera,
        cx: camera.cx - dx / camera.zoom,
        cy: camera.cy - dy / (camera.zoom * 0.5),
      };
      requestRender();
      return;
    }
    if (ev.kind === "release") {
      dragging = null;
      dividerDrag = false; // never let a divider drag survive its release
    }
  }

  /** Sidebar pane: click selects, double-click attaches, wheel steps. */
  function onSidebarMouse(ev: MouseEvent): void {
    if (ev.kind === "wheel-up") return stepSidebarSelection(-1);
    if (ev.kind === "wheel-down") return stepSidebarSelection(1);
    if (ev.kind !== "press" || ev.button !== 0) return;
    const treeId = sidebarLineToTree[ev.y] ?? null;
    if (!treeId) return;
    const now = Date.now();
    if (
      lastClick &&
      lastClick.pane === "sidebar" &&
      lastClick.treeId === treeId &&
      now - lastClick.at < 350
    ) {
      lastClick = null;
      attachConversation(treeId);
      return;
    }
    lastClick = { treeId, at: now, pane: "sidebar" };
    selectedId = treeId;
    const t = forest.get(treeId);
    if (t) camera = ensureVisible(camera, forestVp(), t.x, t.y);
    requestRender();
  }

  function onTreeMouse(ev: MouseEvent): void {
    if (mode.kind !== "tree") return;
    const view = vp();
    const lay = convLayout(mode.view, view.width, view.height, treePanelW());
    // Divider drag resizes the shared sidebar width; persists on release.
    if (lay.sideW > 0) {
      if (dividerDrag) {
        if (ev.kind === "drag") {
          ui.sidebarWidth = Math.max(MIN_SIDEBAR, Math.min(Math.floor(view.width / 2), ev.x));
          requestRender();
        } else if (ev.kind === "release") {
          dividerDrag = false;
          saveUiState(ui);
          out.write("\x1b[2J");
          requestRender();
        }
        return;
      }
      if (ev.kind === "press" && ev.button === 0 && ev.x === lay.sideW) {
        dividerDrag = true;
        return;
      }
    }
    if (ev.kind === "wheel-up") {
      mode.selected = Math.max(0, mode.selected - 3);
      requestRender();
    } else if (ev.kind === "wheel-down") {
      mode.selected = Math.min(mode.view.rows.length - 1, mode.selected + 3);
      requestRender();
    } else if (ev.kind === "press" && ev.button === 0) {
      // Agents panel: the floating mini hit-tests its own cells; agent rows
      // start below it. Click = go to that branch tip.
      if (lay.sideW > 0 && ev.x < lay.sideW) {
        if (lay.mapH > 0 && ev.y >= lay.mapTop && ev.y < lay.mapTop + lay.mapH) {
          const nodeId = lastMiniHits?.get(`${ev.x},${ev.y - lay.mapTop}`);
          if (nodeId) gotoTipNode(nodeId);
          return;
        }
        const tip = mode.view.tips[ev.y - lay.agentsTop];
        if (tip) gotoTipNode(tip.nodeId);
        return;
      }
      const idx = mode.scroll + ev.y;
      if (idx >= 0 && idx < mode.view.rows.length) {
        mode.selected = idx;
        requestRender();
      }
    }
  }

  function hitTest(x: number, y: number): string | null {
    // Pick ids were assigned during the last forest render.
    if (!lastCanvas) return null;
    const id = lastCanvas.pickAt(x, y);
    return id >= 0 ? (pickMap.get(id) ?? null) : null;
  }

  /* ------------------------------- input loop ------------------------------ */

  const router = new InputRouter();

  router.on("key", (key) => {
    void (async () => {
      if (mode.kind === "attached") {
        // Prefix interception; everything else passes through raw.
        const bytes = Buffer.from(key, "utf8");
        const prefix = matchesKey(key, PREFIX_KEY);
        if (prefixArmed) {
          // Kitty protocol reports a release after the prefix press. It is
          // part of that same key, not the command following the prefix.
          if (isKeyRelease(key)) return;
          prefixArmed = false;
          if (matchesKey(key, Key.ctrl("c"))) return;
          // ← ascends one level (pi → tree), matching the plain-arrow
          // navigation in pines' own views; plain ← belongs to pi itself.
          if (matchesKey(key, Key.escape) || matchesKey(key, "d") || matchesKey(key, Key.left))
            return detachToTree();
          if (matchesKey(key, "f")) return detachToForest();
          if (matchesKey(key, "n")) {
            detachToForest();
            jumpToAttention();
            return;
          }
          if (prefix) {
            client.send({
              t: "input",
              treeId: mode.treeId,
              data: bytes.toString("base64"),
            });
            return;
          }
          return; // unknown chord: swallow
        }
        if (prefix) {
          if (!isKeyRelease(key)) prefixArmed = true;
          return;
        }
        // Kitty release events (CSI …:3u) never reach pi: presses are what
        // it acts on, and the release of the very key that triggered the
        // attach lands while pi is still starting — before raw mode — where
        // the PTY line discipline echoes it as literal text at the top of
        // the screen.
        if (isKeyRelease(key)) return;
        client.send({ t: "input", treeId: mode.treeId, data: bytes.toString("base64") });
        return;
      }
      const uiKey = normalizeUiKey(key);
      if (!uiKey) return;
      if (overlay) {
        onOverlayKey(uiKey);
        return;
      }
      if (mode.kind === "forest") onForestKey(uiKey);
      else onTreeKey(uiKey);
    })();
  });

  router.on("mouse", (ev) => {
    if (overlay) return; // overlays are keyboard-driven
    if (mode.kind === "forest") onForestMouse(ev);
    else if (mode.kind === "tree") onTreeMouse(ev);
  });

  const feed = (b: Buffer) => router.feed(b);

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", feed);

  process.on("SIGTERM", () => quit());

  // Every fire-and-forget flow (attach, fork, archive, open…) awaits daemon
  // requests that REJECT on a 10s timeout. A slow daemon must degrade to a
  // toast, never crash the TUI with an unhandled rejection.
  process.on("unhandledRejection", (err) => {
    showToast(`error: ${err instanceof Error ? err.message : String(err)}`);
  });

  await boot.finish(() => {
    let n = 0;
    for (const t of forest.values()) if (t.live) n++;
    return n;
  });

  out.write(ALT_SCREEN_ENTER + MOUSE_ENABLE);
  requestRender();
}

/* Re-exported for tests. */
export { statusGlyph, statusSgr };
