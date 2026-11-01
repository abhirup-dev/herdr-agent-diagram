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

- Give every element, arrows included, an `id` you choose. `add` refuses an id that already exists
  (exit 2): change it with `update`.
- `"text"` on a shape is its label. `fontSize`, `verticalAlign` (`top`/`middle`/`bottom`) and
  `textAlign` (`left`/`center`/`right`) next to it style the label.
- Arrows: `startElementId` / `endElementId` bind them to shapes. A bound arrow keeps any `points`
  you give and `"elbowed": true`, and follows when the shapes move. `"text"` on an arrow labels it.
- Colours: `strokeColor` and `backgroundColor`, with `"fillStyle": "solid"` for flat fills.
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

**Act on `warnings`.** `add`, `apply` and `update` list problems they can see, such as a label wider
than its shape or than its arrow, each naming the element and the size it needs. Fix them before
you go on.

## Layout

(0, 0) is the top left; x grows right, y grows down. Plan the grid before writing JSON.

- Rows 80-120px apart, siblings at least 40px apart. Fonts at least 16 (titles 20).
- A zone is a dashed rectangle with a top-left label (as above), 50px larger than what it holds.
  Add zones before the shapes inside them: a later element is drawn on top, and there is no way to
  restack yet.
- Label an arrow only when the label says something (a protocol, a port, a direction).
- Pairs of `strokeColor`/`backgroundColor`: `#1971c2`/`#a5d8ff` blue, `#2f9e44`/`#b2f2bb` green,
  `#e03131`/`#ffc9c9` red, `#e8590c`/`#ffd8a8` orange, `#9c36b5`/`#eebefa` purple, `#0c8599`/`#99e9f2`
  cyan, `#868e96`/`#e9ecef` gray.
- To route an arrow around something, give it waypoints (`points` relative to `x`, `y`) or make it
  `"elbowed": true`.

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
