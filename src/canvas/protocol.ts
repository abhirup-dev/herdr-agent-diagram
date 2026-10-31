// Messages between the sidecar (Bun) and the canvas mod (Herdr), JSON over the sidecar's WebSocket.
// The sidecar owns conversion: the mod only ever receives full Excalidraw elements.
import type { CanvasElement } from "./types.ts";

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
  | { readonly type: "status"; readonly upstream: "connected" | "disconnected"; readonly detail?: string };

/** Mod -> sidecar (milestone 2: user edits). */
export type ClientMessage =
  | { readonly type: "hello"; readonly client: string }
  | { readonly type: "update"; readonly elements: readonly CanvasElement[] }
  | { readonly type: "remove"; readonly ids: readonly string[] };

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw) as { type?: unknown };
    return m.type === "scene" || m.type === "patch" || m.type === "status" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}
