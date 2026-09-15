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
 * The generated sessions come pre-filed into folders (projects/<topic>),
 * the live agents deliberately not — so every folder layout (F cycles the
 * four) has folders, nesting and an unfiled group to show.
 *
 * Everything lives under ~/.pines-demo: its own daemon, socket, database and
 * sessions directory. Your real ~/.pines and ~/.pi are never opened, and
 * deleting that one directory undoes the whole thing.
 *
 * The "agents" are the test suite's fake pi — a process that reports working
 * and then waiting, so the yellow spinner and the teal attention dot are real
 * status driven by real events. No model is ever called, here or when you
 * press `n` inside the demo.
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
const DEMO_VERSION = "3"; // 2: branched fork family (one-tree merge showcase) · 3: folders
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

if (existing === 0) await seedFolders();

process.stdout.write(
  `\x1b[2mdemo forest in ${HOME} — r renames a tree, m files it in a folder, F cycles the folder layouts, ? for keys, q quits\x1b[0m\n`,
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

/**
 * File the generated sessions by their project directory (projects/topic-N),
 * leaving the spawned agents unfiled. Runs against the daemon like the
 * client does: folders are daemon state, not something the generator can
 * write into a session file.
 */
async function seedFolders() {
  const { DaemonClient } = await import(join(ROOT, "dist", "client", "daemon-client.js"));
  // The CLI reads its home from the environment at import time.
  Object.assign(process.env, demoEnv);
  let client;
  try {
    client = await DaemonClient.connect({ cols: 80, rows: 24 });
  } catch {
    return; // no daemon → the app starts one; folders can be added by hand (m)
  }
  const forest = new Map(client.helloOk.forest.map((t) => [t.treeId, t]));
  client.on("forest_update", ({ upsert, remove }) => {
    for (const t of upsert ?? []) forest.set(t.treeId, t);
    for (const id of remove ?? []) forest.delete(id);
  });
  // The watcher ingests the generated files asynchronously: wait until the
  // count of generated trees stops growing (a quiet second), capped at 10s.
  const generated = () => [...forest.values()].filter((t) => t.cwd?.startsWith("/proj/")).length;
  const deadline = Date.now() + 10_000;
  let seen = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const n = generated();
    if (n !== seen) {
      seen = n;
      quietSince = Date.now();
    } else if (n > 0 && Date.now() - quietSince > 1000) {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const t of forest.values()) {
    if (!t.cwd?.startsWith("/proj/")) continue;
    const topic = t.cwd.slice(t.cwd.lastIndexOf("/") + 1);
    await client.request({ t: "set_folder", id: client.rid(), treeId: t.treeId, folder: `projects/${topic}` });
  }
  client.close();
}
