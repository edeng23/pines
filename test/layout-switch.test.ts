/**
 * The experimental layout switch end to end: the daemon reports its strategy
 * in hello_ok, `relayout` with a strategy switches and persists it (across a
 * restart), and an unknown strategy is refused.
 */
import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { startDaemon, waitFor } from "./fixtures/daemon.js";

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

type Result = { t: "result"; re: string; ok: boolean; err?: string; layout?: string };

async function helloLayout(c: Client): Promise<string | undefined> {
  const hello = await waitFor(
    () => c.inbox.find((m) => (m as { t?: string }).t === "hello_ok") as { layout?: string } | undefined,
    5000,
    "hello_ok",
  );
  return hello.layout;
}

async function relayout(c: Client, id: string, layout?: string): Promise<Result> {
  c.wire.send({ t: "relayout", id, layout });
  return waitFor(
    () => c.inbox.find((m) => (m as { t?: string; re?: string }).t === "result" && (m as { re?: string }).re === id) as
      | Result
      | undefined,
    5000,
    `result ${id}`,
  );
}

describe("layout switch", () => {
  it("reports, switches, persists, and refuses the unknown", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-layout-"));
    const sessionsRoot = join(home, "pi-sessions");
    mkdirSync(sessionsRoot, { recursive: true });
    const env = { PINES_PI_SESSIONS: sessionsRoot, PINES_PI_BIN: "/nonexistent/pi" };

    const d1 = await startDaemon({ home, env });
    procs.push(d1.proc);
    const c1 = await connectClient(d1.sockPath);
    expect(await helloLayout(c1)).toBe("pca");

    const bad = await relayout(c1, "r1", "tsne");
    expect(bad.ok).toBe(false);
    expect(bad.err).toMatch(/unknown layout/);

    const switched = await relayout(c1, "r2", "groves");
    expect(switched.ok).toBe(true);
    expect(switched.layout).toBe("groves");

    // A plain relayout keeps the choice.
    const again = await relayout(c1, "r3");
    expect(again.ok).toBe(true);
    expect(again.layout).toBe("groves");

    c1.wire.send({ t: "shutdown" });
    await waitFor(() => (d1.proc.exitCode !== null ? true : undefined), 10_000, "daemon exit");
    c1.close();

    // The choice survives a restart.
    const d2 = await startDaemon({ home, env });
    procs.push(d2.proc);
    const c2 = await connectClient(d2.sockPath);
    expect(await helloLayout(c2)).toBe("groves");
    c2.close();
  }, 60_000);
});
