// Element -> hand-drawn paths, ported from @excalidraw/excalidraw 0.18.1 (scene/Shape.ts:
// generateRoughOptions, _generateElementShape, getArrowheadPoints/Shapes, getFreeDrawSvgPath). Same roughjs,
// same per-element seed, so strokes match what excalidraw.com draws. Output is renderer-neutral: stroke and
// fill paths in element-local coordinates (origin at element.x/y, unrotated).

import { getStroke } from "perfect-freehand";
import type { Drawable, Op, OpSet, Options, ResolvedOptions } from "roughjs/bin/core";
import { RoughGenerator } from "roughjs/bin/generator.js";
import type { Arrowhead, CanvasElement, FreedrawElement, LinearElement, Point } from "./types.ts";

export type PathOp = Op;

export interface Paint {
  readonly kind: "stroke" | "fill";
  readonly color: string;
  readonly width: number;
  readonly dash: readonly number[] | null;
  readonly ops: readonly PathOp[];
}

const ROUGHNESS_CARTOONIST = 2;
const DEFAULT_PROPORTIONAL_RADIUS = 0.25;
const DEFAULT_ADAPTIVE_RADIUS = 32;
const LINE_CONFIRM_THRESHOLD = 8;

const generator = new RoughGenerator();

/** Excalidraw's check: "transparent", #rgb0 or #rrggbb00. */
export const isTransparent = (color: string): boolean =>
  color === "transparent" || (color.length === 5 && color[4] === "0") || (color.length === 9 && color.endsWith("00"));

