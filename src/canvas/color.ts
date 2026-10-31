// Excalidraw's dark mode for element colours: @excalidraw/common applyDarkModeFilter (CSS invert 93% then
// hue-rotate 180deg). Ported, not imported: the package drags timers into the mod bundle, which the Herdr
// mod runtime lacks. test/color.test.ts pins this to the real function.

const INVERT = 0.93;
const cos = Math.cos(Math.PI);
const sin = Math.sin(Math.PI);
const M = [
  0.213 + cos * 0.787 - sin * 0.213,
  0.715 - cos * 0.715 - sin * 0.715,
  0.072 - cos * 0.072 + sin * 0.928,
  0.213 - cos * 0.213 + sin * 0.143,
  0.715 + cos * 0.285 + sin * 0.14,
  0.072 - cos * 0.072 - sin * 0.283,
  0.213 - cos * 0.213 - sin * 0.787,
  0.715 - cos * 0.715 + sin * 0.715,
  0.072 + cos * 0.928 + sin * 0.072,
] as const;

const cache = new Map<string, string>();
const unit = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
const invert = (c: number): number =>
  Math.round(Math.max(0, Math.min(255, c * (1 - INVERT) + (255 - c) * INVERT))) / 255;
const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

/** The colour Excalidraw draws `color` (#rgb, #rrggbb, #rrggbbaa) as in dark mode; other forms pass through. */
export function darkColor(color: string): string {
  const hit = cache.get(color);
  if (hit) return hit;
  let h = color.startsWith("#") ? color.slice(1) : "";
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return color;
  const [r, g, b] = [0, 2, 4].map((i) => invert(Number.parseInt(h.slice(i, i + 2), 16))) as [number, number, number];
  const alpha = h.length === 8 ? h.slice(6) : "";
  const out = `#${hex2(unit(r * M[0] + g * M[1] + b * M[2]))}${hex2(unit(r * M[3] + g * M[4] + b * M[5]))}${hex2(unit(r * M[6] + g * M[7] + b * M[8]))}${alpha === "ff" ? "" : alpha}`;
  cache.set(color, out);
  return out;
}

/** Whether a #rrggbb background is dark (relative luminance under one half). */
export function isDark(color: string): boolean {
  const h = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
