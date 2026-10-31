// The canvas editor: tools, selection and gestures over world coordinates. Pure (no GPUI, no IO): the mod
// feeds it pointer and key events and drains `outbox` (ops for the sidecar) and `previews` (draft elements
// that need rough paths). Committed edits stay as optimistic `pending` overrides until the server echo
// matches them, so the canvas never snaps back while a write is in flight.
import type { Bounds } from "./camera.ts";
import {
  boundTexts,
  boxFrom,
  DEFAULT_STYLE,
  dragOut,
  elementBounds,
  type Handle,
  handleAt,
  hitTest,
  inBox,
  isShapeTool,
  measureText,
  newElement,
  newId,
  resizeBounds,
  type ShapeTool,
  type Style,
  scaleFields,
  type Tool,
  unionBounds,
} from "./edit.ts";
import type { ElementFields, Op } from "./protocol.ts";
import type { CanvasElement, TextElement } from "./types.ts";

export interface Mods {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly cmd: boolean;
}

type Gesture =
  | { readonly kind: "move"; readonly x0: number; readonly y0: number; readonly originals: readonly CanvasElement[] }
  | {
      readonly kind: "resize";
      readonly handle: Handle;
      readonly from: Bounds;
      readonly originals: readonly CanvasElement[];
    }
  | { readonly kind: "create"; readonly x0: number; readonly y0: number; readonly id: string }
  | { readonly kind: "marquee"; readonly x0: number; readonly y0: number; x1: number; y1: number }
  | { readonly kind: "erase" };

/** An open text editor: a new text, an existing one, or the label inside a container. */
export interface TextEdit {
  readonly id: string;
  readonly isNew: boolean;
  readonly containerId: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly align: "left" | "center";
}

interface Pending {
  readonly el: CanvasElement;
  readonly keys: readonly string[];
  readonly until: number;
}

const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  h: "hand",
  v: "selection",
  "1": "selection",
  r: "rectangle",
  "2": "rectangle",
  d: "diamond",
  "3": "diamond",
  o: "ellipse",
  "4": "ellipse",
  a: "arrow",
  "5": "arrow",
  l: "line",
  "6": "line",
  p: "freedraw",
  x: "freedraw",
  "7": "freedraw",
  t: "text",
  "8": "text",
  e: "eraser",
  "0": "eraser",
};

const PENDING_MS = 2500;
const close = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.5 : JSON.stringify(a) === JSON.stringify(b);

export class Editor {
  tool: Tool = "selection";
  style: Style = DEFAULT_STYLE;
  readonly selected = new Set<string>();
  /** Elements being dragged right now, by id (not yet sent). */
  readonly drafts = new Map<string, CanvasElement>();
  /** Sent but not yet echoed back by the server. */
  readonly pending = new Map<string, Pending>();
  /** Ids the eraser has marked during the current drag. */
  readonly erasing = new Set<string>();
  /** Op batches for the sidecar; each batch is one undo step. Drained by the mod. */
  readonly outbox: Op[][] = [];
  /** Draft elements that need rough paths, latest per id. Drained by the mod. */
  readonly previews = new Map<string, CanvasElement>();
  editing: TextEdit | null = null;
  private gesture: Gesture | null = null;

  constructor(
    private readonly scene: () => readonly CanvasElement[],
    private readonly now: () => number = Date.now,
  ) {}

  // --- what to draw ---------------------------------------------------------------------------------------

  /** The scene as the user should see it: drafts over pending over server state, new drafts on top. */
  elements(): CanvasElement[] {
    const t = this.now();
    const out: CanvasElement[] = [];
    for (const e of this.scene()) {
      const p = this.pending.get(e.id);
      if (p && p.until < t) this.pending.delete(e.id);
      out.push(this.drafts.get(e.id) ?? (p && p.until >= t ? p.el : e));
    }
    const known = new Set(out.map((e) => e.id));
    for (const [id, p] of this.pending) if (!known.has(id) && p.until >= t && !p.el.isDeleted) out.push(p.el);
    for (const [id, d] of this.drafts) if (!known.has(id) && !this.pending.has(id)) out.push(d);
    return out.filter((e) => !e.isDeleted);
  }

