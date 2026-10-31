# Native Herdr canvas feasibility — 2026-10-31

**Go for a native prototype; conditional go for a usable editor.** Native vector rendering, relative RoughJS imports, local dragging, keyboard zoom, wheel pan, scene-file watching, WebSocket scene updates, split panes and pane zoom all work in the installed Herdr. One-frame input-to-photon latency is **not established**. Pointer capture outside the pane is the largest host API gap.

## 1. Drawing

Installed `~/.config/herdr-app/gpui-kit.d.ts:20366–20382` exposes immutable `Path`, fill/stroke builders, lines, quadratic/cubic curves, arcs and polygons. `:20463–20473` exposes `window.paint_path`, legal in render. The spike draws rectangles, ellipses, diamonds, arrows with heads, lines and freedraw polylines. Native absolute-positioned text divs work. No pixels, screenshots, web views or browser drawing participate in the canvas.

**Tested:** relative `import rough from './vendor/rough.esm.js'` works both in `check` and live rendering. Vendored RoughJS 4.6.6 is the unmodified bundled ESM from `https://unpkg.com/roughjs@4.6.6/bundled/rough.esm.js`; MIT license included. Only `rough.generator()` is called, which needs no DOM. Generated move/line/cubic operations are converted to GPUI paths.

Cache native paths by geometry/scale; translate them through native element positioning during drag/pan. Rebuilding all paths on every movement is wasteful: the first naive 10-element loaded render displayed a 43 ms JS build. The first cached implementation showed 11 ms to build that scene; later warm builds were 0–4 ms. These are individual observations, not controlled before/after averages.

**200-element experiment:** 160 rough rectangles + 40 native text labels, 120 timer-driven pan updates at a requested 16 ms interval. 121 render callbacks over 2061 ms. Recorded JS construction median 4 ms, max 16 ms; render-start gaps median 17 ms, max 48 ms. Raw samples: `measurements.json` (`kind: bench`). Instrumentation stops after the bounded experiment; no permanent animation timer. Timing covers the scene-building portion of render, excluding toolbar construction, native layout, GPU submission and presentation. No frame-presentation or input hardware timestamp API was found. Thus roughly 60 Hz updates are plausible, **not a guarantee of 60 presented frames/s or one-frame drag latency**. This mixed workload includes text but does not isolate shaping cost or benchmark 200 long labels. Zoom invalidates path caches and will cost more; complex freedraw also needs a separate stress test.

## 2. Input

`gpui-kit.d.ts:459–501`: key/chord, typed character, modifiers, local/window coordinates and click count. `:721–790`: move, up/down, hover, focus-path keyboard and wheel handlers. `:20399–20404`: focus handle. `:21330–21369`: retained `InputState` + `Input` for real text editing; use this for caret, clipboard and composition rather than implementing text input with key characters. IME and positioned text editor integration were not tested.

**Tested:** one 500 ms synthetic drag with 30 intermediate moves delivered all 30, moved the rectangle and selected it. Key `=` after focusing canvas changed zoom to 120%. Wheel moved the scene. Server-pushed text appeared live.

**Boundary limitation:** move is explicitly documented as hovered-only. A drag into the sidebar stopped at the canvas boundary; the spike cancels on hover exit to prevent a stuck drag. No public pointer-capture, mouse-up-out, global mouse-move or mouse-button-state API was found. `window.mouse_position()` alone cannot guarantee release detection. A temporary full-window overlay is a possible workaround inside the window, but is untested and cannot establish OS-level capture outside it. Proper capture needs a host API addition if cross-boundary dragging is required. Double-click and modifiers are typed APIs but were not separately verified. Event-to-screen latency was not measured; no capture/decode/network step is in the local drag path.

## 3. Sync

`gpui-kit.d.ts:22150–22167` exports **`import {WebSocket} from 'websocket'`**, not browser-global WebSocket: `connect`, async `read`, `write`, `close`. Capability gating is mentioned, but connection succeeds in an ordinary mod with this mod.json. Twenty echo messages per connection measured typical median RTT 53–55 ms (first two runs range 14–66 ms); another run under benchmark load was slower. This is whole mod-side await/echo timing, not network RTT alone. Host async scheduling likely contributes, but its implementation was not inspected.

`gpui-kit.d.ts:22169–22187`: fetch supports response text/json, not a streaming body; no EventSource/SSE API found. Periodic fetch has interval/2 average detection delay plus request/host scheduling; long-poll fetch is possible in principle, not tested. `herdr.d.ts:10–13`: exec returns completed stdout/stderr, 30-second limit and 8 MiB output, so it is unsuitable as a permanent streaming helper API.

