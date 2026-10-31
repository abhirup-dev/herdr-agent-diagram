---
name: herdr-canvas
description: Use inside the Herdr desktop app when drawing or editing an Excalidraw diagram with excalidraw-skill, or when the user asks to see the Excalidraw canvas beside the agent. Opens the live canvas as a pane to the agent's right.
---

# herdr-canvas

In Herdr, the Excalidraw canvas is a native pane, not a browser tab. Draw with
**excalidraw-skill** as usual; this skill only shows its canvas.

1. Before the first drawing in a session, run `herdr-canvas open`. It starts the
   canvas server and the sidecar if they are down, then splits a canvas pane to the
   right of your terminal. Run it once: each run adds another pane.
2. Everything excalidraw-skill writes appears in the pane as you write it. The
   user edits the same scene there; read their changes back with `describe` or
   `export` before you change something they may have touched.
3. Don't ask the user to open `http://127.0.0.1:3000` in a browser: screenshots
   work without one.
