---
name: herdr-canvas-mod
description: Use inside the Herdr desktop app to draw, lay out, edit or refine an Excalidraw diagram on a live canvas the user can edit too, or when the user asks to see the canvas beside the agent. Works the same when the agent runs on another machine the app reaches. Opens the canvas as a pane to the agent's right; drawing commands are `herdr-draw canvas <command>`.
---

# herdr-canvas-mod

The canvas is a native Herdr pane beside your terminal, showing your own board. You draw with
`herdr-draw canvas <command>`; the user sees each change live and can edit the same scene.

1. **Open once per session:** `herdr-draw canvas open` starts what it needs and splits a canvas pane
   to your right (each run adds another pane, so don't repeat it). On a machine without the Herdr
   app it asks the app on the user's machine to open it; nothing else changes for you.
2. **Draw** with `add`, `apply`, `update`, `delete`; read with `describe`, `get`, `query`; check with
   `screenshot`. Read [references/drawing.md](references/drawing.md) before your first diagram.
   `herdr-draw canvas help [command]` has every command and flag.
3. **Read before you edit:** the user may have changed the scene. Run `describe` first.
4. **Keep it narrow:** the pane is usually tall and narrow. Lay out top to bottom, at most 3-4 boxes
   per row, and wrap long chains onto the next row. Go wide only when the user asks.
5. **Screenshot before you say you're done:** `herdr-draw canvas screenshot` prints a PNG path. Look at
   it: no cut-off text, no labels crossing lines or boxes, arrows longer than their labels.
   Never ask the user to open a browser.

Your board is saved to `~/.local/state/herdr-draw/boards/<your terminal id>.excalidraw` a second after
each change. If the canvas comes back empty, restore it with
`herdr-draw canvas import <that file> --replace`.

For a read-only diagram that stays pinned, use the herdr-diagram skill (`herdr-draw mermaid`).
Mermaid can't be converted onto the canvas: draw the elements directly.
