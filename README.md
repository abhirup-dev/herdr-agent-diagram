# Herdr Canvas Mod

A live Excalidraw canvas and pinned Mermaid diagrams for coding agents in the Herdr desktop app,
driven by the `herdr-draw` CLI.

Coding agents (Claude Code, Pi, anything with a shell) pin Mermaid diagrams
for the terminal they run in. The Herdr desktop app shows a badge in that
pane's header and a popup viewer with tabs and pages.

```
agent ──herdr-draw mermaid add──▶ ~/.config/herdr-app/data/herdr-agent-diagram/<terminal>/
                              state.json + <pin>-r<rev>.svg (raw Pele SVG)
                                     │ watchFolder
          ┌──────────────────────────┴──────────────────────────┐
   mods/diagram-pane (pane header + badge)        mods/diagram-popup (viewer)
   count, glows while rev > seen                  themes the SVG (theme() colors,
   click → openOverlay(diagram-popup)             installed sans font), tabs, pages
```

State is keyed by `$HC_TERMINAL_ID` only: one diagram set per terminal.

## Install

On the machine that runs the Herdr app:

```sh
curl -fsSL https://raw.githubusercontent.com/abhirup-dev/herdr-canvas-mod/main/install.sh | sh
# or from a clone:
git clone https://github.com/abhirup-dev/herdr-canvas-mod.git && cd herdr-canvas-mod && ./install.sh
```

`install.sh` gets bun if needed, installs dependencies and runs `herdr-draw install`, which asks:

- which agents get the skills (Claude Code, pi, Codex; the ones found are the default);
- which of your other machines (`hc machine ls`) to sync, and for which agents there.

Nothing is installed on another machine unless you pick it. A synced machine gets the CLI and the skills
(copied from this machine over hc; if its bun is missing or older than 1.4, a private one in
`~/.local/share/herdr-draw-bun`). Agents there draw as usual: their canvas opens beside them in this app,
and their pinned diagrams show in the same badge and popup, over a link opened on first use.

```sh
herdr-draw install -y --agents claude,pi --machines vpsme   # no questions (agents, scripts)
herdr-draw install --machines vpsme                          # add or update one machine later
herdr-draw doctor                                            # check this machine and synced ones
herdr-draw uninstall                                         # remove (asks about synced machines)
```

The badge needs a layout whose pane header is `diagram-pane`. Shipped layouts
are read-only, so clone yours once and point the header at the mod:

```sh
herdr-app do layout.clone '{"name":"compact","as":"compact-diagrams"}'
# in ~/.config/herdr-app/layouts/compact-diagrams.json, on the {"tab":"active"} block's "pane":
#   "header": { "content": { "mod": "diagram-pane" }, "height": 30, "position": "top", "reveal": "always" }
```

`layout.clone` switches to the clone. Back to the shipped one:
`herdr-app do layout.switch --name compact` (or `cmd-shift-l` cycles).

Then, in any terminal inside Herdr:

```sh
printf 'flowchart TD\n  a[Cart] --> b[Pay]\n' | herdr-draw mermaid add --title "Checkout"
herdr-draw mermaid ls
```

The header shows `◫ 1`, glowing. Click it, or `herdr-app do mod.open --name diagram-popup`
(opens for the focused pane). Each diagram is fitted to its viewport; its toolbar zooms
(− + fit 1:1), pans (← ↑ ↓ →) and maximises. Drag or scroll pans, ⌘/ctrl-scroll zooms,
double-click maximises. Keys: `←`/`→` pages, `↑`/`↓` or `1`-`9` tabs, `+` `-` `0` zoom/fit,
`f` maximise (arrows then pan), `Esc` restores, then closes.

Every pin also gets `<id>.png` beside `state.json` (light theme, via resvg) so an
agent can look at what it drew; `add`/`replace` print its path and a readability
warning when the fitted text would be under 70% size.

## CLI

Help is layered: `herdr-draw help` is a short overview (groups, aliases, exit codes, environment variables);
`herdr-draw <group> help` has that group's commands and flags; `herdr-draw canvas help` lists the board commands'
usages and `herdr-draw canvas help <command>` (or `<command> --help`) shows one. Usage errors (unknown command, option
or argument) exit 2.

```
herdr-draw mermaid add [--tab NAME] [--title T] [file]   bare mermaid or markdown with a ```mermaid fence; stdin if no file
herdr-draw mermaid replace <id> [--title T] [file]
herdr-draw mermaid remove <id>
herdr-draw mermaid check [file | id]                     render only: Pele errors, a PNG preview, readability warnings
herdr-draw mermaid ls [--json]
herdr-draw mermaid clear
  --terminal <addr>   override $HC_TERMINAL_ID (testing)
