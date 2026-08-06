/**
 * Classic ASCII tree layout for conversation trees (the T3 design).
 *
 * Naive mode — the default, for casual-sized sessions:
 *   ○ user turn                        ← exchanges start at the margin of
 *   └─ · assistant reply                  their fork level; replies nest one
 *      ⚙ ⋯ 3 steps                        step in a └─ stanza; tool runs stay
 *      ├─ ○ a branch…                     flat. Only FORKS add lasting indent.
 *      └─ ○ the active continuation
 *
 * Scale rules — engaged automatically when the tree outgrows the viewport:
 *   non-active branches with more than FOLD_MIN_ROWS rows collapse to one
 *   `├─ ○ excerpt · N msgs · age [+]` row, unfoldable per branch. Small
 *   trees never change appearance.
 *
 * Branch order is STABLE: siblings render in creation order (the merged
 * tree sorts children by message timestamp) and never reorder because a
 * different branch became active — attention moves the highlight, not the
 * rows. Only the fold-mode pin (below) rearranges, for legibility at scale.
 */
import type { NodeSummary, TreeDetail } from "../../shared/types.js";
import { spliceCustom } from "./lanegraph.js";
import { humanAge } from "../forest/sidebar.js";

export interface ATreeRow {
  kind: "node" | "elision" | "fold";
  /** Structural prefix (guides + connector), plain text — renderer styles it. */
  prefix: string;
  nodeId?: string;
  node?: NodeSummary;
  runId?: string;
  count?: number;
  ids?: string[];
  /** Elision content summary: how many hidden nodes are tool steps. */
  toolCount?: number;
  foldId?: string;
  foldExcerpt?: string;
  foldMsgs?: number;
  foldAge?: string;
  /** ids inside a folded branch (search jumps unfold it). */
  foldIds?: string[];
  onActive: boolean;
  isLeaf: boolean;
}

export interface ATree {
  rows: ATreeRow[];
  leafId: string | null;
  /** True when scale rules kicked in (some branch was folded). */
  folded: boolean;
}

export interface ATreeOptions {
  /** Expanded elision runs (keyed by first node id of the run). */
  expandedRuns?: Set<string>;
  /** Manually unfolded branches (keyed by branch head node id). */
  unfolded?: Set<string>;
  /** Viewport height; naive mode applies while rows fit. 0 = always naive. */
  viewportH?: number;
  /** Wall-clock for fold ages (injectable for tests). */
  now?: number;
  /**
   * Always-significant node ids (session tips): never elided into a ⋯ run,
   * and branches containing one never fold — an agent must stay visible.
   */
  keep?: Set<string>;
}

const MIN_RUN = 2;
/** Non-active branches needing more rows than this fold under scale rules. */
const FOLD_MIN_ROWS = 3;

interface Ctx {
  detail: TreeDetail;
  children: Map<string, string[]>;
  active: Set<string>;
  keep: Set<string>;
  leafId: string | null;
  expandedRuns: Set<string>;
  unfolded: Set<string>;
  foldMode: boolean;
  now: number;
  rows: ATreeRow[];
  folded: boolean;
}

function isUserish(n: NodeSummary): boolean {
  return n.kind === "user" || n.kind === "compaction" || n.kind === "branch_summary";
}

function subtreeHasKeep(ctx: Ctx, id: string): boolean {
  if (ctx.keep.has(id)) return true;
  for (const c of ctx.children.get(id) ?? []) if (subtreeHasKeep(ctx, c)) return true;
  return false;
}

function subtreeIds(ctx: Ctx, id: string): string[] {
  const out: string[] = [];
  const visit = (n: string) => {
    out.push(n);
    for (const c of ctx.children.get(n) ?? []) visit(c);
  };
  visit(id);
  return out;
}