`herdr.d.ts:395–402`: watchFolder is an awaited filesystem event stream; read/write are async and writes support expected-content atomic replacement (`:23–28`). File reload worked. One timestamped file-write → watch/read completion sample was 104 ms; not a distribution. readTextFile is capped at 1 MiB. Watcher watches the mod directory in this spike; production should use a dedicated data directory.

**Recommend WebSocket patches** with optimistic local editing, coalesced outbound movement updates and revisioned commits. Fetch for snapshots/reconnect; atomic JSON persistence server-side. File watching is a simple local-only alternative, with tens-to-hundreds of ms as a cautious unverified planning range, not a one-frame interaction path. The spike accepts full scene broadcasts; it does not yet publish drags, merge concurrent edits, reconnect sockets or persist user changes. The optional server is a transport/metrics probe, not a production scene server.

## 4. Docking

Installed `~/.config/herdr-app/AGENTS.md:125–130,513–527` documents mod tabs, splits, persistence, focus and pane zoom. `:217–245` documents row/column/block layouts, sizing and resizing. `:557–560` documents layout toggle/show/hide/resize. `:360–385` documents floating edge drawers and hover peek.

- `tab.new {name, mod, props}`: works; native-canvas tab left installed/open.
- `pane.split {pane, direction:'right'|'down', mod, props}`: works. Tested bottom split + `pane.zoom {pane}` + restore; temporary second pane was closed. Right is the explicit split direction; left/top placement uses pane rearrangement or layout composition.
- Fixed left/right dock: a mod block beside the workspace in a row. Bottom dock: block below it in a column. `layout.toggle/show/hide {id}` gives hide/minimise; native dividers resize. Requires an authorized personal layout edit, not performed here.
- Tab panes have `pane.zoom`; fixed layout blocks do **not** have a documented generic block-maximise command. To offer both, use a tab pane for the zoomable canvas, or implement panel maximise by opening another mod instance with shared scene/view state in an overlay/tab and restoring it afterward.
- Floating blocks can sit at all four edges, drag/re-anchor, and side drawers can peek/minimise on hover. They are overlays, not space-reserving docks. No automatic maximise contract found for them.

## 5. Limits and architecture

No rendering blocker found for the tested subset. Strict pointer capture is currently missing. Full Excalidraw compatibility is substantial work: bound text, arrow bindings, elbow/curved arrows, freehand pressure, fills, fonts, rotation, groups, hit testing, handles, undo and conflict handling. Spike text is not rotated and selection uses bounding boxes. Native JSX/React/DOM Excalidraw code cannot be embedded directly. Native path construction/zoom cache invalidation and whole-window redraw cost remain performance risks (`AGENTS.md:827–838`).

Recommended flow:

    Agent CLI/skill → revisioned scene server ↔ WebSocket patches ↔ native Herdr mod
                                  ↓                                ↓
                            atomic scene JSON              cached paths + text

Keep the scene document separate from local camera/selection. Server accepts id-based create/update/delete with base revisions; mod applies drag immediately, coalesces patches and handles remote edits during a drag explicitly. CLI offers describe/query/apply/export; skill teaches element IDs, labels and connections. No page is necessary except an optional browser client/exporter later.

**Effort estimate, one engineer:** 10–15 engineering days for a usable constrained v1: basic shapes/arrows/text, select/move/resize, bindings for simple arrows, undo, persistence, live agent patches and docking controls. Rough breakdown: renderer/camera 2–3d; tools/text/selection/resize 4–6d; sync/CLI/conflicts 2–3d; packaging/QA 2–3d. Exact Excalidraw parity and multi-user CRDT collaboration are excluded. A host pointer-capture change depends on access to Herdr source; budget separately rather than assuming a mod can solve it.

## Reproduce and state

```sh
bun scratch/native-canvas/server.ts  # optional probe at 127.0.0.1:18743
herdr-app check "$PWD/scratch/native-canvas/"
# Copy main.js, mod.json, scene.json and vendor/ to ~/.config/herdr-app/mods/native-canvas/
herdr-app do tab.new '{"name":"native-canvas","mod":"native-canvas"}'
```

No global installs, commits, app/core restart, active-layout edits or existing diagram-mod edits. Only scratch/native-canvas and its installed mod copy were written. Optional probe was stopped after measurement; start it again before opening/reloading the mod to try WebSocket sync. Without it, scene-file drawing and local input still work. The mod starts with the original small scene. Its Bench button is explicitly a bounded measurement, not a production animation mechanism.

Screenshots in `evidence/`: scene, 200-elements, drag, boundary, bottom-split, pane-zoom, live-edit-keyboard-zoom, wheel. These are actual Herdr shots used for visual validation. `check` passed after the final change and live async rendering was exercised; check alone did not test lazy branches.
