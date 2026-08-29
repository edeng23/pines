/**
 * End-to-end attention notification: an agent that settles in the background
 * rings the client's terminal (BEL on an OSC-less xterm), including when the
 * terminal never reports focus — "unknown" must err on ringing, not silence
 * (the Apple Terminal / tmux-without-focus-events case).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { ensureNodePtyReady } from "../src/daemon/pty-compat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FAKE_PI = join(HERE, "fixtures", "fake-pi.mjs");

let home: string;
let daemon: ChildProcess;
let env: Record<string, string>;

async function waitFor(fn: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timeout waiting for ${what}`);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-notify-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  // Pin the audible signal to BEL: on macOS the default notifySound ("Hero")
  // replaces the BEL with an afplay spawn this test cannot observe.
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifySound: "" }));
  chmodSync(FAKE_PI, 0o755);
  env = {
    ...(process.env as Record<string, string>),
    PINES_HOME: home,
    PINES_PI_BIN: FAKE_PI,
    PINES_PI_SESSIONS: join(home, "sessions"),
    PINES_BOOT: "off",
    FAKE_PI_EXT: "1", // fake pi reports agent_start → agent_settled
    FAKE_PI_SETTLE_MS: "1500",
  };
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env,
    stdio: "ignore",
  });
  await waitFor(() => {
    try {
      process.kill(daemon.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }, 5000, "daemon");
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("attention notification flow", () => {
  it("rings on settle in forest view even when the terminal never reports focus", async () => {
    ensureNodePtyReady();
    const app = pty.spawn(process.execPath, [join(ROOT, "dist", "cli.js")], {
      name: "xterm-256color", // no known OSC dialect → BEL path
      cols: 100,
      rows: 30,
      cwd: home,
      env,
    });
    let output = "";
    app.onData((data) => {
      output += data;
    });

    await waitFor(() => output.includes("forest"), 5000, "forest");
    // Focus reporting is requested even if this terminal never answers.
    expect(output).toContain("\x1b[?1004h");
    expect(output).not.toContain("\x07");

    // A background agent (running → settled) must ring the watching client.
    execFileSync(
      process.execPath,
      [join(ROOT, "dist", "cli.js"), "spawn", "--cwd", home, "--name", "probe"],
      { env },
    );
    const mark = output.length;
    await waitFor(() => output.slice(mark).includes("\x07"), 8000, "BEL after settle");

    const exited = new Promise<void>((resolve) => app.onExit(() => resolve()));
    app.write("q");
    await exited;
  });
});
