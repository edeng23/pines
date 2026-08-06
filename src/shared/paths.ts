import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * All pines state lives under ~/.pines (overridable with PINES_HOME, which the
 * test suite uses to sandbox daemons).
 */
export function pinesHome(): string {
  return process.env.PINES_HOME ?? join(homedir(), ".pines");
}

export function ensurePinesHome(): string {
  const home = pinesHome();
  mkdirSync(home, { recursive: true });
  return home;
}

export function socketPath(): string {
  return process.env.PINES_SOCK ?? join(pinesHome(), "pines.sock");
}

export function dbPath(): string {
  return join(pinesHome(), "pines.db");
}

export function modelsDir(): string {
  return join(pinesHome(), "models");
}

export function configPath(): string {
  return join(pinesHome(), "config.json");
}

export function daemonLogPath(): string {
  return join(pinesHome(), "daemon.log");
}

/**
 * Pid of the daemon that owns the socket. The handshake carries `daemonPid`
 * too, but a daemon running stale code rejects the handshake before we ever
 * learn its pid — that is exactly when we most need to signal it.
 */
export function daemonPidPath(): string {
  return join(pinesHome(), "daemon.pid");
}

/** Client UI state (sidebar width/visibility, …) — separate from config.json. */
export function uiStatePath(): string {
  return join(pinesHome(), "ui.json");
}

/** pi's default session root (all cwd-encoded subdirectories live under it). */
export function piSessionsRoot(): string {
  return process.env.PINES_PI_SESSIONS ?? join(homedir(), ".pi", "agent", "sessions");
}
