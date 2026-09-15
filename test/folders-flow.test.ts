/**
 * User-facing smoke test for folders: file a tree from the forest (`m` →
 * new folder), see it under a folder section, and cycle all four folder
 * layouts with `F` — each must draw its own chrome and keep the tree
 * reachable. Drives the real TUI through a pty against a real daemon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import xterm from "@xterm/headless";
import { ensureNodePtyReady } from "../src/daemon/pty-compat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

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
  home = mkdtempSync(join(tmpdir(), "pines-folders-"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  // A handful of dormant sessions across two "projects" — no agents needed.
  spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "gen-sessions.mjs"), "--topics", "2", "--per", "2"],
    { env: { ...process.env, PINES_HOME: home, PINES_PI_SESSIONS: join(home, "sessions") }, stdio: "ignore" },
  );
  daemon = spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "server"], {
    env: { ...process.env, PINES_HOME: home, PINES_PI_SESSIONS: join(home, "sessions") },
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
  await new Promise((resolve) => setTimeout(resolve, 800)); // ingest
});

afterAll(() => {
  daemon?.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

describe("folders in the forest", () => {
  it("files a tree with m, then cycles tree → drill → tabs → chips with F", async () => {
    ensureNodePtyReady();
    const COLS = 110;
    const ROWS = 32;
    const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    const app = pty.spawn(process.execPath, [join(ROOT, "dist", "cli.js")], {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: home,
      env: {
        ...(process.env as Record<string, string>),
        PINES_HOME: home,
        PINES_PI_SESSIONS: join(home, "sessions"),
        PINES_BOOT: "off",
      },
    });
    let output = "";
    app.onData((data) => {
      output += data;
      term.write(data);
    });
    const screen = (): string[] => {
      const lines: string[] = [];
      for (let y = 0; y < ROWS; y++) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? "");
      return lines;
    };
    const has = (s: string) => screen().some((l) => l.includes(s));

    await waitFor(() => output.includes("pines") && has("recent"), 8000, "forest with trees");

    // m: the folder menu for the selected tree; there are no folders yet, so
    // the first option is "new folder…" — ↵ picks it, then we type a path.
    app.write("m");
    await waitFor(() => has("new folder"), 5000, "folder menu");
    app.write("\r");
    await waitFor(() => has("new folder"), 5000, "new folder prompt");
    app.write("work/auth\r");
    await waitFor(() => has("filed"), 5000, "filed toast");
    // Tree layout (the default): nested sections, the filed tree indented under auth.
    await waitFor(() => has("▾ work") && has("▾ auth") && has("unfiled"), 5000, "tree layout sections");
    const sidebarLines = screen().filter((l) => l.includes("▾ work") || l.includes("▾ auth"));
    expect(sidebarLines.length).toBe(2);

    // ← on the tree folds its folder; → unfolds it again.
    app.write("\x1b[D");
    await waitFor(() => has("▸ auth"), 5000, "auth folded");
    app.write("\x1b[C");
    await waitFor(() => has("▾ auth"), 5000, "auth unfolded");

    // F → drill: top level shows the folder as an enterable row.
    app.write("F");
    await waitFor(() => has("folders 2/4") && has("▸ work"), 5000, "drill layout");
    // Cursor to the folder row (it is the first row) and → enters it.
    app.write("\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A");
    app.write("\x1b[C");
    await waitFor(() => has("forest ▸ work") && has("◂ .."), 5000, "inside work");
    app.write("\x1b[D");
    await waitFor(() => !has("forest ▸ work"), 5000, "back at the top level");

    // F → tabs: the strip with all / work / unfiled; > switches to work.
    app.write("F");
    await waitFor(() => has("folders 3/4") && has("all") && has("│ work") && has("unfiled"), 5000, "tabs layout");
    app.write(">");
    await waitFor(() => has("forest ▸ work"), 5000, "work tab");
    app.write("<");
    await waitFor(() => !has("forest ▸ work"), 5000, "all tab");

    // F → chips: flat list, the folder rides on the row as a chip.
    app.write("F");
    await waitFor(() => has("folders 4/4"), 5000, "chips layout");
    await waitFor(() => screen().some((l) => l.includes("work/auth") && !l.includes("folders 4/4")), 5000, "folder chip");

    // F wraps back to tree.
    app.write("F");
    await waitFor(() => has("folders 1/4"), 5000, "tree again");

    const exited = new Promise<void>((resolve) => app.onExit(() => resolve()));
    app.write("q");
    await exited;
  }, 40_000);
});