  /** Union bounds of the selection, or null. */
  selectionBounds(els: readonly CanvasElement[] = this.elements()): Bounds | null {
    return unionBounds(els.filter((e) => this.selected.has(e.id)).map(elementBounds));
  }

  marquee(): Bounds | null {
    const g = this.gesture;
    return g?.kind === "marquee" ? boxFrom(g.x0, g.y0, g.x1, g.y1) : null;
  }

  get busy(): boolean {
    return this.gesture !== null;
  }

  /** Drops pending overrides the server has caught up with. Call after every scene change. */
  reconcile(): void {
    const byId = new Map(this.scene().map((e) => [e.id, e]));
    for (const [id, p] of this.pending) {
      const e = byId.get(id);
      if (
        p.el.isDeleted
          ? !e
          : e && p.keys.every((k) => close(e[k as keyof CanvasElement], p.el[k as keyof CanvasElement]))
      )
        this.pending.delete(id);
    }
  }

  // --- pointer --------------------------------------------------------------------------------------------

  /** A press at world (x, y). `tol` is the hit slop in world units (a few screen px / zoom). */
  down(x: number, y: number, m: Mods, clicks: number, tol: number): void {
    if (this.editing) this.commitText(this.editing.text);
    const els = this.elements();
    if (this.tool === "eraser") {
      this.gesture = { kind: "erase" };
      this.erase(els, x, y, tol);
      return;
    }
    if (this.tool === "text" || (this.tool === "selection" && clicks >= 2)) {
      this.openText(els, x, y, tol);
      return;
    }
    if (isShapeTool(this.tool)) {
      const draft = newElement(this.tool as ShapeTool, x, y, this.style);
      this.drafts.set(draft.id, draft);
      this.selected.clear();
      this.gesture = { kind: "create", x0: x, y0: y, id: draft.id };
      return;
    }
    if (this.tool !== "selection") return;
    const sel = this.selectionBounds(els);
    const handle = sel && this.selected.size ? handleAt(sel, x, y, tol * 1.5) : null;
    if (sel && handle) {
      const originals = els.filter((e) => this.selected.has(e.id));
      this.gesture = { kind: "resize", handle, from: sel, originals };
      return;
    }
    const hit = hitTest(els, x, y, tol);
    if (hit) {
      if (m.shift) {
        if (this.selected.has(hit.id)) this.selected.delete(hit.id);
        else this.selected.add(hit.id);
      } else if (!this.selected.has(hit.id)) {
        this.selected.clear();
        this.selected.add(hit.id);
      }
      const ids = new Set(this.selected);
      const originals = [...els.filter((e) => ids.has(e.id)), ...boundTexts(els, ids)];
      this.gesture = { kind: "move", x0: x, y0: y, originals };
      return;
    }
    if (!m.shift) this.selected.clear();
    this.gesture = { kind: "marquee", x0: x, y0: y, x1: x, y1: y };
  }

