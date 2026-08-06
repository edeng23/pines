#!/usr/bin/env node
/**
 * fake-pi: a scripted stand-in for the pi binary used by integration tests.
 *
 * - prints a banner wrapped in CSI 2026 synchronized-update (like pi-tui does)
 * - emits "tick N" every 300ms (proves the process keeps running when no
 *   client is attached)
 * - echoes stdin lines as "echo:<line>"
 * - if PINES_SOCK is set and --ext-report is passed, connects to the daemon
 *   socket as an extension and reports scripted status events (M2 tests)
 */
import net from "node:net";

const args = process.argv.slice(2);
process.stdout.write("\x1b[?2026h\x1b[1mFAKE-PI READY\x1b[0m cwd=" + process.cwd() + "\r\n\x1b[?2026l");

let n = 0;
const ticker = setInterval(() => {
  n++;
  process.stdout.write(`tick ${n}\r\n`);
}, 300);

let lineBuf = "";
process.stdin.on("data", (b) => {
  lineBuf += b.toString("utf8");
  let idx;
  while ((idx = lineBuf.indexOf("\r")) >= 0 || (idx = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, idx);
    lineBuf = lineBuf.slice(idx + 1);
    if (line === "exit") {
      clearInterval(ticker);
      process.exit(0);
    }
    process.stdout.write(`echo:${line}\r\n`);
  }
});

if (process.env.PINES_SOCK && (args.includes("--ext-report") || process.env.FAKE_PI_EXT === "1")) {
  const sock = net.connect(process.env.PINES_SOCK);
  const send = (obj) => sock.write(JSON.stringify(obj) + "\n");
  sock.on("connect", () => {
    send({
      t: "hello",
      role: "extension",
      protocolVersion: 2, // keep in sync with PROTOCOL_VERSION (dependency-free fixture)
      pid: process.pid,
      treeId: process.env.PINES_TREE_ID ?? "",
      // Real pi reports the session it was resumed on; mirror that when the
      // daemon passed --session, so records don't rebind to a bogus path.
      sessionPath:
        process.env.FAKE_PI_SESSION ??
        (args.includes("--session")
          ? args[args.indexOf("--session") + 1]
          : `/tmp/fake-session-${process.pid}.jsonl`),
      sessionId: "fake0000",
      leafId: null,
    });
    send({ t: "ev", type: "agent_start" });
    const settleMs = Number(process.env.FAKE_PI_SETTLE_MS ?? 600);
    setTimeout(() => send({ t: "ev", type: "agent_settled" }), settleMs);
  });
  sock.on("error", () => {});
  let buf = "";
  sock.on("data", (b) => {
    buf += b.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.t === "cmd") {
          process.stdout.write(`cmd:${msg.op}\r\n`);
          send({ t: "cmd_result", re: msg.id, ok: true });
        }
      } catch {
        // ignore
      }
    }
  });
}

process.stdin.resume();
