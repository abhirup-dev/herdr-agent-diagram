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
| Go to agent | Every hosted view shows a "Go to agent" button that focuses the agent's pane (`pane.focus {terminal}`); the badge stays for the opt-in layout |
| Processes | One shared sidecar for all boards. Board servers (`mcp-excalidraw-server`, one scene per process, ~58 MB each) run as Bun Workers inside the sidecar process if the spike holds up, else as separate processes started on demand and stopped when idle |

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
2. **Board per agent, one sidecar.** The sidecar becomes multi-board: one upstream link, mirror,
   writer and converted scene per board; mod clients subscribe by board. Board servers start on
   demand on a port per terminal (Workers in the sidecar process, or processes with idle shutdown).
   `canvas open` prints the `EXPRESS_SERVER_URL` the agent prefixes its excalidraw commands with.
3. **One visual mod, three hosts.** A single view (Mermaid pins or the canvas) shared by the split
   pane, the floating window and the popup. Shared chrome module (toolbar, footer, theme tokens, dark
   mode, terminal opacity, zoom); Mermaid gets the canvas's theme sync and camera. A "Go to agent"
   button focuses the agent's pane.
4. **One skill.** Asks Mermaid (pinned) or Excalidraw (interactive), then follows that path. The
   Excalidraw part is the pinned `excalidraw-skill` from `mcp-excalidraw-server install-skill`; the old
   skillshare copy gets excluded to avoid a clash.
5. **Installer.** `herdr-draw install`: skills into Claude, pi and Codex; excalidraw-skill into each;
   mods and fonts; asks before adding the shortcut to keys.json; offers the opt-in layout. Replaces
   `install.sh`.
6. **Docs and upstream.** README; Herdr feature-request drafts: header contributions from mods, pinch.

7. **Agents on other machines.** Each machine runs its own backend (board servers, sidecar, Mermaid
   pin state) beside its agents; the local app runs the frontend (the herdr-draw mod) and a relay in
   the local sidecar. Herdr has no port forwarding, so the bridge is `hc exec --on <machine> -i`, a
   stdin/stdout pipe over Herdr's own machine link. Ids are machine-qualified (`vpsme/t1f`), and E2's
   protocol should use them from the start so local and remote share one code path.

   **Bridge spike (hd-jf3.7.1, 2026-10-31, laptop to vpsme, `scripts/bridge-spike.ts`).**
   `hc exec --on <m> -i` is not a stream. It reads stdin to EOF, runs the program, and returns its
   output at exit (base64 in `machine.exec`). Its timeout is 60 s by default and at most 600 s. So
   the bridge is the machine's own link run as a stdio pipe: `ssh -T -o BatchMode=yes <target>
   <remote endpoint>` (for `--via` machines, the via command with the line as its last argument).

   | Pipe | 1 KB round trip p50 / p95 | Notes |
   |---|---|---|
   | `hc exec -i`, one call per message | 57-64 / 123-278 ms | batch only; usable for one-shot RPC (install, status) |
   | ssh stdio pipe (chosen) | 26 / 95 ms | 64 KB: 56-104 / 190-420 ms; 1 MB scene: 0.7-1.6 s |
   | ssh -L + websocket | 28 / 95 ms | same latency; ssh machines only; needs a listening port there |

   - Throughput over the ssh pipe: 540-1190 msg/s for 1 KB patches, 0.6-1.4 MB/s; the link is the limit.
   - Connect plus first echo: 0.6-1.5 s; reconnect after a drop: 0.6-0.95 s.
   - A 70 s stream at one echo per second ran fine (p50 26 ms), with no cap.
   - Disconnect cases:
     - Killing the local ssh: the remote endpoint sees EOF and exits within 1.5 s.
     - Killing the remote endpoint: the local ssh exits (code 255) in about 0.55 s.
     - A hung link (local ssh stopped): only the endpoint's own idle timeout ends it. So both sides
       heartbeat, and the endpoint exits after missed pings.
   - Pitfalls:
     - A remote server that doesn't read stdin outlives its ssh (no pty, so no SIGHUP). That is what
       happened with the ssh -L server.
     - An idle timeout must count heartbeats, not input. Echoing 6.5 MB back over a ~0.7 MB/s link
       took longer than a 5 s input-idle timer.
     - Use `BatchMode=yes` and a short `ServerAliveInterval`: the user's ssh config waits up to 180 s.
   - Not chosen:
     - `terminal.run --on` plus `terminal.attach` (Herdr's only native stream) is a PTY: echo, `\r\n`
       and a 4 KB line limit unless set raw, plus a framed-API client.
     - ssh -L doesn't work for `--via` machines.

8. **Mermaid pin to editable board (last).** Convert a pinned Mermaid diagram into Excalidraw elements
   headlessly with Pele (`parse()` for structure, the tagged SVG for layout), replacing the upstream
   browser-only `from-mermaid`. Flowcharts first, then state and class; "Edit as board" in the view
   and `herdr-draw mermaid to-board`. Starts after the merged view and per-agent boards exist.

## Tracking

Beads (prefix `hd`): one epic, a child epic per step, issues under each. `bd ready` lists what can start.

## Lint backlog

`bun run check` passes with 43 warnings (long or complex functions, nested ternaries, many
parameters), mostly in src/canvas-mod/paths.ts, src/canvas/edit.ts, src/canvas/scene.ts and the panel
UI. Fix them as those files get touched.