/** Rough naive-row count of a branch (fold decisions only). */
function estimateRows(ctx: Ctx, id: string): number {
  let rows = 0;
  let run = 0;
  const flush = () => {
    rows += run >= MIN_RUN ? 1 : run;
    run = 0;
  };
  const visit = (n: string) => {
    const node = ctx.detail.nodes[n]!;
    const kids = ctx.children.get(n) ?? [];
    if (isUserish(node) || node.label || n === ctx.leafId || ctx.keep.has(n) || kids.length > 1) {
      flush();
      rows += 1;
    } else run += 1;
    if (kids.length === 0) flush();
    for (const k of kids) visit(k);
  };
  visit(id);
  return rows;
}

function emitFold(ctx: Ctx, id: string, prefix: string): void {
  const ids = subtreeIds(ctx, id);
  const head = ctx.detail.nodes[id]!;
  let lastTs = "";
  for (const n of ids) {
    const ts = ctx.detail.nodes[n]?.timestamp ?? "";
    if (ts > lastTs) lastTs = ts;
  }
  const ageMs = lastTs ? Date.parse(lastTs) : NaN;
  ctx.rows.push({
    kind: "fold",
    prefix,
    foldId: id,
    foldExcerpt: head.excerpt || head.kind,
    foldMsgs: ids.length,
    foldAge: Number.isFinite(ageMs) ? humanAge(ageMs, ctx.now) : "",
    foldIds: ids,
    onActive: false,
    isLeaf: false,
  });
  ctx.folded = true;
}

/**
 * Emit one branch starting at `id`. `guides` = accumulated ancestor prefix;
 * `connector` decorates the branch's first row; `cont` replaces it afterward.
 */
function walk(ctx: Ctx, id: string | undefined, guides: string, connector: string, cont: string): void {
  let first = true;
  let inReply = false; // inside a user turn's reply stanza
  let replyFirst = false; // next stanza row carries the └─
  const run: string[] = [];
  /** Branches collected along the current exchange, fanned at its end. */
  const pending: string[] = [];

  /** Prefix for the next emitted row; consumes connector and stanza └─. */
  const nextPrefix = (stanzaRow: boolean): string => {
    let p = guides + (first ? connector : cont);
    first = false;
    if (stanzaRow && inReply) {
      if (replyFirst) {
        replyFirst = false;
        p += "└─ ";
      } else {
        p += "   ";
      }
    }
    return p;
  };

  const flushRun = (): void => {
    if (run.length === 0) return;
    const runId = run[0]!;
    const onActive = ctx.active.has(runId);
    if (run.length >= MIN_RUN && !ctx.expandedRuns.has(runId)) {
      const toolCount = run.filter((n) => ctx.detail.nodes[n]?.kind === "tool").length;
      ctx.rows.push({
        kind: "elision",
        prefix: nextPrefix(true),
        runId,
        count: run.length,
        ids: [...run],
        toolCount,
        onActive,
        isLeaf: false,
      });
    } else {
      for (const n of run) {
        ctx.rows.push({
          kind: "node",
          prefix: nextPrefix(true),
          nodeId: n,
          node: ctx.detail.nodes[n],
          onActive: ctx.active.has(n),
          isLeaf: n === ctx.leafId,
        });
      }
    }
    run.length = 0;
  };

  const emit = (n: string, stanzaRow: boolean): void => {
    ctx.rows.push({
      kind: "node",
      prefix: nextPrefix(stanzaRow),
      nodeId: n,
      node: ctx.detail.nodes[n],
      onActive: ctx.active.has(n),
      isLeaf: n === ctx.leafId,
    });
  };

  let cur: string | undefined = id;
  while (cur) {
    const node = ctx.detail.nodes[cur]!;
    const kids = ctx.children.get(cur) ?? [];
    const significant =
      isUserish(node) || node.label || cur === ctx.leafId || ctx.keep.has(cur) || kids.length > 1;

    if (significant) {
      flushRun();
      if (isUserish(node)) {
        inReply = false; // user turns return to the branch margin
        emit(cur, false);
        inReply = true;
        replyFirst = true;
      } else {
        emit(cur, true);
      }
    } else {
      run.push(cur);
    }

    // The unit of branching is the EXCHANGE, not the node. The answer chain
    // (tools + replies) continues the stanza; branches collected anywhere
    // along it — off the question or off its replies — fan together AFTER
    // the exchange. The split never happens "into" an answer.
    // The first-created answer continues the stanza; a re-answer is a
    // branch like any other (stable — attaching to it must not swap what
    // reads as "the" answer).
    const conts = kids.filter((k) => !isUserish(ctx.detail.nodes[k]!));
    const next: string | undefined = conts[0];
    for (const k of kids) if (k !== next) pending.push(k);
    if (next) {
      cur = next;
      continue;
    }

    flushRun();
    if (pending.length === 0) return;
    if (pending.length === 1) {
      // A single continuation is just the conversation flowing on — no fan,
      // no staircase; user turns return to the margin as always.
      cur = pending[0]!;
      pending.length = 0;
      continue;
    }

    const branches = [...pending];
    pending.length = 0;
    const childGuides = guides + cont + (inReply ? "   " : "");
    const activeChild = branches.find((k) => ctx.active.has(k));
    const rest = branches.filter((k) => k !== activeChild);

    if (ctx.foldMode && activeChild) {
      // Scale rule: the active path stays pinned at its margin — only the
      // side branches indent (all with ├─, since the main line continues
      // below them). Big branches fold to a single summary row.
      for (const child of rest) {
        if (
          !ctx.unfolded.has(child) &&
          !subtreeHasKeep(ctx, child) &&
          estimateRows(ctx, child) > FOLD_MIN_ROWS
        ) {
          emitFold(ctx, child, childGuides + "├─ ");
        } else {
          walk(ctx, child, childGuides, "├─ ", "│  ");
        }
      }
      cur = activeChild;
      inReply = false;
      continue;
    }

    branches.forEach((child, i) => {
      const last = i === branches.length - 1;
      const conn = last ? "└─ " : "├─ ";
      const contChild = last ? "   " : "│  ";
      if (
        ctx.foldMode &&
        !ctx.unfolded.has(child) &&
        !subtreeHasKeep(ctx, child) &&
        estimateRows(ctx, child) > FOLD_MIN_ROWS
      ) {
        emitFold(ctx, child, childGuides + conn);
      } else {
        walk(ctx, child, childGuides, conn, contChild);
      }
    });
    return;
  }
}

