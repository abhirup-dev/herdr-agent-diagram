// Applies the mod's op batches to a board and keeps undo history. Inverses are computed from
// the RAW server elements (which may be agent shorthand), not from the converted ones the mod sees, so undo
// restores exactly what was there. Pure apart from the injected REST client, so it is unit-tested.
import type { ElementFields, Op } from "../canvas/protocol.ts";
import type { RawElement } from "./diff.ts";

/** The board's element API. create/update resolve to the stored element. */
export interface Rest {
  create(element: ElementFields): Promise<RawElement>;
  update(id: string, fields: ElementFields): Promise<RawElement>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<RawElement | null>;
}

/** What the writer reads: the raw elements, and converted elements (for generated ids such as labels). */
export interface Source {
  /** The raw elements. The writer records its own writes in it at once (the next op's inverse must see this
   * one even if the store behind `Rest` is remote and lags). */
  raw(): Map<string, RawElement>;
  prepared(id: string): Readonly<Record<string, unknown>> | undefined;
}

interface Step {
  readonly forward: readonly Op[];
  readonly inverse: readonly Op[];
}

const LIMIT = 200;

export class Writer {
  private readonly undoStack: Step[] = [];
  private readonly redoStack: Step[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rest: Rest,
    private readonly src: Source,
    private readonly onHistory: (canUndo: boolean, canRedo: boolean) => void = () => {},
  ) {}