herdr-draw canvas open | start | status                  live Excalidraw canvas beside this terminal; status prints JSON health
herdr-draw canvas <board command>                        add, apply, update, delete, get, query, describe, screenshot,
                                                         export, import, snapshot, arrange, clear (herdr-draw canvas help)
herdr-draw open                                          the view for this terminal (for now: canvas open)
herdr-draw install [-y|--yes] [--agents claude,pi,codex|none] [--machines a,b | --no-machines] [--headless]
herdr-draw uninstall [-y] [--machines a,b]
herdr-draw doctor                                        exits 1 if something is missing
herdr-draw logs [component] [-n N] [--machine NAME] [--path]
herdr-draw -V | --version
herdr-draw help [group [command]]
```

Environment: `HC_TERMINAL_ID` (set by herdr-core; picks your pins and board), `HERDR_APP_HOME` (default
`~/.config/herdr-app`), `CANVAS_SIDECAR_PORT` (default 3077), `HERDR_DRAW_BUN` (the bun for the sidecar and board
commands), `HERDR_DRAW_DEBUG=0` (no debug log lines), `HERDR_DRAW_LOGS` and `HERDR_DRAW_BOARDS` (default under
`${XDG_STATE_HOME:-~/.local/state}/herdr-draw/`); for `install.sh`: `HERDR_DRAW_REPO`, `HERDR_DRAW_HOME`.

The CLI parses with [cac](https://github.com/cacjs/cac), one program per group (`cli/lib/args.mjs`); the board
commands keep their own table in `src/board/cli.ts`.

## Debugging

Every part writes a log, with debug lines on by default for now (`HERDR_DRAW_DEBUG=0` turns them off):

| Where | What |
|-------|------|
| `~/.local/state/herdr-draw/logs/` (`$HERDR_DRAW_LOGS`) | `cli`, `sidecar`, `endpoint` (the bridge's far end), `install`; `sidecar-<port>.out` is its raw stdout |
| `~/.config/herdr-app/data/herdr-draw/logs/` | `mod-excal-canvas`, `mod-diagram-pane`, `mod-diagram-popup` (mods can only write under the app home) |
| `~/.local/state/herdr-draw/boards/` | each board saved as `<board>.excalidraw`; restore with `herdr-draw canvas import <file> --replace` |

`herdr-draw logs [component] [-n N]` merges them by time; `--machine vpsme` reads a synced machine's logs over hc.
For a remote board, read both sides: the laptop's `sidecar` (`relay:` and `bridge vpsme:` lines) and the machine's
`endpoint` (`<-` frames in, `->` frames out) and `sidecar`.

## Layout of this repo

- `cli/herdr-draw.mjs`: the CLI router; `cli/lib/mermaid.mjs` (Node, `pele`, `@resvg/resvg-js` for PNG previews)
  and `cli/lib/canvas.mjs` (starts the canvas server from `node_modules/.bin` and the sidecar, splits the pane).
- `mods/diagram-pane/`: clone of Herdr's shipped `pane` header plus the badge.
- `mods/diagram-popup/`: the viewer.
- `skills/herdr-canvas-mod/`: the agent skill; `SKILL.md` routes to `references/mermaid.md` (pins) or `references/canvas.md` (live canvas).
- `scratch/anim-spike.mjs`: the animated-GIF experiment (negative result, see below).

## Known limits (POC)

- Local machine only. Remote terminals (`vps/t7`) are refused by the CLI.
- The SVG text font is the nearest installed sans (Helvetica Neue), not Herdr's
  bundled Geist: GPUI's SVG rasteriser only sees installed fonts.
- Animations: Pele only marks animated edges (dash pattern + class, usecase and
  agentflow only); GPUI's `image()` draws one frame of SVGs and GIFs, and
  timer-driven frame swaps did not repaint reliably. Not supported.
- `mod.open` cannot pass props, so the popup opened from the palette or CLI
  shows the focused pane's terminal.
- `herdr-app check` does not run deferred renders: test tab switches in the app.
- Pele's own zoom/pan controls (`enableZoom`) are DOM-only; the popup reimplements
  them natively. `on_size_change` reports unzoomed px while `.w()`/`.h()` are
  multiplied by the app zoom, so the popup divides measured sizes by `settings().zoom`.
