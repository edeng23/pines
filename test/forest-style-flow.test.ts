/**
 * End-to-end check of the look switcher: `v` cycles, `V` picks, and the
 * choice survives a restart — driven through a real PTY, because that is the
 * only way to know the keys are actually wired to the renderer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function waitFor(fn: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timeout waiting for ${what}`);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "pines-look-"));
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
  await waitFor(
    () => {
      try {
        process.kill(daemon.pid!, 0);
        return true;
      } catch {
        return false;
      }
    },
    5000,
    "daemon",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

function openApp(): { app: pty.IPty; out: () => string } {
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
    },
  });
  let output = "";
  app.onData((data) => {
    output += data;
  });
  return { app, out: () => output };
}

function uiState(): { forestStyle?: string } {
  return JSON.parse(readFileSync(join(home, "ui.json"), "utf8")) as { forestStyle?: string };
}

describe("forest look switching", () => {
  it("cycles with v, picks with V, and remembers the choice", async () => {
    ensureNodePtyReady();
    const { app, out } = openApp();
    await waitFor(() => out().includes("pines") && out().includes("forest"), 5000, "forest");

    // The default look is the plat (canopy); v announces the look it moved
    // to, and persists it.
    const beforeCycle = out().length;
    app.write("v");
    await waitFor(() => out().slice(beforeCycle).includes("constellation"), 4000, "toast");
    await waitFor(() => uiState().forestStyle === "constellation", 4000, "constellation persisted");

    app.write("v");
    await waitFor(() => uiState().forestStyle === "cards", 4000, "cards persisted");

    // V opens the picker with every look listed and the current one marked.
    const beforePicker = out().length;
    app.write("V");
    await waitFor(() => out().slice(beforePicker).includes("forest look"), 4000, "picker");
    const picker = out().slice(beforePicker);
    for (const name of ["classic", "canopy", "constellation", "cards", "contour"]) {
      expect(picker).toContain(name);
    }

    // Number keys jump straight to a look; esc would leave it unchanged.
    app.write("5");
    await waitFor(() => uiState().forestStyle === "contour", 4000, "contour picked");

    const exited = new Promise<void>((resolve) => app.onExit(() => resolve()));
    app.write("q");
    await exited;

    // A fresh client comes back up in the look that was chosen.
    const second = openApp();
    await waitFor(
      () => second.out().includes("pines") && second.out().includes("forest"),
      5000,
      "forest again",
    );
    expect(uiState().forestStyle).toBe("contour");
    const exited2 = new Promise<void>((resolve) => second.app.onExit(() => resolve()));
    second.app.write("q");
    await exited2;
  }, 40_000);
});
