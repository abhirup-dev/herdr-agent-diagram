---
name: herdr-canvas
description: Use inside the Herdr desktop app when drawing or editing an Excalidraw diagram with excalidraw-skill, or when the user asks to see the Excalidraw canvas beside the agent. Opens the live canvas as a pane to the agent's right.
---

# herdr-canvas

In Herdr, the Excalidraw canvas is a native pane, not a browser tab, and every agent
has its own board. Follow **excalidraw-skill** for how to lay out and refine a diagram,
but run its commands as `herdr-draw canvas <command>` instead of
`npx mcp-excalidraw-server <command>` (add, apply, update, delete, get, query, describe,
screenshot, export, import, snapshot, arrange, `clear --yes`). That writes to this
terminal's board; the upstream server on port 3000 is not shown in Herdr.

1. Before the first drawing in a session, run `herdr-draw canvas open`. It starts the
   canvas server and the sidecar if they are down, then splits a canvas pane to the
   right of your terminal. Run it once: each run adds another pane.
2. Everything excalidraw-skill writes appears in the pane as you write it. The
   user edits the same scene there; read their changes back with `describe` or
   `export` before you change something they may have touched.
3. Don't ask the user to open anything in a browser: `herdr-draw canvas screenshot`
   works without one.
4. **Keep it narrow.** The canvas pane is usually tall and narrow (a split beside
   your terminal), so lay diagrams out top to bottom: aim for a scene taller than
   it is wide, at most about 3-4 boxes per row, and wrap long chains onto the next
   row instead of stretching them sideways. Go wide only when the user asks for it.
5. **Check the canvas screenshot before you say you're done**: labels must not
   cross other lines or boxes, arrows must be longer than their labels, and the
   whole scene should read at the pane's width.
