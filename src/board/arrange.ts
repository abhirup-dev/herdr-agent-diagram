// `arrange`: align, distribute, group, ungroup, lock, duplicate, over a board's REST API.
// From mcp-excalidraw-server 2.1.2 core/geometry.ts (MIT).
import type { BoardClient } from "./client.ts";
import { type BoardElement, generateId } from "./store.ts";

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Direction = "horizontal" | "vertical";

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function fetchAll(c: BoardClient, ids: string[]): Promise<BoardElement[]> {
  const found = await Promise.all(ids.map((id) => c.get(id).catch(() => null)));
  return found.filter((e): e is BoardElement => e !== null);
}

const ALIGN: Record<Alignment, (els: BoardElement[]) => (e: BoardElement) => Record<string, number>> = {
  left: (els) => {
    const x = Math.min(...els.map((e) => n(e.x)));
    return () => ({ x });
  },
  right: (els) => {
    const r = Math.max(...els.map((e) => n(e.x) + n(e.width)));
    return (e) => ({ x: r - n(e.width) });
  },
  center: (els) => {
    const c = avg(els.map((e) => n(e.x) + n(e.width) / 2));
    return (e) => ({ x: c - n(e.width) / 2 });
  },
  top: (els) => {
    const y = Math.min(...els.map((e) => n(e.y)));
    return () => ({ y });
  },
  bottom: (els) => {
    const b = Math.max(...els.map((e) => n(e.y) + n(e.height)));
    return (e) => ({ y: b - n(e.height) });
  },
  middle: (els) => {
    const m = avg(els.map((e) => n(e.y) + n(e.height) / 2));
    return (e) => ({ y: m - n(e.height) / 2 });
  },
};

export async function align(c: BoardClient, ids: string[], to: Alignment) {
  const els = await fetchAll(c, ids);
  if (els.length < 2) throw new Error("Need at least 2 elements to align");
  const at = ALIGN[to](els);
  await Promise.all(els.map((e) => c.update(e.id, at(e))));
  return { aligned: true, elementIds: ids, alignment: to, successCount: els.length };
}

export async function distribute(c: BoardClient, ids: string[], dir: Direction) {
  const els = await fetchAll(c, ids);
  if (els.length < 3) throw new Error("Need at least 3 elements to distribute");
  const [pos, size] = dir === "horizontal" ? (["x", "width"] as const) : (["y", "height"] as const);
  els.sort((a, b) => n(a[pos]) - n(b[pos]));
  const first = els[0] as BoardElement;
  const last = els[els.length - 1] as BoardElement;
  const span = n(last[pos]) + n(last[size]) - n(first[pos]);
  const gap = (span - els.reduce((s, e) => s + n(e[size]), 0)) / (els.length - 1);
  let at = n(first[pos]);
  for (const e of els) {
    await c.update(e.id, { [pos]: at });
    at += n(e[size]) + gap;
  }
  return { distributed: true, elementIds: ids, direction: dir, count: els.length };
}

export async function setLocked(c: BoardClient, ids: string[], locked: boolean) {
  await Promise.all(ids.map((id) => c.update(id, { locked })));
  return { elementIds: ids, successCount: ids.length };
}

const groupIds = (e: BoardElement) => (Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []);

export async function group(c: BoardClient, ids: string[]) {
  const groupId = generateId();
  const els = await fetchAll(c, ids);
  await Promise.all(els.map((e) => c.update(e.id, { groupIds: [...groupIds(e), groupId] })));
  return { groupId, elementIds: ids, successCount: els.length };
}

export async function ungroup(c: BoardClient, groupId: string) {
  const members = (await c.elements()).filter((e) => groupIds(e).includes(groupId));
  if (!members.length) throw new Error(`Group ${groupId} not found`);
  await Promise.all(members.map((e) => c.update(e.id, { groupIds: groupIds(e).filter((g) => g !== groupId) })));
  const elementIds = members.map((e) => e.id);
  return { groupId, ungrouped: true, elementIds, successCount: members.length };
}

export async function duplicate(c: BoardClient, ids: string[], dx: number, dy: number) {
  const copies = (await fetchAll(c, ids)).map((e) => {
    const { createdAt: _c, updatedAt: _u, version: _v, syncedAt: _s, source: _src, syncTimestamp: _t, ...rest } = e;
    return { ...rest, id: generateId(), x: n(e.x) + dx, y: n(e.y) + dy };
  });
  if (!copies.length) throw new Error("No elements could be duplicated (none found)");
  return { count: copies.length, offsetX: dx, offsetY: dy, elements: await c.batch(copies) };
}
