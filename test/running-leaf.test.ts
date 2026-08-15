/**
 * Leaf authority while an agent WORKS: the extension only reports a new leaf
 * on settle, so mid-run the growing session file's tail is the truth. The
 * tip/attach pointer must follow the newest message, not pin to the previous
 * settle point (which is exactly what the extension's last word says).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { branchedSession, msg } from "./fixtures/sessions.js";
import { FAKE_PI, startDaemon, waitFor } from "./fixtures/daemon.js";

let home: string;
let fixtureSession: string;
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

function upserts(inbox: unknown[]): Array<Record<string, unknown>> {
  return inbox
    .filter((m) => (m as { t?: string }).t === "forest_update")
    .flatMap((m) => ((m as { upsert?: Array<Record<string, unknown>> }).upsert ?? []));
}

function result(inbox: unknown[], re: string): Record<string, unknown> | undefined {
  return inbox.find(
    (m): m is Record<string, unknown> =>
      typeof m === "object" && m !== null && (m as { re?: string }).re === re,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-runleaf-"));
  const sessionsRoot = join(home, "pi-sessions");
  const dir = join(sessionsRoot, "--tmp-proj--");
  mkdirSync(dir, { recursive: true });
  fixtureSession = join(dir, "2026-01-01T00-00-00-000Z_22222222.jsonl");
  writeFileSync(fixtureSession, branchedSession("/tmp/proj").content);

  chmodSync(FAKE_PI, 0o755);
  const started = await startDaemon({
    home,
    env: {
      PINES_PI_BIN: FAKE_PI,
      PINES_PI_SESSIONS: sessionsRoot,
      FAKE_PI_EXT: "1",
      FAKE_PI_SESSION: fixtureSession,
      // The extension's last word: an OLD leaf (the fixture's a2), and a
      // settle far in the future — the agent stays "running" for the test.
      FAKE_PI_LEAF: "aaaa0004",
      FAKE_PI_SETTLE_MS: "60000",
    },
  });
  daemon = started.proc;
  sockPath = started.sockPath;
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("leaf authority while running", () => {
  it("get_tree follows the growing file's tail mid-run, not the stale extension leaf", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");

    c.wire.send({ t: "spawn_tree", id: "s1", cwd: home });
    const spawned = await waitFor(() => result(c.inbox, "s1"), 8000, "spawn result");
    expect(spawned.ok).toBe(true);

    // Extension hello binds the fixture; agent_start makes it "running".
    const running = await waitFor(
      () => upserts(c.inbox).find((t) => t.sessionPath === fixtureSession && t.status === "running"),
      8000,
      "running status",
    );
    const treeId = running.treeId as string;

    // The conversation grows mid-run: a new user turn lands in the file.
    appendFileSync(fixtureSession, msg("bbbb0001", "aaaa0004", "user", "one more thing") + "\n");
    await waitFor(
      () => (upserts(c.inbox).some((t) => t.treeId === treeId && t.leafId === "bbbb0001") ? true : undefined),
      8000,
      "leaf follows the file tail",
    );

    // get_tree agrees: the tip sits on the new message, not the old settle
    // point the extension reported on hello.
    c.wire.send({ t: "get_tree", id: "g1", treeId });
    const res = await waitFor(() => result(c.inbox, "g1"), 8000, "get_tree result");
    expect(res.ok).toBe(true);
    expect((res.tree as { leafId: string }).leafId).toBe("bbbb0001");
  }, 30_000);
});
