---
name: herdr-canvas-mod
description: Use inside the Herdr desktop app to show the user a diagram beside the agent, either pinned as Mermaid (the pane's Diagrams badge and popup) or drawn on a live Excalidraw canvas the user can edit too. Use when the user asks to pin, replace or remove a diagram, mentions the diagram badge or popup, asks to draw, lay out or edit a diagram together, or asks to see the canvas; also when another skill produced a chart.mmd worth keeping visible. Works the same when the agent runs on another machine the app reaches. One CLI: `herdr-draw`.
---

# herdr-canvas-mod

Two ways to show a diagram next to your terminal in the Herdr app, both through `herdr-draw` CLI:

| The user wants | Use | Read first |
|---|---|---|
| A diagram kept visible, read-only (an architecture, a flow, a state machine) | `herdr-draw mermaid`: pins show in the pane's Diagrams badge and popup | [references/mermaid.md](references/mermaid.md) |
| To draw or edit a diagram together, or to see the canvas | `herdr-draw canvas`: a live Excalidraw pane to your right | [references/canvas.md](references/canvas.md) |

Diagrams that are just part of a chat answer stay in chat. Mermaid pins can't be converted onto the
canvas: draw the elements there directly.

Both modes:

- **Prefer tall diagrams.** The user views it in a tall, narrow pane: keep horizontal width conservative, lay out top to bottom, a few nodes per
  row, wrap long chains. Go wide only when asked.
- **Look at what you made before you say you're done.** Both print a PNG path (`mermaid add` and
  `replace` print `preview:`, `canvas screenshot` prints its file). Open it and fix cut-off text,
  crossing labels and cramped layouts.
- `herdr-draw <mermaid|canvas> help [command]` has every command and flag. Never pass `--terminal`;
  your terminal's `$HC_TERMINAL_ID` picks your pins and your board.
- If a pin or the canvas doesn't show up, check `herdr-draw logs` before guessing.
