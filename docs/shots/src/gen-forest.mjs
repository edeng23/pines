#!/usr/bin/env node
/**
 * Demo sessions with a realistic spread of conversation lengths, so the forest
 * shows saplings next to old growth instead of 60 identical sprites.
 * Same file format as scripts/gen-sessions.mjs — only the length distribution
 * and the project names differ.
 *
 *   PINES_PI_SESSIONS=~/.pines-demo/sessions node gen-pretty.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const root = process.env.PINES_PI_SESSIONS ?? join(homedir(), ".pi", "agent", "sessions");
// Sessions carry the directory they ran in, and pines refuses to resume a tree
// whose cwd is gone. Point this at a real path to make the trees resumable.
const CWD = process.env.PINES_DEMO_CWD ?? "/proj/pines";

const PROJECTS = [
  {
    cwd: CWD,
    openers: [
      "the canopy flickers on pan", "zoom feels sticky past 4x", "name trees from the first prompt",
      "the sidebar truncates mid-word", "elders lose their trunk when crowded",
      "relayout shuffles the whole forest", "search misses abandoned branches",
      "the boot splash outlasts the daemon", "wheel zoom drifts off the cursor",
      "attach leaves a stale screen", "labels collide at low zoom", "the age column jitters",
      "archived trees still steal a slot", "branch tips lose their status on resume",
      "the minimap strip overlaps the last row",
    ],
    follow: ["profile the render loop", "memoize the layout pass", "only repaint dirty cells",
             "clamp the camera to the world box", "measure the frame time again"],
  },
  {
    cwd: CWD,
    openers: [
      "the login flow returns 401", "rate limit the search endpoint", "audit the session cookies",
      "refresh tokens expire early", "the health check lies during rollout",
      "pagination skips the last page", "webhook retries pile up", "signups bypass the email check",
      "the admin route leaks stack traces", "uploads time out over 8MB",
      "search ranks archived rows first", "the cron job double-fires",
      "rotate keys without dropping sessions", "idle sockets never close", "audit log misses deletes",
    ],
    follow: ["trace the token refresh", "add a regression test", "return retry-after",
             "shorten the idle timeout", "document the window"],
  },
  {
    cwd: CWD,
    openers: [
      "write docs for the wire protocol", "the changelog page is unreadable",
      "dark mode washes out code blocks", "the nav collapses too early",
      "search returns nothing on mobile", "og images are the wrong ratio",
      "the pricing table overflows", "anchor links jump past the heading",
      "fonts flash on first paint", "the footer duplicates the nav",
      "diagram the reconnect path", "add usage examples", "explain the handshake",
      "the 404 page has no way back", "tables scroll the whole page",
    ],
    follow: ["group by minor version", "raise the contrast", "check it on mobile",
             "link each entry to its PR", "add a fallback"],
  },
  {
    cwd: CWD,
    openers: [
      "migrate the sqlite schema", "the daemon leaks pty handles",
      "nightly backups are silent on failure", "disk fills up with old snapshots",
      "the deploy step races the migration", "logs rotate mid-write",
      "staging drifts from prod", "the runner runs out of inodes",
      "certs renew but nothing reloads", "metrics stop after a restart",
      "add an index for search", "backfill the embeddings column",
      "the alert threshold is meaningless", "reap children on exit",
      "restore has never been tested",
    ],
    follow: ["verify row counts", "drop the old table", "add an assertion",
             "alert on a missing snapshot", "measure it under load"],
  },
];

const REPLIES = [
  "took a look — the hot path is narrower than it seemed",
  "reproduced it; the fix is small but touches two call sites",
  "measured before and after, the difference holds",
  "that path was already covered, so this only adds the edge case",
  "pushed a first cut, still rough around the error handling",
  "checked the logs going back a week and it only fires on cold start",
  "split it in two so the risky half can land on its own",
  "left the old behaviour behind a flag for now",
];

let idCounter = 0;
const eid = () => (++idCounter).toString(16).padStart(8, "0");

/** Build one session: `turns` user/assistant pairs, walking the thread's prompts. */
function makeSession(cwd, prompts, turns, startedAt) {
  const lines = [];
  const stamp = (i) => new Date(startedAt + i * 90_000).toISOString();
  lines.push(JSON.stringify({
    type: "session", version: 3, id: crypto.randomUUID(), timestamp: stamp(0), cwd,
  }));
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const text = i < prompts.length
      ? prompts[i]
      : `${prompts[i % prompts.length]} — follow-up ${Math.floor(i / prompts.length)}`;
    const u = eid();
    lines.push(JSON.stringify({
      type: "message", id: u, parentId: parent, timestamp: stamp(i * 2),
      message: { role: "user", content: [{ type: "text", text }], timestamp: startedAt + i * 180_000 },
    }));
    const a = eid();
    lines.push(JSON.stringify({
      type: "message", id: a, parentId: u, timestamp: stamp(i * 2 + 1),
      message: {
        role: "assistant",
        content: [{ type: "text", text: REPLIES[(i + text.length) % REPLIES.length] }],
        timestamp: startedAt + i * 180_000 + 60_000,
      },
    }));
    parent = a;
  }
  return lines.join("\n") + "\n";
}

function write(cwd, content, startedAt) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = join(root, safe);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}.jsonl`);
  writeFileSync(file, content);
}

// Deterministic spread: mostly young, a solid middle, a few elders that earn a
// bark trunk and tiered crown.
const LENGTHS = [
  2, 2, 3, 3, 4, 5, 6, 8,        // saplings
  10, 12, 14, 16, 18, 22, 26,    // filling out
  30, 34, 40, 46,                // established
  60, 72, 96, 128,               // old growth
];

const now = Date.now();
let n = 0;
for (const proj of PROJECTS) {
  proj.openers.forEach((opener, i) => {
    const prompts = [opener, ...proj.follow.slice(i % 2), ...proj.follow];
    const turns = LENGTHS[(n * 7 + i * 3) % LENGTHS.length];
    const ageDays = ((n * 13) % 96) / 24; // 0–4 days back
    const at = now - ageDays * 86_400_000;
    write(proj.cwd, makeSession(proj.cwd, prompts, turns, at), at);
    n++;
  });
}
process.stdout.write(`wrote ${n} session(s) under ${root}\n`);
