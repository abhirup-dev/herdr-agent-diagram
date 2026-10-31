---
name: herdr-canvas-mod
description: Use inside the Herdr desktop app to draw, lay out, edit or refine an Excalidraw diagram on a live canvas the user can edit too, or when the user asks to see the canvas beside the agent. Works the same when the agent runs on another machine the app reaches. Opens the canvas as a pane to the agent's right; drawing commands are `herdr-draw canvas <command>`.
---

# herdr-canvas-mod

In Herdr, the Excalidraw canvas is a native pane beside your terminal, and you have your
own board on it. You draw with `herdr-draw canvas <command>`; the user sees each change
as you make it and can edit the same scene.

1. Before the first drawing in a session, run `herdr-draw canvas open` once. It starts
   what it needs and splits a canvas pane to the right of your terminal (each run adds
   another pane). On a machine without the Herdr app, it asks the app on the user's
   machine to open it; nothing else changes for you.
2. Draw with the board commands: `add`, `apply`, `update`, `delete`, `get`, `query`,
   `describe`, `screenshot`, `export`, `import`, `snapshot`, `arrange`, `clear --yes`.
   How to lay out and refine a diagram, the element format and every flag:
   [references/drawing.md](references/drawing.md) (read it before your first diagram)
   and [references/cheatsheet.md](references/cheatsheet.md).
3. The user edits the same scene; read their changes back with `describe` or `export`
   before you change something they may have touched.
4. Don't ask the user to open anything in a browser: `herdr-draw canvas screenshot`
   works without one.
5. **Keep it narrow.** The canvas pane is usually tall and narrow (a split beside
   your terminal), so lay diagrams out top to bottom: aim for a scene taller than
   it is wide, at most about 3-4 boxes per row, and wrap long chains onto the next
   row instead of stretching them sideways. Go wide only when the user asks for it.
6. **Check the canvas screenshot before you say you're done**: labels must not
   cross other lines or boxes, arrows must be longer than their labels, and the
   whole scene should read at the pane's width.

Your board is saved to `~/.local/state/herdr-draw/boards/<your terminal id>.excalidraw` a second
after each change (on the machine you run on). If the canvas comes back empty after a restart,
bring it back with `herdr-draw canvas import <that file> --replace`.

For a read-only diagram that should stay pinned (not edited together), use the
herdr-diagram skill (`herdr-draw mermaid`) instead. Converting Mermaid onto the canvas
isn't supported yet: draw the elements directly.

The references are adapted from mcp-excalidraw-server's excalidraw-skill (MIT, see
src/board/LICENSE).
