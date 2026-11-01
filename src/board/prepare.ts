// Client-side element shaping (from mcp-excalidraw-server 2.1.2 core/normalize.ts and core/describe.ts, MIT):
// what `add`/`apply`/`update` send, and the plain-text scene description agents read.
import { type BoardElement, generateId, normalizeFontFamily } from "./store.ts";

type Input = Record<string, unknown>;
type Pt = [number, number] | { x: number; y: number };

const points = (p: unknown): [number, number][] | undefined =>
  Array.isArray(p) ? (p as Pt[]).map((q) => (Array.isArray(q) ? q : [q.x, q.y])) : undefined;

const isRecord = (v: unknown): v is Input => !!v && typeof v === "object" && !Array.isArray(v);

/** Label styling given at the top level of a shape; Excalidraw only draws it on the label. */
const LABEL_KEYS = ["fontSize", "verticalAlign", "textAlign"] as const;

/** A frame title is `name`. Any other shape's `text` is its label, and top-level label styling belongs on that label. */
function foldLabel(el: Input, type: string | undefined, existing?: Input): Input {
  if (type === "frame") return foldFrame(el);
  if (!type || type === "text") return el;
  const text = typeof el.text === "string" && el.text ? el.text : undefined;
  const styles = LABEL_KEYS.filter((k) => el[k] !== undefined);
  if (text === undefined && !styles.length) return el;
  const prior = isRecord(existing?.label) ? existing.label : undefined;
  const own = isRecord(el.label) ? el.label : undefined;
  if (text === undefined && !prior && !own) return el;
  const rest: Input = { ...el };
  const label: Input = { ...prior, ...own };
  if (text !== undefined) label.text = text;
  for (const k of styles) label[k] = el[k];
  for (const k of ["text", "label", ...styles]) delete rest[k];
  return { ...rest, label };
}

function foldFrame(el: Input): Input {
  if (typeof el.text !== "string" || !el.text) return el;
  const { text, ...rest } = el;
  return typeof rest.name === "string" && rest.name ? rest : { ...rest, name: text };
}

/** startElementId/endElementId -> start/end refs, frame `text` -> `name`, shape `text` and label styling -> `label`. */
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
  return foldLabel(el, typeof el.type === "string" ? el.type : undefined);
}

/** An update body. Frame `text` becomes `name`; on a labelled shape `text` and label styling join `label`. */
export function prepareUpdate(updates: Input, knownType?: string, existing?: Input): Input {
  const { points: raw, ...rest } = updates;
  const body: Input = { ...rest, points: points(raw), updatedAt: new Date().toISOString() };
  if (body.fontFamily !== undefined) body.fontFamily = normalizeFontFamily(body.fontFamily);
  const type = (typeof body.type === "string" ? body.type : undefined) ?? knownType;
  return foldLabel(body, type, existing);
}

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const r = (v: unknown) => Math.round(n(v));
const groups = (e: BoardElement) => (Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []);

const refId = (v: unknown): string | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const id = (v as { id?: unknown }).id;
  if (typeof id === "string" && id) return id;
  const elementId = (v as { elementId?: unknown }).elementId;
  return typeof elementId === "string" && elementId ? elementId : undefined;
};

const arrowEnds = (e: BoardElement) => ({
  from: refId(e.start) ?? refId(e.startBinding),
  to: refId(e.end) ?? refId(e.endBinding),
});

function relation(el: BoardElement): string | undefined {
  if (el.type === "arrow") {
    const { from, to } = arrowEnds(el);
    return from || to ? `from ${from ?? "?"} -> ${to ?? "?"}` : undefined;
  }
  return el.type === "frame" && typeof el.name === "string" && el.name ? `name: "${el.name}"` : undefined;
}

function line(el: BoardElement): string {
  const parts = [`[${el.id}] ${el.type}`, `at (${r(el.x)}, ${r(el.y)})`];
  if (el.width || el.height) parts.push(`size ${r(el.width)}x${r(el.height)}`);
  const linked = relation(el);
  if (linked) parts.push(linked);
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
  const links = all.flatMap((e) => {
    if (e.type !== "arrow") return [];
    const { from, to } = arrowEnds(e);
    return from || to ? [`  ${from ?? "?"} --> ${to ?? "?"} (arrow: ${e.id})`] : [];
  });
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
