// World <-> screen: screen = world * zoom + offset. Pure, so it is unit-tested and shared.
import type { Point } from "./types.ts";

export interface Camera {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export const toScreen = (c: Camera, [x, y]: Point): Point => [x * c.zoom + c.offsetX, y * c.zoom + c.offsetY];
export const toWorld = (c: Camera, [x, y]: Point): Point => [(x - c.offsetX) / c.zoom, (y - c.offsetY) / c.zoom];

export const pan = (c: Camera, dx: number, dy: number): Camera => ({
  ...c,
  offsetX: c.offsetX + dx,
  offsetY: c.offsetY + dy,
});

/** Zoom by `factor`, keeping the world point under screen point `at` where it is. */
export function zoomAt(c: Camera, factor: number, at: Point): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
  const [wx, wy] = toWorld(c, at);
  return { zoom, offsetX: at[0] - wx * zoom, offsetY: at[1] - wy * zoom };
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A camera showing `b` centred in a `w` x `h` viewport with `pad` px around it, never zoomed past 1. */
export function fit(b: Bounds, w: number, h: number, pad = 40): Camera {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh)));
  return { zoom, offsetX: (w - bw * zoom) / 2 - b.minX * zoom, offsetY: (h - bh * zoom) / 2 - b.minY * zoom };
}
