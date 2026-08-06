/**
 * NDJSON framing over a stream socket.
 *
 * Strict LF-only splitting (pi's RPC docs warn that readline also splits on
 * U+2028/U+2029, which are valid inside JSON strings — same trap applies here).
 */
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";

export interface WireEvents {
  msg: [unknown];
  close: [];
  error: [Error];
}

export class Wire extends EventEmitter<WireEvents> {
  private buf = "";
  private closed = false;

  constructor(readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.on("error", (err) => this.emit("error", err));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A malformed line is a protocol violation from the peer; surface and move on.
        this.emit("error", new Error(`wire: malformed JSON line (${line.length} bytes)`));
        continue;
      }
      this.emit("msg", parsed);
    }
  }

  send(msg: unknown): boolean {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(JSON.stringify(msg) + "\n");
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}
