// Paints (from the sidecar, element-local) -> native GPUI paths. A built Path is immutable and positioned by
// its element, so panning reuses it; only a zoom change or an element change rebuilds it.
// Hot path, written in scalar form on purpose: the mod runtime makes calls, tuple returns, destructuring and
// spread calls very slow (one rectangle took seconds), so no helpers returning [x, y] and no `...` here.
import { type Path, PathBuilder } from "gpui-kit";
import type { Paint } from "../canvas/shape.ts";
import type { CanvasElement } from "../canvas/types.ts";

export type Hex = `#${string}`;

/** GPUI takes hex colours only; Excalidraw stores hex, plus the occasional "transparent". */
export const hex = (c: string): Hex => (c.startsWith("#") ? (c as Hex) : c === "transparent" ? "#00000000" : "#1e1e1e");

export interface BuiltPaint {
  readonly path: Path;
  readonly color: Hex;
}

export interface BuiltElement {
  /** Offset of the painted area's top-left from the element origin, world units (the paths' local minimum). */
  readonly mx: number;
  readonly my: number;
  readonly paints: readonly BuiltPaint[];
  /** What it was built from and at: reuse it only while all four match. */
  readonly src: readonly Paint[];
  readonly scale: number;
  readonly sx: number;
  readonly sy: number;
}

/** Rotation about the element centre plus the shift and scale into device px. Plain fields, read inline. */
interface Xform {
  readonly cos: number;
  readonly sin: number;
  readonly cx: number;
  readonly cy: number;
  /** Device-space origin offset (element local units, before scaling). */
  ox: number;
  oy: number;
  readonly scale: number;
  /** Stretch applied to local coordinates before rotation (paths generated at another size). */
  readonly sx: number;
  readonly sy: number;
}
// A local point (x, y) maps to ((ox + (x-cx)*cos - (y-cy)*sin) * scale, (oy + (x-cx)*sin + (y-cy)*cos) * scale).

/** The smallest rotated local coordinates (at most 0), so painting can shift negative points into view. */
function localMin(paints: readonly Paint[], t: Xform): { mx: number; my: number } {
  let mx = 0;
  let my = 0;
  for (const p of paints)
    for (const op of p.ops) {
      const d = op.data;
      for (let i = 0; i + 1 < d.length; i += 2) {
        const x = (d[i] ?? 0) * t.sx - t.cx;
        const y = (d[i + 1] ?? 0) * t.sy - t.cy;
        const rx = t.cx + x * t.cos - y * t.sin;
        const ry = t.cy + x * t.sin + y * t.cos;
        if (rx < mx) mx = rx;
        if (ry < my) my = ry;
      }
    }
  return { mx, my };
}

function trace(b: PathBuilder, p: Paint, t: Xform): void {
  const { cos, sin, cx, cy, ox, oy, scale, sx, sy } = t;
  for (const op of p.ops) {
    const d = op.data;
    if (op.op === "bcurveTo") {
      const x0 = (d[0] ?? 0) * sx - cx;
      const y0 = (d[1] ?? 0) * sy - cy;
      const x1 = (d[2] ?? 0) * sx - cx;
      const y1 = (d[3] ?? 0) * sy - cy;
      const x2 = (d[4] ?? 0) * sx - cx;
      const y2 = (d[5] ?? 0) * sy - cy;
      b.cubic_bezier_to(
        (ox + x2 * cos - y2 * sin) * scale,
        (oy + x2 * sin + y2 * cos) * scale,
        (ox + x0 * cos - y0 * sin) * scale,
        (oy + x0 * sin + y0 * cos) * scale,
        (ox + x1 * cos - y1 * sin) * scale,
        (oy + x1 * sin + y1 * cos) * scale,
      );
      continue;
    }
    const x = (d[0] ?? 0) * sx - cx;
    const y = (d[1] ?? 0) * sy - cy;
    const px = (ox + x * cos - y * sin) * scale;
    const py = (oy + x * sin + y * cos) * scale;
    if (op.op !== "move") b.line_to(px, py);
    else if (op === p.ops[0]) b.move_to(px, py);
    // GPUI fills even-odd: rough's second, near-identical fill loop would cancel the first (Excalidraw's
    // canvas fills nonzero, so the union is ~the first loop). Strokes keep both loops.
    else if (p.kind === "fill") return;
    else b.move_to(px, py);
  }
}

/**
 * Builds an element's paths at `scale` device px per world unit (camera zoom x app zoom). Points are rotated
 * about the element centre as Excalidraw does, then shifted so none is negative (an arrow pointing left has
 * negative points); the shift is reported in world units for positioning.
 */
export function buildElement(e: CanvasElement, paints: readonly Paint[], scale: number, sx = 1, sy = 1): BuiltElement {
  const angle = e.angle || 0;
  const t: Xform = {
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    cx: e.width / 2,
    cy: e.height / 2,
    ox: 0,
    oy: 0,
    scale,
    sx,
    sy,
  };
  const { mx, my } = localMin(paints, t);
  t.ox = t.cx - mx;
  t.oy = t.cy - my;
  const built: BuiltPaint[] = [];
  for (const p of paints) {
    if (p.ops.length < 2) continue;
    const b = p.kind === "fill" ? PathBuilder.fill() : PathBuilder.stroke(Math.max(0.5, p.width * scale));
    if (p.kind === "stroke" && p.dash) b.dash_array(p.dash.map((v) => v * scale));
    trace(b, p, t);
    built.push({ path: b.build(), color: hex(p.color) });
  }
  return { mx, my, paints: built, src: paints, scale, sx, sy };
}
