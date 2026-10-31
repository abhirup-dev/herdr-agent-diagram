// The subset of Excalidraw's element format the canvas draws and edits. Field names and meanings match
// @excalidraw/excalidraw 0.18 so scenes round-trip with excalidraw.com and the excalidraw skill.
// Out of scope by decision: images, embeds/iframes, frames, libraries, collaboration.
import type { Op } from "roughjs/bin/core";

export type PathOp = Op;

/** One stroke or fill of an element's hand-drawn look, in element-local coordinates (from the sidecar). */
export interface Paint {
  readonly kind: "stroke" | "fill";
  readonly color: string;
  readonly width: number;
  readonly dash: readonly number[] | null;
  readonly ops: readonly PathOp[];
}

export type Point = readonly [x: number, y: number];

export type StrokeStyle = "solid" | "dashed" | "dotted";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type Arrowhead = "arrow" | "bar" | "dot" | "circle" | "circle_outline" | "triangle" | "triangle_outline";

/** Excalidraw's roundness types: 1 legacy, 2 proportional radius, 3 adaptive radius. */
export interface Roundness {
  readonly type: 1 | 2 | 3;
  readonly value?: number;
}

export interface Binding {
  readonly elementId: string;
  readonly focus?: number;
  readonly gap?: number;
}

interface Base {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fillStyle: FillStyle;
  readonly strokeWidth: number;
  readonly strokeStyle: StrokeStyle;
  readonly roughness: number;
  readonly opacity: number;
  readonly roundness: Roundness | null;
  readonly seed: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly index: string | null;
  readonly isDeleted: boolean;
  readonly groupIds: readonly string[];
  readonly boundElements: readonly { readonly id: string; readonly type: "arrow" | "text" }[] | null;
  readonly locked: boolean;
  /** Hand-drawn paths, element-local and unscaled. Added by the sidecar so the mod never runs roughjs. */
  readonly paints?: readonly Paint[];
}

export interface ShapeElement extends Base {
  readonly type: "rectangle" | "ellipse" | "diamond";
}

export interface LinearElement extends Base {
  readonly type: "arrow" | "line";
  /** Relative to (x, y); the first point is usually [0, 0]. */
  readonly points: readonly Point[];
  readonly startBinding: Binding | null;
  readonly endBinding: Binding | null;
  readonly startArrowhead: Arrowhead | null;
  readonly endArrowhead: Arrowhead | null;
  readonly elbowed?: boolean;
}

export interface FreedrawElement extends Base {
  readonly type: "freedraw";
  readonly points: readonly Point[];
  readonly pressures: readonly number[];
  readonly simulatePressure: boolean;
}

export interface TextElement extends Base {
  readonly type: "text";
  readonly text: string;
  readonly originalText: string;
  readonly fontSize: number;
  /** 1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, 7 Lilita One, 8 Comic Shanns. */
  readonly fontFamily: number;
  readonly textAlign: "left" | "center" | "right";
  readonly verticalAlign: "top" | "middle" | "bottom";
  readonly containerId: string | null;
  readonly lineHeight: number;
}

export type CanvasElement = ShapeElement | LinearElement | FreedrawElement | TextElement;
export type ElementType = CanvasElement["type"];

const DRAWN_TYPES: ReadonlySet<string> = new Set<ElementType>([
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "freedraw",
  "text",
]);

/** Narrows an element from the wire (any Excalidraw type) to one this canvas draws. */
export function isCanvasElement(e: { readonly type: string; readonly isDeleted?: boolean }): e is CanvasElement {
  return DRAWN_TYPES.has(e.type) && e.isDeleted !== true;
}
