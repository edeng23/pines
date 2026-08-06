/**
 * Daemon shutdown and socket ownership.
 *
 * A daemon outlives the `dist/` it was built from, so the handshake it speaks
 * can go stale under a rebuilt client. These cover the two ways that used to
 * leave an unkillable daemon behind: `shutdown` being dropped along with the
 * version-mismatched hello that carried it, and a second daemon silently
 * unlinking a live socket to take the path for itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FAKE_PI = join(HERE, "fixtures", "fake-pi.mjs");
const CLI = join(ROOT, "dist", "cli.js");

let home: string;
let daemon: ChildProcess;
let sockPath: string;
let pidPath: string;

function isListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(sockPath);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

/** Awaits `fn`'s result, so async probes (socket liveness) work as predicates. */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 8000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-kill-test-"));
  sockPath = join(home, "pines.sock");
  pidPath = join(home, "daemon.pid");
  chmodSync(FAKE_PI, 0o755);
  daemon = spawn(process.execPath, [CLI, "server"], {
    env: { ...process.env, PINES_HOME: home, PINES_PI_BIN: FAKE_PI },
    stdio: "ignore",
  });
  await waitFor(async () => ((await isListening()) ? true : undefined), 15000, "daemon socket");
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("daemon shutdown", () => {
  it("records its pid so a client that cannot speak its protocol can still signal it", async () => {
    const pid = await waitFor(
      () => (existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : undefined),
      5000,
      "pidfile",
    );
    expect(pid).toBe(daemon.pid);
    expect(alive(pid)).toBe(true);
  });

  it("refuses to unlink a live socket out from under the daemon that owns it", async () => {
    const intruder = spawn(process.execPath, [CLI, "server"], {
      env: { ...process.env, PINES_HOME: home, PINES_PI_BIN: FAKE_PI },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    intruder.stderr?.on("data", (c) => (stderr += String(c)));
    const code = await new Promise<number | null>((r) => intruder.once("exit", (c) => r(c)));

    expect(code).toBe(1);
    expect(stderr).toContain("already listening");
    // The incumbent — and its socket — must be untouched.
    expect(existsSync(sockPath)).toBe(true);
    expect(await isListening()).toBe(true);
    expect(alive(daemon.pid!)).toBe(true);
  });

  // Must run last: it stops the shared daemon.
  it("honors shutdown from a client whose protocol version it rejects", async () => {
    const sock = connect(sockPath);
    sock.on("error", () => {}); // a dead daemon must fail THIS test, not the process
    const inbox: Record<string, unknown>[] = [];
    const wire = new Wire(sock);
    wire.on("msg", (m) => inbox.push(m as Record<string, unknown>));
    await new Promise<void>((r) => sock.once("connect", () => r()));

    // Exactly what `pines kill` sends, from a client the daemon cannot talk to.
    wire.send({
      t: "hello",
      role: "client",
      protocolVersion: PROTOCOL_VERSION + 1000,
      cols: 80,
      rows: 24,
    });
    wire.send({ t: "shutdown" });

    const err = await waitFor(() => inbox.find((m) => m.t === "hello_err"), 5000, "hello_err");
    expect(err.reason).toBe("version");
    // The pid travels on the rejection so the client has a fallback.
    expect(err.daemonPid).toBe(daemon.pid);

    await waitFor(async () => (alive(daemon.pid!) ? undefined : true), 10000, "daemon to exit");
    expect(await isListening()).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    sock.destroy();
  });
});
