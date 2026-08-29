# pines — full guide

**pi + trees.** A tree-first orchestration TUI for [pi](https://pi.dev) coding agents.
*(Looking for the quick start? See the [README](../README.md).)*

Your conversations *are* trees — pi stores every session as an append-only tree of
messages you can branch anywhere. pines makes that structure the primary interface:
the main view is a **forest**, a zoomable map of every conversation tree, with
live color-coded agent status on each one. Enter a tree to get the **real pi TUI**;
leave it and the agent **keeps running in the background**.

```
            ◐ auth-fix                        ready to zoom, pan, click
        ⡠⠔⠉                                  ● teal  = waiting for you (unseen)
   ● render-perf                              ◐ yellow = agent working
                     ○ docs-cleanup           ○ green = seen / done
        · archive-migration                   · gray  = dormant (no process)
```

## Why

- pi's built-in `/tree` view is powerful but hard to navigate and not visual.
- Leaving a pi session pauses it. pines fixes that with a background daemon that
  owns every pi process — detaching is just closing a socket, no tmux involved.
- Status is **exact**, not screen-scraped: a tiny pines extension rides inside
  each spawned pi and reports `agent_start` / `agent_settled` events directly.

## Install & run

Requires Node 22.19+ (up to 24) — the floor comes from `@earendil-works/pi-*`,
which pines bundles. Pines includes a compatible `pi` runtime; an independently
installed global `pi` is not required.

```sh
npx @edeng23/pines

# or install the command globally
npm i -g @edeng23/pines
pines
```

From a source checkout:

```sh
pnpm install && pnpm build
node dist/cli.js

# optional: expose the `pines` command globally
npm link
pines
```

- `pines` — open the forest (auto-starts the daemon). Launch plays a short
  germination splash while the daemon connects — any key skips it, and it
  reports how many agents kept running while you were away. Disable it with
  `"boot": "off"` in `~/.pines/config.json` (or `PINES_BOOT=off`).
- `pines spawn --cwd ~/proj --name auth-fix --prompt "fix the tests"` — spawn a background tree
- `pines status` / `pines kill` — inspect / stop the daemon (and its agents)

Sessions you run with plain `pi` (outside pines) appear in the forest
automatically as dormant trees, via a watcher on `~/.pi/agent/sessions`.

## Navigation

Three levels: **Forest ⇄ Tree ⇄ Node (attached pi)**. Arrow keys navigate the
hierarchy like columns in a file browser: `→` descends (forest → tree → pi),
`←` ascends, `↑`/`↓` move the selection. `Enter`/`Esc` still work everywhere.
Inside pi the arrows belong to pi itself, so ascending from there is
`Ctrl+t ←` (or `Ctrl+t d`).

The forest screen is split: an **agents sidebar** on the left (a state-grouped
list of every tree — needs input first, then working, then recent — each row
showing status, name, and age) and the spatial canvas on the right. The two
share one selection: moving in the list pans the camera only when the tree is
off-screen. `S` toggles the sidebar, `[`/`]` resize it, or drag the divider;
width and visibility persist in `~/.pines/ui.json`.

The canvas draws the **canopy** — a forester's plat: sunlit pines on graph
paper, lineage surveyed in right angles. A tree grows with the conversation
behind it on a log curve that never tops out: one new crown row per rough
doubling of the conversation, up to nine. Past ninety-odd messages the crown
breaks into **stacked tiers**, and the oldest trees stand on a bark trunk —
the forest's one non-green, and it shows at *every* zoom: even when crowding
shrinks the crown, an elder still stands on its bark. The tier pattern is
dealt from the tree's id (exactly like its green), so no two elders match,
yet every silhouette is strictly symmetric — a pine at every size, lit from
the upper left. A dormant session keeps its needles in a muted, wintered-over green
(the whole forest sleeps between daemon runs — it still reads as a forest);
only a crashed one stands bare, ember red. Work you haven't seen lights the
crown's tip. Underneath, graph paper and right-angle lineage: survey lines
run tree to tree and disappear behind the wood.

**Try it without touching your sessions:**

```sh
pnpm build && pnpm demo      # a throwaway forest under ~/.pines-demo
```

`pnpm demo` generates ~18 sessions across three projects — including one
branched conversation (“plan the v1 release”: sibling branches, a branch of
a branch, and a parked fork — open it with `→` to see the one-tree merge,
agent tips, and the metro map) — and starts three
simulated agents (the test suite's fake pi — no model is ever called), then
opens the forest on that sandbox: its own daemon, socket, database and sessions
directory. `x` kills an agent, `n` starts another. `pnpm demo --trees 60` for
a crowded forest, `--reset` to start over, and `rm -rf ~/.pines-demo` to erase
the whole thing.

In a crowded forest the map names the live, unseen, and crashed sessions
first and leaves the rest as glyphs — names shorten as trees pack together, and
zooming in hands them back. Preview the map without running anything:

```sh
pnpm tsx scripts/forest-preview.ts --list              # scenarios
pnpm tsx scripts/forest-preview.ts --scenario busy     # one scenario
pnpm tsx scripts/forest-preview.ts --html forest.html  # side by side in a browser
```

The scenarios cover a working day, a quiet forest, forty sessions at once, a
branched conversation, an 80-column terminal with the sidebar open, mid zoom,
and a first run — all placed by the same layout the daemon uses.

| view | keys / mouse |
|---|---|
| forest | `↑`/`↓` move through the sidebar list · `Enter` attach · `→` open tree view · wheel = zoom at cursor · drag = pan · click = select · double-click = open (canvas) / attach (sidebar) · `hjkl` pan · `+`/`-` zoom · `0` fit · `Tab` cycle by attention · `o` jump to most urgent · `a` attach · `n` new tree and attach · `r`/`L` rename tree · `A`/`Ctrl+X` archive/unarchive · `.` show/hide archived · `S` sidebar · `[`/`]` sidebar width · `x` kill agent · `R` relayout · `s` similar conversations · `/` search · `?` help |
| tree | `↑`/`↓` or `j`/`k` move · `→`/`Enter` — on a tip (a node showing an agent's status): attach to that branch's agent (resume if dormant); on a `⋯` row: expand; on a `[+]` row: unfold; on any other message: grow a new branch there with its own agent and attach (from a question: *beside* it — the question stays out) · `f` flow (one branch's conversation) ⇄ full tree · `Tab`/`Shift+Tab` next/prev branch · `1`-`9` jump to a branch tip · `←`/`Esc` back to the forest · `b` branch menu (with/without agent) · `L` label · `r` rename tree · `/` search |
| attached pi | everything goes to pi, except the prefix `Ctrl+t`: `←`/`d` = back to tree · `f` = forest · `n` = next attention target · `Ctrl+t Ctrl+t` = send a literal Ctrl+t |

Zooming is semantic: the sprite is the tree at every distance — maturity by
conversation size, life by color — and it fills out from a glyph to old
growth as you close in; zooming all the way into a tree opens it. Branch
structure lives inside: the conversation view and its metro map.

The tree view is a classic ascii tree (`├─` / `└─`): user turns start at their
branch margin, replies nest one step, tool runs elide to `⚙ ⋯ n steps`, and
only forks add lasting indent. When a session outgrows the screen, scale rules
engage automatically: the active path pins to its margin (no indent drift),
non-active branches fold to one `· N msgs · age [+]` row each, and a minimap
strip appears on the right edge. Small trees always render in full.

**A conversation is ONE tree.** Branching materializes a new session file
under the hood — that's how a branch gets its own agent, running in
parallel, never blocking anyone — but the files are plumbing: pines merges
the whole family back into a single message tree (forked files share their
entry ids up to the branch point, so the merge is lossless). The forest
shows one item per conversation, colored by the family's most
attention-worthy member.

Inside, the conversation is one ascii tree. Nodes where a branch currently
ends are **tips**: they carry that branch's live agent status (`◐ working`,
`● needs input`, …) right on the tree. When more than one agent lives on
the tree, a left panel lists them — agents, not messages — and `1`-`9` or a
click moves the cursor to exactly that tip. Above the list, a metro-style
map draws the branch structure: rounded routes, one color per branch line,
agents as stations you can click; the station nearest your cursor lights up
as a you-are-here marker.

`n` starts a new daemon-hosted pi in the current directory and immediately
opens its real TUI inside pines. `Ctrl+t f` returns to the forest while that pi
continues running. Use `pines spawn --cwd …` when you explicitly want a
background-only launch.

**Branching** (`b` on any message, or just `Enter` on a non-tip message):
grows a new branch of the same tree, optionally with an agent on it.
Where the fork lands depends on what you point at: a *reply* branches after
its exchange; a *question* branches from just before it — the question is
not part of the new branch, so your next message replaces it as a sibling
(the way editing a message works in chat UIs) and the old answer can never
read as answering the new question. The `b` menu's *re-answer* keeps the
question and regenerates only the answer. Branches never touch each other's
agents, so branching while one works is always possible — that is the
multiplexing model. (In-place leaf moves still exist in the daemon for pi's
own navigation.)

**Flow view** (`f`): narrows the transcript to one branch's conversation —
the cursor's — root to tip, nothing else. The metro map keeps the whole
shape with the flow's route drawn bold while everything off it recedes to
the grid gray, the flowed agent carries a `▸` in the panel, and the panel
keeps every branch: `Tab`/`Shift+Tab` cycle the flow through them, and
`1`-`9` or a click jumps straight to one. `f` again restores the full tree.

**Search** (`/`): SQLite FTS5 over session names, every user message (abandoned
branches included), compaction/branch summaries, and labels. `Enter` jumps to
the exact tree and node.

**Archiving** (`A`): finished trees leave the canvas and sidebar without losing
anything — the session file, search index, and lineage all stay. `.` reveals
the archived group at the bottom of the sidebar; `A` again (or resuming the
tree, from anywhere) un-archives it. Trees with a live agent refuse to archive:
kill the agent first (`x`).

## Semantic layout

Trees that talk about similar things sit near each other. Each tree is
embedded locally (MiniLM q8, ~23 MB, downloaded once to `~/.pines/models`,
runs in a worker thread) from its *essence*: the name and labels, every user
message, compaction/branch summaries, and a digest of the tool activity (which
files the agent worked on, which tools it ran). Each piece embeds once —
cached per chunk, so a growing session only embeds its new messages — and the
tree vector is a recency-weighted pool: recent turns dominate, but the opening
prompt keeps a floor weight, so a chat that drifted from "fix auth" to
"rewrite the parser" sits between those topics, leaning where it actually went.

Vectors are projected to 2-D with a cached PCA basis and nudged apart with
overlap relaxation. New trees project through the cached basis so **existing
trees never jump**; `R` refits. Offline or before the model warms, a
deterministic lexical layout (cwd clusters on a spiral, recency rings) applies
— the forest always loads instantly.

**Similar trees** (`s`): ranks the forest against the selected tree in two
stages — a cheap pooled-cosine shortlist over everything, then an exact
re-rank that *matches the two trees' chunks* (each message finds its best
counterpart on the other side, recency-weighted). Matching chunk sets, not
blended vectors, means a conversation that covers two topics ranks well
against both — and every score comes with receipts: the selected hit shows
the top matching message pairs, with `⚙` marking matches that come from
tool activity (same files) rather than topic. Picking a neighbor jumps the
camera to it. Note the map is the *approximate* view (pooled vectors,
projected to 2-D for stability); the `s` list is the honest one.

## Configuration

`~/.pines/config.json` (all optional):

```json
{
  "prefixKey": "ctrl+t",
  "boot": "off",
  "notify": "terminal",
  "maxLiveAgents": 12,
  "piBin": "/path/to/custom/pi",
  "embedModel": "Xenova/bge-small-en-v1.5"
}
```

`notify` rings when an agent finishes, needs input, or crashes while you
aren't watching it — the terminal is unfocused, focus is unknowable (a
terminal without focus reporting, e.g. Apple Terminal, or tmux without
`set -g focus-events on`), or a different agent's pi covers the screen. Only
a provably focused terminal showing the forest/tree views (or that agent's
own pi) stays quiet. Modes:

- `"terminal"` (default) — desktop toast via OSC escape codes (kitty, iTerm2,
  WezTerm, Ghostty, foot, Warp); other terminals get a plain BEL. Works over
  SSH. Inside tmux the toast needs `set -g allow-passthrough on` (tmux ≥ 3.3);
  the BEL fallback pairs well with tmux's `monitor-bell` window flags.
- `"bell"` — BEL only.
- `"system"` — OS notifier (`osascript` on macOS, `notify-send` on Linux):
  works in any terminal, but not over SSH.
- `"off"` — silence.

`maxLiveAgents` caps concurrent pi processes (default 12). The slots are a
warm cache of instantly-attachable sessions — kept full on purpose. When a
new spawn needs a slot, the least-recently-active *waiting* agent is quietly
put to sleep (its tree stays resumable, its unseen dot survives); working
and attached agents are never evicted, and if nothing is idle the spawn
fails with a message naming who is busy.

`embedModel` swaps the local embedding model (default MiniLM;
`Xenova/bge-small-en-v1.5` is a known-good 384-d quality upgrade). Changing it
re-embeds everything on the next daemon start.

`piBin` is an optional development/custom-runtime override; by default pines
uses its bundled, version-matched pi. Env overrides: `PINES_HOME`, `PINES_SOCK`,
`PINES_PI_BIN`, `PINES_PI_SESSIONS`.
Using tmux? Enable its mouse mode (`set -g mouse on`) to pass wheel events through.

## Architecture

```
 pines (thin client, your terminal)      pi processes (PTYs)
   forest/tree canvas + pi passthrough      │  each loaded with -e pines-extension.ts
        │ NDJSON over unix socket           │  (reports exact status + runs commands)
        ▼                                   ▼
 pines daemon (detached, survives terminal close)
   owns PTYs (@xterm/headless screen state) · SQLite (forest, FTS5, embeddings)
   session watcher (~/.pi/agent/sessions) · embedding worker (MiniLM)
```

- One Unix socket (`~/.pines/pines.sock`), role handshake (client vs extension),
  protocol-version guard. Detach = drop the socket; processes never stop.
- A *tree* is a pi session JSONL on disk; an *agent* is a pi process bound to
  one. Trees are dormant by default; kill -9 the daemon and everything comes
  back dormant from SQLite on restart.
- Ownership rule: a live tree's JSONL is written only by its pi process (via the
  extension); dormant trees only via pi's SDK. pines never hand-writes session files.

## Development

```sh
pnpm test          # unit + integration (spawns real daemons with a scripted fake pi)
pnpm typecheck
node scripts/gen-sessions.mjs --topics 3 --per 8   # populate a demo forest
```

## Roadmap

- **Graft (v2):** spawn a tree from *two* nodes of different trees, mixing both
  contexts. The data model already carries n-parent provenance
  (`graft_parents`, `pines.graft` custom entries); the mixing strategy and the
  two-node picker are next.
- Crashed-agent final-screen peek, client-side position tweening, copy mode.

## Credits

- [pi](https://pi.dev) by Mario Zechner — the agent, the session tree format,
  and the extension API that makes exact status reporting possible.

Apache-2.0.
