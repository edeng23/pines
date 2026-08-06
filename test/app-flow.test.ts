/**
 * User-facing smoke test: `n` hosts a new pi inside pines immediately, and
 * both enhanced-terminal and legacy prefix chords return to the forest.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

async function waitFor(
  fn: () => boolean,
  timeoutMs = 8000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timeout waiting for ${what}`);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-app-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  chmodSync(FAKE_PI, 0o755);
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: {
      ...process.env,
      PINES_HOME: home,
      PINES_PI_BIN: FAKE_PI,
      PINES_PI_SESSIONS: join(home, "sessions"),
    },
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

describe("interactive app flow", () => {
  it("creates and attaches inside pines, then handles Kitty and legacy detach chords", async () => {
    ensureNodePtyReady();
    const app = pty.spawn(process.execPath, [join(ROOT, "dist", "cli.js")], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: home,
      env: {
        ...(process.env as Record<string, string>),
        PINES_HOME: home,
        PINES_PI_BIN: FAKE_PI,
        PINES_PI_SESSIONS: join(home, "sessions"),
        PINES_BOOT: "off",
      },
    });
    let output = "";
    app.onData((data) => {
      output += data;
    });

    await waitFor(() => output.includes("pines") && output.includes("forest"), 5000, "forest");
    const beforeNew = output.length;
    app.write("n");
    await waitFor(() => output.includes("FAKE-PI READY"), 8000, "embedded pi");
    const embeddedTransition = output.slice(beforeNew);
    expect(embeddedTransition).not.toContain("cwd for new tree");
    expect(embeddedTransition).not.toContain("first prompt");
    expect(embeddedTransition).not.toContain("\x1b[?1049l");

    // A Kitty key-RELEASE event must never reach pi: at attach time it can
    // land before pi raw-modes its terminal and echo as literal text at the
    // top of the screen (the release of the very key that attached).
    const beforeRelease = output.length;
    app.write("\x1b[110;1:3u"); // release of 'n' — the attach trigger
    app.write("probe\r"); // a real line, so we know input flowed after it
    await waitFor(() => output.slice(beforeRelease).includes("echo:probe"), 5000, "probe echo");
    expect(output.slice(beforeRelease)).not.toContain("110;1:3u");

    const beforeDetach = output.length;
    // Pi enables Kitty keyboard flags 1+2+4 in iTerm2. A physical Ctrl+t,
    // then f produces press/release events for both keys.
    app.write(
      "\x1b[116;5:1u" +
        "\x1b[116;5:3u" +
        "\x1b[102;1:1u" +
        "\x1b[102;1:3u",
    );
    await waitFor(
      () => output.slice(beforeDetach).includes("pines") && output.slice(beforeDetach).includes("forest"),
      5000,
      "forest after Kitty Ctrl+t f",
    );
    expect(output.slice(beforeDetach)).toContain("\x1b[=0u");

    // Enhanced printable keys must keep working in the forest after detach.
    const beforeReattach = output.length;
    app.write("\x1b[97;1:1u\x1b[97;1:3u");
    await waitFor(
      () => output.slice(beforeReattach).includes("FAKE-PI READY"),
      5000,
      "reattach after Kitty a",
    );
    expect(output.slice(beforeReattach)).toContain("\x1b[=7u");

    const beforeLegacyDetach = output.length;
    app.write("\x14f");
    await waitFor(
      () =>
        output.slice(beforeLegacyDetach).includes("pines") &&
        output.slice(beforeLegacyDetach).includes("forest"),
      5000,
      "forest after legacy Ctrl+t f",
    );

    const exited = new Promise<void>((resolve) => app.onExit(() => resolve()));
    app.write("q");
    await exited;
  });
});
