// Editing geometry, element factories and the style palette. Pure (no GPUI, no IO), so it is unit-tested in
// Bun and shared by the mod. Coordinates are world units unless a name says otherwise.
import type { Bounds } from "./camera.ts";
import type { Paint } from "./shape.ts";
import type { CanvasElement, FillStyle, LinearElement, Point, StrokeStyle, TextElement } from "./types.ts";

export type Tool =
  | "hand"
  | "selection"
  | "rectangle"
  | "diamond"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "eraser";

export type ShapeTool = "rectangle" | "diamond" | "ellipse" | "arrow" | "line" | "freedraw" | "text";
export const isShapeTool = (t: Tool): t is ShapeTool => t !== "hand" && t !== "selection" && t !== "eraser";

/** The properties the panel edits; new elements take the current style, as in Excalidraw. */
export interface Style {
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: FillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle;
  readonly roughness: number;
  readonly opacity: number;
  readonly roundEdges: boolean;
  readonly fontSize: number;
}

export const DEFAULT_STYLE: Style = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundEdges: true,
  fontSize: 20,
};

/** Excalidraw's palette (open-color): five shades per hue, lightest first. */
export const PALETTE: readonly (readonly [name: string, shades: readonly string[]])[] = [
  ["gray", ["#f8f9fa", "#e9ecef", "#ced4da", "#868e96", "#343a40"]],
  ["red", ["#fff5f5", "#ffc9c9", "#ff8787", "#fa5252", "#e03131"]],
  ["pink", ["#fff0f6", "#fcc2d7", "#f783ac", "#e64980", "#c2255c"]],
  ["grape", ["#f8f0fc", "#eebefa", "#da77f2", "#be4bdb", "#9c36b5"]],
  ["violet", ["#f3f0ff", "#d0bfff", "#9775fa", "#7950f2", "#6741d9"]],
  ["blue", ["#e7f5ff", "#a5d8ff", "#4dabf7", "#228be6", "#1971c2"]],
  ["cyan", ["#e3fafc", "#99e9f2", "#3bc9db", "#15aabf", "#0c8599"]],
  ["teal", ["#e6fcf5", "#96f2d7", "#38d9a9", "#12b886", "#099268"]],
  ["green", ["#ebfbee", "#b2f2bb", "#69db7c", "#40c057", "#2f9e44"]],
  ["yellow", ["#fff9db", "#ffec99", "#ffd43b", "#fab005", "#f08c00"]],
  ["orange", ["#fff4e6", "#ffd8a8", "#ffa94d", "#fd7e14", "#e8590c"]],
  ["bronze", ["#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358"]],
];
export const QUICK_STROKES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"] as const;
export const QUICK_BACKGROUNDS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"] as const;
export const FONT_SIZES = [16, 20, 28, 36] as const;

const rid = (): string => Math.random().toString(36).slice(2, 12);
const rseed = (): number => Math.floor(Math.random() * 2 ** 31);
export const newId = rid;

/** A full element of `type` at (x, y) with the current style, sized 0 (creation drags it out). */
export function newElement(type: ShapeTool, x: number, y: number, s: Style, id = rid(), seed = rseed()): CanvasElement {
  const base = {
    id,
    x,
    y,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: s.strokeColor,
    backgroundColor: type === "line" || type === "arrow" || type === "freedraw" ? "transparent" : s.backgroundColor,
    fillStyle: s.fillStyle,
    strokeWidth: s.strokeWidth,
    strokeStyle: type === "freedraw" ? ("solid" as const) : s.strokeStyle,
    roughness: s.roughness,
    opacity: s.opacity,
    seed,
    version: 1,
    versionNonce: rseed(),
    index: null,
    isDeleted: false,
    groupIds: [],
    boundElements: null,
    locked: false,
  };
  switch (type) {
    case "rectangle":
      return { ...base, type, roundness: s.roundEdges ? { type: 3 } : null };
    case "diamond":
      return { ...base, type, roundness: s.roundEdges ? { type: 2 } : null };
    case "ellipse":
      return { ...base, type, roundness: null };
    case "arrow":
    case "line":
      return {
        ...base,
        type,
        roundness: s.roundEdges ? { type: 2 } : null,
        points: [[0, 0]],
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: type === "arrow" ? "arrow" : null,
      };
    case "freedraw":
      return { ...base, type, roundness: null, points: [[0, 0]], pressures: [], simulatePressure: true };
    case "text":
      return {
        ...base,
        type,
        roundness: null,
        text: "",
        originalText: "",
        fontSize: s.fontSize,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        lineHeight: 1.25,
      };
  }
}

