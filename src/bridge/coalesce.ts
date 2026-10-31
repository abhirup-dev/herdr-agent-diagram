// Backpressure: while a pipe is busy, messages for a board merge so a slow link carries the latest state, not
// every step. Applying the drained messages gives the same scene as applying all pushed ones in order.
// Only for backend -> frontend messages: user ops are never merged (each batch is one undo step).
import type { ServerMessage } from "../canvas/protocol.ts";
import type { CanvasElement } from "../canvas/types.ts";
import type { BoardServerMessage, Pin } from "./protocol.ts";

type SceneMsg = Extract<ServerMessage, { type: "scene" }>;
type PatchMsg = Extract<ServerMessage, { type: "patch" }>;

interface Pending {
  /** A scene, or a patch whose `remove` runs before its `upsert` (as `applyMessage` does). */
  elements?: SceneMsg | { type: "patch"; rev: number; upsert: Map<string, CanvasElement>; remove: Set<string> };
  pins?: Map<string, Pin>;
  /** Latest wins, by `status`, `history`, `preview:<id>`, `pin:<id>`. */
  last: Map<string, BoardServerMessage>;
}

function mergeIntoScene(scene: SceneMsg, p: PatchMsg): SceneMsg {
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  for (const id of p.remove) byId.delete(id);
  for (const e of p.upsert) byId.set(e.id, e);
  return { type: "scene", rev: p.rev, elements: [...byId.values()] };
}

function mergeElements(pending: Pending, m: SceneMsg | PatchMsg): void {
  const cur = pending.elements;
  if (m.type === "scene") pending.elements = m;
  else if (cur?.type === "scene") pending.elements = mergeIntoScene(cur, m);
  else {
    const merged = cur ?? { type: "patch", rev: m.rev, upsert: new Map(), remove: new Set() };
    merged.rev = m.rev;
    for (const id of m.remove) {
      merged.upsert.delete(id);
      merged.remove.add(id);
    }
    // An id removed then upserted stays in `remove` too, so it lands on top as it would in order.
    for (const e of m.upsert) merged.upsert.set(e.id, e);
    pending.elements = merged;
  }
}

function mergePins(pending: Pending, m: Extract<BoardServerMessage, { type: "pins" | "pin" | "unpin" }>): void {
  if (m.type === "pins") {
    pending.pins = new Map(m.pins.map((p) => [p.id, p]));
    for (const k of pending.last.keys()) if (k.startsWith("pin:")) pending.last.delete(k);
  } else if (pending.pins) {
    if (m.type === "pin") pending.pins.set(m.pin.id, m.pin);
    else pending.pins.delete(m.id);
  } else pending.last.set(`pin:${m.type === "pin" ? m.pin.id : m.id}`, m);
}

function drainOne(p: Pending): BoardServerMessage[] {
  const out: BoardServerMessage[] = [];
  const e = p.elements;
  if (e?.type === "scene") out.push(e);
  else if (e) out.push({ type: "patch", rev: e.rev, upsert: [...e.upsert.values()], remove: [...e.remove] });
  if (p.pins) out.push({ type: "pins", pins: [...p.pins.values()] });
  out.push(...p.last.values());
  return out;
}

export class Coalescer {
  #boards = new Map<string, Pending>();

  get empty(): boolean {
    return this.#boards.size === 0;
  }

  push(board: string, m: BoardServerMessage): void {
    let p = this.#boards.get(board);
    if (!p) {
      p = { last: new Map() };
      this.#boards.set(board, p);
    }
    if (m.type === "scene" || m.type === "patch") mergeElements(p, m);
    else if (m.type === "pins" || m.type === "pin" || m.type === "unpin") mergePins(p, m);
    else p.last.set(m.type === "preview" ? `preview:${m.id}` : m.type, m);
  }

  /** Everything pending, board by board, and empties the queue. */
  drain(): { board: string; msg: BoardServerMessage }[] {
    const out = [...this.#boards].flatMap(([board, p]) => drainOne(p).map((msg) => ({ board, msg })));
    this.#boards.clear();
    return out;
  }
}
