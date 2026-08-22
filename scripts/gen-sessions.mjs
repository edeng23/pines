#!/usr/bin/env node
/**
 * Generate fake pi session files for perf/layout testing.
 *
 *   node scripts/gen-sessions.mjs 120                # 120 sessions
 *   node scripts/gen-sessions.mjs --topics 3 --per 8 # 3 topical clusters × 8
 *   node scripts/gen-sessions.mjs 20 --anon          # no session names: the
 *                                                    # forest derives them
 *                                                    # from first prompts
 *   node scripts/gen-sessions.mjs --drift 4          # 4 sessions opening on
 *       topic A then drifting to topic B (should land near B's cluster)
 *   node scripts/gen-sessions.mjs --topics 3 --per 6 --even  # every session
 *       the same short length (the old behavior; sizes are varied by default)
 *   PINES_PI_SESSIONS=~/somewhere overrides the target root
 *
 * Conversations come out at wildly different lengths on purpose: a tree's
 * size IS its conversation's size, so a generated forest where every session
 * is two turns long draws a field of identical saplings and says nothing
 * about growth. The ladder below walks the whole range instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 0) || null;
const topics = Number(flag("topics", 0)) || null;
const per = Number(flag("per", 8));
// Without an explicit name, pines names a tree after its first user message —
// which is what real sessions look like.
const anon = args.includes("--anon");
const drift = Number(flag("drift", 0)) || null;
// One branched fork FAMILY (root + sibling branches + a nested one + a
// parked fork) so the demo showcases the one-tree merge, not just dots.
const family = args.includes("--family");
// Same-length conversations: what the generator used to do, kept for perf
// runs where a uniform forest is the point.
const even = args.includes("--even");

const root =
  process.env.PINES_PI_SESSIONS ?? join(homedir(), ".pi", "agent", "sessions");

const TOPIC_PROMPTS = [
  [
    "fix the failing auth tests", "the login flow returns 401",
    "add oauth token refresh", "the refresh races the retry loop",
    "expire the session cookie on logout", "audit what the token actually signs",
  ],
  [
    "optimize the render loop", "profile the canvas frame time",
    "memoize the layout pass", "why does resize drop frames?",
    "batch the writes into one flush", "cache the measured text widths",
  ],
  [
    "write docs for the API", "add usage examples to the readme",
    "document the wire protocol", "the getting-started page is stale",
    "explain the daemon lifecycle", "write the migration notes",
  ],
  [
    "migrate the database schema", "add a sqlite index for search",
    "backfill the embeddings column", "the migration locks on big tables",
    "make the backfill resumable", "vacuum after the backfill",
  ],
  [
    "refactor the parser module", "extract the tokenizer",
    "add error recovery to the lexer", "the parser chokes on trailing commas",
    "give the errors a line and column", "fuzz it against the old parser",
  ],
];

/**
 * Follow-ups: what turn 7 of a real session looks like. A long conversation
 * built by cycling a topic's opening prompts reads like a stuck record the
 * moment anyone opens the tree — these keep it looking like work.
 */
const FOLLOW_UPS = [
  "still red on CI", "why did that work?", "show me the diff",
  "can you add a test for that?", "roll that last bit back",
  "what else touches this?", "ship it", "hmm, try the other way",
  "that broke the other test", "explain the tradeoff",
  "keep going", "any faster way?",
];

/** Assistant replies, so a transcript isn't the same line 200 times. */
const REPLIES = [
  "Found it — patching now.", "Done. Tests pass locally.",
  "That path was never covered; adding a case.",
  "Reverted. The earlier approach was closer.",
  "Two options here — going with the smaller one.",
  "Traced it to the retry loop.", "Pushed. CI is green.",
  "Reproduced it. It only fails on a cold cache.",
];

/**
 * Conversation lengths in TURNS, walked in order so a generated forest shows
 * the whole ladder: saplings beside a tier-broken elder, which is the thing
 * a screenshot of the forest is supposed to show.
 */
