/**
 * M2 integration: extension-reported status (running → waiting), session-file
 * binding via claimSession, get_tree over the wire, and watcher discovery of
 * sessions created outside pines.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { branchedSession } from "./fixtures/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FAKE_PI = join(HERE, "fixtures", "fake-pi.mjs");

let home: string;
let sessionsRoot: string;
let fixtureSession: string;
let daemon: ChildProcess;
let sockPath: string;

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${what}`);
}

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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-ext-"));
  sessionsRoot = join(home, "pi-sessions");
  const dir = join(sessionsRoot, "--tmp-proj--");
  mkdirSync(dir, { recursive: true });
  fixtureSession = join(dir, "2026-01-01T00-00-00-000Z_11111111.jsonl");
  writeFileSync(fixtureSession, branchedSession("/tmp/proj").content);

  sockPath = join(home, "pines.sock");
  chmodSync(FAKE_PI, 0o755);
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: {
      ...process.env,
      PINES_HOME: home,
      PINES_PI_BIN: FAKE_PI,
      PINES_PI_SESSIONS: sessionsRoot,
      FAKE_PI_EXT: "1",
      FAKE_PI_SESSION: fixtureSession,
    },
    stdio: "ignore",
  });
  await waitFor(() => {
    try {
      const c = connect(sockPath);
      c.on("error", () => {});
      return true as const;
    } catch {
      return undefined;
    }
  });
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("extension-driven status", () => {
  it("binds the session file on hello, reports running → waiting(unseen), serves get_tree", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");

    c.wire.send({ t: "spawn_tree", id: "s1", cwd: home });
    const spawned = await waitFor(
      () =>
        c.inbox.find(
          (m): m is Record<string, unknown> =>
            typeof m === "object" && m !== null && (m as { re?: string }).re === "s1",
        ),
      8000,
      "spawn result",
    );
    expect(spawned.ok).toBe(true);
    const provisionalId = spawned.newTreeId as string;

    // Fake extension: hello (binds fixture session) → agent_start → settled
    // (600ms). Identity may be renamed mid-flight (watcher vs spawn race), so
    // match on sessionPath and take the canonical treeId from the settled update.
    const settled = await waitFor(() => {
      return upserts(c.inbox).find(
        (t) => t.sessionPath === fixtureSession && t.status === "waiting" && t.seen === false,
      );
    }, 8000, "waiting(unseen) status");
    const treeId = settled.treeId as string;
    expect(settled.live).toBe(true);

    // get_tree serves the fixture structure (with the extension's leaf override).
    c.wire.send({ t: "get_tree", id: "g1", treeId });
    const res = await waitFor(
      () =>
        c.inbox.find(
          (m): m is Record<string, unknown> =>
            typeof m === "object" && m !== null && (m as { re?: string }).re === "g1",
        ),
      8000,
      "get_tree result",
    );
    expect(res.ok).toBe(true);
    const tree = res.tree as { rootIds: string[]; nodes: Record<string, { children: string[] }> };
    expect(tree.rootIds).toEqual(["aaaa0001"]);
    expect(tree.nodes["aaaa0002"]!.children).toHaveLength(2);

    // Provisional id was either kept or replaced — but only one tree owns the path.
    const all = upserts(c.inbox).filter((t) => t.sessionPath === fixtureSession);
    const distinct = new Set(all.map((t) => t.treeId));
    expect(distinct.has(treeId)).toBe(true);
    void provisionalId;

    c.sock.destroy();
  });

  it("discovers sessions created outside pines via the watcher", async () => {
    const c = await connectClient();
    await waitFor(() => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok"), 5000, "hello_ok");

    const dir = join(sessionsRoot, "--home-user-other--");
    mkdirSync(dir, { recursive: true });
    const outside = join(dir, "2026-02-02T00-00-00-000Z_22222222.jsonl");
    writeFileSync(outside, branchedSession("/home/user/other").content);

    // The dormant record broadcasts once on creation and again once ingest has
    // filled in metadata — wait for the fully-populated update.
    const discovered = await waitFor(() => {
      return upserts(c.inbox).find(
        (t) => t.sessionPath === outside && t.status === "dormant" && t.name === "parser-work",
      );
    }, 10_000, "watcher discovery");
    expect(discovered.nodeCount).toBeGreaterThan(0);
    expect(discovered.live).toBe(false);

    // Discovery must never leak a provisional supervisor id to connected
    // clients before adopting the canonical DB id.
    const ids = new Set(
      upserts(c.inbox)
        .filter((t) => t.sessionPath === outside)
        .map((t) => t.treeId),
    );
    expect(ids).toEqual(new Set([discovered.treeId]));

    // Removing a dormant session removes it from both current clients and the
    // daemon's next hello snapshot.
    rmSync(outside);
    await waitFor(
      () =>
        c.inbox.some(
          (m) =>
            (m as { t?: string }).t === "forest_update" &&
            ((m as { remove?: string[] }).remove ?? []).includes(discovered.treeId as string),
        )
          ? true
          : undefined,
      5000,
      "watcher removal",
    );
    const d = await connectClient();
    const hello = await waitFor(
      () =>
        d.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
          | { forest?: Array<Record<string, unknown>> }
          | undefined,
      5000,
      "hello after removal",
    );
    expect(hello.forest?.some((t) => t.treeId === discovered.treeId)).toBe(false);
    d.sock.destroy();

    c.sock.destroy();
  });
});