export function buildAsciiTree(detail: TreeDetail, opts: ATreeOptions = {}): ATree {
  const { children, roots, leafId } = spliceCustom(detail);
  const active = new Set<string>();
  for (let cur = leafId; cur; ) {
    active.add(cur);
    cur = detail.nodes[cur]?.parentId ?? null;
  }

  const build = (foldMode: boolean): Ctx => {
    const ctx: Ctx = {
      detail,
      children,
      active,
      keep: opts.keep ?? new Set(),
      leafId,
      expandedRuns: opts.expandedRuns ?? new Set(),
      unfolded: opts.unfolded ?? new Set(),
      foldMode,
      now: opts.now ?? Date.now(),
      rows: [],
      folded: false,
    };
    for (const r of roots) walk(ctx, r, "", "", "");
    return ctx;
  };

  // Naive first; engage scale rules only when the tree outgrows the viewport.
  let ctx = build(false);
  const vh = opts.viewportH ?? 0;
  if (vh > 0 && ctx.rows.length > vh) ctx = build(true);

  return { rows: ctx.rows, leafId, folded: ctx.folded };
}

/** Row index for a node id (cursor placement, search jumps). */
export function aRowIndexOf(tree: ATree, nodeId: string | null | undefined): number {
  if (!nodeId) return -1;
  return tree.rows.findIndex((r) => r.nodeId === nodeId);
}

/** The elision run or folded branch hiding `nodeId`, if any. */
export function aContainerOf(
  tree: ATree,
  nodeId: string,
): { kind: "run" | "fold"; id: string } | undefined {
  for (const r of tree.rows) {
    if (r.kind === "elision" && r.ids?.includes(nodeId)) return { kind: "run", id: r.runId! };
    if (r.kind === "fold" && r.foldIds?.includes(nodeId)) return { kind: "fold", id: r.foldId! };
  }
  return undefined;
}