  move(x: number, y: number, m: Mods, tol: number): void {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "erase") this.erase(this.elements(), x, y, tol);
    else if (g.kind === "marquee") {
      g.x1 = x;
      g.y1 = y;
    } else if (g.kind === "move") {
      const [dx, dy] = [x - g.x0, y - g.y0];
      for (const e of g.originals) this.drafts.set(e.id, { ...e, x: e.x + dx, y: e.y + dy });
    } else if (g.kind === "resize") {
      const to = resizeBounds(g.from, g.handle, x, y, m.shift);
      for (const e of g.originals) {
        const d = { ...e, ...scaleFields(e, g.from, to) } as CanvasElement;
        this.drafts.set(e.id, d);
        if (g.originals.length <= 4) this.previews.set(e.id, d);
      }
    } else {
      const d = this.drafts.get(g.id);
      if (!d) return;
      const next = dragOut(d, g.x0, g.y0, x, y, m.shift);
      this.drafts.set(g.id, next);
      if (next.width >= 1 || next.height >= 1) this.previews.set(g.id, next);
    }
  }

  up(_x: number, _y: number, _m: Mods): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.kind === "erase") {
      if (this.erasing.size) this.remove([...this.erasing]);
      this.erasing.clear();
    } else if (g.kind === "marquee") {
      for (const e of inBox(this.elements(), boxFrom(g.x0, g.y0, g.x1, g.y1))) this.selected.add(e.id);
    } else if (g.kind === "move" || g.kind === "resize") {
      const moved = g.originals.filter((o) => {
        const d = this.drafts.get(o.id);
        return d && (d.x !== o.x || d.y !== o.y || d.width !== o.width || d.height !== o.height);
      });
      const keys = g.kind === "move" ? ["x", "y"] : ["x", "y", "width", "height"];
      const ops = moved.map((o): Op => {
        const d = this.drafts.get(o.id) as CanvasElement;
        const fields = g.kind === "move" ? { x: d.x, y: d.y } : scaleFieldsOf(d);
        return { op: "update", id: o.id, fields };
      });
      for (const o of moved) this.settle(this.drafts.get(o.id) as CanvasElement, keys);
      for (const o of g.originals) this.drafts.delete(o.id);
      if (ops.length) this.outbox.push(ops);
    } else this.finishCreate(g.id);
  }

  /** The pointer left the canvas mid-gesture: finish it where it is rather than leave it stuck. */
  leave(): void {
    if (this.gesture) this.up(0, 0, { shift: false, alt: false, cmd: false });
  }

  private finishCreate(id: string): void {
    const d = this.drafts.get(id);
    this.drafts.delete(id);
    this.previews.delete(id);
    if (!d || (d.width < 2 && d.height < 2)) return;
    const element: Record<string, unknown> & { id: string; type: string } = { ...d };
    delete element.paints;
    if (d.type === "arrow" && "points" in d) {
      const els = this.elements().filter((e) => e.id !== id && e.type !== "arrow" && e.type !== "line");
      const end = d.points[d.points.length - 1] ?? [0, 0];
      const start = hitTest(els, d.x, d.y, 2);
      const stop = hitTest(els, d.x + end[0], d.y + end[1], 2);
      if (start) element.start = { id: start.id };
      if (stop) element.end = { id: stop.id };
    }
    this.outbox.push([{ op: "create", element }]);
    this.settle(d, ["x", "y"]);
    this.selected.clear();
    this.selected.add(id);
    if (this.tool !== "freedraw") this.tool = "selection";
  }

  private erase(els: readonly CanvasElement[], x: number, y: number, tol: number): void {
    const hit = hitTest(els, x, y, tol);
    if (hit) this.erasing.add(hit.id);
  }

  // --- text -----------------------------------------------------------------------------------------------

  private openText(els: readonly CanvasElement[], x: number, y: number, tol: number): void {
    const hit = hitTest(els, x, y, tol);
    const s = this.style;
    if (hit?.type === "text") {
      this.editing = {
        id: hit.id,
        isNew: false,
        containerId: null,
        x: hit.x,
        y: hit.y,
        width: hit.width,
        text: hit.text,
        fontSize: hit.fontSize,
        color: hit.strokeColor,
        align: "left",
      };
    } else if (hit && hit.type !== "freedraw") {
      const label = boundTexts(els, new Set([hit.id]))[0];
      const b = elementBounds(hit);
      const fontSize = label?.fontSize ?? 20;
      this.editing = {
        id: label?.id ?? `${hit.id}-label`,
        isNew: false,
        containerId: hit.id,
        x: b.minX,
        y: (b.minY + b.maxY) / 2 - (fontSize * 1.25) / 2,
        width: Math.max(40, b.maxX - b.minX),
        text: label?.text ?? "",
        fontSize,
        color: label?.strokeColor ?? s.strokeColor,
        align: "center",
      };
    } else {
      this.editing = {
        id: newId(),
        isNew: true,
        containerId: null,
        x,
        y: y - (s.fontSize * 1.25) / 2,
        width: 0,
        text: "",
        fontSize: s.fontSize,
        color: s.strokeColor,
        align: "left",
      };
    }
    this.selected.clear();
  }

  /** Closes the text editor, writing `text` back (empty text deletes a text element). */
  commitText(text: string): void {
    const t = this.editing;
    this.editing = null;
    this.tool = "selection";
    if (!t) return;
    const trimmed = text.replace(/\s+$/, "");
    if (t.containerId) {
      if (trimmed !== t.text) this.outbox.push([{ op: "label", containerId: t.containerId, text: trimmed }]);
      return;
    }
    if (t.isNew) {
      if (!trimmed) return;
      const el = newElement("text", t.x, t.y, this.style, t.id) as TextElement;
      const size = measureText(trimmed, t.fontSize);
      const element = { ...el, text: trimmed, originalText: trimmed, fontSize: t.fontSize, ...size };
      this.outbox.push([{ op: "create", element }]);
      this.settle(element, ["x", "y"]);
      this.selected.add(t.id);
      return;
    }
    if (!trimmed) {
      this.remove([t.id]);
      return;
    }
    if (trimmed === t.text) return;
    const old = this.elements().find((e) => e.id === t.id);
    const size = measureText(trimmed, t.fontSize);
    this.outbox.push([{ op: "update", id: t.id, fields: { text: trimmed, originalText: trimmed, ...size } }]);
    if (old) this.settle({ ...old, text: trimmed, ...size } as CanvasElement, ["text"]);
  }

  cancelText(): void {
    this.editing = null;
  }

  // --- commands -------------------------------------------------------------------------------------------

  remove(ids: readonly string[]): void {
    const els = this.elements();
    const set = new Set(ids);
    const all = [...set, ...boundTexts(els, set).map((t) => t.id)];
    const gone = new Set(all);
    for (const e of els) if (gone.has(e.id)) this.settle({ ...e, isDeleted: true }, []);
    for (const id of all) this.selected.delete(id);
    this.outbox.push([{ op: "remove", ids: all }]);
  }

  /** Applies style changes to the selection (one undo step) and to new elements. */
  setStyle(patch: Partial<Style>): void {
    this.style = { ...this.style, ...patch };
    const els = this.elements().filter((e) => this.selected.has(e.id));
    const ops: Op[] = [];
    for (const e of els) {
      const fields = styleFields(e, patch);
      if (!Object.keys(fields).length) continue;
      ops.push({ op: "update", id: e.id, fields });
      this.settle({ ...e, ...fields } as CanvasElement, Object.keys(fields));
    }
    if (ops.length) this.outbox.push(ops);
  }

  /** The style shown in the panel: the first selected element's, else the tool's. */
  shownStyle(): Style {
    const e = this.elements().find((x) => this.selected.has(x.id));
    if (!e) return this.style;
    return {
      strokeColor: e.strokeColor,
      backgroundColor: e.backgroundColor,
      fillStyle: e.fillStyle,
      strokeWidth: e.strokeWidth,
      strokeStyle: e.strokeStyle,
      roughness: e.roughness,
      opacity: e.opacity,
      roundEdges: e.roundness !== null,
      fontSize: e.type === "text" ? e.fontSize : this.style.fontSize,
    };
  }

  /** Copies the selection 10 units down-right; labels come along through the skeleton `label` field. */
  duplicate(): void {
    const els = this.elements();
    const sel = els.filter((e) => this.selected.has(e.id) && !(e.type === "text" && e.containerId));
    if (!sel.length) return;
    const ops: Op[] = [];
    this.selected.clear();
    for (const e of sel) {
      const id = newId();
      const element: Record<string, unknown> & { id: string; type: string } = { ...e, id, x: e.x + 10, y: e.y + 10 };
      delete element.paints;
      element.boundElements = null;
      element.index = null;
      const label = boundTexts(els, new Set([e.id]))[0];
      if (label) element.label = { text: label.text };
      ops.push({ op: "create", element });
      this.settle({ ...e, id, x: e.x + 10, y: e.y + 10 } as CanvasElement, ["x", "y"]);
      this.selected.add(id);
    }
    this.outbox.push(ops);
  }

  nudge(dx: number, dy: number): void {
    const els = this.elements().filter((e) => this.selected.has(e.id));
    if (!els.length) return;
    this.outbox.push(els.map((e): Op => ({ op: "update", id: e.id, fields: { x: e.x + dx, y: e.y + dy } })));
    for (const e of els) this.settle({ ...e, x: e.x + dx, y: e.y + dy }, ["x", "y"]);
  }

  selectAll(): void {
    for (const e of this.elements()) if (!(e.type === "text" && e.containerId)) this.selected.add(e.id);
  }

  setTool(t: Tool): void {
    this.tool = t;
    if (t !== "selection") this.selected.clear();
  }

  /** Editing shortcuts. True when the key was the editor's. */
  key(keystroke: string): boolean {
    if (this.editing) return false;
    const tool = TOOL_KEYS[keystroke];
    const command = COMMANDS[keystroke];
    if (tool) this.setTool(tool);
    else if (command) command(this);
    else return this.arrowKey(keystroke);
    return true;
  }

  private arrowKey(keystroke: string): boolean {
    const step = keystroke.startsWith("shift-") ? 10 : 1;
    const d = ARROWS[keystroke.replace(/^shift-/, "")];
    if (!d || !this.selected.size) return false;
    this.nudge(d[0] * step, d[1] * step);
    return true;
  }

  clearSelection(): void {
    this.selected.clear();
    this.tool = "selection";
  }

  private settle(el: CanvasElement, keys: readonly string[]): void {
    this.pending.set(el.id, { el, keys, until: this.now() + PENDING_MS });
  }
}

