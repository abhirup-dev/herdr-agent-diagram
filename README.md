# herdr-agent-diagram

Coding agents (Claude Code, Pi, anything with a shell) pin Mermaid diagrams
for the terminal they run in. The Herdr desktop app shows a badge in that
pane's header and a popup viewer with tabs and pages.

```
agent ──herdr-diagram add──▶ ~/.config/herdr-app/data/herdr-agent-diagram/<terminal>/
                              state.json + <pin>-r<rev>.svg (raw Pele SVG)
                                     │ watchFolder
          ┌──────────────────────────┴──────────────────────────┐
   mods/diagram-pane (pane header + badge)        mods/diagram-popup (viewer)
   count, glows while rev > seen                  themes the SVG (theme() colors,
   click → openOverlay(diagram-popup)             installed sans font), tabs, pages
```

State is keyed by `$HC_TERMINAL_ID` only: one diagram set per terminal.

## Try it (POC, local install)

```sh
npm install
./install.sh                   # ~/.local/bin/herdr-diagram, mods into ~/.config/herdr-app/mods,
                               # skill into ~/.claude/skills and ~/.pi/agent/skills
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
printf 'flowchart TD\n  a[Cart] --> b[Pay]\n' | herdr-diagram add --title "Checkout"
herdr-diagram ls
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

```
herdr-diagram add [--tab NAME] [--title T] [file]   bare mermaid or markdown with a ```mermaid fence; stdin if no file
herdr-diagram replace <id> [--title T] [file]
herdr-diagram remove <id>
herdr-diagram check [file | id]                     render only: Pele errors, a PNG preview, readability warnings
herdr-diagram ls [--json]
herdr-diagram clear
  --terminal <addr>   override $HC_TERMINAL_ID (testing)
```

## Layout of this repo

- `bin/herdr-diagram.mjs`: the CLI (Node, `pele`, `@resvg/resvg-js` for PNG previews).
- `mods/diagram-pane/`: clone of Herdr's shipped `pane` header plus the badge.
- `mods/diagram-popup/`: the viewer.
- `skills/herdr-diagram/SKILL.md`: the agent skill (Claude Code and Pi read the same file).
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
