# Screenshots

Frames of the real TUI, captured from the throwaway demo forest
(`pnpm demo`) — its own daemon, socket, database and sessions under
`~/.pines-demo`, and no model is ever called. The agents are the test
suite's fake pi, which is why the header reads `pi custom` rather than a
version.

| file | what it shows |
|---|---|
| `01-forest.png` | the forest: state-grouped sidebar (needs input / working / recent), live agents on the canvas |
| `02-canopy.png` | zoomed in — maturity by conversation size, an elder on its bark trunk |
| `03-tree.png` | one conversation as one tree: sibling branches, a branch of a branch, agent tips, the metro map |
| `04-flow.png` | flow view: one branch's conversation, root to tip |
| `05-search.png` | FTS5 search reaching messages inside branches |

Regenerate with `scripts/screenshot/shot.sh` (see the header there).

The semantic layout is **not** in these shots: the machine that captured
them could not reach huggingface.co, so the embedding model never loaded
and the forest fell back to the deterministic lexical layout. Shots of
the semantic map and of `s` (similar conversations, with receipts) need a
machine that can download the model once.

## Diagrams

| file | what it shows |
|---|---|
| `branch-diagram.png` | where a linear conversation wants to branch (the post's mermaid flowchart) |
| `session-tree-diagram.png` | a pi session file, its `parentId` pointers, and the tree they already form |

Each has a `-light.png` twin for light backgrounds. Sources are in `src/`:

```sh
# flowchart — needs @mermaid-js/mermaid-cli
mmdc -i src/branch-diagram.mmd -o /tmp/d.svg -c src/mermaid-dark.json -b transparent

# session tree — a hand-built page, rendered like the screenshots
chromium --headless --force-device-scale-factor=2 --window-size=1250,1250 \
  --default-background-color=0d1117ff --screenshot=/tmp/d.png \
  file://$PWD/src/session-tree-diagram.html
node ../../scripts/screenshot/trim.mjs /tmp/d.png out.png 100
```

`trim.mjs` crops a render to its content and re-pads it, which is what keeps
the margins even — Chromium's screenshot viewport is shorter than the window
it is given.
