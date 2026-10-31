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
   Chosen: an hc terminal stream. `hc run --on <m> --name <n>` starts the remote endpoint with its tty
   raw (`stty raw -echo`), and the relay runs `hc attach <m>/<n>` under a pseudo-terminal (Bun's
   built-in `Bun.Terminal`, so no python or `script`). It is Herdr-native: no extra configuration,
   hc's own machine link, and it works for ssh and `--via` machines alike.
   `hc exec --on <m> -i` is not a stream: it reads stdin to EOF, runs the program, and returns its
   output at exit, with a 600 s cap. It stays for one-shot calls such as starting the remote backend.

   | Pipe | 1 KB round trip p50 / p95 | 64 KB | 1 MB | 1 KB throughput | Connect |
   |---|---|---|---|---|---|
   | `hc exec -i`, one call per message | 57-66 / 123-278 ms | | | | per call |
   | hc terminal stream (chosen) | 28-31 / 103-150 ms | 151-185 / 225-465 ms | 1.2-2.2 s | 480-1130 msg/s, 0.5-1.2 MB/s | cold 0.8 s, reattach 0.04-0.8 s |
   | ssh stdio pipe (fallback) | 25-26 / 92-95 ms | 56-104 / 165-420 ms | 0.7-1.9 s | 540-1190 msg/s, 0.6-1.4 MB/s | 0.6-1.5 s |
   | ssh -L + websocket | 26-28 / 95-99 ms | | | | 0.6-1.7 s |

   Numbers vary with the link (vpsme is the limit at about 0.5-1.4 MB/s). The hc stream is within
   2x of ssh except at the 64 KB p50 (about 2x); a full scene is sent only on subscribe or resync.

   - **hc terminal stream, behaviour:**
     - It ran 70 s at one echo per second (p50 45 ms) with no cap.
     - Bytes pass exactly, including UTF-8 and DEL. Lines of 64 KB and 1 MB work: input arrives in
       ~1 KB pieces, and raw mode removes the 4 KB canonical line limit.
     - Killing the attach client leaves the remote program running; a new attach reaches it again.
     - Killing hc's own link to the machine: the attach survives and resumes after hc re-dials it
       (1.3-3.6 s). Frames sent in that gap are lost (7 of 8 sends over 2 s).
     - On attach and on resume, hc repaints the screen, so old lines come back.
     - Until `hc attach` sets its tty raw, the local tty echoes input back.
     - A user who opens the endpoint's terminal in Herdr could type into it.
   - **How src/bridge handles that:**
     - Frames parse from the first `{`.
     - Frames before the pong to the link's first ping are ignored.
     - Frames carry per-link sequence numbers: a repeat is dropped, and a gap asks for full state.
       Up gaps make the endpoint reopen its boards; down gaps make the relay resubscribe.
     - A lost op is not re-sent: the follow-up is acks plus resend.
   - **End to end through src/bridge on vpsme (fake sidecar websocket there):**
     - hc stream: cold start to scene 0.75-0.96 s; ops to patch p50 25-55 / p95 33-120 ms. A
       killed hc link answers ops again after 1.5-1.8 s, with 2 full-state resyncs; 6 of 80 ops sent
       4/s were lost.
     - ssh: subscribe to scene 0.67 s; ops to patch 29 / 93 ms. A killed endpoint is seen in 0.53 s,
       and a queued op is answered 1.6 s later.
   - **ssh fallback:**
     - Built only from `hc machine ls`: `ssh -T -o BatchMode=yes -o ServerAliveInterval=5 <target>`,
       or `<via command> '<line>'`.
     - A ControlMaster in the user's ssh config is reused as ssh always does. hc's own control
       socket (`$XDG_STATE_HOME/herdr-core/<session>/ssh-<hash>`) can't be matched to a machine from
       outside, and none was running.
     - Killing the local ssh ends the remote endpoint (EOF) within 1.5 s; killing the endpoint ends
       ssh in 0.55 s. A hung link is ended only by heartbeats, so both sides ping.
   - **Pitfalls:**
     - A remote program that doesn't read stdin outlives its ssh (no pty, no SIGHUP), as the ssh -L
       server did.
     - Idle timeouts must count heartbeats, not input: echoing 6.5 MB back over ~0.7 MB/s took longer
       than a 5 s input timer.
     - ssh -L needs a listening port on the machine and doesn't work for `--via` machines.

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
