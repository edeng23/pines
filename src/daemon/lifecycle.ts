/**
 * Daemon lifecycle: auto-spawn as a detached background process, socket
 * liveness probing, and shutdown.
 *
 * `pines` (bare) probes the socket; if nothing is listening it re-execs this
 * same installation as `pines server` with detached:true (setsid on POSIX) and
 * null stdio, then polls until the socket accepts connections.
 */
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { daemonPidPath, ensurePinesHome, socketPath } from "../shared/paths.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { Wire } from "../shared/wire.js";

const SERVER_READY_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 100;
/** Longest we wait for a SIGTERMed daemon to actually exit before reporting failure. */
const TERM_TIMEOUT_MS = 5000;

/** True if a live server is accepting connections on the pines socket. */
export function isServerListening(path = socketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

/** Record this process as the daemon that owns the socket. */
export function writeDaemonPid(): void {
  try {
    writeFileSync(daemonPidPath(), `${process.pid}\n`);
  } catch {
    // A missing pidfile only costs us the SIGTERM fallback; never fail to boot.
  }
}

export function clearDaemonPid(): void {
  try {
    unlinkSync(daemonPidPath());
  } catch {
    /* ignore */
  }
}

/** Pid recorded by the running daemon, or undefined if absent/garbage/dead. */
export function readDaemonPid(): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(daemonPidPath(), "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return isProcessAlive(pid) ? pid : undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM a daemon and wait for it to actually go. Returns false if it is still
 * alive after the timeout — callers must not claim success on our behalf.
 */
export async function terminateDaemon(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  const deadline = Date.now() + TERM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * Ask the daemon on the socket to shut down. Resolves with the pid it reported
 * (from hello_ok, or from hello_err when it speaks a different protocol), so a
 * caller can fall back to a signal when the conversation goes nowhere.
 */
export function requestDaemonShutdown(): Promise<{ closed: boolean; daemonPid?: number }> {
  return new Promise((resolveDone) => {
    let daemonPid: number | undefined;
    const sock = connect(socketPath());
    const wire = new Wire(sock);
    const finish = (closed: boolean) => resolveDone({ closed, daemonPid });
    sock.once("error", () => finish(false));
    wire.on("close", () => finish(true));
    wire.on("msg", (raw) => {
      const msg = raw as { t?: string; daemonPid?: number };
      if (msg.t === "hello_ok" || msg.t === "hello_err") daemonPid = msg.daemonPid;
    });
    sock.once("connect", () => {
      wire.send({
        t: "hello",
        role: "client",
        protocolVersion: PROTOCOL_VERSION,
        cols: 80,
        rows: 24,
      });
      wire.send({ t: "shutdown" });
    });
    setTimeout(() => finish(false), 5000);
  });
}

/**
 * Replace whatever daemon holds the socket with one spawned from this install.
 *
 * Stopping it is only half the job: `ensureDaemon` returns the moment anything
 * accepts a connection, so handing straight over to it would re-adopt the very
 * daemon we asked to leave. We wait for the socket to go quiet first, and throw
 * rather than pretend when it never does — a caller that cannot get a fresh
 * daemon needs to say so, not silently keep the old one.
 */
export async function restartDaemon(): Promise<void> {
  const recorded = readDaemonPid();
  const { daemonPid } = await requestDaemonShutdown();
  const pid = daemonPid ?? recorded;
  if (pid !== undefined && isProcessAlive(pid)) await terminateDaemon(pid);

  const deadline = Date.now() + TERM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isServerListening())) break;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  if (await isServerListening()) {
    throw new Error(`a pines daemon is still holding ${socketPath()} after a shutdown request`);
  }
  await ensureDaemon();
}

/** Path to the built CLI entry (dist/cli.js), resolved from this module. */
function cliEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/daemon/lifecycle.js → dist/cli.js (same layout under src/ when run via tsx)
  return join(here, "..", "cli.js");
}

export function spawnServerDaemon(): number | undefined {
  ensurePinesHome();
  const entry = cliEntryPath();
  const child = spawn(process.execPath, [entry, "server"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PINES_STARTUP_CWD: process.cwd() },
  });
  child.unref();
  return child.pid;
}

/**
 * Ensure a daemon is running; spawn one if needed. Returns once the socket is
 * accepting connections. Throws after the readiness timeout.
 */
export async function ensureDaemon(): Promise<void> {
  const path = socketPath();
  if (await isServerListening(path)) return;

  // A socket file with no listener is stale (daemon died without cleanup).
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Racing another client doing the same cleanup is fine.
    }
  }

  spawnServerDaemon();

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerListening(path)) return;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  throw new Error(
    `pines daemon did not become ready within ${SERVER_READY_TIMEOUT_MS / 1000}s (socket: ${path})`,
  );
}
