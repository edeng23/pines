/**
 * pines extension — loaded INSIDE each pines-spawned pi via `-e <this file>`.
 *
 * Reports precise agent/session state to the pines daemon over PINES_SOCK and
 * executes daemon commands (labels, session name, in-place tree navigation).
 * No-ops instantly when PINES_SOCK is unset, so it is harmless if a user
 * copies it into ~/.pi/agent/extensions/.
 *
 * SELF-CONTAINED by design: runtime imports are node builtins only; pi types
 * are `import type` (erased). jiti loads this from wherever pines is installed,
 * where pines' own modules may not be resolvable.
 *
 * Wire protocol: NDJSON over a Unix socket — keep in sync with
 * src/shared/protocol.ts (PROTOCOL_VERSION below must match).
 */
import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 2;
const NAV_COMMAND = "pines-nav";

export default function pinesExtension(pi: ExtensionAPI): void {
  const sockPath = process.env.PINES_SOCK;
  const treeId = process.env.PINES_TREE_ID ?? "";
  if (!sockPath) return;

  let socket: net.Socket | null = null;
  let connected = false;
  let backoff = 250;
  let lastCtx: ExtensionContext | null = null;
  let stamped = false;
  /** Editor draft saved around an injected /pines-nav submission. */
  let savedDraft: string | null = null;

  function send(obj: Record<string, unknown>): void {
    if (connected && socket) socket.write(JSON.stringify(obj) + "\n");
  }

  function hello(ctx: ExtensionContext): void {
    send({
      t: "hello",
      role: "extension",
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      treeId,
      sessionPath: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      idle: ctx.isIdle(),
    });
  }

  function handleCmd(msg: Record<string, unknown>): void {
    const id = String(msg.id ?? "");
    const reply = (ok: boolean, err?: string) => send({ t: "cmd_result", re: id, ok, err });
    const ctx = lastCtx;
    if (!ctx) return reply(false, "no session context yet");

    try {
      switch (msg.op) {
        case "set_label":
          pi.setLabel(String(msg.entryId), (msg.label as string | null) ?? undefined);
          return reply(true);
        case "set_session_name":
          pi.setSessionName(String(msg.name ?? ""));
          return reply(true);
        case "stamp":
          pi.appendEntry("pines", msg.data ?? { treeId, v: 1 });
          return reply(true);
        case "navigate_tree": {
          // navigateTree needs a user-initiated command context. We stage the
          // registered /pines-nav command in the editor; the daemon submits it
          // by writing CR to the PTY once we ack.
          if (ctx.mode !== "tui") return reply(false, "navigate requires tui mode");
          if (!ctx.isIdle()) return reply(false, "agent is busy");
          savedDraft = ctx.ui.getEditorText();
          ctx.ui.setEditorText(`/${NAV_COMMAND} ${String(msg.targetId)}`);
          return reply(true);
        }
        default:
          return reply(false, `unknown op ${String(msg.op)}`);
      }
    } catch (err) {
      return reply(false, err instanceof Error ? err.message : String(err));
    }
  }

  function connect(): void {
    if (socket) return;
    const sock = net.connect(sockPath!);
    socket = sock;
    let buf = "";
    sock.on("connect", () => {
      connected = true;
      backoff = 250;
      if (lastCtx) hello(lastCtx);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.t === "cmd") handleCmd(msg);
        } catch {
          // ignore malformed daemon lines
        }
      }
    });
    const onGone = () => {
      connected = false;
      socket = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    sock.on("error", onGone);
    sock.on("close", () => {
      if (socket === sock) onGone();
    });
  }

  /* The in-place branch target of the editor-injection flow. */
  pi.registerCommand(NAV_COMMAND, {
    description: "pines: navigate the session tree to an entry (internal)",
    handler: async (args, ctx) => {
      const targetId = args.trim();
      // Restore whatever the user had typed before the injection.
      if (savedDraft !== null && ctx.mode === "tui") {
        ctx.ui.setEditorText(savedDraft);
        savedDraft = null;
      }
      if (!targetId) return;
      await ctx.navigateTree(targetId, { summarize: false });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Fires on startup AND after new/resume/fork (fresh runtime → re-hello).
    lastCtx = ctx;
    stamped = false;
    connect();
    if (connected) hello(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    if (!stamped) {
      stamped = true;
      const hasStamp = ctx.sessionManager
        .getEntries()
        .some((e) => e.type === "custom" && (e as { customType?: string }).customType === "pines");
      if (!hasStamp && treeId) pi.appendEntry("pines", { treeId, v: 1 });
    }
    send({ t: "ev", type: "agent_start" });
  });

  pi.on("agent_end", (_event, ctx) => {
    lastCtx = ctx;
    send({ t: "ev", type: "agent_end" });
  });

  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    send({
      t: "ev",
      type: "agent_settled",
      newLeafId: ctx.sessionManager.getLeafId(),
    });
  });

  pi.on("session_tree", (event, ctx) => {
    lastCtx = ctx;
    send({
      t: "ev",
      type: "session_tree",
      newLeafId: event.newLeafId,
      oldLeafId: event.oldLeafId,
    });
  });

  pi.on("session_info_changed", (event, ctx) => {
    lastCtx = ctx;
    send({ t: "ev", type: "session_name", name: event.name ?? "" });
  });

  pi.on("session_shutdown", (event, _ctx) => {
    send({ t: "ev", type: "session_shutdown", sessionPath: event.targetSessionFile });
  });
}
