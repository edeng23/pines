/**
 * Renaming a tree: the `rename_tree` request must stick — in the live forest,
 * in the session file (as a session_info entry), across the watcher's
 * re-ingest of that write, and across a daemon restart.
 */
import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { startDaemon, waitFor } from "./fixtures/daemon.js";
import { branchedSession, eid, msg } from "./fixtures/sessions.js";

let home: string;
const procs: ChildProcess[] = [];

afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  if (home) rmSync(home, { recursive: true, force: true });
});

interface Client {
  wire: Wire;
  inbox: unknown[];
  close: () => void;
}

function connectClient(sockPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("error", reject);
    const inbox: unknown[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m));
    sock.once("connect", () => {
      wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols: 80, rows: 24 });
      resolve({ wire, inbox, close: () => sock.destroy() });
    });
  });
}

function forestOf(inbox: unknown[]): Array<Record<string, unknown>> | undefined {
  const hello = inbox.find((m) => (m as { t?: string }).t === "hello_ok") as
    | { forest?: Array<Record<string, unknown>> }
    | undefined;
  return hello?.forest;
}

/** Latest known summary of a tree: hello_ok forest patched by forest_updates. */
function summaryOf(
  inbox: unknown[],
  match: (t: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let latest = forestOf(inbox)?.find(match);
  for (const m of inbox) {
    const upd = m as { t?: string; upsert?: Array<Record<string, unknown>> };
    if (upd.t !== "forest_update") continue;
    const hit = upd.upsert?.find(match);
    if (hit) latest = hit;
  }
  return latest;
}

describe("rename tree", () => {
  it("renames a dormant tree and the name survives re-ingest and restart", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-rename-"));
    const sessionsRoot = join(home, "pi-sessions");
    const dir = join(sessionsRoot, "--tmp-proj--");
    mkdirSync(dir, { recursive: true });
    const sessionPath = join(dir, "2026-01-01T00-00-00-000Z_rename01.jsonl");
    const fixture = branchedSession("/tmp/proj");
    // The fixture carries a session_info name of its own — the rename must
    // beat it (last entry wins).
    writeFileSync(sessionPath, fixture.content);
    const env = { PINES_PI_SESSIONS: sessionsRoot };

    const d1 = await startDaemon({ home, env });
    procs.push(d1.proc);

    const a = await connectClient(d1.sockPath);
    const tree = await waitFor(
      () => summaryOf(a.inbox, (t) => typeof t.name === "string" && t.name !== ""),
      10_000,
      "ingested tree",
    );
    const treeId = tree.treeId as string;

    a.wire.send({ t: "rename_tree", id: "r1", treeId, name: "auth-fix" });
    const res = await waitFor(
      () => a.inbox.find((m) => (m as { re?: string }).re === "r1") as Record<string, unknown> | undefined,
      10_000,
      "rename result",
    );
    expect(res.ok).toBe(true);

    // Broadcast reflects the new name.
    const byId = (t: Record<string, unknown>) => t.treeId === treeId;
    await waitFor(
      () => (summaryOf(a.inbox, byId)?.name === "auth-fix" ? true : undefined),
      10_000,
      "renamed broadcast",
    );

    // Durable: the daemon wrote a session_info entry into the JSONL itself.
    expect(readFileSync(sessionPath, "utf8")).toContain('"auth-fix"');

    // The watcher's re-ingest of that very write must not undo the rename,
    // and neither must later session growth.
    appendFileSync(sessionPath, msg(eid(), fixture.ids.a2!, "user", "and one more thing") + "\n");
    await waitFor(
      () => ((summaryOf(a.inbox, byId)?.nodeCount as number) >= 7 ? true : undefined),
      10_000,
      "growth re-ingested",
    );
    expect(summaryOf(a.inbox, byId)?.name).toBe("auth-fix");
    a.close();

    // Unclean death, then a fresh daemon: the name comes back.
    d1.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    try {
      unlinkSync(d1.sockPath);
    } catch {
      /* may not exist */
    }
    const d2 = await startDaemon({ home, env });
    procs.push(d2.proc);
    const b = await connectClient(d2.sockPath);
    const restored = await waitFor(
      () => summaryOf(b.inbox, (t) => t.treeId === treeId),
      10_000,
      "restored tree",
    );
    expect(restored.name).toBe("auth-fix");
    b.close();
    d2.proc.kill("SIGKILL");
  }, 60_000);
});
