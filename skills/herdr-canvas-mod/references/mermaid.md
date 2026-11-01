# Pinned Mermaid diagrams

Pins live next to your terminal in the Herdr app: a badge in the pane header shows how many there are
and glows until the user opens them; clicking it opens a popup with tabs and pages.

Any Mermaid type works (flowchart, sequence, state, class, ER, gantt, ...). Rendering is Pele, not
Mermaid.js: same syntax, its own layout. It refuses what it can't draw (exit 1 with the reason).

Group pins in tabs by topic (`--tab "Auth flow"`; the default is "Diagrams"). Change a pin with
`replace` (same id, same tab) rather than adding a copy, and `remove` pins that no longer apply.

Do:
- **Keep labels short and wrap long chains** into subgraphs or a second rank, so the diagram fits the
  popup at full size.
- **Split a big diagram** (more than about 15 nodes) into a few focused ones.

Don't:
- Don't ignore a `warning:` line: split the diagram, shorten labels, or switch to the direction it
  names, then `replace`.
- Don't trust "ok" alone: Pele can draw overlapping parts without complaint (ER cardinality marks,
  for one). Open the `preview:` PNG; the line after it, e.g. `fits the popup (1460x912) at 80% size`,
  is measured against the user's actual popup.

```sh
herdr-draw mermaid add [--tab NAME] [--title T] file.mmd   # prints the pin id (d1, d2, ...)
printf 'flowchart TD\n  a --> b\n' | herdr-draw mermaid add --title "Build"
herdr-draw mermaid replace d2 [--title T] file.mmd
herdr-draw mermaid remove d2
herdr-draw mermaid check file.mmd                          # render only (or a pin id, e.g. d2): errors, preview, readability
herdr-draw mermaid ls [--json]
herdr-draw mermaid clear                                   # remove every pin of this terminal
```

Input is bare Mermaid, or Markdown with a `# Title` and a ```mermaid fence (the heading becomes the title).

Another skill wrote a `chart.mmd` (for example `/statechart`)? Pin it too:
`herdr-draw mermaid add --tab "State chart" <out>/chart.mmd`.
