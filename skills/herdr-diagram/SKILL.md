---
name: herdr-diagram
description: Use when drawing a Mermaid diagram for the user inside the Herdr desktop app, when the user asks to pin, replace or remove a diagram, mentions the diagram badge or Diagrams popup, or when another skill (for example /statechart) produced a chart.mmd worth keeping visible.
---

# herdr-diagram

Pinned diagrams live next to this terminal in the Herdr app: a badge in the
pane header shows how many there are and glows until the user opens them.
Clicking it opens a popup with tabs and pages. You pin with one CLI.

## Rules

1. **Pin only when asked** to keep a diagram visible, or when a diagram is the
   deliverable (an architecture, a flow, a state machine). Chat diagrams stay in
   chat as a `mermaid` code block.
2. **Any Mermaid type works** (flowchart, sequence, state, class, ER, gantt,
   ...). Rendering is Pele, not Mermaid.js: same syntax, its own layout. No
   terminal-era limits: labels can be long, cycles are fine.
   **Keep it narrow.** The user most likely views it in a tall, narrow pane, so
   prefer `TD`/`TB` over `LR`, wrap long rows into a second rank or a subgraph,
   and aim for a diagram taller than it is wide (at most about 4-5 nodes side by
   side). Go wide only when the user asks for it.
3. **Group with tabs.** `--tab` names a tab; pins in one tab belong together
   (one tab per topic: "Auth flow", "Data model"). Default tab is "Diagrams".
4. **Change a pin with `replace`, never by adding a second copy.** Remove pins
   that no longer apply.
5. **Pele rejects what it can't draw** (exit 1 with the reason). Fix the
   Mermaid and retry; don't fall back to another tool.
6. **Look at what you pinned.** `add` and `replace` print a `preview:` PNG path
   and how big the text will show in the popup. Open the PNG (your image/file
   reading tool) and check the labels and layout. On a `warning:` line, split
   the diagram, shorten labels, or switch direction, then `replace`. To try a
   draft without pinning, `herdr-draw mermaid check file.mmd`.
7. The CLI needs `$HC_TERMINAL_ID`, which the terminal running you already
   has. Never pass `--terminal` yourself.

## Commands

```sh
herdr-draw mermaid add [--tab NAME] [--title T] file.mmd     # prints the pin id (d1, d2, ...)
printf 'flowchart TD\n  a --> b\n' | herdr-draw mermaid add --title "Build"
herdr-draw mermaid replace d2 [--title T] file.mmd
herdr-draw mermaid remove d2
herdr-draw mermaid check file.mmd                            # render only: errors, preview PNG, readability
herdr-draw mermaid ls                                        # tabs, ids, titles
```

Input is bare Mermaid, or Markdown with a `# Title` and a ```mermaid fence
(the heading becomes the title).

## With other skills

- `/statechart` (pstack) writes `chart.mmd`, a `stateDiagram-v2`: also run
  `herdr-draw mermaid add --tab "State chart" <out>/chart.mmd` so the user sees it in
  the app.
