// Frames between the local relay and a remote machine's backend, one JSON object per line (NDJSON)
// over the bridge pipe. A frame carries one board's ServerMessage/ClientMessage unchanged plus the
// board id. On the wire the id is local to that machine (`t1f`); the relay qualifies it (`vpsme/t1f`).
// Proposal for hd-jf3.7.2: the same board-tagged messages can run over the local mod websocket.
import type { ClientMessage, ServerMessage } from "../canvas/protocol.ts";

/** A pinned Mermaid diagram: the backend renders it, the frontend only shows the SVG. */
export interface Pin {
  readonly id: string;
  readonly title: string;
  readonly svg: string;
  /** Mermaid source, for "Edit as board" and re-rendering on theme change. */
  readonly source: string;
  /** Milliseconds since the epoch, from the backend's clock. */
  readonly updated: number;
}

/** Backend -> frontend pin state of one board (an agent's terminal). `pins` replaces the whole list. */
export type PinMessage =
  | { readonly type: "pins"; readonly pins: readonly Pin[] }
  | { readonly type: "pin"; readonly pin: Pin }
  | { readonly type: "unpin"; readonly id: string };

export type BoardServerMessage = ServerMessage | PinMessage;

/** `subscribe` asks for a board's full state (status, scene, history, pins), then its changes. */
export type BoardClientMessage = ClientMessage | { readonly type: "subscribe" } | { readonly type: "unsubscribe" };

/** Backend -> relay. `t` echoes the ping's. */
export type DownFrame =
  | { readonly kind: "board"; readonly board: string; readonly msg: BoardServerMessage }
  | { readonly kind: "pong"; readonly t: number };

/** Relay -> backend. A ping every few seconds both ways keeps a hung link from living forever. */
export type UpFrame =
  | { readonly kind: "board"; readonly board: string; readonly msg: BoardClientMessage }
  | { readonly kind: "ping"; readonly t: number };

/** `vpsme/t1f` -> { machine: "vpsme", board: "t1f" }; a local board has no machine. */
export function splitBoardId(id: string): { readonly machine?: string; readonly board: string } {
  const i = id.indexOf("/");
  return i < 0 ? { board: id } : { machine: id.slice(0, i), board: id.slice(i + 1) };
}

export const qualify = (machine: string | undefined, board: string) => (machine ? `${machine}/${board}` : board);

const BOARD_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const SERVER_TYPES: ReadonlySet<unknown> = new Set([
  "scene",
  "patch",
  "status",
  "preview",
  "history",
  "pins",
  "pin",
  "unpin",
]);
const CLIENT_TYPES: ReadonlySet<unknown> = new Set(["preview", "ops", "undo", "redo", "subscribe", "unsubscribe"]);

// Trust boundary: frames come from another machine. Checks the envelope; message bodies are the
// same shapes the local sidecar already trusts.
function parseFrame(raw: string, beat: string, types: ReadonlySet<unknown>): unknown {
  try {
    const f = JSON.parse(raw) as { kind?: unknown; board?: unknown; msg?: { type?: unknown }; t?: unknown };
    if (f.kind === beat) return typeof f.t === "number" ? f : null;
    if (f.kind !== "board" || typeof f.board !== "string" || !BOARD_ID.test(f.board)) return null;
    return types.has(f.msg?.type) ? f : null;
  } catch {
    return null;
  }
}

export const parseDownFrame = (raw: string) => parseFrame(raw, "pong", SERVER_TYPES) as DownFrame | null;
export const parseUpFrame = (raw: string) => parseFrame(raw, "ping", CLIENT_TYPES) as UpFrame | null;
