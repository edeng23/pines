/**
 * Shared daemon-startup helpers for the integration tests.
 *
 * Every test that spawns a real daemon has to answer one question before it
 * connects: is the socket listening yet? Getting that wrong is silent and
 * load-dependent, so it lives here once rather than in each test file.
 *
 * The trap: `net.connect()` on a missing unix socket does NOT throw — it
 * returns a Socket and reports the failure asynchronously on "error". So
 *
 *     try { connect(p); return true } catch { return undefined }
 *
 * is satisfied on its first tick whether or not anything is listening, which
 * turns the poll into a no-op and leaves a fixed sleep as the real guard. That
 * sleep has to cover node boot, two native module loads, opening the database,
 * running migrations and starting the watcher — fine on an idle machine, not
 * fine when the rest of the suite is running alongside it. `isListening` waits
 * for the "connect" event instead, which is the only honest signal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const CLI = join(ROOT, "dist", "cli.js");
export const FAKE_PI = join(HERE, "fake-pi.mjs");

/** Resolves true only once something actually accepts a connection. */
export function isListening(sockPath: string): Promise<boolean> {
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
export async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
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

export interface StartedDaemon {
  proc: ChildProcess;
  sockPath: string;
  /** Everything the daemon wrote to stderr, for failure messages. */
  stderr: () => string;
}

/**
 * Spawns a daemon and returns once its socket genuinely accepts connections.
 *
 * stderr is captured rather than discarded: when the daemon dies during boot
 * the useful error is on its stderr, and throwing it here is the difference
 * between naming the bug and staring at `connect ENOENT`.
 */
export async function startDaemon(opts: {
  home: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<StartedDaemon> {
  const sockPath = join(opts.home, "pines.sock");
  const proc = spawn(process.execPath, [CLI, "server"], {
    env: { ...process.env, PINES_HOME: opts.home, ...opts.env },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let err = "";
  proc.stderr?.on("data", (c) => (err += String(c)));
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  proc.once("exit", (code, signal) => (exited = { code, signal }));

  try {
    await waitFor(
      async () => {
        // A daemon that died will never bind — fail now with the real reason.
        if (exited) {
          throw new Error(
            `daemon exited during startup (code ${exited.code}, signal ${exited.signal})` +
              (err.trim() ? `\n--- daemon stderr ---\n${err.trim()}` : " with no stderr"),
          );
        }
        return (await isListening(sockPath)) ? true : undefined;
      },
      opts.timeoutMs ?? 20_000,
      `daemon socket at ${sockPath}`,
    );
  } catch (e) {
    proc.kill("SIGKILL");
    const detail = err.trim() ? `\n--- daemon stderr ---\n${err.trim()}` : "";
    throw new Error(`${(e as Error).message}${detail}`);
  }

  return { proc, sockPath, stderr: () => err };
}
