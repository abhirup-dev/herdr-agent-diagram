// One board's elements and snapshots, in memory. Ported from mcp-excalidraw-server 2.1.2's server.ts (MIT,
// see LICENSE): the same element rules (shorthand kept as stored, arrow start/end resolved to edge points,
// bound arrows rerouted when a shape moves, text/originalText kept in sync), minus the HTTP and the globals.
// Pure: no IO, so it is unit-tested. `onChange` fires after every mutation.

/** An element as the board stores it: agent shorthand (label/start/end) or a full Excalidraw element. */
export type BoardElement = Record<string, unknown> & { id: string; type: string };

export interface Snapshot {
  readonly name: string;
  readonly elements: BoardElement[];
  readonly createdAt: string;
}

/** A rejected request; `status` is the HTTP status the REST layer answers with. */
export class BoardError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow", "text", "line", "freedraw", "image", "frame"]);
const GEOMETRY = ["x", "y", "width", "height"];
const BR = /<\s*b\s*r\s*\/?\s*>/i;

export const generateId = (): string => Date.now().toString(36) + Math.random().toString(36).substring(2);

/** Excalidraw's numeric font ids for the names agents use. */
export function normalizeFontFamily(f: unknown): number | undefined {
  if (typeof f === "number") return f;
  if (typeof f !== "string") return undefined;
  const map: Record<string, number> = {
    virgil: 1,
    hand: 1,
    handwritten: 1,
    helvetica: 2,
    sans: 2,
    "sans-serif": 2,
    cascadia: 3,
    mono: 3,
    monospace: 3,
    excalifont: 5,
    nunito: 6,
    lilita: 7,
    "lilita one": 7,
    "comic shanns": 8,
    comic: 8,
  };
  return map[f.toLowerCase()] ?? ({ 1: 1, 2: 2, 3: 3, 5: 5, 6: 6, 7: 7, 8: 8 } as Record<string, number>)[f];
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const ref = (v: unknown): string | undefined =>
  v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined;
const now = () => new Date().toISOString();
const isLinear = (e: { type: string }) => e.type === "arrow" || e.type === "line";
const has = (o: object, k: string) => Object.hasOwn(o, k);

/** Validates what the upstream zod schema checked that matters: a known type, numeric coordinates. */
function check(body: Record<string, unknown>, creating: boolean): void {
  if (creating || body.type !== undefined) {
    if (typeof body.type !== "string" || !TYPES.has(body.type))
      throw new BoardError(`Invalid element type: ${String(body.type)}`);
  }
  for (const k of GEOMETRY) {
    const v = body[k];
    const required = creating && (k === "x" || k === "y");
    if ((v === undefined && required) || (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))))
      throw new BoardError(`${k}: Expected number, received ${v === undefined ? "undefined" : typeof v}`);
  }
  if (body.id !== undefined && typeof body.id !== "string") throw new BoardError("id: Expected string");
}

const normalizeLineBreaks = (t: string) => t.replace(/<\s*b\s*r\s*\/?\s*>/gi, "\n").replace(/\n{3,}/g, "\n\n");

/** Where the ray from `el`'s centre toward (tx, ty) leaves its outline. */
function edgePoint(el: BoardElement, tx: number, ty: number): { x: number; y: number } {
  const hw = num(el.width) / 2;
  const hh = num(el.height) / 2;
  const cx = num(el.x) + hw;
  const cy = num(el.y) + hh;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  if (el.type === "diamond") {
    const s = Math.abs(dx) / hw + Math.abs(dy) / hh;
    const scale = s > 0 ? 1 / s : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }
  const angle = Math.atan2(dy, dx);
  if (el.type === "ellipse") return { x: cx + hw * Math.cos(angle), y: cy + hh * Math.sin(angle) };
  const tan = Math.tan(angle);
  if (Math.abs(tan * hw) <= hh) {
    const sx = dx >= 0 ? 1 : -1;
    return { x: cx + sx * hw, y: cy + sx * hw * tan };
  }
  const sy = dy >= 0 ? 1 : -1;
  return { x: cx + (sy * hh) / tan, y: cy + sy * hh };
}

const center = (e: BoardElement) => ({ x: num(e.x) + num(e.width) / 2, y: num(e.y) + num(e.height) / 2 });

/** Points an arrow with start/end refs from edge to edge (8 px gap). Keeps start/end: the SDK binds from them. */
function routeArrow(el: BoardElement, lookup: (id: string) => BoardElement | undefined): void {
  const startId = ref(el.start);
  const endId = ref(el.end);
  if (!startId && !endId) return;
  const s = startId ? lookup(startId) : undefined;
  const e = endId ? lookup(endId) : undefined;
  const sc = s ? center(s) : { x: num(el.x), y: num(el.y) };
  const ec = e ? center(e) : { x: num(el.x) + 100, y: num(el.y) };
  const sp = s ? edgePoint(s, ec.x, ec.y) : sc;
  const ep = e ? edgePoint(e, sc.x, sc.y) : ec;
  const dist = Math.hypot(ep.x - sp.x, ep.y - sp.y) || 1;
  const ux = (ep.x - sp.x) / dist;
  const uy = (ep.y - sp.y) / dist;
  const start = { x: sp.x + ux * 8, y: sp.y + uy * 8 };
  const end = { x: ep.x - ux * 8, y: ep.y - uy * 8 };
  el.x = start.x;
  el.y = start.y;
  el.points = [
    [0, 0],
    [end.x - start.x, end.y - start.y],
  ];
}

