// Final label geometry shared by native paints and headless SVG/PNG export.
// The SDK converter centres container labels regardless of their requested alignment.
import { LinearElementEditor } from "@excalidraw/element";
import type { CanvasElement, TextElement } from "../canvas/types.ts";

export function alignContainerLabels(
  elements: CanvasElement[],
  source: readonly Record<string, unknown>[],
): CanvasElement[] {
  const raw = new Map(source.map((e) => [e.id, e]));
  const map = new Map(elements.map((e) => [e.id, e]));
  return elements.map((e) => {
    if (e.type !== "text" || !e.containerId) return e;
    const container = map.get(e.containerId);
    if (!container || !["rectangle", "diamond", "ellipse"].includes(container.type)) return e;
    const label = raw.get(container.id)?.label as Partial<TextElement> | undefined;
    const textAlign = label?.textAlign ?? e.textAlign;
    const verticalAlign = label?.verticalAlign ?? e.verticalAlign;
    const insetX =
      container.type === "diamond"
        ? container.width / 4
        : container.type === "ellipse"
          ? (container.width * (1 - Math.SQRT1_2)) / 2
          : 0;
    const insetY =
      container.type === "diamond"
        ? container.height / 4
        : container.type === "ellipse"
          ? (container.height * (1 - Math.SQRT1_2)) / 2
          : 0;
    const left = container.x + insetX + 5;
    const top = container.y + insetY + 5;
    const width = container.width - 2 * insetX - 10;
    const height = container.height - 2 * insetY - 10;
    return {
      ...e,
      textAlign,
      verticalAlign,
      x: textAlign === "left" ? left : textAlign === "right" ? left + width - e.width : left + (width - e.width) / 2,
      y:
        verticalAlign === "top"
          ? top
          : verticalAlign === "bottom"
            ? top + height - e.height
            : top + (height - e.height) / 2,
    };
  });
}

type Linear = Extract<CanvasElement, { type: "arrow" | "line" }>;

/** The segment at the path midpoint, matching the SDK's choice for a polyline label. */
function labelSegment(arrow: Linear) {
  const i = Math.max(0, Math.floor((arrow.points.length - 1) / 2));
  const a = arrow.points[i] ?? [0, 0];
  const b = arrow.points[i + 1] ?? a;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return { dx, dy, length, x: arrow.x + (a[0] + b[0]) / 2, y: arrow.y + (a[1] + b[1]) / 2 };
}

export function oversizedLabel(arrow: Linear, text: TextElement): boolean {
  const { dx, dy, length } = labelSegment(arrow);
  return length === 0 || (Math.abs(dx) * text.width + Math.abs(dy) * text.height) / length > length;
}

// Keep the text bound for editing; only the SVG export copy is detached below.
export function placeArrowLabels(elements: CanvasElement[]): CanvasElement[] {
  const map = new Map(elements.map((e) => [e.id, e]));
  const position = LinearElementEditor.getBoundTextElementPosition as unknown as (
    a: Linear,
    t: TextElement,
    m: Map<string, CanvasElement>,
  ) => { x: number; y: number };
  return elements.map((e) => {
    if (e.type !== "text" || !e.containerId) return e;
    const arrow = map.get(e.containerId);
    if (arrow?.type !== "arrow" && arrow?.type !== "line") return e;
    if (!oversizedLabel(arrow, e)) return { ...e, ...position(arrow, e, map) };
    const seg = labelSegment(arrow);
    const nx = seg.length ? seg.dy / seg.length : 0;
    const ny = seg.length ? -seg.dx / seg.length : -1;
    let offset = (Math.abs(nx) * e.width + Math.abs(ny) * e.height) / 2 + 10;
    // Move beyond both bound containers, so a narrow gap never puts text over a box.
    for (const binding of [arrow.startBinding, arrow.endBinding, arrow.startBinding]) {
      const box = binding && map.get(binding.elementId);
      if (!box) continue;
      const tx = seg.x + nx * offset - e.width / 2;
      const ty = seg.y + ny * offset - e.height / 2;
      if (
        tx >= box.x + box.width + 8 ||
        tx + e.width <= box.x - 8 ||
        ty >= box.y + box.height + 8 ||
        ty + e.height <= box.y - 8
      )
        continue;
      const exitX = nx > 0 ? (box.x + box.width + 8 - tx) / nx : nx < 0 ? (box.x - 8 - tx - e.width) / nx : Infinity;
      const exitY = ny > 0 ? (box.y + box.height + 8 - ty) / ny : ny < 0 ? (box.y - 8 - ty - e.height) / ny : Infinity;
      offset += Math.min(exitX, exitY);
    }
    return { ...e, x: seg.x + nx * offset - e.width / 2, y: seg.y + ny * offset - e.height / 2 };
  });
}

/** Excalidraw's SVG exporter otherwise re-centres and masks bound arrow text. */
export function labelsForSvg(elements: CanvasElement[]): CanvasElement[] {
  const map = new Map(elements.map((e) => [e.id, e]));
  const detached = new Set(
    elements.flatMap((e) => {
      const a = e.type === "text" && e.containerId ? map.get(e.containerId) : undefined;
      return e.type === "text" && (a?.type === "arrow" || a?.type === "line") && oversizedLabel(a, e) ? [e.id] : [];
    }),
  );
  return elements.map((e) =>
    e.type === "text" && detached.has(e.id)
      ? { ...e, containerId: null }
      : { ...e, boundElements: e.boundElements?.filter((b) => !detached.has(b.id)) ?? null },
  );
}

export function labelWarnings(elements: CanvasElement[]): string[] {
  const map = new Map(elements.map((e) => [e.id, e]));
  return elements.flatMap((e) => {
    const a = e.type === "text" && e.containerId ? map.get(e.containerId) : undefined;
    return e.type === "text" && (a?.type === "arrow" || a?.type === "line") && oversizedLabel(a, e)
      ? [`arrow ${a.id}: label is wider than the arrow; widen the gap to ~${Math.ceil(e.width + 32)}px`]
      : [];
  });
}
