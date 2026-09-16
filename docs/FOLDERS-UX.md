# Folders — the decision and the alternatives

Trees (conversations) can be filed into **folders**: a `/`-separated path
such as `work/auth`, stored on the tree in the daemon's SQLite store and
streamed to clients with the rest of the tree summary. Filing a
conversation files every branch of it; archiving and un-archiving leave
the folder alone; a folder exists as long as any tree names it.

The sidebar shows folders as **collapsible sections** (the *tree* layout
below). That is the one that shipped; this document keeps the record of
the three alternatives that were built alongside it, tried side by side,
and removed, plus the survey of other TUIs that informed all four.

```sh
pnpm tsx scripts/folders-preview.ts          # the sidebar with folders, from a fixture
pnpm demo                                    # a sandbox forest, pre-filed
```

## What shipped

| key | forest |
|---|---|
| `m` | file the selected conversation: a menu of existing folders (with counts), `+ new folder…` (`a/b` nests), `− unfile` |
| `↑`/`↓` | walk folder rows as well as trees |
| `⏎`/`→` on a folder row | unfold (or fold) it |
| `f`/`←` | fold the folder at the cursor (on a tree: the folder it sits in); `←` on a folded folder climbs to its parent |
| `r` on a folder row | rename the folder (every tree beneath moves along; nested paths keep their tails) |
| `n` on a folder row | start a new tree filed in that folder |
| click | a folder row: first click selects, second folds/unfolds |

Folder headers carry their subtree's badges (`●2 ◐1 7`: needs input,
working, total). A folder's trees sit under it in triage order (attention
→ working → recent), one indent step in; subfolders nest. Unfiled trees
follow in the classic state groups, archived trees last (`.` reveals them).
The canvas is untouched: folding is a list affair. Folds persist in
`~/.pines/ui.json`. `Tab`/`o` attention cycling walks trees only.

```
 ▾ side                      ●1 2
  ● add usage examples        45m
  · write docs for the wire … 25h
 ▾ work                   ●1 ◐1 5
  ○ migrate the sqlite schema 30m
  ▾ auth                     ●1 2
   ● add oauth token refresh   3m
   · audit the session cookies 4h
  ▾ perf                     ◐1 2
   ◐ profile the frame time    1m
   · memoize the layout pass   1h
 unfiled
 ◐ review this diff      pines 8m
 · hi                    infra 2d
```

*Archetype:* aerc's `dirlist-tree`, neomutt's sidebar, tmux `choose-tree`,
neo-tree/nvim-tree, WeeChat's buflist — the sidebar-tree consensus of the
mail and chat clients. Its cost is known: the global "needs input first"
triage is gone; attention lives inside each section, and the `●` counts on
headers are what carry it across the list.

## The alternatives that were tried

All four were implemented on the same data model, switchable at runtime,
and compared on the same fixture. They are gone from the code; the shapes
are recorded here in case the question comes back.

**drill — one level at a time (the file manager).** ranger/yazi/lf
columns, oil.nvim's `-`. The folder in view is a level of the Forest ⇄
Tree ⇄ Node hierarchy (`forest ▸ work ▸ auth` in the breadcrumb): folders
as rows, `◂ ..` inside one, and the canvas narrows to the folder's subtree.
The least chrome and the most consistent with the existing arrow-key
navigation, but no overview: attention in a sibling folder shows only as
a count on its row, and a nested tree is two `→`s away.

**tabs — workspaces (tmux / zellij / k9s).** nnn contexts, lazygit panels,
gh-dash sections, pisesh's `Favorites · Today · Here · All` bar. A strip
`all │ side │ work │ unfiled` atop the classic triage list, one tab in
view, subfolders as chips, `<`/`>` and `1`-`9` to switch. One keystroke per
context and the triage list survives intact, but no nesting in the strip,
and it clips past about five tabs at 32 columns.

**chips — flat list plus a filter (tags / saved searches).** notmuch/alot,
broot's filtered paths, Claude Code's picker with the project column.
Nothing moves: the row's chip shows its folder and `f` filters list and
canvas to one folder. Zero structural cost and the natural home for a
future tags model, but folders are undiscoverable until the picker opens,
and long titles crowd the chip out of a narrow sidebar.

## What other TUIs do (research notes)

- **AI-agent TUIs barely group.** Claude Code, opencode, Codex, Gemini
  CLI, pi and crush all scope sessions by *working directory*, sort by
  recency, and offer search and rename — none has user-defined folders or
  tags. The demand shows up in their trackers: opencode's sessions vanish
  past a 50-newest window (#48974) and users ask for pinned session tabs
  (#24451); pi's third-party `pisesh` adds a `Favorites · Today · Here ·
  All` tab bar and starring. pines already keeps cwd as a chip, so "cwd is
  the folder" is table stakes, not a design.
- **Mail and chat clients converge on a foldable sidebar tree** (aerc
  `dirlist-tree`, neomutt sidebar, WeeChat buflist) — with *saved queries
  rendered as folders in the same list* (aerc `query-map`, neomutt
  `virtual-mailboxes`). notmuch/alot go all the way to tags-only.
- **File managers pick columns or a single-level `-`/`..`** (ranger, yazi,
  lf, oil) with tabs/contexts (`1`–`9`) as the parallel-workspace axis
  (nnn, yazi, ranger).
- **Workspace tools use a visible scope switcher**: lazygit `1`–`5`
  panels, k9s `:ns` with numbered favorites, gh-dash sections on `h`/`l`,
  tmux `choose-tree`'s collapsible sessions → windows → panes.
- **Nobody nests deep.** No surveyed chat or agent tool needed more than
  two levels; the ones with trees ship a default collapse depth.

## Implementation notes

- Store: `trees.folder TEXT` (schema v4, migrated in place). Daemon:
  `TreeRecord.folder`, persisted with the rest; `set_folder { treeId,
  folder | null }` normalizes (`" work / auth "` → `work/auth`), refuses an
  all-separator path, and broadcasts. Protocol version 3.
- Client: `src/shared/folders.ts` (path helpers), `src/client/forest/
  folders.ts` (folder index, section rows), `sidebar.ts` (folder rows,
  indent, per-line row map for clicks), `app.ts` (a list cursor that can
  sit on a folder row — `cursorFolder` — which the tree-targeting keys
  refuse with a toast rather than acting on an unhighlighted tree).
- Tests: `test/folders.test.ts` (paths, index, sections, renderer),
  `test/folders-flow.test.ts` (the real TUI through a pty: `m` → new
  folder, fold/unfold, rename from the row), `test/daemon.test.ts` and
  `test/restore.test.ts` (wire + persistence across kill -9).
