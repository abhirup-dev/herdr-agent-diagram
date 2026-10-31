Adapted from mcp-excalidraw-server's excalidraw-skill (MIT). Commands run as `herdr-draw canvas <command>`.

# Excalidraw Skill Cheatsheet

## Defaults

- Board: this terminal's own board on the herdr-draw sidecar (set up by `herdr-draw canvas`; no URL to pass).
- Canvas health: `GET /health` or `herdr-draw canvas status`
- Auto-start: every board command starts the sidecar if it is down.

## CLI Reference

`herdr-draw canvas <command>` (or `excalidraw-canvas <command>` after `npm i -g`).
JSON results on stdout — except `describe` (plain text) and raw-content output when `--out` is omitted (`export` scene JSON, `screenshot --format svg`). Diagnostics on stderr. Exit codes: 0 ok, 1 error, 2 usage, 3 canvas unreachable,. Explicit `start` overrides `EXCALIDRAW_NO_AUTOSTART=1`.

### Server

| Command | Description |
|---------|-------------|
| `stop` | Stop the canvas server (identity-checked via `/health` — never signals foreign services) |
| `status` | Health of the sidecar and its boards (`herdr-draw canvas status`) |

### Elements

| Command | Description |
|---------|-------------|
| `add [file\|-]` | Batch create from a JSON array (file, `-`, or piped stdin); `--one '{...}'` for a single element |
| `apply [file\|-]` | Multi-op patch `{"create":[...],"update":[{"id":"a","set":{...}}],"delete":["id",...]}` in one call |
| `get <id>` | Get one element |
| `query` | `--type rectangle` `--bbox x0,y0,x1,y1` `--filter locked=true` (typed; nested keys like `label.text=API` work) `--filter-json '{...}'` |
| `update <id> --set '{...}'` | Update one element |
| `delete <id> [...]` | Delete elements |

### Scene

| Command | Description |
|---------|-------------|
| `describe` | AI-readable scene summary (ids, positions, labels, connections) — plain text |
| `screenshot` | PNG/SVG capture; `--out f.png`, `--format png\|svg`, `--no-background`; PNG without `--out` → temp file path in JSON, SVG without `--out` → raw SVG |
| `export [--out f.excalidraw] [--format json\|obsidian]` | Scene as .excalidraw JSON (stdout without `--out`); a `.md` out path writes Obsidian's .excalidraw.md format |
| `import [file\|-] [--replace]` | Import .excalidraw JSON or Obsidian .excalidraw.md (merge by default) |
| `share` | Encrypted upload → shareable excalidraw.com URL |
| `clear --yes` | Wipe the canvas |
| `snapshot save\|list\|restore [name]` | Named canvas snapshots |

### Arrange

| Command | Description |
|---------|-------------|
| `arrange align --ids a,b,c --to left\|center\|right\|top\|middle\|bottom` | Align (≥2 ids) |
| `arrange distribute --ids a,b,c --to horizontal\|vertical` | Even spacing (≥3 ids) |
| `arrange group --ids a,b` / `arrange ungroup --group <groupId>` | Group membership lives on element `groupIds` |
| `arrange lock\|unlock --ids a,b` | Toggle edit lock |
| `arrange duplicate --ids a,b [--offset 20,20]` | Clone with offset |

### Meta

| Command | Description |
|---------|-------------|
| `install-skill --dir <skills-root>` | Install this skill into an agent-chosen project/global skills root (replaces any existing copy) |
| `help [command]`, `--version` | Usage and version |

## Design Guide (quick version)

Stroke/fill pairs: `#e03131`/`#ffc9c9` red, `#2f9e44`/`#b2f2bb` green, `#1971c2`/`#a5d8ff` blue, `#9c36b5`/`#eebefa` purple, `#e8590c`/`#ffd8a8` orange, `#0c8599`/`#99e9f2` cyan, `#868e96`/`#e9ecef` gray.
Styling: `"fillStyle": "solid"` for crisp flat fills (default is sketchy hachure); `"strokeStyle": "dashed"` for zone borders / async arrows.
Sizing: shapes ≥ 120×60 with width ≥ `labelChars * 12`, fonts ≥ 16 (titles ≥ 20), gaps 40–80px (120px+ for labeled arrows), align to a 20px grid.
Order of work: background zones → primary shapes (with `text`) → arrows (bound via ids) → annotations → refine (align/distribute/screenshot).
