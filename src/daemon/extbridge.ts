/**
 * Extension bridge: accepts pi-extension connections on the daemon socket
 * (role "extension" in the hello), turns their events into exact tree status,
 * and provides a request/response channel for daemon → extension commands.
 */
import { randomUUID } from "node:crypto";
import type { Wire } from "../shared/wire.js";
import type {
  ExtensionCmd,
  ExtensionEvent,
  ExtensionHello,
  ExtensionToDaemon,
} from "../shared/protocol.js";
import type { Supervisor, TreeRecord } from "./supervisor.js";

interface ExtConn {
  wire: Wire;
  rec: TreeRecord | undefined;
}

export class ExtBridge {
  private readonly byWire = new Map<Wire, ExtConn>();
  private readonly pending = new Map<
    string,
    { resolve: (res: { ok: boolean; err?: string }) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly supervisor: Supervisor,
    private readonly hooks: {
      /**
       * Resolve/claim the tree record for an extension hello. The daemon may
       * rename the record's treeId here (session-path identity reconciliation).
       */
      claimSession: (treeId: string, hello: ExtensionHello) => Promise<TreeRecord | undefined>;
      /** Called when a session file needs (re)ingest after an extension event. */
      onSessionActivity: (sessionPath: string, treeId: string) => void;
      /** True if any client is currently attached to this tree (affects seen). */
      isAttached: (treeId: string) => boolean;
      /** Fired when an agent settles to idle (queued navigations run here). */
      onSettled?: (treeId: string) => void;
      log: (msg: string) => void;
    },
  ) {}

  /** Wire this bridge into Daemon.extensionHandlers. Returns true if handled. */
  handle = (wire: Wire, msg: ExtensionToDaemon): boolean => {
    if (msg.t === "hello" && msg.role === "extension") {
      void this.onHello(wire, msg);
      return true;
    }
    const conn = this.byWire.get(wire);
    if (!conn) return false;
    if (msg.t === "ev") {
      this.onEvent(conn, msg);
      return true;
    }
    if (msg.t === "cmd_result") {
      const p = this.pending.get(msg.re);
      if (p) {
        this.pending.delete(msg.re);
        clearTimeout(p.timer);
        p.resolve({ ok: msg.ok, err: msg.err });
      }
      return true;
    }
    return false;
  };

  private async onHello(wire: Wire, msg: ExtensionHello): Promise<void> {
    const conn: ExtConn = { wire, rec: undefined };
    this.byWire.set(wire, conn);
    wire.on("close", () => {
      this.byWire.delete(wire);
      if (conn.rec) conn.rec.extensionConnected = false;
    });

    try {
      conn.rec = await this.hooks.claimSession(msg.treeId, msg);
    } catch (err) {
      this.hooks.log(`claimSession failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const rec = conn.rec;
    if (!rec) {
      this.hooks.log(`extension hello for unknown tree ${msg.treeId}`);
      return;
    }
    rec.extensionConnected = true;
    rec.sessionId = msg.sessionId;
    if (msg.leafId != null) rec.leafId = msg.leafId;
    // A pi that connects already idle is waiting for input, not "running"
    // (spawn optimistically marks running; correct it — as seen, nothing new).
    if (msg.idle === true && rec.status === "running") rec.status = "waiting";
    this.supervisor.notify(rec); // broadcast
    this.hooks.log(`extension connected for ${rec.treeId} (${msg.sessionPath})`);
  }

  private onEvent(conn: ExtConn, ev: ExtensionEvent): void {
    const rec = conn.rec;
    if (!rec) return;
    switch (ev.type) {
      case "agent_start":
        this.supervisor.setStatus(rec, "running");
        break;
      case "agent_end":
        // Not idle yet — retries/compaction/queued work may follow. Wait for settled.
        break;
      case "agent_settled": {
        if (ev.newLeafId !== undefined) rec.leafId = ev.newLeafId;
        const attached = this.hooks.isAttached(rec.treeId);
        this.supervisor.setStatus(rec, "waiting", { unseen: !attached });
        if (rec.sessionPath) this.hooks.onSessionActivity(rec.sessionPath, rec.treeId);
        this.hooks.onSettled?.(rec.treeId);
        break;
      }
      case "session_tree":
        if (ev.newLeafId !== undefined) rec.leafId = ev.newLeafId;
        this.supervisor.notify(rec);
        if (rec.sessionPath) this.hooks.onSessionActivity(rec.sessionPath, rec.treeId);
        break;
      case "session_switch":
      case "session_shutdown":
        if (ev.sessionPath) {
          rec.sessionPath = ev.sessionPath;
          this.hooks.onSessionActivity(ev.sessionPath, rec.treeId);
        }
        break;
      case "session_name":
        rec.name = ev.name ?? rec.name;
        this.supervisor.notify(rec);
        break;
    }
  }

  hasExtension(treeId: string): boolean {
    for (const conn of this.byWire.values()) {
      if (conn.rec?.treeId === treeId) return true;
    }
    return false;
  }

  /** Send a command to a tree's extension; resolves with its cmd_result. */
  command(
    treeId: string,
    cmd: Omit<ExtensionCmd, "t" | "id">,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; err?: string }> {
    let target: ExtConn | undefined;
    for (const conn of this.byWire.values()) {
      if (conn.rec?.treeId === treeId) target = conn;
    }
    if (!target) return Promise.resolve({ ok: false, err: "no extension connected" });
    const id = `c_${randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, err: "extension command timed out" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      target!.wire.send({ t: "cmd", id, ...cmd });
    });
  }
}
