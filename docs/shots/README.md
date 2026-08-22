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
