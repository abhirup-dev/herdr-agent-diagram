// Client-side element shaping (from mcp-excalidraw-server 2.1.2 core/normalize.ts and core/describe.ts, MIT):
// what `add`/`apply`/`update` send, and the plain-text scene description agents read.
import { type BoardElement, generateId, normalizeFontFamily } from "./store.ts";

type Input = Record<string, unknown>;
type Pt = [number, number] | { x: number; y: number };

const points = (p: unknown): [number, number][] | undefined =>
  Array.isArray(p) ? (p as Pt[]).map((q) => (Array.isArray(q) ? q : [q.x, q.y])) : undefined;

/** startElementId/endElementId -> start/end refs, `text` on a shape -> `label`, font names -> ids. */
export function prepareElement(input: Input): Input {
  const { startElementId, endElementId, id, ...props } = input;
  const t = new Date().toISOString();
  const el: Input = {
    id: typeof id === "string" && id ? id : generateId(),
    ...props,
    points: points(props.points),
    ...(typeof startElementId === "string" ? { start: { id: startElementId } } : {}),
    ...(typeof endElementId === "string" ? { end: { id: endElementId } } : {}),
    createdAt: t,
    updatedAt: t,
    version: 1,
  };
  if (el.fontFamily !== undefined) el.fontFamily = normalizeFontFamily(el.fontFamily);
  if ((startElementId || endElementId) && !props.points)
    el.points = [
      [0, 0],
      [100, 0],
    ];
  if (el.text && el.type !== "text") {
    const { text, ...rest } = el;
    return { ...rest, label: { text } };
  }
  return el;
}

/** An update body; `text` becomes `label` only on a shape (on a text element it is the text). */
export function prepareUpdate(updates: Input, knownType?: string): Input {
  const { points: raw, ...rest } = updates;
  const body: Input = { ...rest, points: points(raw), updatedAt: new Date().toISOString() };
  if (body.fontFamily !== undefined) body.fontFamily = normalizeFontFamily(body.fontFamily);
  const type = (updates.type as string | undefined) ?? knownType;
  if (body.text !== undefined && type && type !== "text") {
    const { text, ...withoutText } = body;
    return { ...withoutText, label: { text } };
  }
  return body;
}

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const r = (v: unknown) => Math.round(n(v));
const groups = (e: BoardElement) => (Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []);

function line(el: BoardElement): string {
  const parts = [`[${el.id}] ${el.type}`, `at (${r(el.x)}, ${r(el.y)})`];
  if (el.width || el.height) parts.push(`size ${r(el.width)}x${r(el.height)}`);
  if (el.text) parts.push(`text: "${String(el.text)}"`);
  const label = (el.label as { text?: unknown } | undefined)?.text;
  if (label) parts.push(`label: "${String(label)}"`);
  if (el.backgroundColor && el.backgroundColor !== "transparent") parts.push(`bg: ${String(el.backgroundColor)}`);
  if (el.strokeColor && el.strokeColor !== "#000000") parts.push(`stroke: ${String(el.strokeColor)}`);
  if (el.locked) parts.push("(locked)");
  if (groups(el).length) parts.push(`groups: [${groups(el).join(", ")}]`);
  return `  ${parts.join(" | ")}`;
}

/** Types, bounds, elements top-to-bottom, arrows, groups. */
export function describeScene(all: BoardElement[]): string {
  if (!all.length) return "The canvas is empty. No elements to describe.";
  const counts = new Map<string, number>();
  for (const e of all) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const minX = Math.min(...all.map((e) => n(e.x)));
  const minY = Math.min(...all.map((e) => n(e.y)));
  const maxX = Math.max(...all.map((e) => n(e.x) + n(e.width)));
  const maxY = Math.max(...all.map((e) => n(e.y) + n(e.height)));
  const sorted = [...all].sort((a, b) => Math.floor(n(a.y) / 50) - Math.floor(n(b.y) / 50) || n(a.x) - n(b.x));
  const bindingOf = (v: unknown) => (v as { elementId?: string } | null | undefined)?.elementId;
  const links = all
    .filter((e) => e.type === "arrow" && (bindingOf(e.startBinding) || bindingOf(e.endBinding)))
    .map((e) => `  ${bindingOf(e.startBinding) ?? "?"} --> ${bindingOf(e.endBinding) ?? "?"} (arrow: ${e.id})`);
  const byGroup = new Map<string, string[]>();
  for (const e of all) for (const g of groups(e)) byGroup.set(g, [...(byGroup.get(g) ?? []), e.id]);
  const lines = [
    "## Canvas Description",
    `Total elements: ${all.length}`,
    `Types: ${[...counts].map(([t, c]) => `${t}(${c})`).join(", ")}`,
    `Bounding box: (${r(minX)}, ${r(minY)}) to (${r(maxX)}, ${r(maxY)}) = ${r(maxX - minX)}x${r(maxY - minY)}`,
    "",
    "### Elements (top-to-bottom, left-to-right):",
    ...sorted.map(line),
  ];
  if (links.length) lines.push("", "### Connections:", ...links);
  if (byGroup.size)
    lines.push("", "### Groups:", ...[...byGroup].map(([g, ids]) => `  Group ${g}: [${ids.join(", ")}]`));
  return lines.join("\n");
}
