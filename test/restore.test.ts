/**
 * M6: forest state survives an unclean daemon death (kill -9) — trees come
 * back as dormant with their metadata and positions from SQLite.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { branchedSession } from "./fixtures/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let procs: ChildProcess[] = [];
let home: string;

afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function socketReady(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = connect(path);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`socket never became ready: ${path}`);
}

function startDaemon(env: Record<string, string>): ChildProcess {
  const d = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  procs.push(d);
  return d;
}

async function helloForest(sockPath: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    sock.once("error", reject);
    const wire = new Wire(sock);
    wire.on("msg", (m) => {
      const msg = m as { t?: string; forest?: Array<Record<string, unknown>> };
      if (msg.t === "hello_ok") {
        sock.destroy();
        resolve(msg.forest ?? []);
      }
    });
    sock.once("connect", () => {
      wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols: 80, rows: 24 });
    });
  });
}

describe("restart restore", () => {
  it("restores trees as dormant with metadata and positions after kill -9", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-restore-"));
    const sessionsRoot = join(home, "pi-sessions");
    const dir = join(sessionsRoot, "--tmp-proj--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_55555555.jsonl"), branchedSession("/tmp/proj").content);
    const sockPath = join(home, "pines.sock");
    const env = { PINES_HOME: home, PINES_PI_SESSIONS: sessionsRoot };

    const d1 = startDaemon(env);
    await socketReady(sockPath);
    // Wait for ingest to complete (name populated).
    let before: Record<string, unknown> | undefined;
    {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !before) {
        const forest = await helloForest(sockPath);
        before = forest.find((x) => x.name === "parser-work");
        if (!before) await new Promise((r) => setTimeout(r, 200));
      }
      if (!before) throw new Error("initial ingest never completed");
    }

    expect(before.nodeCount).toBeGreaterThan(0);
    const savedX = before.x as number;
    const savedY = before.y as number;
    expect(savedX !== 0 || savedY !== 0).toBe(true);

    // Archive it (dormant, so allowed) — the flag must survive the crash too.
    await new Promise<void>((resolve, reject) => {
      const sock = connect(sockPath);
      sock.once("error", reject);
      const wire = new Wire(sock);
      wire.on("msg", (m) => {
        if ((m as { re?: string }).re === "arch1") {
          expect((m as { ok?: boolean }).ok).toBe(true);
          sock.destroy();
          resolve();
        }
      });
      sock.once("connect", () => {
        wire.send({ t: "hello", role: "client", protocolVersion: PROTOCOL_VERSION, cols: 80, rows: 24 });
        wire.send({ t: "set_archived", id: "arch1", treeId: before!.treeId, archived: true });
      });
    });

    // Unclean death: no shutdown handler runs, socket file left behind.
    d1.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    try {
      unlinkSync(sockPath);
    } catch {
      /* may not exist */
    }

    startDaemon(env);
    await socketReady(sockPath);
    await new Promise((r) => setTimeout(r, 400));

    const after = await helloForest(sockPath);
    const restored = after.find((x) => x.name === "parser-work");
    expect(restored).toBeTruthy();
    expect(restored!.status).toBe("dormant");
    expect(restored!.live).toBe(false);
    expect(restored!.nodeCount).toBe(before.nodeCount);
    expect(restored!.x).toBe(savedX);
    expect(restored!.y).toBe(savedY);
    expect(restored!.archived).toBe(true);
  }, 40_000);
});
