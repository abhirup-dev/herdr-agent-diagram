// Messages between the sidecar (Bun) and the canvas mod (Herdr), JSON over the sidecar's WebSocket.
// The sidecar owns conversion, rough paths, board writes and undo history; the mod owns interaction.
// Every websocket frame is one board's message: {kind: "board", board, msg}, the same frame src/bridge carries
// between machines, so a relay forwards it unchanged. A board id is a local terminal address ("t72", "default"
// without one), or machine-qualified ("vpsme/t1f") for a board on another machine, which a relay serves; on the
// wire to a machine ids are local to it.
import type { CanvasElement, Paint } from "./types.ts";

export const SIDECAR_PORT = 3077;
export const DEFAULT_BOARD = "default";

/** A board id split into machine (null = this one) and the board's local id. */
export function splitBoard(id: string): { readonly machine: string | null; readonly local: string } {
  const at = id.indexOf("/");
  return at < 0 ? { machine: null, local: id } : { machine: id.slice(0, at), local: id.slice(at + 1) };
}

/** Local board ids are path-safe: they appear in REST URLs as /b/<id>/api/... */
export const isLocalBoardId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

/** One board's message on the websocket. */
export interface BoardFrame<M> {
  readonly kind: "board";
  readonly board: string;
  readonly msg: M;
}

/** Sidecar -> mod. `scene` replaces everything; `patch` upserts and deletes by id. `rev` increases by one per message. */
export type ServerMessage =
  | { readonly type: "scene"; readonly rev: number; readonly elements: readonly CanvasElement[] }
  | {
      readonly type: "patch";
      readonly rev: number;
      readonly upsert: readonly CanvasElement[];
      readonly remove: readonly string[];
    }
  | { readonly type: "status"; readonly upstream: "connected" | "disconnected"; readonly detail?: string }
  /** Rough paths for a draft element (`width` x `height` is the size they were generated at). */
  | {
      readonly type: "preview";
      readonly req: number;
      readonly id: string;
      readonly width: number;
      readonly height: number;
      readonly paints: readonly Paint[];
    }
  | { readonly type: "history"; readonly canUndo: boolean; readonly canRedo: boolean };

/** Fields an `update` may change: everything the editor edits, nothing that identifies the element. */
export type ElementFields = Readonly<Record<string, unknown>>;

/** One edit. A batch of ops is one undo step. */
export type Op =
  /** A new element: full Excalidraw fields, or skeleton fields (`start`/`end` bind an arrow, `label` adds text). */
  | { readonly op: "create"; readonly element: ElementFields & { readonly id: string; readonly type: string } }
  | { readonly op: "update"; readonly id: string; readonly fields: ElementFields }
  | { readonly op: "remove"; readonly ids: readonly string[] }
  /** Sets the text inside a container: its bound text element if it has one, else its `label`. */
  | { readonly op: "label"; readonly containerId: string; readonly text: string };

/**
 * Mod -> sidecar. `subscribe` asks for the board's full state (status, scene, history), then its changes, on this
 * socket; `unsubscribe` stops them. Edits name their board, subscribed or not.
 */
export type ClientMessage =
  | { readonly type: "subscribe" }
  | { readonly type: "unsubscribe" }
  | { readonly type: "preview"; readonly req: number; readonly element: CanvasElement }
  | { readonly type: "ops"; readonly ops: readonly Op[] }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

const SERVER_TYPES: ReadonlySet<unknown> = new Set(["scene", "patch", "status", "preview", "history"]);
const CLIENT_TYPES: ReadonlySet<unknown> = new Set(["subscribe", "unsubscribe", "preview", "ops", "undo", "redo"]);

function parse<M>(raw: string, types: ReadonlySet<unknown>): BoardFrame<M> | null {
  try {
    const f = JSON.parse(raw) as { kind?: unknown; board?: unknown; msg?: { type?: unknown } | null } | null;
    const ok = f?.kind === "board" && typeof f.board === "string" && f.board && types.has(f.msg?.type);
    return ok ? (f as BoardFrame<M>) : null;
  } catch {
    return null;
  }
}

export const parseServerFrame = (raw: string): BoardFrame<ServerMessage> | null => parse(raw, SERVER_TYPES);
export const parseClientFrame = (raw: string): BoardFrame<ClientMessage> | null => parse(raw, CLIENT_TYPES);
/** A frame as sent on the websocket. */
export const frame = <M>(board: string, msg: M): string => JSON.stringify({ kind: "board", board, msg });
