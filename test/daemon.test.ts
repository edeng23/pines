/**
 * M1 integration: real daemon subprocess owning a fake-pi PTY; client attach,
 * input echo, and — the core promise — the agent keeps running while no client
 * is connected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { FAKE_PI, startDaemon, waitFor } from "./fixtures/daemon.js";

let home: string;
let daemon: ChildProcess;
let sockPath: string;

function connectClient(): Promise<{ wire: Wire; sock: Socket; inbox: unknown[] }> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("error", reject);
    const inbox: unknown[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m));
    sock.once("connect", () => {
      wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols: 100, rows: 30 });
      resolve({ wire, sock, inbox });
    });
  });
}

function findResult(inbox: unknown[], re: string): Record<string, unknown> | undefined {
  return inbox.find(
    (m): m is Record<string, unknown> =>
      typeof m === "object" && m !== null && (m as { re?: string }).re === re,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-test-"));
  chmodSync(FAKE_PI, 0o755);
  const started = await startDaemon({ home, env: { PINES_PI_BIN: FAKE_PI } });
  daemon = started.proc;
  sockPath = started.sockPath;
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("daemon", () => {
  it("spawns an agent, attaches with a faithful snapshot, echoes input, and keeps the agent running across full disconnect", async () => {
    const a = await connectClient();
    await waitFor(() => a.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");

    // Spawn a tree running fake-pi.
    a.wire.send({ t: "spawn_tree", id: "s1", cwd: home });
    const spawned = await waitFor(() => findResult(a.inbox, "s1"), 8000, "spawn result");
    expect(spawned.ok).toBe(true);
    const treeId = spawned.newTreeId as string;

    // Observe at least one tick before taking a fresh snapshot. This avoids
    // making process startup speed part of the assertion while still proving
    // that the snapshot contains output emitted before the latest attach.
    a.wire.send({ t: "attach", id: "warmup", treeId, cols: 100, rows: 30 });
    await waitFor(() => findResult(a.inbox, "warmup"), 8000, "warmup attach");
    await waitFor(() => (currentTick(a.inbox) > 0 ? true : undefined), 8000, "first tick");
    a.wire.send({ t: "detach", treeId });

    a.wire.send({ t: "attach", id: "a1", treeId, cols: 100, rows: 30 });
    const attach = await waitFor(() => findResult(a.inbox, "a1"), 8000, "snapshot attach");
    const snapshot = Buffer.from(attach.snapshot as string, "base64").toString("utf8");

    const term = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    await new Promise<void>((r) => term.write(snapshot, r));
    const screenText = () => {
      const lines: string[] = [];
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        lines.push(buf.getLine(y)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    };
    expect(screenText()).toContain("FAKE-PI READY");
    expect(screenText()).toMatch(/tick \d+/);

    // Input round-trip.
    a.wire.send({ t: "input", treeId, data: Buffer.from("hello\r").toString("base64") });
    await waitFor(() => {
      const outs = a.inbox.filter((m) => (m as { t?: string }).t === "output");
      const text = outs
        .map((m) => Buffer.from((m as { data: string }).data, "base64").toString("utf8"))
        .join("");
      return text.includes("echo:hello") ? true : undefined;
    }, 8000, "echo output");

    // Record latest tick, then fully disconnect.
    const t1 = currentTick(a.inbox);
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 1200));

    // Reconnect: the agent must still be live and have advanced.
    const b = await connectClient();
    const hello = await waitFor(
      () => b.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as { forest?: Array<Record<string, unknown>> } | undefined,
      5000,
      "hello_ok (2nd client)",
    );
    const tree = hello.forest?.find((t) => t.treeId === treeId);
    expect(tree?.live).toBe(true);

    b.wire.send({ t: "attach", id: "a2", treeId, cols: 100, rows: 30 });
    const attach2 = await waitFor(() => findResult(b.inbox, "a2"), 8000, "reattach");
    const snap2 = Buffer.from(attach2.snapshot as string, "base64").toString("utf8");
    const ticks = [...snap2.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ticks)).toBeGreaterThan(t1);

    // Kill the agent; expect crash/completed status broadcast.
    b.wire.send({ t: "kill_agent", treeId });
    await waitFor(() => {
      const upd = b.inbox
        .filter((m) => (m as { t?: string }).t === "forest_update")
        .flatMap((m) => ((m as { upsert?: Array<Record<string, unknown>> }).upsert ?? []))
        .find((t) => t.treeId === treeId && t.live === false);
      return upd ? true : undefined;
    }, 8000, "agent exit status");

    b.sock.destroy();
    term.dispose();
  });

  it("refuses to archive a tree with a live agent, archives it once killed", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");

    c.wire.send({ t: "spawn_tree", id: "ar-spawn", cwd: home });
    const spawned = await waitFor(() => findResult(c.inbox, "ar-spawn"), 8000, "spawn result");
    expect(spawned.ok).toBe(true);
    const treeId = spawned.newTreeId as string;

    // Live agent → archive refused with a reason.
    c.wire.send({ t: "set_archived", id: "ar-live", treeId, archived: true });
    const refused = await waitFor(() => findResult(c.inbox, "ar-live"), 8000, "refusal");
    expect(refused.ok).toBe(false);
    expect(String(refused.err)).toContain("live agent");

    const upsertsFor = (id: string) =>
      c.inbox
        .filter((m) => (m as { t?: string }).t === "forest_update")
        .flatMap((m) => ((m as { upsert?: Array<Record<string, unknown>> }).upsert ?? []))
        .filter((t) => t.treeId === id);

    c.wire.send({ t: "kill_agent", treeId });
    await waitFor(
      () => (upsertsFor(treeId).some((t) => t.live === false) ? true : undefined),
      8000,
      "agent death",
    );

    // Dead agent → archive succeeds and the new state is broadcast.
    c.wire.send({ t: "set_archived", id: "ar-ok", treeId, archived: true });
    const ok = await waitFor(() => findResult(c.inbox, "ar-ok"), 8000, "archive result");
    expect(ok.ok).toBe(true);
    await waitFor(
      () => (upsertsFor(treeId).some((t) => t.archived === true) ? true : undefined),
      8000,
      "archived broadcast",
    );

    // Unknown trees fail cleanly.
    c.wire.send({ t: "set_archived", id: "ar-nope", treeId: "t_missing", archived: true });
    const nope = await waitFor(() => findResult(c.inbox, "ar-nope"), 8000, "unknown tree");
    expect(nope.ok).toBe(false);

    c.sock.destroy();
  });

  it("rejects spawning in a nonexistent cwd with a clear reason", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");
    c.wire.send({ t: "spawn_tree", id: "bad1", cwd: join(home, "does-not-exist") });
    const res = await waitFor(() => findResult(c.inbox, "bad1"), 8000, "spawn result");
    expect(res.ok).toBe(false);
    expect(String(res.err)).toContain("cwd does not exist");
    c.sock.destroy();
  });

  it("rejects protocol version mismatches", async () => {
    const sock = connect(sockPath);
    sock.on("error", () => {}); // a dead daemon must fail THIS test, not the process
    const inbox: unknown[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m));
    await new Promise<void>((r) => sock.once("connect", () => r()));
    wire.send({ t: "hello", role: "client", protocolVersion: 999, cols: 80, rows: 24 });
    const err = await waitFor(
      () => inbox.find((m) => (m as { t?: string }).t === "hello_err") as { reason?: string } | undefined,
      5000,
      "hello_err",
    );
    expect(err.reason).toBe("version");
    sock.destroy();
  });
});

function currentTick(inbox: unknown[]): number {
  const outs = inbox.filter((m) => (m as { t?: string }).t === "output");
  const text = outs
    .map((m) => Buffer.from((m as { data: string }).data, "base64").toString("utf8"))
    .join("");
  const ticks = [...text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1]));
  return ticks.length ? Math.max(...ticks) : 0;
}