const scaleFieldsOf = (d: CanvasElement): ElementFields => {
  const f: Record<string, unknown> = { x: d.x, y: d.y, width: d.width, height: d.height };
  if ("points" in d) f.points = d.points;
  if (d.type === "text") f.fontSize = d.fontSize;
  return f;
};

const COMMANDS: Readonly<Record<string, (ed: Editor) => void>> = {
  backspace: (ed) => ed.remove([...ed.selected]),
  delete: (ed) => ed.remove([...ed.selected]),
  escape: (ed) => ed.clearSelection(),
  "cmd-a": (ed) => ed.selectAll(),
  "ctrl-d": (ed) => ed.duplicate(), // cmd-d is Herdr's split-pane
};

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

type ElementType = CanvasElement["type"];
const FILLABLE: ReadonlySet<ElementType> = new Set(["rectangle", "diamond", "ellipse"]);
const ROUNDABLE: ReadonlySet<ElementType> = new Set(["rectangle", "diamond", "arrow", "line"]);
const STROKED: ReadonlySet<ElementType> = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw"]);
const DASHABLE: ReadonlySet<ElementType> = new Set(["rectangle", "diamond", "ellipse", "arrow", "line"]);

/** Which element types each style key applies to (absent: all). */
const APPLIES: Partial<Record<keyof Style, ReadonlySet<ElementType>>> = {
  backgroundColor: FILLABLE,
  fillStyle: FILLABLE,
  strokeWidth: STROKED,
  strokeStyle: DASHABLE,
  roughness: STROKED,
};

/** Panel style -> the element fields it changes for `e`. */
export function styleFields(e: CanvasElement, p: Partial<Style>): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  for (const k of [
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeWidth",
    "strokeStyle",
    "roughness",
    "opacity",
  ] as const) {
    const allowed = APPLIES[k];
    if (p[k] !== undefined && (!allowed || allowed.has(e.type))) f[k] = p[k];
  }
  if (p.roundEdges !== undefined && ROUNDABLE.has(e.type))
    f.roundness = p.roundEdges ? { type: e.type === "rectangle" ? 3 : 2 } : null;
  if (e.type === "text" && p.fontSize !== undefined)
    Object.assign(f, { fontSize: p.fontSize }, measureText(e.text, p.fontSize, e.lineHeight));
  return f;
}
