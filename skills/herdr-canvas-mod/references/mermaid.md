# Pinned Mermaid diagrams

Pins live next to your terminal in the Herdr app: a badge in the pane header shows how many there are
and glows until the user opens them; clicking it opens a popup with tabs and pages.

1. **Pin only when asked** to keep a diagram visible, or when the diagram is the deliverable.
2. **Any Mermaid type works** (flowchart, sequence, state, class, ER, gantt, ...). Rendering is Pele, not
   Mermaid.js: same syntax, its own layout. Prefer `TD`/`TB` over `LR`; at most 4-5 nodes side by side.
3. **One tab per topic:** `--tab "Auth flow"`. The default tab is "Diagrams".
4. **Change a pin with `replace`**, never by adding a second copy. Remove pins that no longer apply.
5. **Pele refuses what it can't draw** (exit 1 with the reason): fix the Mermaid and retry.
6. **Check the preview:** `add` and `replace` print a `preview:` PNG and how big the text will show. On a
   `warning:` line, split the diagram, shorten labels or change direction, then `replace`.

```sh
herdr-draw mermaid add [--tab NAME] [--title T] file.mmd   # prints the pin id (d1, d2, ...)
printf 'flowchart TD\n  a --> b\n' | herdr-draw mermaid add --title "Build"
herdr-draw mermaid replace d2 [--title T] file.mmd
herdr-draw mermaid remove d2
herdr-draw mermaid check file.mmd                          # render only: errors, preview, readability
herdr-draw mermaid ls
```

Input is bare Mermaid, or Markdown with a `# Title` and a ```mermaid fence (the heading becomes the title).

Another skill wrote a `chart.mmd` (for example `/statechart`)? Pin it too:
`herdr-draw mermaid add --tab "State chart" <out>/chart.mmd`.
