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
import { ensureDaemon } from "../daemon/lifecycle.js";

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

  static async connect(size: { cols: number; rows: number }): Promise<DaemonClient> {
    await ensureDaemon();
    const client = new DaemonClient();
    await client.open(size);
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
