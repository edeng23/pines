/**
 * Build-version handshake: the client must notice when the daemon on the socket
 * is not the build that was installed.
 *
 * The daemon outlives every upgrade — nothing about replacing the package
 * restarts the process holding the ptys — so an old daemon keeps serving old
 * code under a freshly installed client. PROTOCOL_VERSION does not catch it
 * (a fix inside the daemon changes no wire shape), which is how a shipped fix
 * comes back as "wasn't this supposed to be fixed?". These cover the signal
 * that makes it visible and the restart that clears it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wire } from "../src/shared/wire.js";
import { PROTOCOL_VERSION } from "../src/shared/protocol.js";
import { isStaleDaemon, pinesVersion, UNKNOWN_VERSION } from "../src/shared/version.js";
import { CLI, FAKE_PI, ROOT, isListening, startDaemon, waitFor } from "./fixtures/daemon.js";
import { connect } from "node:net";

describe("isStaleDaemon", () => {
  it("accepts only our own build", () => {
    expect(isStaleDaemon("0.1.5", "0.1.5")).toBe(false);
    expect(isStaleDaemon("0.1.4", "0.1.5")).toBe(true);
  });

  it("treats a daemon that cannot name its build as stale", () => {
    // Every daemon older than the field itself — the ones that most need
    // replacing — reports nothing here.
    expect(isStaleDaemon(undefined, "0.1.5")).toBe(true);
  });

  it("compares nothing when our own version is unreadable", () => {
    // A broken package.json must not restart daemons on every connect.
    expect(isStaleDaemon(undefined, UNKNOWN_VERSION)).toBe(false);
    expect(isStaleDaemon("0.1.4", UNKNOWN_VERSION)).toBe(false);
  });

  it("reads this install's version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(pinesVersion()).toBe(pkg.version);
  });
});

describe("daemon build handshake", () => {
  let home: string | undefined;
  let daemon: ChildProcess | undefined;

  afterEach(async () => {
    daemon?.kill("SIGKILL");
    daemon = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  /** Raw hello over the wire, so this tests the protocol and not the client. */
  function hello(sockPath: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = connect(sockPath);
      const wire = new Wire(sock);
      sock.once("error", reject);
      wire.on("msg", (raw) => {
        sock.destroy();
        resolve(raw as Record<string, unknown>);
      });
      sock.once("connect", () => {
        wire.send({
          t: "hello",
          role: "client",
          protocolVersion: PROTOCOL_VERSION,
          buildVersion: pinesVersion(),
          cols: 80,
          rows: 24,
        });
      });
      setTimeout(() => reject(new Error("no hello response")), 5000);
    });
  }

  it("reports the daemon's own build version in hello_ok", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-build-"));
    const started = await startDaemon({ home, env: { PINES_PI_BIN: FAKE_PI } });
    daemon = started.proc;

    const ok = await hello(started.sockPath);
    expect(ok.t).toBe("hello_ok");
    expect(ok.daemonVersion).toBe(pinesVersion());
    // The whole point: a same-build daemon is not stale, so nothing restarts.
    expect(isStaleDaemon(ok.daemonVersion as string | undefined)).toBe(false);
  }, 40_000);

  it("restartDaemon replaces the process holding the socket", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-restart-"));
    const started = await startDaemon({ home, env: { PINES_PI_BIN: FAKE_PI } });
    daemon = started.proc;
    const pidPath = join(home, "daemon.pid");
    const before = Number(
      await waitFor(
        () => (existsSync(pidPath) ? readFileSync(pidPath, "utf8").trim() : undefined),
        10_000,
        "daemon pidfile",
      ),
    );

    // Driven through the built dist, the way a real client runs it: the
    // replacement is spawned from dist/cli.js relative to the module.
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { restartDaemon } from ${JSON.stringify(join(ROOT, "dist", "daemon", "lifecycle.js"))};
           await restartDaemon();`,
        ],
        { env: { ...process.env, PINES_HOME: home, PINES_PI_BIN: FAKE_PI }, stdio: "pipe" },
      );
      let err = "";
      proc.stderr?.on("data", (c) => (err += String(c)));
      proc.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`restartDaemon exited ${code}: ${err}`)),
      );
    });

    const after = Number(
      await waitFor(
        () => {
          const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : NaN;
          return Number.isInteger(pid) && pid !== before ? pid : undefined;
        },
        10_000,
        "replacement daemon pidfile",
      ),
    );
    expect(after).not.toBe(before);
    // A restart that leaves no daemon listening would break every client that
    // asked for one — the socket has to come back.
    expect(await isListening(started.sockPath)).toBe(true);

    try {
      process.kill(after, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 60_000);

  it("pines status names the daemon build", async () => {
    home = mkdtempSync(join(tmpdir(), "pines-status-"));
    const started = await startDaemon({ home, env: { PINES_PI_BIN: FAKE_PI } });
    daemon = started.proc;

    const out = await new Promise<string>((resolve) => {
      const proc = spawn(process.execPath, [CLI, "status"], {
        env: { ...process.env, PINES_HOME: home, PINES_PI_BIN: FAKE_PI },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      proc.stdout?.on("data", (c) => (text += String(c)));
      proc.stderr?.on("data", (c) => (text += String(c)));
      proc.once("exit", () => resolve(text));
    });
    expect(out).toContain(`pines ${pinesVersion()}`);
    // Same build on both ends: no upgrade warning to print.
    expect(out).not.toContain("newer fixes are not active");
  }, 40_000);
});
