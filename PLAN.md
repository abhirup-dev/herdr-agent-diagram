# herdr-draw: packaging and unification plan

Decided 2026-10-31. One package and CLI, `herdr-draw`, for both kinds of visual: pinned Mermaid diagrams
(read-only) and a live Excalidraw canvas (the user can edit). The agent asks which one the user wants.

## Decisions

| Topic | Decision |
|---|---|
| Name | `herdr-draw` (package, CLI, mods, skill) |
| Canvas scope | One board per agent: a canvas server per drawing agent on its own port |
| Layout | Never edit the user's layout by default. Floating window without layout changes; header badge only in an opt-in layout we ship (like `win98`) |
| Mermaid popup | Keep it, beside the new split and window views |

## Herdr facts behind them (from ~/.config/herdr-app/AGENTS.md)

- Layouts belong to the user. Mods never edit them; Herdr has no layout merge or contribution API.
  A pane header and the terminal menu are single slots: one mod each, set in the layout file. So
  plugins can't stack there; the only automatic placement is `mod.json` `place`, docked once.
- `pane.split {mod}` is a runtime command, not a layout edit: the agent (CLI) or a key can always split.
- `openOverlay({ kind: "window", key, keep })`: non-modal, draggable, stays open, remembers its spot,
  reopens on start with `keep`. Also openable as `mod.open` through `mod.json` `overlay`, and from
  `keys.json` (`mod.open:<name>`), which is the documented way a package adds shortcuts.
- Window limits: it floats over the terminal (doesn't resize it), sizes to its content (we draw our
  own resize grip), and a layout switch closes it unless kept.

## Ways in

| Trigger | Without layout change | With the herdr-draw layout |
|---|---|---|
| Agent draws | split to its right (`pane.split`) | same |
| User shortcut (keys.json) | toggles the floating window | toggles the split |
| Header badge | n/a | toggles the split |
| Big view | Mermaid popup, window maximise | same |

## Steps

1. **CLI and package skeleton.** `herdr-draw mermaid add|replace|remove|check|ls|clear`,
   `herdr-draw canvas open|start|status`, `herdr-draw open`, `herdr-draw install`. Replaces
   `herdr-diagram` and `herdr-canvas`. `mcp-excalidraw-server` as a dependency: `excalidraw-canvas`
   on PATH, no npx (about 1 s saved per agent command).
2. **Board per agent.** `canvas open` starts a server and a sidecar on ports derived from the
   terminal and prints the `EXPRESS_SERVER_URL` the agent prefixes its excalidraw commands with. The
   pane connects to its terminal's sidecar.
3. **One visual mod, three hosts.** A single view (Mermaid pins or the canvas) shared by the split
   pane, the floating window and the popup. Shared chrome module (toolbar, footer, theme tokens, dark
   mode, terminal opacity, zoom); Mermaid gets the canvas's theme sync and camera.
4. **One skill.** Asks Mermaid (pinned) or Excalidraw (interactive), then follows that path. The
   Excalidraw part is the pinned `excalidraw-skill` from `mcp-excalidraw-server install-skill`; the old
   skillshare copy gets excluded to avoid a clash.
5. **Installer.** `herdr-draw install`: skills into Claude, pi and Codex; excalidraw-skill into each;
   mods and fonts; asks before adding the shortcut to keys.json; offers the opt-in layout. Replaces
   `install.sh`.
6. **Docs and upstream.** README; Herdr feature-request drafts: header contributions from mods, pinch.

## Lint backlog

`bun run check` passes with 43 warnings (long or complex functions, nested ternaries, many
parameters), mostly in src/canvas-mod/paths.ts, src/canvas/edit.ts, src/canvas/scene.ts and the panel
UI. Fix them as those files get touched.
