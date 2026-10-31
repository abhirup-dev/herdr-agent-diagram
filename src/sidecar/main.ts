#!/usr/bin/env bun
// The canvas sidecar: a "headless tab" for mcp-excalidraw-server. It connects to the server's tab WebSocket
// like a browser tab would, converts agent shorthand into full Excalidraw elements with the Excalidraw SDK
// (the server package's own prepareScene: convertToExcalidrawElements + restore under jsdom), and serves the
// result to the native Herdr canvas mod over its own WebSocket. It also answers the server's screenshot
// requests with the SDK's headless renderer, so the excalidraw skill needs no browser.
//   bun src/sidecar/main.ts        env: EXPRESS_SERVER_URL (default http://127.0.0.1:3000), CANVAS_SIDECAR_PORT
import type { ServerWebSocket } from "bun";
import { prepareScene } from "mcp-excalidraw-server/dist/core/render/excalidraw-node/index.js";
import { renderScene } from "mcp-excalidraw-server/dist/core/render/index.js";
import { type ClientMessage, parseClientMessage, type ServerMessage, SIDECAR_PORT } from "../canvas/protocol.ts";
import { elementPaints } from "../canvas/shape.ts";
import { type CanvasElement, isCanvasElement } from "../canvas/types.ts";
import { applyEvent, diff, type RawElement, stableSeed, type UpstreamEvent, withSeeds } from "./mirror.ts";
import { type Rest, Writer } from "./writer.ts";

