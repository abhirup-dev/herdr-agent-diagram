// The sidecar's pure core: mirror mcp-excalidraw-server's tab events into a raw element map, and diff two
// prepared scenes into a patch. No IO here, so it is unit-tested.

/** An element as the canvas server stores it: agent shorthand (label/start/end) or a full Excalidraw element. */
export type RawElement = Readonly<Record<string, unknown>> & { readonly id: string };

/** The WebSocket events mcp-excalidraw-server 2.1 sends its browser tab (server.js broadcast calls). */
export type UpstreamEvent =
  | { readonly type: "initial_elements"; readonly elements: readonly RawElement[] }
  | { readonly type: "element_created" | "element_updated"; readonly element: RawElement }
  | { readonly type: "element_deleted"; readonly elementId: string }
  | { readonly type: "elements_batch_created"; readonly elements: readonly RawElement[] }
  | { readonly type: "canvas_cleared" }
  | { readonly type: "elements_synced" }
  | {
      readonly type: "export_image_request";
      readonly requestId: string;
      readonly format: "png" | "svg";
      readonly background?: boolean;
    }
  | { readonly type: "set_viewport"; readonly requestId: string }
  | { readonly type: "mermaid_convert" | "sync_status" | "files_added" | "file_deleted" };

export type MirrorResult = "changed" | "unchanged" | "refetch";

/** Applies one upstream event to `raw`. "refetch" means the event carries no elements: reload GET /api/elements. */
export function applyEvent(raw: Map<string, RawElement>, e: UpstreamEvent): MirrorResult {
  switch (e.type) {
    case "initial_elements":
      raw.clear();
      for (const el of e.elements) raw.set(el.id, el);
      return "changed";
    case "element_created":
    case "element_updated":
      raw.set(e.element.id, e.element);
      return "changed";
    case "elements_batch_created":
      for (const el of e.elements) raw.set(el.id, el);
      return "changed";
    case "element_deleted":
      return raw.delete(e.elementId) ? "changed" : "unchanged";
    case "canvas_cleared":
      if (!raw.size) return "unchanged";
      raw.clear();
      return "changed";
    case "elements_synced":
      return "refetch";
    default:
      return "unchanged";
  }
}

export interface Keyed {
  readonly id: string;
}

export interface Patch<T extends Keyed> {
  readonly upsert: T[];
  readonly remove: string[];
}

/** Fields the SDK regenerates on every conversion; they don't change what is drawn. */
const VOLATILE = new Set(["updated", "versionNonce"]);
const stable = (el: object) => JSON.stringify(el, (k, v) => (VOLATILE.has(k) ? undefined : v));

/** What changed between two prepared scenes, by deep comparison (server updates don't always bump `version`). */
export function diff<T extends Keyed>(prev: ReadonlyMap<string, T>, next: readonly T[]): Patch<T> {
  const upsert = next.filter((el) => {
    const old = prev.get(el.id);
    return old === undefined || stable(old) !== stable(el);
  });
  const ids = new Set(next.map((el) => el.id));
  return { upsert, remove: [...prev.keys()].filter((id) => !ids.has(id)) };
}

/**
 * A seed derived from the id (FNV-1a), for elements the agent created without one: the SDK would otherwise
 * pick a random seed on every conversion and the hand-drawn strokes would re-wobble on each edit.
 */
export function stableSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 2 ** 31 || 1;
}

/** Raw elements with a stable seed filled in where missing. */
export const withSeeds = (els: Iterable<RawElement>): RawElement[] =>
  [...els].map((el) => (typeof el.seed === "number" ? el : { ...el, seed: stableSeed(el.id) }));