export class Board {
  readonly elements = new Map<string, BoardElement>();
  readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly onChange: () => void = () => {}) {}

  list(): BoardElement[] {
    return [...this.elements.values()];
  }

  get(id: string): BoardElement {
    const el = this.elements.get(id);
    if (!el) throw new BoardError(`Element with ID ${id} not found`, 404);
    return el;
  }

  create(body: Record<string, unknown>): BoardElement {
    const el = this.fresh(body);
    if (this.elements.has(el.id)) throw new BoardError(`id ${el.id} exists; use update`);
    if (isLinear(el)) routeArrow(el, (id) => this.elements.get(id));
    this.elements.set(el.id, el);
    this.onChange();
    return el;
  }

  /** Creates many at once; `replace` swaps the whole scene, validated before anything is dropped. */
  batch(bodies: unknown, replace = false): BoardElement[] {
    if (!Array.isArray(bodies)) throw new BoardError("Expected an array of elements");
    const created = bodies.map((b) => this.fresh(b as Record<string, unknown>));
    this.assertNew(created, replace);
    const byId = new Map(created.map((e) => [e.id, e]));
    for (const el of created)
      if (isLinear(el)) routeArrow(el, (id) => byId.get(id) ?? (replace ? undefined : this.elements.get(id)));
    if (replace) this.elements.clear();
    for (const el of created) this.elements.set(el.id, el);
    this.onChange();
    return created;
  }

  update(id: string, body: Record<string, unknown>): BoardElement {
    check(body, false);
    const old = this.get(id);
    const el: BoardElement = {
      ...old,
      ...body,
      id,
      type: typeof body.type === "string" ? body.type : old.type,
      fontFamily: body.fontFamily !== undefined ? normalizeFontFamily(body.fontFamily) : old.fontFamily,
      updatedAt: now(),
      version: num(old.version) + 1,
    };
    if (el.type === "text" && has(body, "text") && !has(body, "originalText")) syncOriginalText(el, old, body);
    this.elements.set(id, el);
    if (!isLinear(el) && GEOMETRY.some((k) => has(body, k))) this.rerouteArrowsOf(id);
    this.onChange();
    return el;
  }

  remove(id: string): void {
    this.get(id);
    this.elements.delete(id);
    this.onChange();
  }

  clear(): number {
    const count = this.elements.size;
    this.elements.clear();
    this.onChange();
    return count;
  }

  /** Type, bounding box (x_min..y_max on the element's x/y) and exact-match string filters. */
  search(query: URLSearchParams): BoardElement[] {
    const bound = (k: string, d: number) => (query.has(k) ? Number(query.get(k)) : d);
    const [x0, x1] = [bound("x_min", -Infinity), bound("x_max", Infinity)];
    const [y0, y1] = [bound("y_min", -Infinity), bound("y_max", Infinity)];
    const type = query.get("type");
    const exact = [...query].filter(([k]) => !["type", "x_min", "x_max", "y_min", "y_max"].includes(k));
    return this.list().filter(
      (e) =>
        (!type || e.type === type) &&
        num(e.x) >= x0 &&
        num(e.x) <= x1 &&
        num(e.y) >= y0 &&
        num(e.y) <= y1 &&
        exact.every(([k, v]) => e[k] === v),
    );
  }

  saveSnapshot(name: unknown): Snapshot {
    if (!name || typeof name !== "string") throw new BoardError("Snapshot name is required");
    const snap = { name, elements: structuredClone(this.list()), createdAt: now() };
    this.snapshots.set(name, snap);
    return snap;
  }

  snapshot(name: string): Snapshot {
    const snap = this.snapshots.get(name);
    if (!snap) throw new BoardError(`Snapshot "${name}" not found`, 404);
    return snap;
  }

  /** Create refuses an id the board already has. A replace may reuse ids; a repeated id in one batch may not. */
  private assertNew(els: BoardElement[], replace: boolean): void {
    const seen = new Set<string>();
    for (const el of els) {
      if (seen.has(el.id) || (!replace && this.elements.has(el.id)))
        throw new BoardError(`id ${el.id} exists; use update`);
      seen.add(el.id);
    }
  }

  private fresh(body: Record<string, unknown>): BoardElement {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoardError("Expected an element object");
    check(body, true);
    const t = now();
    return {
      ...body,
      id: typeof body.id === "string" && body.id ? body.id : generateId(),
      type: body.type as string,
      fontFamily: normalizeFontFamily(body.fontFamily),
      createdAt: t,
      updatedAt: t,
      version: 1,
    };
  }

  /** Bindings resolve at creation only, so a moved shape drags the arrows that name it along. */
  private rerouteArrowsOf(id: string): void {
    for (const el of this.elements.values()) {
      if (!isLinear(el) || (ref(el.start) !== id && ref(el.end) !== id)) continue;
      const arrow = { ...el, updatedAt: now(), version: num(el.version) + 1 }; // a copy: snapshots stay as taken
      routeArrow(arrow, (x) => this.elements.get(x));
      this.elements.set(arrow.id, arrow);
    }
  }
}

/** Keeps a text element's source text in step with REST text edits (stale originalText re-wraps wrongly). */
function syncOriginalText(el: BoardElement, old: BoardElement, body: Record<string, unknown>): void {
  const incoming = typeof body.text === "string" ? body.text : "";
  const oldText = typeof old.text === "string" ? old.text : "";
  const oldOriginal = typeof old.originalText === "string" ? old.originalText : "";
  const normalizedOriginal = normalizeLineBreaks(oldOriginal);
  if (BR.test(oldOriginal) && incoming === normalizeLineBreaks(oldText) && normalizedOriginal) {
    el.text = normalizedOriginal;
    el.originalText = normalizedOriginal;
  } else el.originalText = incoming;
}
