/**
 * User-facing smoke test for the two peek-and-leave features:
 *  - a plain ← on an empty editor steps out of the attached pi into the tree
 *    (no prefix chord), via the extension's leave event;
 *  - `v` cycles the forest's right pane: canopy → conversation preview →
 *    live screen of the selected agent → canopy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { ensureNodePtyReady } from "../src/daemon/pty-compat.js";
import { branchedSession } from "./fixtures/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FAKE_PI = join(HERE, "fixtures", "fake-pi.mjs");

let home: string;
let sessionsRoot: string;
let daemon: ChildProcess;

async function waitFor(fn: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-preview-"));
  sessionsRoot = join(home, "sessions");
  const dir = join(sessionsRoot, "--tmp-proj--");
  mkdirSync(dir, { recursive: true });
  // The fake extension claims this file as its session, so the embedded pi
  // has a real conversation behind it for the preview to show.
  const fixtureSession = join(dir, "2026-01-01T00-00-00-000Z_11111111.jsonl");
  writeFileSync(fixtureSession, branchedSession("/tmp/proj").content);
  chmodSync(FAKE_PI, 0o755);
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: {
      ...process.env,
      PINES_HOME: home,
      PINES_PI_BIN: FAKE_PI,
      PINES_PI_SESSIONS: sessionsRoot,
      FAKE_PI_EXT: "1",
      FAKE_PI_SESSION: fixtureSession,
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

describe("preview pane and ← to leave", () => {
  it("← leaves an empty editor for the tree; v cycles canopy → conversation → screen → canopy", async () => {
    ensureNodePtyReady();
    const app = pty.spawn(process.execPath, [join(ROOT, "dist", "cli.js")], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: home,
      env: {
        ...(process.env as Record<string, string>),
        PINES_HOME: home,
        PINES_PI_BIN: FAKE_PI,
        PINES_PI_SESSIONS: sessionsRoot,
        PINES_BOOT: "off",
      },
    });
    let output = "";
    app.onData((data) => {
      output += data;
    });

    await waitFor(() => output.includes("pines") && output.includes("forest"), 5000, "forest");

    // Start a tree and land inside its pi.
    app.write("n");
    await waitFor(() => output.includes("FAKE-PI READY"), 8000, "embedded pi");
    // The fake's extension settles ~600ms after hello; give it time to be
    // bound and listening for the ← rule before we press it.
    await waitFor(() => strip(output).includes("← on an empty editor"), 5000, "attached bar");
    await new Promise((r) => setTimeout(r, 900));

    // Plain ← with nothing typed: back to the TREE view, no prefix needed.
    const beforeLeft = output.length;
    app.write("\x1b[D");
    await waitFor(
      () => strip(output.slice(beforeLeft)).includes("⏎ attach/branch"),
      5000,
      "tree view after ←",
    );

    // ← again climbs to the forest (the tree view's own rule).
    const beforeForest = output.length;
    app.write("\x1b[D");
    await waitFor(
      () => strip(output.slice(beforeForest)).includes("v preview"),
      5000,
      "forest after ←",
    );

    // v: conversation preview of the selected (live) tree.
    const beforePreview = output.length;
    app.write("v");
    await waitFor(() => {
      const s = strip(output.slice(beforePreview));
      return s.includes("conversation") && s.includes("v cycles");
    }, 5000, "conversation preview");
    // The fixture's first user message is on screen without opening the tree.
    await waitFor(
      () => strip(output.slice(beforePreview)).includes("parser"),
      5000,
      "conversation text in the preview",
    );

    // v: live screen of the agent — the fake's banner shows up in the FOREST.
    const beforeScreen = output.length;
    app.write("v");
    await waitFor(() => strip(output.slice(beforeScreen)).includes("live screen"), 5000, "screen header");
    // The pane shows the BOTTOM of the agent's screen (where pi's editor
    // lives), so the fake's banner on row 0 is cropped — its ticks are not.
    await waitFor(
      () => /tick \d+/.test(strip(output.slice(beforeScreen))),
      5000,
      "agent screen inside the preview pane",
    );
    // Still the forest: the status bar's forest hints are there, no attach happened.
    expect(strip(output.slice(beforeScreen))).toContain("v forest/screen");

    // v: back to the canopy.
    const beforeCanvas = output.length;
    app.write("v");
    await waitFor(() => strip(output.slice(beforeCanvas)).includes("v preview"), 5000, "canopy again");

    const exited = new Promise<void>((resolve) => app.onExit(() => resolve()));
    app.write("q");
    await exited;
  }, 40_000);
});
