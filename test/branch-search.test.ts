/**
 * M4 integration: FTS search over the wire, new-tree branch via pi's SDK
 * (createBranchedSession), and durable in-place branch on a dormant tree.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { branchedSession } from "./fixtures/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let home: string;
let sessionsRoot: string;
let fixtureSession: string;
let fixtureIds: Record<string, string>;
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

interface TestClient {
  wire: Wire;
  sock: Socket;
  inbox: unknown[];
  request: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

let reqCounter = 0;
function connectClient(): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("error", reject);
    const inbox: unknown[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m));
    sock.once("connect", () => {
      wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols: 100, rows: 30 });
      resolve({
        wire,
        sock,
        inbox,
        request: async (msg) => {
          const id = `q${++reqCounter}`;
          wire.send({ ...msg, id });
          return waitFor(
            () =>
              inbox.find(
                (m): m is Record<string, unknown> =>
                  typeof m === "object" && m !== null && (m as { re?: string }).re === id,
              ),
            8000,
            `response to ${String(msg.t)}`,
          );
        },
      });
    });
  });
}

function upserts(inbox: unknown[]): Array<Record<string, unknown>> {
  return inbox
    .filter((m) => (m as { t?: string }).t === "forest_update")
    .flatMap((m) => ((m as { upsert?: Array<Record<string, unknown>> }).upsert ?? []));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-branch-"));
  sessionsRoot = join(home, "pi-sessions");
  const dir = join(sessionsRoot, "--tmp-proj--");
  mkdirSync(dir, { recursive: true });
  fixtureSession = join(dir, "2026-01-01T00-00-00-000Z_44444444.jsonl");
  const fixture = branchedSession("/tmp/proj");
  fixtureIds = fixture.ids;
  writeFileSync(fixtureSession, fixture.content);

  sockPath = join(home, "pines.sock");
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: { ...process.env, PINES_HOME: home, PINES_PI_SESSIONS: sessionsRoot },
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

describe("search + branch", () => {
  it("finds indexed user messages via FTS and returns tree + entry ids", async () => {
    const c = await connectClient();
    // Wait until the watcher has ingested the fixture.
    await waitFor(
      () =>
        upserts(c.inbox)
          .concat(
            ((c.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
              | { forest?: Array<Record<string, unknown>> }
              | undefined)?.forest ?? []),
          )
          .find((t) => t.sessionPath === fixtureSession && (t.nodeCount as number) > 0),
      10_000,
      "fixture ingest",
    );

    const res = await c.request({ t: "search", query: "embeddings" });
    expect(res.ok).toBe(true);
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.entryId).toBe(fixtureIds.u3);
    expect((hits[0]!.snippet as string).toLowerCase()).toContain("embeddings");

    // Phrase from a different branch is also reachable (abandoned branches indexed).
    const res2 = await c.request({ t: "search", query: "incremental" });
    expect(res2.ok).toBe(true);
    expect((res2.hits as unknown[]).length).toBeGreaterThan(0);

    c.sock.destroy();
  });

  it("rejects new-tree branch from the root entry with a clear reason", async () => {
    // pi's createBranchedSession returns a path but writes no file for the
    // session's first entry — pines must surface that, not 'failed to ingest'.
    const c = await connectClient();
    const hello = await waitFor(
      () =>
        c.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
          | { forest?: Array<Record<string, unknown>> }
          | undefined,
      5000,
      "hello_ok",
    );
    const source = hello.forest!.find((t) => t.sessionPath === fixtureSession)!;
    const res = await c.request({
      t: "branch",
      treeId: source.treeId as string,
      nodeId: "aaaa0001", // u1: the root entry
      mode: "new-tree",
      spawn: false,
    });
    expect(res.ok).toBe(false);
    expect(String(res.err)).toContain("first entry");
  });

  it("branches a dormant tree to a new tree containing only the root→node path", async () => {
    const c = await connectClient();
    const hello = await waitFor(
      () =>
        c.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
          | { forest?: Array<Record<string, unknown>> }
          | undefined,
      5000,
      "hello_ok",
    );
    const source = hello.forest!.find((t) => t.sessionPath === fixtureSession)!;
    const treeId = source.treeId as string;

    const res = await c.request({
      t: "branch",
      treeId,
      nodeId: fixtureIds.a1,
      mode: "new-tree",
      spawn: false,
    });
    expect(res.ok).toBe(true);
    const newTreeId = res.newTreeId as string;
    expect(newTreeId).not.toBe(treeId);

    const treeRes = await c.request({ t: "get_tree", treeId: newTreeId });
    expect(treeRes.ok).toBe(true);
    const tree = treeRes.tree as {
      rootIds: string[];
      leafId: string | null;
      nodes: Record<string, { children: string[] }>;
    };
    // Only the u1 → a1 path came over; the u2/u3 branches did not.
    expect(tree.nodes[fixtureIds.u1!]).toBeTruthy();
    expect(tree.nodes[fixtureIds.a1!]).toBeTruthy();
    expect(tree.nodes[fixtureIds.u2!]).toBeUndefined();
    expect(tree.nodes[fixtureIds.u3!]).toBeUndefined();

    // Lineage: the new tree points back at the source session.
    const newSummary = await waitFor(
      () => upserts(c.inbox).find((t) => t.treeId === newTreeId && t.parentSessionPath),
      8000,
      "lineage in forest update",
    );
    expect(newSummary.parentSessionPath).toBe(fixtureSession);

    // Header of the new file records the parent session (pi-native lineage).
    const newPath = newSummary.sessionPath as string;
    const headerLine = JSON.parse(readFileSync(newPath, "utf8").split("\n")[0]!) as Record<string, unknown>;
    expect(headerLine.parentSession).toBe(fixtureSession);

    c.sock.destroy();
  });

  it("in-place branch on a dormant tree durably moves the leaf under the branch point", async () => {
    const c = await connectClient();
    const hello = await waitFor(
      () =>
        c.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
          | { forest?: Array<Record<string, unknown>> }
          | undefined,
      5000,
      "hello_ok",
    );
    const source = hello.forest!.find((t) => t.sessionPath === fixtureSession)!;
    const treeId = source.treeId as string;

    const res = await c.request({
      t: "branch",
      treeId,
      nodeId: fixtureIds.a2,
      mode: "in-place",
    });
    expect(res.ok).toBe(true);

    const treeRes = await c.request({ t: "get_tree", treeId });
    const tree = treeRes.tree as {
      leafId: string | null;
      nodes: Record<string, { parentId: string | null; kind: string }>;
    };
    // The durable marker (custom entry) is the new leaf, parented at a2.
    expect(tree.leafId).toBeTruthy();
    const leaf = tree.nodes[tree.leafId!]!;
    expect(leaf.parentId).toBe(fixtureIds.a2);
    expect(leaf.kind).toBe("custom");

    c.sock.destroy();
  });
});
