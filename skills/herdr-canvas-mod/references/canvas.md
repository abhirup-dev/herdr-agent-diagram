# The live canvas

The canvas is a native Herdr pane beside your terminal showing your own board; the user sees each change
live and can edit the same scene.

1. **Open once per session:** `herdr-draw canvas open` starts what it needs and splits a pane to your
   right (each run adds another pane). On a machine without the Herdr app, it asks the app on the
   user's machine to open it; nothing else changes for you.
2. **Read before you edit:** run `describe` first; the user may have changed the scene.
3. **Never ask the user to open a browser:** `screenshot` works without one.
4. Your board is saved to `~/.local/state/herdr-draw/boards/<your terminal id>.excalidraw` a second
   after each change. If the canvas comes back empty, restore it with
   `herdr-draw canvas import <that file> --replace`.

Commands print JSON (`describe` prints text). Exit codes: 0 ok, 1 error, 2 usage, 3 board unreachable.

## Elements

`add` takes a JSON array (a file or stdin), or one element with `add --one '{...}'`. `apply` takes a
patch: `{"create":[...],"update":[{"id":"a","set":{...}}],"delete":["id"]}`.

- Give every element, arrows included, an `id` you choose.
- `"text"` on a shape is its label. `fontSize`, `verticalAlign` (`top`/`middle`/`bottom`) and
  `textAlign` (`left`/`center`/`right`) next to it style the label.
- Arrows: `startElementId` / `endElementId` bind them to shapes. A bound arrow keeps any `points`
  you give and `"elbowed": true`, and follows when the shapes move. `"text"` on an arrow labels it.
- `fontFamily`: `"excalifont"`, `"helvetica"`, `"cascadia"`, or `"1"`-`"8"`.

```bash
herdr-draw canvas add <<'EOF'
[
  {"id": "zone", "type": "rectangle", "x": 0, "y": 0, "width": 320, "height": 380,
   "strokeStyle": "dashed", "text": "Backend", "verticalAlign": "top", "textAlign": "left"},
  {"id": "api", "type": "rectangle", "x": 70, "y": 60, "width": 180, "height": 60, "text": "API",
   "strokeColor": "#1971c2", "backgroundColor": "#a5d8ff", "fillStyle": "solid"},
  {"id": "db", "type": "rectangle", "x": 70, "y": 260, "width": 180, "height": 60, "text": "Postgres"},
  {"id": "api-db", "type": "arrow", "x": 0, "y": 0, "startElementId": "api", "endElementId": "db", "text": "SQL"}
]
EOF
```

## Do and don't

Plan with these limits and the first batch comes back without warnings. (0, 0) is the top left;
x grows right, y grows down.

Do:
- **Size shapes to their labels:** width ≥ characters × 11 + 40 at the default font (20), × 9 at
  16. "Payments gateway API" (20 characters) needs about 240px. Height 60 for one line, 80 for two.
- **Leave room for arrow labels:** the gap between two shapes ≥ label characters × 13 + 40. "HTTPS 443"
  (9 characters) needs about 160px; an unlabelled arrow needs 40px.
- **Keep the canvas tall:** rows 80-120px apart, at most 3-4 boxes per row, the scene taller than
  it is wide.
- **Draw zones first,** 50px larger than what they hold, with a top-left title (`"verticalAlign": "top",
  "textAlign": "left"`, dashed stroke). A later element is drawn on top, and there's no restack yet.
- **Route around obstacles** with `points` (relative to `x`, `y`) or `"elbowed": true` on bound arrows.
- **Pick ids that say what the element is** (`api`, `api-db`); you'll `update` by them.

Don't:
- Don't label every arrow: only when the label says something (a protocol, a port, a direction).
- Don't use fonts under 16 (titles 20).
- Don't `add` an id that exists (exit 2); `update` it.
- Don't draw an arrow through an unrelated shape; move the shape or route the arrow.

Colours (`strokeColor`/`backgroundColor`, `"fillStyle": "solid"`): `#1971c2`/`#a5d8ff` blue,
`#2f9e44`/`#b2f2bb` green, `#e03131`/`#ffc9c9` red, `#e8590c`/`#ffd8a8` orange, `#9c36b5`/`#eebefa`
purple, `#0c8599`/`#99e9f2` cyan, `#868e96`/`#e9ecef` gray.

If `add`, `apply` or `update` still returns `warnings` (each names the element and the size it
needs), fix them before you go on.

## Check, then edit

After each batch, run `screenshot`. It prints JSON whose `file` is a PNG: open it and check that all
text shows, nothing overlaps, and no arrow crosses an unrelated shape. Fix what you see, then
screenshot again.

- `describe` lists ids, positions, labels, arrow endpoints (`from a -> b`) and frame names. Find
  elements by id or label, not coordinates. `query --type`/`--bbox`/`--filter k=v` and `get <id>`
  return the JSON.
- `update <id> --set '{...}'` changes one element; bound arrows follow. `delete <id> ...` removes.
  `apply` does many changes at once.
- `arrange align --ids a,b --to left|center|right|top|middle|bottom`,
  `arrange distribute --ids a,b,c --to horizontal|vertical`, `arrange group|duplicate --ids a,b`.
- `snapshot save <name>` before a risky change, `snapshot restore <name>` to go back.
- Files: `export --out diagram.excalidraw`, `import diagram.excalidraw [--replace]`,
  `screenshot --out diagram.png` (or `.svg`).
- `herdr-draw canvas help <command>` shows one command's flags.
