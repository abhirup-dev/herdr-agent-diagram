import { cutOut, elementPaints } from "../canvas/shape.ts";
import type { CanvasElement } from "../canvas/types.ts";
import { oversizedLabel } from "./layout.ts";

/** Paints for every shape; an arrow or line with a label gets its stroke cut where the label sits, as in Excalidraw. */
export function withPaints(els: CanvasElement[]): CanvasElement[] {
  const labels = new Map(els.flatMap((t) => (t.type === "text" && t.containerId ? [[t.containerId, t] as const] : [])));
  return els.map((e): CanvasElement => {
    if (e.type === "text") return e;
    const paints = elementPaints(e);
    const t = (e.type === "arrow" || e.type === "line") && labels.get(e.id);
    if (
      !t ||
      (e.type !== "arrow" && e.type !== "line") ||
      oversizedLabel(e, t as Extract<CanvasElement, { type: "text" }>)
    )
      return { ...e, paints };
    const r = { x: t.x - e.x, y: t.y - e.y, width: t.width, height: t.height };
    return { ...e, paints: paints.map((p) => (p.kind === "stroke" ? { ...p, ops: cutOut(p.ops, r) } : p)) };
  });
}
