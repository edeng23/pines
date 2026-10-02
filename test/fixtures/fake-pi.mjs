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
 * - as that extension, mirrors the real one's ← rule: a plain ← arriving on
 *   an empty line is swallowed and reported as a "leave" event; with text
 *   pending it stays ordinary input
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
/** Set once the extension socket is up; the ← rule needs somewhere to report. */
let extSend = null;
// Raw mode, like a real TUI: keys arrive as they are typed instead of being
// held by the line discipline until a newline (an arrow would never be seen).
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (b) => {
  let chunk = b.toString("utf8");
  if (extSend && lineBuf === "" && chunk === "\x1b[D") {
    extSend({ t: "ev", type: "leave" });
    return;
  }
  lineBuf += chunk;
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
    extSend = send;
    send({
      t: "hello",
      role: "extension",
      protocolVersion: 4, // keep in sync with PROTOCOL_VERSION (dependency-free fixture)
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
      // Real pi reports its current leaf on hello; tests exercising leaf
      // authority (extension vs growing file) inject one here.
      leafId: process.env.FAKE_PI_LEAF ?? null,
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