/** Rough text box size: GPUI measures the real thing, the sidecar's SDK re-measures on conversion. */
export function measureText(text: string, fontSize: number, lineHeight = 1.25): { width: number; height: number } {
  const lines = text.split("\n");
  const widest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  return { width: widest * fontSize * 0.55, height: lines.length * fontSize * lineHeight };
}

const hasPoints = (e: CanvasElement): e is CanvasElement & { readonly points: readonly Point[] } =>
  e.type === "arrow" || e.type === "line" || e.type === "freedraw";

/** Axis-aligned world bounds (rotation ignored). */
export function elementBounds(e: CanvasElement): Bounds {
  if (hasPoints(e) && e.points.length) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [px, py] of e.points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    return { minX: e.x + minX, minY: e.y + minY, maxX: e.x + maxX, maxY: e.y + maxY };
  }
  return { minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height };
}

export function unionBounds(bs: readonly Bounds[]): Bounds | null {
  if (!bs.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of bs) {
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether world point (x, y) touches `e`, within `tol` world units. */
export function hits(e: CanvasElement, x: number, y: number, tol: number): boolean {
  if (hasPoints(e)) {
    const pts = e.points;
    if (pts.length === 1) return Math.hypot(x - e.x, y - e.y) <= tol;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] ?? [0, 0];
      const b = pts[i] ?? [0, 0];
      if (segmentDistance(x, y, e.x + a[0], e.y + a[1], e.x + b[0], e.y + b[1]) <= tol + e.strokeWidth) return true;
    }
    return false;
  }
  const b = elementBounds(e);
  return x >= b.minX - tol && x <= b.maxX + tol && y >= b.minY - tol && y <= b.maxY + tol;
}

/** The topmost element under (x, y); a container's bound text selects the container. */
export function hitTest(order: readonly CanvasElement[], x: number, y: number, tol: number): CanvasElement | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const e = order[i];
    if (!e || !hits(e, x, y, tol)) continue;
    if (e.type === "text" && e.containerId) return order.find((c) => c.id === e.containerId) ?? e;
    return e;
  }
  return null;
}

/** Elements fully inside `box` (bound texts are skipped: they follow their container). */
export function inBox(order: readonly CanvasElement[], box: Bounds): CanvasElement[] {
  return order.filter((e) => {
    if (e.type === "text" && e.containerId) return false;
    const b = elementBounds(e);
    return b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY;
  });
}

export const boxFrom = (ax: number, ay: number, bx: number, by: number): Bounds => ({
  minX: Math.min(ax, bx),
  minY: Math.min(ay, by),
  maxX: Math.max(ax, bx),
  maxY: Math.max(ay, by),
});

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Where handle `h` of `b` sits. */
export function handlePoint(b: Bounds, h: Handle): Point {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const x = h.includes("w") ? b.minX : h.includes("e") ? b.maxX : cx;
  const y = h.startsWith("n") ? b.minY : h.startsWith("s") ? b.maxY : cy;
  return [x, y];
}

export function handleAt(b: Bounds, x: number, y: number, tol: number): Handle | null {
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(b, h);
    if (Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol) return h;
  }
  return null;
}

/** `b` with handle `h` dragged to (x, y); shift keeps the aspect ratio. Normalised, so dragging past flips. */
export function resizeBounds(b: Bounds, h: Handle, x: number, y: number, keepAspect = false): Bounds {
  let { minX, minY, maxX, maxY } = b;
  if (h.includes("w")) minX = x;
  if (h.includes("e")) maxX = x;
  if (h.startsWith("n")) minY = y;
  if (h.startsWith("s")) maxY = y;
  if (keepAspect && h.length === 2) {
    const w0 = b.maxX - b.minX || 1;
    const h0 = b.maxY - b.minY || 1;
    const s = Math.max(Math.abs(maxX - minX) / w0, Math.abs(maxY - minY) / h0);
    if (h.includes("w")) minX = maxX - w0 * s;
    else maxX = minX + w0 * s;
    if (h.startsWith("n")) minY = maxY - h0 * s;
    else maxY = minY + h0 * s;
  }
  return boxFrom(minX, minY, maxX, maxY);
}

