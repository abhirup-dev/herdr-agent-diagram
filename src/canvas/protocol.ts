// Messages between the sidecar (Bun) and the canvas mod (Herdr), JSON over the sidecar's WebSocket.
// The sidecar owns conversion, rough paths, server writes and undo history; the mod owns interaction.
import type { CanvasElement, Paint } from "./types.ts";

export const SIDECAR_PORT = 3077;

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

/** Mod -> sidecar. */
export type ClientMessage =
  | { readonly type: "preview"; readonly req: number; readonly element: CanvasElement }
  | { readonly type: "ops"; readonly ops: readonly Op[] }
  | { readonly type: "undo" }
  | { readonly type: "redo" };

const SERVER_TYPES: ReadonlySet<unknown> = new Set(["scene", "patch", "status", "preview", "history"]);
const CLIENT_TYPES: ReadonlySet<unknown> = new Set(["preview", "ops", "undo", "redo"]);

function parse<T>(raw: string, types: ReadonlySet<unknown>): T | null {
  try {
    const m = JSON.parse(raw) as { type?: unknown };
    return types.has(m.type) ? (m as T) : null;
  } catch {
    return null;
  }
}

export const parseServerMessage = (raw: string): ServerMessage | null => parse(raw, SERVER_TYPES);
export const parseClientMessage = (raw: string): ClientMessage | null => parse(raw, CLIENT_TYPES);
