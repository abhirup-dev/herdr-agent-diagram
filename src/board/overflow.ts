// Label-width warnings for add/apply/update. A label wider than its shape is clipped or wraps
// tall; say so with the element id first. Arrow length is a separate warning.
import type { BoardElement } from "./store.ts";
import { getFontEntry } from "./upstream/core/render/fonts.js";
import { measureTextWidth } from "./upstream/core/render/text-metrics.js";

const BOXES = new Set(["rectangle", "ellipse", "diamond"]);
const word = (type: string) => (type === "rectangle" ? "rect" : type);

const fontSizeOf = (el: BoardElement, label: { fontSize?: unknown }): number => {
  if (typeof label.fontSize === "number" && Number.isFinite(label.fontSize)) return label.fontSize;
  if (typeof el.fontSize === "number" && Number.isFinite(el.fontSize)) return el.fontSize;
  return 20;
};

/** One warning per labelled box whose text is wider than the box. Empty when every label fits. */
export function labelOverflowWarnings(elements: readonly BoardElement[]): string[] {
  const warnings: string[] = [];
  for (const el of elements) {
    if (!BOXES.has(el.type) || !el.label || typeof el.label !== "object") continue;
    const label = el.label as { text?: unknown; fontSize?: unknown };
    if (typeof label.text !== "string" || !label.text) continue;
    if (typeof el.width !== "number" || !Number.isFinite(el.width)) continue;
    const family = getFontEntry(
      typeof el.fontFamily === "number" || typeof el.fontFamily === "string" ? el.fontFamily : undefined,
    ).family;
    const font = `${fontSizeOf(el, label)}px ${family}`;
    const measured = Math.max(...label.text.split("\n").map((line) => measureTextWidth(line, font)));
    if (measured > el.width)
      warnings.push(
        `${word(el.type)} ${el.id}: label needs ~${Math.ceil(measured)}px width (has ${Math.round(el.width)})`,
      );
  }
  return warnings;
}
