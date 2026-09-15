# Folders — four UX candidates, one data model

Trees (conversations) can be filed into **folders**: a `/`-separated path
such as `work/auth`, stored on the tree in the daemon's SQLite store and
streamed to clients with the rest of the tree summary. Filing a
conversation files every branch of it; archiving and un-archiving leave
the folder alone; a folder exists as long as any tree names it.

The *data* is settled. The *presentation* is not — so this build ships four
sidebar layouts side by side and a runtime switch between them (`F` in the
forest, persisted in `~/.pines/ui.json` as `folderUx`). Live with each for a
few days; the loser layouts get deleted, not maintained.

```sh
pnpm tsx scripts/folders-preview.ts          # the four layouts, side by side
pnpm demo                                    # a sandbox forest, pre-filed
```

## What every layout shares

| key | forest |
|---|---|
| `m` | file the selected conversation: a menu of existing folders (with counts), `+ new folder…` (type `a/b` to nest; under an open folder, a bare name nests inside it, a leading `/` doesn't), `− unfile` |
| `F` | cycle the layout: tree → drill → tabs → chips (a toast names each) |
| `n` | a new tree lands in the folder in view (drill's open folder, the active tab, the chips filter); nowhere under *all*/*unfiled* |
| `r` on a folder row | rename the folder (every tree beneath moves along; nested paths keep their tails) |
| `?` | the help overlay lists the layout-specific keys |

Archived trees stay in their own group at the bottom (`.` reveals them)
whatever the layout. The `Tab`/`o` attention cycle walks trees only —
folders are structure, never targets.

## The four layouts

Rendered at 32 columns from the same fixture (`scripts/folders-preview.ts --plain --width 32`):

```
 1. tree                         │  2. drill                        │  3. tabs                         │  4. chips
 ▾ side                    ●1 2  │  ◂ ..  top level                 │   all●2 │ side●1 │ work●1 │ unf… │  needs input
  ● add usage examples      45m  │  ▸ auth                    ●1 2  │  needs input                     │  ● add oauth token refresh   3m
  · write docs for the wir… 25h  │  ▸ perf                    ◐1 2  │  ● add oauth token refresh   3m  │  ● add usage examples  side 45m
 ▾ work                 ●1 ◐1 5  │  recent                          │  working                         │  working
  ○ migrate the sqlite sch… 30m  │  ○ migrate the sqlite sche… 30m  │  ◐ profile the frame time    1m  │  ◐ profile the frame time    1m
  ▾ auth                   ●1 2  │                                  │  recent                          │  ◐ review this diff    pines 8m
   ● add oauth token refresh 3m  │                                  │  ○ migrate the sqlite sche… 30m  │  recent
   · audit the session cook… 4h  │                                  │  · memoize the layout pass   1h  │  ○ migrate the sqlite sche… 30m
  ▾ perf                   ◐1 2  │                                  │  · audit the session cookies 4h  │  · memoize the layout pass   1h
   ◐ profile the frame time  1m  │                                  │                                  │  · audit the session cookies 4h
   · memoize the layout pass 1h  │                                  │                                  │  · write docs for the wire… 25h
 unfiled                         │                                  │                                  │  · hi                  infra 2d
 ◐ review this diff    pines 8m  │                                  │                                  │
 · hi                  infra 2d  │                                  │                                  │
```

(drill is shown inside `work`; tabs on the `work` tab.)

### 1. tree — collapsible sections (the explorer)

*Archetype:* aerc's `dirlist-tree`, neomutt's sidebar, tmux `choose-tree`,
neo-tree/nvim-tree, WeeChat's buflist.

The sidebar becomes folder-first: every folder is a section header with
its subtree counts (`●2 ◐1 7`: needs input, working, total), its trees
under it in triage order (attention → working → recent), subfolders nested
one indent step in. Unfiled trees follow in the classic state groups.
The canvas is untouched: folding is a list affair.

- `↑`/`↓` walk folder rows too. On a folder: `⏎`/`→`/`f` toggles the fold,
  `←` folds it (or climbs to its parent once folded), `r` renames.
- On a tree: `f` or `←` folds the folder it sits in.
- Folds persist (`collapsedFolders` in `ui.json`).

Good: structure is always visible; nesting is native; the fold keys are
the ones every tree UI uses. Costs: the global "needs input first" triage
is gone — attention lives inside each section (the `●` counts on headers
compensate); the list gets long with many folders unless folded; each
level costs a column of indent in a 32-wide sidebar.

### 2. drill — one level at a time (the file manager)

*Archetype:* ranger/yazi/lf columns, oil.nvim's `-`, and pines' own
"arrows navigate the hierarchy like columns in a file browser" rule.

The folder in view is a level of the Forest ⇄ Tree ⇄ Node hierarchy:
`forest ▸ work ▸ auth` in the breadcrumb. At the top: folders as rows,
then the unfiled trees in state groups. Inside a folder: an `◂ ..` row,
its subfolders, then the trees filed *directly* there. The **canvas
narrows to the folder's subtree** and re-fits, so entering a folder is
zooming into that part of the forest.

- `→`/`⏎` on a folder enters it; `←` (or clicking `◂ ..`) goes up, cursor
  on the folder just left. `f` jumps to any folder by name.
- `n` files the new tree where you are.

Good: the least chrome, the most consistent with the existing navigation
model, and the only layout where the canvas becomes a folder view. Costs:
no overview — what's in other folders is invisible until you go there;
attention in a sibling folder shows only as a count on its row; a tree
under `work/auth` is two `→`s away from the top.

### 3. tabs — workspaces (tmux / zellij / k9s)

*Archetype:* nnn contexts, lazygit panels, gh-dash sections, k9s
namespaces, pisesh's `Favorites · Today · Here · All` bar.

A strip at the top of the sidebar: `all │ side │ work │ unfiled`, with
attention dots per tab. One tab is in view; its trees keep the classic
state-grouped triage list, with subfolder chips (`auth`) on the rows.
The canvas shows the tab's subtree. Tabs are top-level folders only.

- `<`/`>` step tabs, `1`–`9` jump, `f` picks from a menu, clicking a tab
  switches. `n` files into the active tab.
- *unfiled* appears only when both folders and unfiled trees exist.

Good: one keystroke to switch context, always-visible overview of where
attention is, the triage list survives intact within a tab. Costs: no
nesting in the strip (subfolders are chips); the strip clips past ~5
tabs at 32 columns; there is no way to see two folders at once short of
*all*.

### 4. chips — flat list plus a filter (tags / smart folders)

*Archetype:* notmuch/alot saved searches, broot's filtered tree with
paths, Claude Code's picker with `Ctrl+A` showing the project column,
gomuks/tg pin-and-flag lists.

Nothing moves. The sidebar is exactly today's state-grouped list; each
row's chip shows its folder (`work/auth`) instead of the directory. `f`
opens a filter menu (folders with counts and attention dots); a filter
narrows list and canvas to that subtree and shows as a `▾ work` header
(click it, or pick *all*, to clear). Chips shorten relative to the filter.

Good: zero structural cost — the global triage order is untouched and a
folder is just metadata until you ask; the natural home for a future
"tags, not folders" model where one tree can carry several. Costs: folders
are undiscoverable until you open the picker; long titles crowd the chip
out of a narrow sidebar (the title wins, as with the directory chip
today); there is no browsing, only filtering.

## What other TUIs do (research notes)

The survey is in the PR that introduced this document; the short version:

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

Mapped onto the four layouts: 1 is the sidebar-tree consensus, 2 is the
file-manager consensus, 3 is the workspace-switcher consensus, 4 is the
tags/saved-search school. The archetype the research favors for a session
list is a **combination**: a visible single-level switcher (3) with tags
as chips and a filter escape hatch (4), folding (1) only when the list gets
long. Whichever layout wins, `m`, `F`'s data model and the `set_folder`
wire message stay.

## Implementation notes

- Store: `trees.folder TEXT` (schema v4, migrated in place). Daemon:
  `TreeRecord.folder`, persisted with the rest; `set_folder { treeId,
  folder | null }` normalizes (`" work / auth "` → `work/auth`), refuses an
  all-separator path, and broadcasts. Protocol version 3.
- Client: `src/client/forest/folders.ts` builds rows for each layout from
  one `FolderViewState` (`ux`, `collapsed`, `cwd`, `tab`, `filter`);
  `scopeTrees` decides what the canvas and list show. `sidebar.ts` renders
  the new row kinds (`folder`, `up`, `tabs`) and folder chips. The app's
  list cursor can sit on a folder row (`cursorFolder`), which the
  tree-targeting keys refuse with a toast rather than acting on an
  unhighlighted tree.
- Tests: `test/folders.test.ts` (paths, index, all four layouts, renderer),
  `test/folders-flow.test.ts` (the real TUI through a pty: `m`, fold, and
  all four `F` states), `test/daemon.test.ts` and `test/restore.test.ts`
  (wire + persistence across kill -9).