  /** Applies one batch (one undo step). Batches run strictly in order. */
  apply(ops: readonly Op[]): Promise<void> {
    return this.enqueue(async () => {
      const step = await this.run(ops);
      if (!step.forward.length) return;
      this.undoStack.push(step);
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
    });
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      const step = this.undoStack.pop();
      if (!step) return;
      const back = await this.run(step.inverse);
      this.redoStack.push({ forward: step.forward, inverse: back.forward.length ? back.inverse : step.inverse });
    });
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      const step = this.redoStack.pop();
      if (!step) return;
      this.undoStack.push(await this.run(step.forward));
    });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job, job).then(() => this.onHistory(this.canUndo, this.canRedo));
    return this.queue;
  }

  /** Runs ops, returning what was actually done and its inverse (newest-first, so undo replays backwards). */
  private async run(ops: readonly Op[]): Promise<Step> {
    const forward: Op[] = [];
    const inverse: Op[] = [];
    for (const op of ops) {
      const done = await this.one(op);
      if (!done) continue;
      forward.push(done.op);
      inverse.unshift(...done.inverse);
    }
    return { forward, inverse };
  }

  private one(op: Op): Promise<Done | null> {
    switch (op.op) {
      case "create":
        return this.create(op);
      case "remove":
        return this.remove(op);
      case "update":
        return this.update(op);
      case "label":
        return this.label(op);
    }
  }

  private async create(op: Extract<Op, { op: "create" }>): Promise<Done> {
    this.src.raw().set(op.element.id, await this.rest.create(op.element));
    return { op, inverse: [{ op: "remove", ids: [op.element.id] }] };
  }

  private async remove(op: Extract<Op, { op: "remove" }>): Promise<Done | null> {
    const raw = this.src.raw();
    // Generated ids (a shorthand container's label) are not on the server: they go with their container.
    const snapshots = op.ids.flatMap((id) => raw.get(id) ?? []);
    if (!snapshots.length) return null;
    for (const { id } of snapshots) {
      await this.rest.remove(id);
      raw.delete(id);
    }
    return {
      op: { op: "remove", ids: snapshots.map((e) => e.id) },
      inverse: snapshots.map((element): Op => ({ op: "create", element: restorable(element) })),
    };
  }

  private async update(op: Extract<Op, { op: "update" }>): Promise<Done | null> {
    const raw = this.src.raw();
    const el = raw.get(op.id);
    const converted = this.src.prepared(op.id);
    if (!el) {
      // A generated label: only its text can change, through its container.
      const text = op.fields.text;
      const containerId = converted?.containerId;
      return typeof text === "string" && typeof containerId === "string"
        ? this.label({ op: "label", containerId, text })
        : null;
    }
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(op.fields)) {
      // shortcut: a key the raw element lacks restores to its converted value; a truly absent key can't be
      // unset through the server's merge-PUT, so it stays (rare: editor keys always have converted values).
      const v = el[k] ?? converted?.[k];
      if (v !== undefined) prev[k] = v;
    }
    const bent = GEOMETRY.some((k) => k in op.fields) ? this.bentArrowsOf(op.id) : [];
    raw.set(op.id, await this.rest.update(op.id, op.fields));
    for (const a of bent) await this.keepBend(a);
    return { op, inverse: [{ op: "update", id: op.id, fields: prev }] };
  }

  /** Arrows/lines bound to `id` that have bend points (more than two points). */
  private bentArrowsOf(id: string): RawElement[] {
    const ref = (b: unknown) => (b as { elementId?: unknown; id?: unknown } | null | undefined) ?? {};
    return [...this.src.raw().values()].filter((e) => {
      if ((e.type !== "arrow" && e.type !== "line") || !Array.isArray(e.points) || e.points.length < 3) return false;
      const ends = [ref(e.startBinding).elementId, ref(e.endBinding).elementId, ref(e.start).id, ref(e.end).id];
      return ends.includes(id);
    });
  }

  /**
   * The server re-routes a moved shape's bound arrows as straight lines, dropping bend points. Excalidraw keeps
   * them: take the server's new endpoints, put the old middle points (fixed in world space) back between them.
   */
  private async keepBend(before: RawElement): Promise<void> {
    const after = await this.rest.get(before.id);
    const pts = after?.points as readonly (readonly [number, number])[] | undefined;
    const oldPts = before.points as readonly (readonly [number, number])[];
    if (!after || !pts || pts.length < 2 || pts.length >= oldPts.length) return;
    const [ax, ay] = [after.x as number, after.y as number];
    const [bx, by] = [before.x as number, before.y as number];
    const first = pts[0] ?? [0, 0];
    const last = pts[pts.length - 1] ?? [0, 0];
    const [sx, sy] = [ax + first[0], ay + first[1]];
    const middle = oldPts.slice(1, -1).map(([x, y]): [number, number] => [bx + x - sx, by + y - sy]);
    const points: [number, number][] = [[0, 0], ...middle, [ax + last[0] - sx, ay + last[1] - sy]];
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    this.src.raw().set(before.id, await this.rest.update(before.id, { x: sx, y: sy, points, width, height }));
  }

  private async label(op: Extract<Op, { op: "label" }>): Promise<Done | null> {
    const raw = this.src.raw();
    const bound = [...raw.values()].find((e) => e.type === "text" && e.containerId === op.containerId);
    const container = raw.get(op.containerId);
    const target = bound ?? container;
    if (!target) return null;
    const old = bound ? bound.text : (container?.label as { text?: unknown } | undefined)?.text;
    const fields = bound ? { text: op.text, originalText: op.text } : { label: { text: op.text } };
    raw.set(target.id, await this.rest.update(target.id, fields));
    return { op, inverse: [{ op: "label", containerId: op.containerId, text: typeof old === "string" ? old : "" }] };
  }
}

const GEOMETRY = ["x", "y", "width", "height"] as const;

interface Done {
  readonly op: Op;
  readonly inverse: Op[];
}

/** A raw element as a create body: server bookkeeping dropped, identity (id, seed, index) kept. */
function restorable(e: RawElement): ElementFields & { id: string; type: string } {
  const {
    createdAt: _c,
    updatedAt: _u,
    syncedAt: _s,
    syncTimestamp: _t,
    version: _v,
    ...rest
  } = e as RawElement & {
    type: string;
  };
  return rest as ElementFields & { id: string; type: string };
}