const upstream = (process.env.EXPRESS_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const port = Number(process.env.CANVAS_SIDECAR_PORT ?? SIDECAR_PORT);
const log = (msg: string) => console.error(`[canvas-sidecar ${new Date().toISOString().slice(11, 23)}] ${msg}`);

const raw = new Map<string, RawElement>();
let prepared = new Map<string, CanvasElement>();
let rev = 0;
let upstreamUp = false;
const mods = new Set<ServerWebSocket<unknown>>();

const send = (ws: ServerWebSocket<unknown>, m: ServerMessage) => ws.send(JSON.stringify(m));
const broadcast = (m: ServerMessage) => {
  const data = JSON.stringify(m);
  for (const ws of mods) ws.send(data);
};
const snapshot = (): ServerMessage => ({ type: "scene", rev, elements: [...prepared.values()] });
const status = (): ServerMessage => ({ type: "status", upstream: upstreamUp ? "connected" : "disconnected" });

// --- conversion: raw -> prepared, broadcast the difference. Serialised: one conversion at a time, latest wins.
let converting = false;
let dirty = false;
async function reconvert(): Promise<void> {
  dirty = true;
  if (converting) return; // the running loop picks the change up
  converting = true;
  try {
    while (dirty) {
      dirty = false;
      const t0 = performance.now();
      // Rough paths are generated here: in the mod's slow JS runtime one rectangle takes seconds.
      const next = (await prepareScene(withSeeds(raw.values())))
        .filter((e): e is CanvasElement => isCanvasElement(e as { type: string; isDeleted?: boolean }))
        .map((e): CanvasElement => (e.type === "text" ? e : { ...e, paints: elementPaints(e) }));
      const patch = diff(prepared, next);
      prepared = new Map(next.map((e) => [e.id, e]));
      if (patch.upsert.length || patch.remove.length) {
        rev++;
        broadcast({ type: "patch", rev, upsert: patch.upsert, remove: patch.remove });
        log(
          `rev ${rev}: ${patch.upsert.length} up, ${patch.remove.length} removed (${(performance.now() - t0).toFixed(1)} ms)`,
        );
      }
    }
  } catch (e) {
    log(`conversion failed: ${String(e)}`);
  } finally {
    converting = false;
  }
}

async function refetch(): Promise<void> {
  const res = await fetch(`${upstream}/api/elements`);
  const body = (await res.json()) as { elements?: RawElement[] };
  applyEvent(raw, { type: "initial_elements", elements: body.elements ?? [] });
  await reconvert();
}

// --- screenshots for the skill: the server broadcasts a request to every tab and keeps the largest answer.
async function answerExport(e: Extract<UpstreamEvent, { type: "export_image_request" }>): Promise<void> {
  try {
    const result = await renderScene(
      { elements: withSeeds(raw.values()), files: {} },
      { format: e.format, background: e.background ?? true },
    );
    await postJson("/api/export/image/result", { requestId: e.requestId, format: e.format, data: result.data });
    log(`answered screenshot ${e.requestId} (${e.format}, ${result.width}x${result.height})`);
  } catch (err) {
    await postJson("/api/export/image/result", { requestId: e.requestId, error: String(err) }).catch(() => {});
    log(`screenshot ${e.requestId} failed: ${String(err)}`);
  }
}

const postJson = (path: string, body: unknown) =>
  fetch(`${upstream}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// --- edits from the mod: REST writes with undo history, and rough paths for drafts.
async function call(method: string, path: string, body?: unknown): Promise<RawElement> {
  const res = await fetch(`${upstream}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { success?: boolean; element?: RawElement; error?: string };
  if (!res.ok || json.success === false) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json.element ?? ({ id: "" } as RawElement);
}
const rest: Rest = {
  create: (el) => call("POST", "/api/elements", el),
  update: (id, fields) => call("PUT", `/api/elements/${encodeURIComponent(id)}`, fields),
  remove: async (id) => void (await call("DELETE", `/api/elements/${encodeURIComponent(id)}`)),
};
const writer = new Writer(
  rest,
  { raw: () => raw, prepared: (id) => prepared.get(id) as Readonly<Record<string, unknown>> | undefined },
  (canUndo, canRedo) => broadcast({ type: "history", canUndo, canRedo }),
);

function onClient(ws: ServerWebSocket<unknown>, m: ClientMessage): void {
  const fail = (err: unknown) => log(`${m.type} failed: ${String(err)}`);
  if (m.type === "preview") {
    const e = typeof m.element.seed === "number" ? m.element : { ...m.element, seed: stableSeed(m.element.id) };
    const paints = e.type === "text" ? [] : elementPaints(e);
    send(ws, { type: "preview", req: m.req, id: e.id, width: e.width, height: e.height, paints });
  } else if (m.type === "ops") writer.apply(m.ops).catch(fail);
  else if (m.type === "undo") writer.undo().catch(fail);
  else writer.redo().catch(fail);
}

// --- upstream connection, with reconnect.
function connectUpstream(delay = 0): void {
  setTimeout(() => {
    const ws = new WebSocket(upstream.replace(/^http/, "ws"));
    ws.onopen = () => {
      upstreamUp = true;
      broadcast(status());
      log(`connected to ${upstream}`);
    };
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as UpstreamEvent;
      if (e.type === "export_image_request") return void answerExport(e);
      const r = applyEvent(raw, e);
      if (r === "changed") void reconvert();
      else if (r === "refetch") refetch().catch((err: unknown) => log(`refetch failed: ${String(err)}`));
    };
    ws.onclose = () => {
      if (upstreamUp) log("upstream closed; retrying");
      upstreamUp = false;
      broadcast(status());
      connectUpstream(Math.min(5000, Math.max(500, delay * 2)));
    };
    ws.onerror = () => {}; // onclose follows and handles the retry
  }, delay);
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response(JSON.stringify({ ok: true, rev, elements: prepared.size, upstream: upstreamUp }), {
      headers: { "content-type": "application/json" },
    });
  },
  websocket: {
    open(ws) {
      mods.add(ws);
      send(ws, status());
      send(ws, snapshot());
      send(ws, { type: "history", canUndo: writer.canUndo, canRedo: writer.canRedo });
    },
    message(ws, data) {
      const m = parseClientMessage(String(data));
      if (m) onClient(ws, m);
    },
    close(ws) {
      mods.delete(ws);
    },
  },
});
log(`serving mods on ws://127.0.0.1:${port}`);
connectUpstream();
