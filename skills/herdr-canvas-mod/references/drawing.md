# Drawing on the canvas

Every command runs as `herdr-draw canvas <command>` on this terminal's board. Results are JSON on stdout
(`describe` is plain text). Exit codes: 0 ok, 1 error, 2 usage, 3 board unreachable.
Adapted from mcp-excalidraw-server's excalidraw-skill (MIT, src/board/LICENSE).

## Elements

Send a JSON array to `add` (a file, or stdin), or a patch to `apply`:
`{"create":[...],"update":[{"id":"a","set":{...}}],"delete":["id"]}`.

- Give every element an `id` you choose (`"auth-svc"`), so you can update it later.
- `"text": "Label"` on a shape becomes its label.
- Arrows: `"startElementId"` / `"endElementId"` bind them to shapes; they route to the edges and follow
  when the shapes move.
- `fontFamily` takes a name (`"excalifont"`, `"helvetica"`, `"cascadia"`) or `"1"`-`"8"`.

```bash
herdr-draw canvas add <<'EOF'
[
  {"id": "web", "type": "rectangle", "x": 100, "y": 0, "width": 180, "height": 60, "text": "Web app"},
  {"id": "api", "type": "rectangle", "x": 100, "y": 160, "width": 180, "height": 60, "text": "API"},
  {"id": "db", "type": "rectangle", "x": 100, "y": 320, "width": 180, "height": 60, "text": "Postgres"},
  {"type": "arrow", "x": 0, "y": 0, "startElementId": "web", "endElementId": "api"},
  {"type": "arrow", "x": 0, "y": 0, "startElementId": "api", "endElementId": "db"}
]
EOF
```

## Layout

(0, 0) is the top left; x grows right, y grows down. Plan the grid before writing JSON.

- Rows 80-120px apart; siblings at least 40px apart, 120px+ when the arrow between them has a label.
- Shape width `max(160, label characters × 12)`; height 60 for one line, 80 for two.
- Fonts at least 16 (titles 20).
- Zones (background rectangles): 50px padding around what they hold, `"strokeStyle": "dashed"`.
- `"fillStyle": "solid"` gives flat fills (the default is sketchy hachure). Stroke/fill pairs:
  `#1971c2`/`#a5d8ff` blue, `#2f9e44`/`#b2f2bb` green, `#e03131`/`#ffc9c9` red, `#e8590c`/`#ffd8a8`
  orange, `#9c36b5`/`#eebefa` purple, `#0c8599`/`#99e9f2` cyan, `#868e96`/`#e9ecef` gray.
- Order: zones, shapes, arrows, annotations, then refine.

Avoid these:

1. **No label on a zone.** It is centred over the boxes inside. Use a separate `text` element at the
   zone's top-left corner instead.
2. **No arrows across zones** through other elements. Keep arrows within a tier or zone, or route
   them along the edge.
3. **Few arrow labels**, 12 characters at most, and only when the label carries real information
   (a protocol, a port, a direction). A label needs an arrow longer than itself.

To route around an obstacle, add waypoints:

```json
{"type": "arrow", "x": 100, "y": 100, "points": [[0, 0], [50, -40], [200, 0]], "roundness": {"type": 2}}
{"type": "arrow", "x": 100, "y": 100, "points": [[0, 0], [0, -50], [200, -50], [200, 0]], "elbowed": true}
```

Curved arrows suit fan-outs; elbowed arrows suit going up, across and down to a side column.

## Check every batch

After each `add` or `apply`, run `screenshot` and look at the PNG:

1. All text visible (else widen or heighten the shape).
2. No shapes overlapping; zones contain their children with padding.
3. No arrow through an unrelated shape; no arrow label on a shape.
4. At least 40px between elements; the whole scene readable at the pane's narrow width.

If something is wrong, say what you see, fix it, and screenshot again before adding more.

## Editing

- `describe` lists ids, positions, labels and connections. Find elements by id or label, not
  coordinates.
- `update <id> --set '{"width": 220}'` moves, resizes or recolours one element; bound arrows follow.
  Use `apply` for many changes at once.
- An update that fails: check the id with `get <id>`. A locked element needs `arrange unlock --ids <id>`.
- `arrange align|distribute|group|lock|unlock|duplicate --ids a,b,c` tidies layouts.
- `snapshot save <name>` before a risky change, `snapshot restore <name>` to go back.
- Files: `export --out diagram.excalidraw`, `import diagram.excalidraw [--replace]`,
  `screenshot --out diagram.png` (or `--format svg`).
- Nothing showing? It may be off screen: check positions with `describe`.