/** The fields that map `e` from group bounds `from` to `to` (every selected element scales with the group). */
export function scaleFields(e: CanvasElement, from: Bounds, to: Bounds): Record<string, unknown> {
  const sx = (to.maxX - to.minX) / (from.maxX - from.minX || 1);
  const sy = (to.maxY - to.minY) / (from.maxY - from.minY || 1);
  const x = to.minX + (e.x - from.minX) * sx;
  const y = to.minY + (e.y - from.minY) * sy;
  if (hasPoints(e)) {
    const points = e.points.map(([px, py]): Point => [px * sx, py * sy]);
    return { x, y, points, width: e.width * sx, height: e.height * sy };
  }
  if (e.type === "text") {
    const fontSize = Math.max(4, e.fontSize * Math.min(sx, sy));
    return { x, y, fontSize, width: e.width * sx, height: e.height * sy };
  }
  return { x, y, width: e.width * sx, height: e.height * sy };
}

/** Width and height from points, as Excalidraw stores them for linear elements. */
export function pointsSize(points: readonly Point[]): { width: number; height: number } {
  const b = unionBounds(points.map(([x, y]) => ({ minX: x, minY: y, maxX: x, maxY: y })));
  return b ? { width: b.maxX - b.minX, height: b.maxY - b.minY } : { width: 0, height: 0 };
}

/** The element as drag-created from (x0, y0) to (x1, y1); shift squares shapes and snaps lines to 15 degrees. */
export function dragOut(
  e: CanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  shift: boolean,
): CanvasElement {
  if (e.type === "arrow" || e.type === "line") {
    let dx = x1 - x0;
    let dy = y1 - y0;
    if (shift) {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      const len = Math.hypot(dx, dy);
      dx = Math.cos(a) * len;
      dy = Math.sin(a) * len;
    }
    const points: Point[] = [
      [0, 0],
      [dx, dy],
    ];
    return { ...e, x: x0, y: y0, points, ...pointsSize(points) } as LinearElement;
  }
  if (e.type === "freedraw") {
    const points: Point[] = [...e.points, [x1 - e.x, y1 - e.y]];
    return { ...e, points, ...pointsSize(points) };
  }
  let w = x1 - x0;
  let h = y1 - y0;
  if (shift) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  return { ...e, x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), width: Math.abs(w), height: Math.abs(h) };
}

/** Plain (not hand-drawn) paths for immediate feedback before the sidecar's rough paths arrive. */
export function simplePaints(e: CanvasElement): Paint[] {
  const stroke = (ops: Paint["ops"]): Paint => ({
    kind: "stroke",
    color: e.strokeColor,
    width: e.strokeWidth,
    dash: null,
    ops,
  });
  const fill = (ops: Paint["ops"]): Paint[] =>
    e.backgroundColor === "transparent" ? [] : [{ kind: "fill", color: e.backgroundColor, width: 0, dash: null, ops }];
  const poly = (pts: readonly Point[], close: boolean): Paint["ops"] => {
    const ops: { op: "move" | "lineTo"; data: number[] }[] = pts.map(([x, y], i) => ({
      op: i ? "lineTo" : "move",
      data: [x, y],
    }));
    const first = pts[0];
    if (close && first) ops.push({ op: "lineTo", data: [first[0], first[1]] });
    return ops;
  };
  const { width: w, height: h } = e;
  if (e.type === "rectangle") {
    const ops = poly(
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      true,
    );
    return [...fill(ops), stroke(ops)];
  }
  if (e.type === "diamond") {
    const ops = poly(
      [
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ],
      true,
    );
    return [...fill(ops), stroke(ops)];
  }
  if (e.type === "ellipse") {
    const k = 0.5523;
    const [rx, ry, cx, cy] = [w / 2, h / 2, w / 2, h / 2];
    const ops: Paint["ops"] = [
      { op: "move", data: [cx + rx, cy] },
      { op: "bcurveTo", data: [cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry] },
      { op: "bcurveTo", data: [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy] },
      { op: "bcurveTo", data: [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry] },
      { op: "bcurveTo", data: [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy] },
    ];
    return [...fill(ops), stroke(ops)];
  }
  if (hasPoints(e)) return e.points.length > 1 ? [stroke(poly(e.points, false))] : [];
  return [];
}

/** Text elements bound to `ids` (they move and die with their containers). */
export function boundTexts(order: readonly CanvasElement[], ids: ReadonlySet<string>): TextElement[] {
  return order.filter((e): e is TextElement => e.type === "text" && e.containerId !== null && ids.has(e.containerId));
}
