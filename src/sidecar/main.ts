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
import { frame, parseClientFrame, type ServerMessage, SIDECAR_PORT, splitBoard } from "../canvas/protocol.ts";
import { cutOut, elementPaints } from "../canvas/shape.ts";
import { type CanvasElement, isCanvasElement } from "../canvas/types.ts";
import { brief, logger } from "../log/log.mjs";
import { Registry } from "./boards.ts";
import { type RawElement, stableSeed, withSeeds } from "./diff.ts";
import { appHome, servePins } from "./pins.ts";
import { Relay } from "./relay.ts";
import { BoardSaver, boardsDir } from "./save.ts";
import { RemoteWatch, syncedMachines } from "./watch.ts";

const port = Number(process.env.CANVAS_SIDECAR_PORT ?? SIDECAR_PORT);
const log = logger("sidecar");
// Unexpected failures land in the log too, not only on the detached process's stderr.
process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? String(e)}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${String(e)}`));

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

const relay = new Relay();
const boards = new Registry(convert, log, relay, new BoardSaver(boardsDir(), log));
type Socket = ServerWebSocket<unknown>;

/** Pin feeds per socket and local board: a relay from the main machine mirrors them (src/sidecar/pins.ts). */
const pinFeeds = new Map<Socket, Map<string, () => void>>();
function followPins(ws: Socket, board: string, on: boolean): void {
  const feeds = pinFeeds.get(ws) ?? new Map<string, () => void>();
  pinFeeds.set(ws, feeds);
  feeds.get(board)?.();
  feeds.delete(board);
  if (on && splitBoard(board).machine === null)
    feeds.set(
      board,
      servePins(appHome(), board, (m) => ws.send(frame(board, m))),
    );
}
function closeSocket(ws: Socket): void {
  for (const stop of pinFeeds.get(ws)?.values() ?? []) stop();
  pinFeeds.delete(ws);
  boards.unsubscribe(ws);
}

const socketIds = new WeakMap<Socket, number>();
let nextSocket = 1;
/** A short id per websocket, so one mod's frames can be followed in the log. */
function socketId(ws: Socket): number {
  const known = socketIds.get(ws);
  if (known !== undefined) return known;
  const id = nextSocket++;
  socketIds.set(ws, id);
  return id;
}

function onMessage(ws: Socket, data: string): void {
  const f = parseClientFrame(data);
  if (!f) {
    log.debug(`ws dropped a frame it can't parse: ${brief(data, 200)}`);
    return;
  }
  const { board, msg: m } = f;
  if (m.type !== "preview")
    log.debug(
      `ws ${socketId(ws)} ${board} <- ${m.type}${m.type === "ops" ? ` (${m.ops.length} ops: ${brief(m.ops.map((o) => o.op))})` : ""}`,
    );
  if (m.type === "subscribe" || m.type === "unsubscribe") followPins(ws, board, m.type === "subscribe");
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
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/" && server.upgrade(req)) return;
    const t = performance.now();
    const res = await handle(boards, req);
    if (url.pathname !== "/health" && url.pathname !== "/")
      log.debug(`rest ${req.method} ${url.pathname} -> ${res.status} (${(performance.now() - t).toFixed(0)} ms)`);
    return res;
  },
  websocket: {
    open: (ws) => log.debug(`ws ${socketId(ws)} open`),
    message: (ws, data) => onMessage(ws, String(data)),
    close: (ws, code) => {
      log.debug(`ws ${socketId(ws)} closed (${code})`);
      closeSocket(ws);
    },
  },
});
log(`${SIDECAR_SERVICE} on http://127.0.0.1:${port} (boards at /b/<board>/api, mods at ws://127.0.0.1:${port}/)`);
const machines = syncedMachines();
if (machines.length) new RemoteWatch(machines, relay, port, log).start();
