# src/board: the herdr-draw board

A board is one agent's Excalidraw scene. The sidecar (`src/sidecar`) owns every board on the machine, in
memory, in one process: agents draw through each board's REST API, the canvas mod subscribes to one board
over the sidecar's WebSocket.

```
http://127.0.0.1:$CANVAS_SIDECAR_PORT/b/<board>/api/...   board REST (the excalidraw skill's API)
http://127.0.0.1:$CANVAS_SIDECAR_PORT/b/<board>/health    upstream-compatible health
http://127.0.0.1:$CANVAS_SIDECAR_PORT/health, /boards     sidecar identity ("herdr-draw-sidecar") and board list
ws://127.0.0.1:$CANVAS_SIDECAR_PORT/                      mod protocol (src/canvas/protocol.ts)
```

`<board>` is the agent's local terminal address (`t72`), `default` without one.

## Origin

Trimmed from [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) 2.1.2 by yctimlin, MIT
(see `LICENSE`).

| Here                                              | From upstream                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.ts`                                        | `server.ts` element routes and helpers (validation, arrow binding, rerouting, text sync, snapshots), ported to a class without globals                                                                     |
| `http.ts`                                         | `server.ts` routes on `Bun.serve`'s Request/Response, same paths, answers and status codes                                                                                                                 |
| `cli.ts`, `client.ts`, `prepare.ts`, `arrange.ts` | `cli/*`, `core/canvas-client.ts`, `core/normalize.ts`, `core/describe.ts`, `core/geometry.ts`                                                                                                              |
| `upstream/`                                       | verbatim `dist/` build output: the headless renderer (`core/render/**`), `core/expand-elements.js`, the bundled Excalidraw SDK (`render/excalidraw-node.mjs`); `types.js` trimmed to `normalizeFontFamily` |
| `assets/fonts/`                                   | the bundled TTFs and their licences                                                                                                                                                                        |

`upstream/` is third-party build output: biome skips it, knip ignores its unused exports. To update, copy
the same files from a newer package's `dist/`.

## Cut

The MCP server and its dependencies, the browser web app (React, Vite build), express/cors/ws/winston/dotenv/zod,
browser sync, the tab-only endpoints (viewport, tab export, from-mermaid and the mermaid packages), image files,
the Obsidian export/import, `share`, `render`, `mermaid` and `install-skill`, auto-start/pidfiles. `screenshot
--renderer browser` is refused (boards render headless). `stop` is a no-op: the sidecar is shared.
