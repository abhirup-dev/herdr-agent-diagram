// The mod's scene: elements by id plus Excalidraw's stacking order (fractional `index` strings sort
// lexicographically; elements without one keep arrival order, on top).
import type { Bounds } from "./camera.ts";
import type { ServerMessage } from "./protocol.ts";
import type { CanvasElement } from "./types.ts";

export interface Scene {
  readonly rev: number;
  readonly byId: ReadonlyMap<string, CanvasElement>;
  /** Bottom to top. */
  readonly order: readonly CanvasElement[];
}

export const emptyScene: Scene = { rev: 0, byId: new Map(), order: [] };

function ordered(byId: ReadonlyMap<string, CanvasElement>): CanvasElement[] {
  const arrival = [...byId.values()];
  const pos = new Map(arrival.map((e, i) => [e.id, i]));
  return arrival.sort((a, b) => {
    if (a.index !== null && b.index !== null) return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
    if (a.index !== b.index) return a.index === null ? 1 : -1;
    return (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0);
  });
}

/** Applies a sidecar message; returns the same scene when nothing changes. Ids of changed elements go to `changed`. */
export function applyMessage(scene: Scene, m: ServerMessage, changed?: Set<string>): Scene {
  if (m.type !== "scene" && m.type !== "patch") return scene;
  if (m.type === "scene") {
    for (const id of scene.byId.keys()) changed?.add(id);
    for (const e of m.elements) changed?.add(e.id);
    const byId = new Map(m.elements.map((e) => [e.id, e]));
    return { rev: m.rev, byId, order: ordered(byId) };
  }
  if (!m.upsert.length && !m.remove.length) return { ...scene, rev: m.rev };
  const byId = new Map(scene.byId);
  for (const id of m.remove) {
    byId.delete(id);
    changed?.add(id);
  }
  for (const e of m.upsert) {
    byId.set(e.id, e);
    changed?.add(e.id);
  }
  return { rev: m.rev, byId, order: ordered(byId) };
}

/** World bounds of all elements (axis-aligned, ignoring rotation and stroke width), or null when empty. */
export function sceneBounds(scene: Scene): Bounds | null {
  if (!scene.order.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of scene.order) {
    const pts = "points" in e && e.points.length ? e.points : [[0, 0] as const, [e.width, e.height] as const];
    for (const [px, py] of pts) {
      minX = Math.min(minX, e.x + px);
      minY = Math.min(minY, e.y + py);
      maxX = Math.max(maxX, e.x + px);
      maxY = Math.max(maxY, e.y + py);
    }
  }
  return { minX, minY, maxX, maxY };
}
