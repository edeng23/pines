/**
 * Thin typed client for the daemon socket: connect, hello, request/response
 * correlation, and event callbacks.
 */
import { connect } from "node:net";
import { EventEmitter } from "node:events";
import { Wire } from "../shared/wire.js";
import {
  PROTOCOL_VERSION,
  type DaemonToClient,
  type ClientToDaemon,
  type HelloOk,
  type ResultMsg,
  type AttachOk,
} from "../shared/protocol.js";
import type { TreeSummary } from "../shared/types.js";
import { socketPath } from "../shared/paths.js";
import { ensureDaemon, restartDaemon } from "../daemon/lifecycle.js";
import { isStaleDaemon, pinesVersion } from "../shared/version.js";

/** Which build answered on the socket, and whether it is the one we installed. */
export interface DaemonBuild {
  /** Version the daemon reported; absent from daemons older than 0.1.5. */
  daemonVersion?: string;
  clientVersion: string;
  /** True when the daemon is running code from a different install than ours. */
  stale: boolean;
  /** Live agents that kept us from replacing a stale daemon (0 if we tried). */
  liveAgents: number;
}

/**
 * One line explaining a stale daemon and how to finish the upgrade.
 *
 * Worth spelling out because the symptom is so misleading: the fix is in the
 * installed code, the running daemon predates it, and the bug looks unfixed.
 */
export function staleDaemonMessage(build: DaemonBuild): string {
  const running = build.daemonVersion ? `pines ${build.daemonVersion}` : "an older build";
  const n = build.liveAgents;
  const held =
    n > 0
      ? ` ${n} live agent${n === 1 ? " keeps" : "s keep"} it up`
      : " it could not be replaced automatically";
  return (
    `daemon is running ${running}, you have ${build.clientVersion} — newer fixes are not active;` +
    `${held}. Run 'pines kill' (sessions stay resumable), then start pines again.`
  );
}

export interface DaemonClientEvents {
  forest_update: [{ upsert?: TreeSummary[]; remove?: string[] }];
  output: [string, Buffer]; // treeId, bytes
  agent_exit: [string, number | null];
  toast: [{ level: "info" | "warn" | "error"; text: string; treeId?: string }];
  close: [];
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private wire!: Wire;
  private nextId = 1;
  private pending = new Map<string, (msg: ResultMsg | AttachOk) => void>();
  helloOk!: HelloOk;
  /** Set once the handshake lands; callers warn on `stale`. */
  build!: DaemonBuild;

  /**
   * Connect, and make sure we are talking to the build that was installed.
   *
   * A daemon outlives every upgrade of the package that spawned it, so `pines`
   * routinely finds an old daemon on the socket running old code — the reason a
   * shipped fix can look like it never landed. When nothing live would be lost
   * we replace it here and the upgrade completes itself; when agents are up,
   * killing them is the user's call, so we connect anyway and flag it.
   */
  static async connect(size: { cols: number; rows: number }): Promise<DaemonClient> {
    await ensureDaemon();
    const client = await DaemonClient.handshake(size);
    if (!client.build.stale || client.build.liveAgents > 0) return client;

    client.close();
    try {
      await restartDaemon();
    } catch {
      // A daemon we cannot replace still serves: reconnect and let the caller
      // report the staleness rather than failing to start over it.
    }
    return DaemonClient.handshake(size);
  }

  private static async handshake(size: { cols: number; rows: number }): Promise<DaemonClient> {
    const client = new DaemonClient();
    await client.open(size);
    const daemonVersion = client.helloOk.daemonVersion;
    client.build = {
      daemonVersion,
      clientVersion: pinesVersion(),
      stale: isStaleDaemon(daemonVersion),
      liveAgents: client.helloOk.forest.filter((t) => t.live).length,
    };
    return client;
  }

  private open(size: { cols: number; rows: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(socketPath());
      sock.once("error", reject);
      this.wire = new Wire(sock);
      this.wire.on("close", () => this.emit("close"));
      this.wire.on("msg", (raw) => this.route(raw as DaemonToClient, resolve, reject));
      sock.once("connect", () => {
        this.wire.send({
          t: "hello",
          role: "client",
          protocolVersion: PROTOCOL_VERSION,
          buildVersion: pinesVersion(),
          cols: size.cols,
          rows: size.rows,
        });
      });
    });
  }

  private route(
    msg: DaemonToClient,
    helloResolve?: () => void,
    helloReject?: (err: Error) => void,
  ): void {
    switch (msg.t) {
      case "hello_ok":
        this.helloOk = msg;
        helloResolve?.();
        return;
      case "hello_err":
        helloReject?.(
          new Error(
            msg.reason === "version"
              ? `protocol version mismatch (daemon ${msg.serverProtocolVersion}, client ${PROTOCOL_VERSION}) — try 'pines kill' then reconnect`
              : (msg.message ?? "hello rejected"),
          ),
        );
        return;
      case "forest_update":
        this.emit("forest_update", { upsert: msg.upsert, remove: msg.remove });
        return;
      case "output":
        this.emit("output", msg.treeId, Buffer.from(msg.data, "base64"));
        return;
      case "agent_exit":
        this.emit("agent_exit", msg.treeId, msg.code);
        return;
      case "toast":
        this.emit("toast", { level: msg.level, text: msg.text, treeId: msg.treeId });
        return;
      case "result":
      case "attach_ok": {
        const cb = this.pending.get(msg.re);
        if (cb) {
          this.pending.delete(msg.re);
          cb(msg);
        }
        return;
      }
    }
  }

  /** Fire-and-forget send. */
  send(msg: ClientToDaemon): void {
    this.wire.send(msg);
  }

  /** Request with correlated response. */
  request<T extends ResultMsg | AttachOk = ResultMsg>(
    msg: ClientToDaemon & { id: string },
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`daemon request timed out: ${msg.t}`));
      }, timeoutMs);
      this.pending.set(msg.id, (res) => {
        clearTimeout(timer);
        resolve(res as T);
      });
      this.wire.send(msg);
    });
  }

  rid(): string {
    return `r${this.nextId++}`;
  }

  close(): void {
    this.wire.end();
  }
}
