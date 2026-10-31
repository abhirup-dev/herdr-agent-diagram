#!/usr/bin/env bun
import { LinearElementEditor } from "@excalidraw/element";
// The herdr-draw sidecar: one process per machine owning every board. Agents draw over each board's REST API
// (http://127.0.0.1:<port>/b/<board>/api/..., the excalidraw skill's API, see src/board); the native Herdr canvas
// mod subscribes to one board over the WebSocket on the same port and edits it with undo. Conversion and rough
// paths run here with the Excalidraw SDK (in the mod's slow JS runtime one rectangle takes seconds).
//   bun src/sidecar/main.ts        env: CANVAS_SIDECAR_PORT (default 3077)
import type { ServerWebSocket } from "bun";
import { handle, SIDECAR_SERVICE } from "../board/http.ts";
import { prepare } from "../board/render.ts";
import { frame, parseClientFrame, type ServerMessage, SIDECAR_PORT } from "../canvas/protocol.ts";
import { cutOut, elementPaints } from "../canvas/shape.ts";
import { type CanvasElement, isCanvasElement } from "../canvas/types.ts";
import { Registry } from "./boards.ts";
import { type RawElement, stableSeed, withSeeds } from "./diff.ts";

const port = Number(process.env.CANVAS_SIDECAR_PORT ?? SIDECAR_PORT);
const log = (msg: string) => console.error(`[herdr-draw sidecar ${new Date().toISOString().slice(11, 23)}] ${msg}`);

const labelPosition = LinearElementEditor.getBoundTextElementPosition as unknown as (
  arrow: CanvasElement,
  text: CanvasElement,
  map: Map<string, CanvasElement>,
) => { x: number; y: number };

/** Arrow labels where Excalidraw puts them (middle point or curve midpoint); the conversion assumes straight arrows. */
function placeArrowLabels(els: CanvasElement[]): CanvasElement[] {
  const map = new Map(els.map((e) => [e.id, e]));
  return els.map((e) => {
    const arrow = e.type === "text" && e.containerId ? map.get(e.containerId) : undefined;
    return arrow?.type === "arrow" || arrow?.type === "line" ? { ...e, ...labelPosition(arrow, e, map) } : e;
  });
}

/** Paints for every shape; an arrow or line with a label gets its stroke cut where the label sits, as in Excalidraw. */
function withPaints(els: CanvasElement[]): CanvasElement[] {
  const labels = new Map(els.flatMap((t) => (t.type === "text" && t.containerId ? [[t.containerId, t] as const] : [])));
  return els.map((e): CanvasElement => {
    if (e.type === "text") return e;
    const paints = elementPaints(e);
    const t = (e.type === "arrow" || e.type === "line") && labels.get(e.id);
    if (!t) return { ...e, paints };
    const r = { x: t.x - e.x, y: t.y - e.y, width: t.width, height: t.height };
    return { ...e, paints: paints.map((p) => (p.kind === "stroke" ? { ...p, ops: cutOut(p.ops, r) } : p)) };
  });
}

const convert = async (raw: readonly RawElement[]): Promise<CanvasElement[]> =>
  withPaints(
    placeArrowLabels(
      ((await prepare(withSeeds(raw))) as { type: string; isDeleted?: boolean }[]).filter(isCanvasElement),
    ),
  );

const boards = new Registry(convert, log);
type Socket = ServerWebSocket<unknown>;

function onMessage(ws: Socket, data: string): void {
  const f = parseClientFrame(data);
  if (!f) return;
  const { board, msg: m } = f;
  if (m.type !== "preview") {
    boards.onClient(ws, board, m).catch((err: unknown) => log(`${board} ${m.type} failed: ${String(err)}`));
    return;
  }
  // Rough paths for a draft element: no board state involved.
  const e = typeof m.element.seed === "number" ? m.element : { ...m.element, seed: stableSeed(m.element.id) };
  const paints = e.type === "text" ? [] : elementPaints(e);
  ws.send(
    frame<ServerMessage>(board, { type: "preview", req: m.req, id: e.id, width: e.width, height: e.height, paints }),
  );
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (new URL(req.url).pathname === "/" && server.upgrade(req)) return;
    return handle(boards, req);
  },
  websocket: {
    message: (ws, data) => onMessage(ws, String(data)),
    close: (ws) => boards.unsubscribe(ws),
  },
});
log(`${SIDECAR_SERVICE} on http://127.0.0.1:${port} (boards at /b/<board>/api, mods at ws://127.0.0.1:${port}/)`);
