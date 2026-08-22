#!/usr/bin/env node
/**
 * Open pines on a throwaway forest, so it can be tried on something
 * that resembles a real week of work — without touching real sessions and
 * without spending a token.
 *
 *   pnpm demo              # ~18 sessions across 3 projects, 3 of them live,
 *                          # plus one branched conversation (open it with →)
 *   pnpm demo --trees 60   # a crowded forest (where decluttering shows)
 *   pnpm demo --reset      # throw it away and generate a fresh one
 *   pnpm demo --no-agents  # dormant sessions only
 *
 * Everything lives under ~/.pines-demo: its own daemon, socket, database and
 * sessions directory. Your real ~/.pines and ~/.pi are never opened, and
 * deleting that one directory undoes the whole thing.
 *
 * The "agents" are the test suite's fake pi — a process that reports working
 * and then waiting, so the yellow spinner and the teal attention dot are real
 * status driven by real events. No model is ever called, here or when you
 * press `n` inside the demo.
 *
 * The generated conversations run from two turns to a hundred and seventy, on
 * purpose: a tree's size is its conversation's size, so a sandbox of uniform
 * two-turn sessions opens on a field of identical saplings and shows none of
 * the growth the forest is built to draw.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.PINES_DEMO_HOME ?? join(homedir(), ".pines-demo");
const SESSIONS = join(HOME, "sessions");
const FAKE_PI = join(ROOT, "test", "fixtures", "fake-pi.mjs");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const trees = Math.max(1, Number(flag("trees", 18)));
const withAgents = !argv.includes("--no-agents") && existsSync(FAKE_PI);

const cli = join(ROOT, "dist", "cli.js");
if (!existsSync(cli)) {
  process.stderr.write("pines: run `pnpm build` first (dist/cli.js is missing)\n");
  process.exit(1);
}

const demoEnv = { ...process.env, PINES_HOME: HOME, PINES_PI_SESSIONS: SESSIONS };

// The sandbox is throwaway BY DESIGN — so when the generated content itself
// evolves (the branched conversation, new session shapes, …), an old sandbox must not
// quietly hide it. Bump DEMO_VERSION whenever the generator's output changes
// and stale sandboxes rebuild themselves on the next `pnpm demo`.
const DEMO_VERSION = "3"; // 3: conversations of every length (tree sizes vary)
const versionFile = join(HOME, "demo-version");
const sandboxVersion = existsSync(versionFile)
  ? readFileSync(versionFile, "utf8").trim()
  : existsSync(HOME)
    ? "1"
    : DEMO_VERSION;
const stale = sandboxVersion !== DEMO_VERSION;
if (stale) {
  process.stdout.write("\x1b[2mdemo sandbox is from an older pines — regenerating it\x1b[0m\n");
}

if ((argv.includes("--reset") || stale) && existsSync(HOME)) {
  // Stop the demo daemon before pulling the directory out from under it.
  spawnSync(process.execPath, [cli, "kill"], { env: demoEnv, stdio: "ignore" });
  rmSync(HOME, { recursive: true, force: true });
}
mkdirSync(SESSIONS, { recursive: true });
writeFileSync(versionFile, DEMO_VERSION + "\n");

const existing = readdirSync(SESSIONS).length;
if (existing === 0) {
  const topics = Math.max(1, Math.min(5, Math.round(trees / 6)));
  const per = Math.max(1, Math.round(trees / topics));
  spawnSync(
    process.execPath,
    [
      join(ROOT, "scripts", "gen-sessions.mjs"),
      "--topics", String(topics),
      "--per", String(per),
      "--anon", // names come from first prompts, like real sessions
      "--family", // one branched conversation: the one-tree merge on display
    ],
    { env: demoEnv, stdio: "inherit" },
  );

  if (withAgents) {
    // Three background "agents". They work for the first few seconds (yellow
    // spinner) and then settle unseen (teal dot), so both attention states
    // show up within moments of the forest opening. `x` kills one back to
    // dormant and `n` starts another — every status is reachable by hand.
    chmodSync(FAKE_PI, 0o755);
    const agentEnv = {
      ...demoEnv,
      PINES_PI_BIN: FAKE_PI,
      FAKE_PI_EXT: "1",
      FAKE_PI_SETTLE_MS: "8000",
    };
    for (const name of [
      "fix the flaky login test",
      "why is startup so slow?",
      "draft the release notes",
    ]) {
      spawnSync(process.execPath, [cli, "spawn", "--cwd", ROOT, "--name", name, "--prompt", name], {
        env: agentEnv,
        stdio: "ignore",
      });
    }
  }
}

process.stdout.write(
  `\x1b[2mdemo forest in ${HOME} — r renames a tree, ? for keys, q quits\x1b[0m\n`,
);

// Hand the terminal over to pines, pointed entirely at the sandbox.
const app = spawn(process.execPath, [cli], { env: demoEnv, stdio: "inherit" });
app.on("exit", (code) => {
  process.stdout.write(
    `\x1b[2mdemo daemon still running — stop it with:\x1b[0m\n` +
      `  PINES_HOME=${HOME} node dist/cli.js kill\n`,
  );
  process.exit(code ?? 0);
});