const TURN_LADDER = [2, 3, 5, 8, 13, 22, 36, 60, 100, 170];

/** A conversation `turns` long: opening prompts, then real follow-ups. */
function conversation(bank, turns, seed) {
  const prompts = [];
  for (let i = 0; i < turns; i++) {
    prompts.push(
      i % 4 === 0
        ? bank[(seed + i / 4) % bank.length]
        : FOLLOW_UPS[(seed * 5 + i) % FOLLOW_UPS.length],
    );
  }
  return prompts;
}

let idCounter = 0;
const eid = () => (++idCounter).toString(16).padStart(8, "0");

function makeSession(cwd, prompts, name) {
  const lines = [];
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
    }),
  );
  let parent = null;
  prompts.forEach((p, i) => {
    const u = eid();
    lines.push(
      JSON.stringify({
        type: "message", id: u, parentId: parent, timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: p }], timestamp: Date.now() },
      }),
    );
    const a = eid();
    lines.push(
      JSON.stringify({
        type: "message", id: a, parentId: u, timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: i === 0 ? `working on: ${p}` : REPLIES[i % REPLIES.length] }],
          timestamp: Date.now(),
        },
      }),
    );
    parent = a;
  });
  if (name) {
    lines.push(
      JSON.stringify({
        type: "session_info", id: eid(), parentId: null,
        timestamp: new Date().toISOString(), name,
      }),
    );
  }
  return lines.join("\n") + "\n";
}

