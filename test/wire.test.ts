import { describe, expect, it } from "vitest";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";

function tmpSock(): string {
  return join(tmpdir(), `pines-wire-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

describe("Wire", () => {
  it("round-trips NDJSON messages, including split and coalesced frames", async () => {
    const path = tmpSock();
    const received: unknown[] = [];
    let serverSock!: Socket;

    const server = createServer((sock) => {
      serverSock = sock;
      const wire = new Wire(sock);
      wire.on("msg", (m) => received.push(m));
    });
    await new Promise<void>((res) => server.listen(path, res));

    const client = connect(path);
    await new Promise<void>((res) => client.on("connect", res));

    // Message containing U+2028 (readline would mis-split here) and a chunk boundary mid-message.
    const tricky = { t: "ev", text: "line sep and   para" };
    const a = JSON.stringify({ t: "hello", role: "client", protocolVersion: 1 }) + "\n";
    const b = JSON.stringify(tricky) + "\n";
    client.write(a.slice(0, 5));
    await new Promise((r) => setTimeout(r, 10));
    client.write(a.slice(5) + b + JSON.stringify({ t: "third" }) + "\n");

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(3);
    expect(received[1]).toEqual(tricky);

    // Server → client direction.
    const clientWire = new Wire(client);
    const back: unknown[] = [];
    clientWire.on("msg", (m) => back.push(m));
    new Wire(serverSock); // ensure server side can also send raw
    serverSock.write(JSON.stringify({ t: "hello_ok" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(back).toEqual([{ t: "hello_ok" }]);

    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("skips malformed lines and keeps parsing subsequent messages", async () => {
    const path = tmpSock();
    const received: unknown[] = [];
    const errors: Error[] = [];

    const server = createServer((sock) => {
      const wire = new Wire(sock);
      wire.on("msg", (m) => received.push(m));
      wire.on("error", (e) => errors.push(e));
    });
    await new Promise<void>((res) => server.listen(path, res));
    const client = connect(path);
    await new Promise<void>((res) => client.on("connect", res));

    client.write('{"ok":1}\nnot-json\n{"ok":2}\r\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(errors).toHaveLength(1);

    client.destroy();
    await new Promise<void>((res) => server.close(() => res()));
  });
});