/** Applies element opacity (0-100) to a #rgb/#rrggbb colour; other colour forms pass through. */
export function withOpacity(color: string, opacity: number): string {
  if (opacity >= 100 || !color.startsWith("#")) return color;
  const hex = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join("") : color.slice(1, 7);
  const alpha = Math.round((Math.max(0, opacity) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${hex}${alpha}`;
}

const dashed = (w: number): number[] => [8, 8 + w];
const dotted = (w: number): number[] => [1.5, 6 + w];

const isPathALoop = (points: readonly Point[]): boolean => {
  if (points.length < 3) return false;
  const [a, b] = [points[0], points[points.length - 1]];
  return !!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1]) <= LINE_CONFIRM_THRESHOLD;
};

function adjustRoughness(e: CanvasElement): number {
  const max = Math.max(e.width, e.height);
  const min = Math.min(e.width, e.height);
  const linear = e.type === "arrow" || e.type === "line";
  const roundable = e.type === "rectangle" || e.type === "diamond" || linear;
  if ((min >= 20 && max >= 50) || (min >= 15 && !!e.roundness && roundable) || (linear && max >= 50))
    return e.roughness;
  return Math.min(e.roughness / (max < 10 ? 3 : 2), 2.5);
}

function roughOptions(e: CanvasElement, continuousPath = false): Options {
  const solid = e.strokeStyle === "solid";
  const o: Options = {
    seed: e.seed,
    disableMultiStroke: !solid,
    strokeWidth: solid ? e.strokeWidth : e.strokeWidth + 0.5,
    fillWeight: e.strokeWidth / 2,
    hachureGap: e.strokeWidth * 4,
    roughness: adjustRoughness(e),
    stroke: e.strokeColor,
    preserveVertices: continuousPath || e.roughness < ROUGHNESS_CARTOONIST,
  };
  if (e.strokeStyle === "dashed") o.strokeLineDash = dashed(e.strokeWidth);
  if (e.strokeStyle === "dotted") o.strokeLineDash = dotted(e.strokeWidth);
  const fillable =
    e.type === "rectangle" ||
    e.type === "diamond" ||
    e.type === "ellipse" ||
    ((e.type === "line" || e.type === "freedraw") && isPathALoop(e.points));
  if (fillable) {
    o.fillStyle = e.fillStyle;
    if (!isTransparent(e.backgroundColor)) o.fill = e.backgroundColor;
    if (e.type === "ellipse") o.curveFitting = 1;
  }
  return o;
}

function cornerRadius(x: number, e: CanvasElement): number {
  const t = e.roundness?.type;
  if (t === 1 || t === 2) return x * DEFAULT_PROPORTIONAL_RADIUS;
  if (t === 3) {
    const fixed = e.roundness?.value ?? DEFAULT_ADAPTIVE_RADIUS;
    return x <= fixed / DEFAULT_PROPORTIONAL_RADIUS ? x * DEFAULT_PROPORTIONAL_RADIUS : fixed;
  }
  return 0;
}

export function diamondPoints(e: {
  width: number;
  height: number;
}): [number, number, number, number, number, number, number, number] {
  const topX = Math.floor(e.width / 2) + 1;
  const rightY = Math.floor(e.height / 2) + 1;
  return [topX, 0, e.width, rightY, topX, e.height, 0, rightY];
}

const rotate = ([x, y]: Point, [cx, cy]: Point, rad: number): Point => [
  (x - cx) * Math.cos(rad) - (y - cy) * Math.sin(rad) + cx,
  (x - cx) * Math.sin(rad) + (y - cy) * Math.cos(rad) + cy,
];

const arrowheadSize = (a: Arrowhead): number => (a === "arrow" ? 25 : 15);
const arrowheadAngle = (a: Arrowhead): number => (a === "bar" ? 90 : a === "arrow" ? 20 : 25);

/** The ops of a drawable's main stroke (the first "path" set). */
const curveOps = (d: Drawable): readonly Op[] => d.sets.find((s) => s.type === "path")?.ops ?? [];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: kept shaped like Excalidraw's getArrowheadPoints so upstream changes diff cleanly
function arrowheadPoints(
  e: LinearElement,
  shaft: Drawable,
  position: "start" | "end",
  head: Arrowhead,
): number[] | null {
  const ops = curveOps(shaft);
  if (ops.length < 2) return null;
  const index = position === "start" ? 1 : ops.length - 1;
  const data = ops[index]?.data;
  if (data?.length !== 6) return null;
  const p3: Point = [data[4] ?? 0, data[5] ?? 0];
  const p2: Point = [data[2] ?? 0, data[3] ?? 0];
  const p1: Point = [data[0] ?? 0, data[1] ?? 0];
  const prev = ops[index - 1];
  const p0: Point =
    prev?.op === "move"
      ? [prev.data[0] ?? 0, prev.data[1] ?? 0]
      : prev?.op === "bcurveTo"
        ? [prev.data[4] ?? 0, prev.data[5] ?? 0]
        : [0, 0];
  const at = (t: number, i: 0 | 1) =>
    (1 - t) ** 3 * p3[i] + 3 * t * (1 - t) ** 2 * p2[i] + 3 * t ** 2 * (1 - t) * p1[i] + p0[i] * t ** 3;
  const [x2, y2] = position === "start" ? p0 : p3;
  const [x1, y1] = [at(0.3, 0), at(0.3, 1)];
  const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
  const [nx, ny] = [(x2 - x1) / dist, (y2 - y1) / dist];
  const pts = e.points;
  const tip = position === "end" ? pts[pts.length - 1] : pts[0];
  const next = pts.length > 1 ? (position === "end" ? pts[pts.length - 2] : pts[1]) : ([0, 0] as Point);
  const length = tip && next ? Math.hypot(tip[0] - next[0], tip[1] - next[1]) : 0;
  const size = Math.min(arrowheadSize(head), length * 0.5);
  const [xs, ys] = [x2 - nx * size, y2 - ny * size];
  if (head === "dot" || head === "circle" || head === "circle_outline") {
    return [x2, y2, Math.hypot(ys - y2, xs - x2) + e.strokeWidth - 2];
  }
  const angle = (arrowheadAngle(head) * Math.PI) / 180;
  const [x3, y3] = rotate([xs, ys], [x2, y2], -angle);
  const [x4, y4] = rotate([xs, ys], [x2, y2], angle);
  return [x2, y2, x3, y3, x4, y4];
}

function arrowheadShapes(
  e: LinearElement,
  shaft: Drawable,
  position: "start" | "end",
  head: Arrowhead,
  base: Options,
  background: string,
): Drawable[] {
  const p = arrowheadPoints(e, shaft, position, head);
  if (!p) return [];
  const o: Options = { ...base, roughness: Math.min(1, base.roughness ?? 0) };
  delete o.strokeLineDash;
  if (head === "dot" || head === "circle" || head === "circle_outline") {
    const [x, y, d] = p as [number, number, number];
    return [
      generator.circle(x, y, d, {
        ...o,
        fill: head === "circle_outline" ? background : e.strokeColor,
        fillStyle: "solid",
        stroke: e.strokeColor,
      }),
    ];
  }
  const [x, y, x3, y3, x4, y4] = p as [number, number, number, number, number, number];
  if (head === "triangle" || head === "triangle_outline") {
    return [
      generator.polygon(
        [
          [x, y],
          [x3, y3],
          [x4, y4],
          [x, y],
        ],
        { ...o, fill: head === "triangle_outline" ? background : e.strokeColor, fillStyle: "solid" },
      ),
    ];
  }
  if (e.strokeStyle === "dotted") {
    const d = dotted(e.strokeWidth - 1);
    o.strokeLineDash = [d[0] ?? 0, (d[1] ?? 1) - 1];
  }
  return [generator.line(x3, y3, x, y, o), generator.line(x4, y4, x, y, o)];
}

function linearShapes(e: LinearElement, background: string): Drawable[] {
  const o = roughOptions(e);
  const points = (e.points.length ? e.points : [[0, 0] as Point]).map((p) => [p[0], p[1]] as [number, number]);
  // shortcut: elbow arrows drawn as straight segments (Excalidraw rounds their corners), upgrade if they look off
  const shaft = e.elbowed
    ? generator.linearPath(points, roughOptions(e, true))
    : !e.roundness
      ? o.fill
        ? generator.polygon(points, o)
        : generator.linearPath(points, o)
      : generator.curve(points, o);
  const shapes = [shaft];
  if (e.type === "arrow") {
    if (e.startArrowhead) shapes.push(...arrowheadShapes(e, shaft, "start", e.startArrowhead, o, background));
    if (e.endArrowhead) shapes.push(...arrowheadShapes(e, shaft, "end", e.endArrowhead, o, background));
  }
  return shapes;
}

/** perfect-freehand outline with Excalidraw's settings, as one filled polygon. */
function freedrawOutline(e: FreedrawElement): PathOp[] {
  const input = e.simulatePressure
    ? e.points.map((p) => [p[0], p[1]])
    : e.points.length
      ? e.points.map((p, i) => [p[0], p[1], e.pressures[i] ?? 0.5])
      : [[0, 0, 0.5]];
  const outline = getStroke(input, {
    simulatePressure: e.simulatePressure,
    size: e.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last: true,
  });
  return outline.map(([x, y], i) => ({ op: i === 0 ? "move" : "lineTo", data: [x ?? 0, y ?? 0] }));
}

function drawables(e: CanvasElement, background: string): Drawable[] {
  switch (e.type) {
    case "rectangle": {
      if (!e.roundness) return [generator.rectangle(0, 0, e.width, e.height, roughOptions(e))];
      const [w, h] = [e.width, e.height];
      const r = cornerRadius(Math.min(w, h), e);
      return [
        generator.path(
          `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`,
          roughOptions(e, true),
        ),
      ];
    }
    case "diamond": {
      const [tx, ty, rx, ry, bx, by, lx, ly] = diamondPoints(e);
      if (!e.roundness) {
        return [
          generator.polygon(
            [
              [tx, ty],
              [rx, ry],
              [bx, by],
              [lx, ly],
            ],
            roughOptions(e),
          ),
        ];
      }
      const v = cornerRadius(Math.abs(tx - lx), e);
      const hr = cornerRadius(Math.abs(ry - ty), e);
      return [
        generator.path(
          `M ${tx + v} ${ty + hr} L ${rx - v} ${ry - hr} C ${rx} ${ry}, ${rx} ${ry}, ${rx - v} ${ry + hr} L ${bx + v} ${by - hr} C ${bx} ${by}, ${bx} ${by}, ${bx - v} ${by - hr} L ${lx + v} ${ly + hr} C ${lx} ${ly}, ${lx} ${ly}, ${lx + v} ${ly - hr} L ${tx - v} ${ty + hr} C ${tx} ${ty}, ${tx} ${ty}, ${tx + v} ${ty + hr}`,
          roughOptions(e, true),
        ),
      ];
    }
    case "ellipse":
      return [generator.ellipse(e.width / 2, e.height / 2, e.width, e.height, roughOptions(e))];
    case "arrow":
    case "line":
      return linearShapes(e, background);
    case "freedraw":
      // Excalidraw fills a closed freedraw with a rough curve under the stroke outline.
      return isPathALoop(e.points)
        ? [
            generator.curve(
              e.points.map((p) => [p[0], p[1]] as [number, number]),
              { ...roughOptions(e), stroke: "none" },
            ),
          ]
        : [];
    case "text":
      return [];
  }
}

/** One roughjs op set as a paint: "path" is the outline, "fillPath" a solid fill, "fillSketch" hachure strokes. */
function setPaint(set: OpSet, o: ResolvedOptions, opacity: number): Paint | null {
  if (set.type === "path") {
    if (o.stroke === "none") return null;
    return {
      kind: "stroke",
      color: withOpacity(o.stroke, opacity),
      width: o.strokeWidth,
      dash: o.strokeLineDash ?? null,
      ops: set.ops,
    };
  }
  if (!o.fill) return null;
  if (set.type === "fillPath")
    return { kind: "fill", color: withOpacity(o.fill, opacity), width: 0, dash: null, ops: set.ops };
  const width = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight;
  return { kind: "stroke", color: withOpacity(o.fill, opacity), width, dash: o.fillLineDash ?? null, ops: set.ops };
}

/** Renderer-neutral paints for an element: what to stroke and fill, in element-local coordinates. */
export function elementPaints(e: CanvasElement, background = "#ffffff"): Paint[] {
  const paints = drawables(e, background).flatMap((d) =>
    d.sets.map((set) => setPaint(set, d.options, e.opacity)).filter((p): p is Paint => p !== null),
  );
  if (e.type === "freedraw") {
    paints.push({
      kind: "fill",
      color: withOpacity(e.strokeColor, e.opacity),
      width: 0,
      dash: null,
      ops: freedrawOutline(e),
    });
  }
  return paints;
}