function writeSession(cwd, content) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = join(root, safe);
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}.jsonl`,
  );
  writeFileSync(file, content);
  return file;
}

let written = 0;
if (drift) {
  // Sessions that open on topic 0 and spend most turns on topic 1: with
  // recency-weighted chunk pooling they should settle near topic 1's cluster
  // (under first-message-only embedding they'd be stuck at topic 0).
  const [a, b] = [TOPIC_PROMPTS[0], TOPIC_PROMPTS[1]];
  for (let i = 0; i < drift; i++) {
    const prompts = [a[i % a.length], ...Array.from({ length: 6 }, (_, j) => b[(i + j) % b.length])];
    writeSession(`/proj/drift`, makeSession(`/proj/drift`, prompts, `drift-${i}`));
    written++;
  }
} else if (topics) {
  // Walk the ladder ACROSS topics, not within one: every project ends up with
  // its own mix of saplings and old growth, the way a real week of work does.
  let rung = 0;
  for (let t = 0; t < topics; t++) {
    const bank = TOPIC_PROMPTS[t % TOPIC_PROMPTS.length];
    for (let i = 0; i < per; i++) {
      const turns = even ? 2 : TURN_LADDER[rung++ % TURN_LADDER.length];
      const prompts = conversation(bank, turns, t * 3 + i);
      writeSession(
        `/proj/topic-${t}`,
        makeSession(`/proj/topic-${t}`, prompts, anon ? null : `${t}-${i}`),
      );
      written++;
    }
  }
} else {
  const n = count ?? 20;
  for (let i = 0; i < n; i++) {
    const bank = TOPIC_PROMPTS[i % TOPIC_PROMPTS.length];
    const cwd = `/proj/p${i % 9}`;
    const turns = even ? 1 : TURN_LADDER[i % TURN_LADDER.length];
    writeSession(cwd, makeSession(cwd, conversation(bank, turns, i), anon ? null : `gen-${i}`));
    written++;
  }
}

/**
 * A branched conversation, written the way pi writes real forks: each branch
 * is its own session file whose header names its parentSession and whose
 * prefix repeats the parent's entries WITH THE SAME IDS — that shared spine
 * is what lets pines merge the family into one tree. Timestamps step by 30s
 * so the branch fan renders in creation order.
 */
function writeFamily(cwd) {
  let t = Date.now() - 2 * 3600e3;
  const ts = () => new Date((t += 30_000)).toISOString();
  const msg = (id, parentId, role, text) =>
    JSON.stringify({
      type: "message", id, parentId, timestamp: ts(),
      message: { role, content: [{ type: "text", text }], timestamp: 0 },
    });
  const header = (parentSession) =>
    JSON.stringify({
      type: "session", version: 3, id: crypto.randomUUID(), timestamp: ts(), cwd,
      ...(parentSession ? { parentSession } : {}),
    });
  const u1 = eid(), a1 = eid(), u2 = eid(), a2 = eid(), u3 = eid(), a3 = eid();
  const rootLines = [
    header(null),
    msg(u1, null, "user", "plan the v1 release"),
    msg(a1, u1, "assistant", "Three blockers: the flaky login test, slow startup, missing docs."),
    msg(u2, a1, "user", "which one first?"),
    msg(a2, u2, "assistant", "The flaky test — it blocks CI for everyone."),
    msg(u3, a2, "user", "ok, fix the flaky test"),
    msg(a3, u3, "assistant", "Found it: the retry loop races the mock clock. Patching."),
  ];
  // The trunk kept going after the branches came off it, so the family shows
  // what it is meant to show: forks hanging off OLD growth. A root the same
  // size as its branches makes the whole fan read as five identical saplings.
  let tail = a3;
  for (const [role, text] of [
    ["user", "run it fifty times"],
    ["assistant", "Fifty green. The clock is injected now, not patched."],
    ["user", "what else uses that mock?"],
    ["assistant", "Two suites — both were leaning on the same race."],
    ["user", "clean those up too"],
    ["assistant", "Done. Same fixture, no sleeps left in either."],
    ["user", "ok, back to the release"],
    ["assistant", "One blocker down. Docs and startup are still open."],
    ["user", "cut the changelog while we're here"],
    ["assistant", "Drafted from the merge log — it's in CHANGELOG.md."],
    ["user", "tag it rc1"],
    ["assistant", "Tagged v1.0.0-rc1. CI published the artifacts."],
  ]) {
    const id = eid();
    rootLines.push(msg(id, tail, role, text));
    tail = id;
  }
  const rootPath = writeSession(cwd, rootLines.join("\n") + "\n");
  const prefixThrough = (lines, lastId) => {
    const out = [];
    for (const l of lines.slice(1)) {
      out.push(l);
      if (JSON.parse(l).id === lastId) break;
    }
    return out;
  };
  const fork = (baseLines, basePath, atId, turns) => {
    const lines = [header(basePath), ...prefixThrough(baseLines, atId)];
    let parent = atId;
    for (const [role, text] of turns) {
      const id = eid();
      lines.push(msg(id, parent, role, text));
      parent = id;
    }
    return { path: writeSession(cwd, lines.join("\n") + "\n"), lines };
  };
  // Two sibling branches off the "which one first?" answer…
  const startup = fork(rootLines, rootPath, a2, [
    ["user", "actually, what about the slow startup?"],
    ["assistant", "Cold boot spends 1.2s loading embeddings — lazy-load them."],
  ]);
  fork(rootLines, rootPath, a2, [
    ["user", "and the docs — how bad is it?"],
    ["assistant", "README covers install only; the API surface is undocumented."],
  ]);
  // …a fork someone opened and never typed into (renders as ⊘ parked)…
  fork(rootLines, rootPath, a2, []);
  // …a later branch off the fix itself…
  fork(rootLines, rootPath, a3, [
    ["user", "write a regression test for the race"],
    ["assistant", "Added a clock-race test — red before the fix, green after."],
  ]);
  // …and a branch OF a branch (depth 2: nests in the tree and the metro map).
  const startupAnswer = JSON.parse(startup.lines[startup.lines.length - 1]).id;
  fork(startup.lines, startup.path, startupAnswer, [
    ["user", "can we cache the embeddings instead?"],
    ["assistant", "Yes — memoize keyed by session mtime; sketching it."],
  ]);
  return 6;
}

if (family) written += writeFamily("/proj/topic-0");
console.log(`wrote ${written} session(s) under ${root}`);
