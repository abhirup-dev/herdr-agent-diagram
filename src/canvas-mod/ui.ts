// The canvas chrome, Excalidraw-like: a tool bar at the top, a properties panel on the left, zoom and
// undo/redo at the bottom left. Stateless render functions; main.ts owns state and passes callbacks.
// Every island swallows its own mouse-downs so a click on the chrome never starts a canvas gesture.
import { Input, type InputState } from "gpui-base";
import { div, type Element, svg } from "gpui-kit";
import { theme } from "herdr";
import { FONT_SIZES, PALETTE, QUICK_BACKGROUNDS, QUICK_STROKES, type Style, type Tool } from "../canvas/edit.ts";
import type { CanvasElement, FillStyle, StrokeStyle } from "../canvas/types.ts";
import { type Hex, hex } from "./paths.ts";

/** A Herdr theme colour, so the chrome follows light and dark themes. */
const c = (name: string): Hex => hex(theme()[name] ?? "#808080");
const ICONS = "mods/excal-canvas/icons";

type Cb = () => void;

/** A floating white panel that keeps clicks to itself. */
const island = (): Element =>
  div()
    .bg(c("popover"))
    .text_color(c("foreground"))
    .rounded_lg()
    .shadow_md()
    .border_1()
    .border_color(c("border"))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());

const icon = (name: string, size = 14, color?: string): Element =>
  svg(`${ICONS}/${name}.svg`)
    .size(size)
    .flex_none()
    .text_color(color ? hex(color) : c("foreground"));

function button(
  content: Element,
  active: boolean,
  onPress: Cb,
  opts: { w?: number; disabled?: boolean } = {},
): Element {
  const b = div()
    .h(26)
    .w(opts.w ?? 26)
    .flex()
    .items_center()
    .justify_center()
    .rounded_md()
    .child(content);
  if (opts.disabled) return b.opacity(0.35);
  return (active ? b.bg(c("selected")) : b.hover((s) => s.bg(c("hover"))))
    .cursor_pointer()
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      onPress();
    });
}

// --- tool bar ---------------------------------------------------------------------------------------------

const TOOLS: readonly (readonly [Tool, string])[] = [
  ["hand", "H"],
  ["selection", "1"],
  ["rectangle", "2"],
  ["diamond", "3"],
  ["ellipse", "4"],
  ["arrow", "5"],
  ["line", "6"],
  ["freedraw", "7"],
  ["text", "8"],
  ["eraser", "0"],
];

export function toolbar(tool: Tool, onTool: (t: Tool) => void): Element {
  const items = TOOLS.flatMap(([t, key], i) => {
    const active = t === tool;
    const cell = div()
      .relative()
      .child(button(icon(t, 14, active ? c("accent") : undefined), active, () => onTool(t), { w: 30 }))
      .child(div().absolute().right(2).bottom(0).text_size(7.5).text_color(c("muted")).child(key));
    return i === 1 ? [div().w(1).h(20).mx(4).bg(c("border")), cell] : [cell];
  });
  return (
    div()
      .absolute()
      .top(10)
      .left(0)
      .right(0)
      .flex()
      .justify_center()
      .px(8)
      // Wraps in a narrow pane (the canvas beside an agent) instead of clipping tools.
      .child(island().flex().flex_wrap().justify_center().items_center().gap(1).p(3).children(items))
  );
}

// --- properties panel -------------------------------------------------------------------------------------

export interface PanelProps {
  readonly style: Style;
  /** Element types the panel speaks for: the selection's, or the active tool's. */
  readonly types: ReadonlySet<CanvasElement["type"]>;
  readonly hasSelection: boolean;
  readonly shades: "stroke" | "background" | null;
  readonly hexInput: InputState;
  readonly onStyle: (p: Partial<Style>) => void;
  readonly onShades: (which: "stroke" | "background" | null) => void;
  readonly onDelete: Cb;
  readonly onDuplicate: Cb;
}

const section = (title: string, body: Element): Element =>
  div()
    .flex()
    .flex_col()
    .gap(4)
    .child(div().text_size(11).text_color(c("muted")).child(title))
    .child(body);

const row = (...children: Element[]): Element => div().flex().items_center().gap(4).flex_wrap().children(children);

function swatch(color: string, active: boolean, onPress: Cb, size = 22): Element {
  const s = div()
    .size(size)
    .rounded_sm()
    .border_1()
    .border_color(active ? c("accent") : c("border"))
    .cursor_pointer()
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      onPress();
    });
  return color === "transparent"
    ? s.bg(c("background")).flex().items_center().justify_center().text_size(12).text_color("#fa5252").child("⌀")
    : s.bg(hex(color));
}

function colorSection(
  title: string,
  which: "stroke" | "background",
  value: string,
  quick: readonly string[],
  p: PanelProps,
): Element {
  const set = (c: string) => p.onStyle(which === "stroke" ? { strokeColor: c } : { backgroundColor: c });
  const quickRow = row(
    ...quick.map((c) => swatch(c, c === value, () => set(c))),
    div().w(1).h(20).bg(c("border")),
    swatch(value, p.shades === which, () => p.onShades(p.shades === which ? null : which)),
  );
  if (p.shades !== which) return section(title, quickRow);
  // The shade grid: one column per hue, lightest shade on top, plus a hex field.
  const grid = div()
    .flex()
    .gap(2)
    .children(
      PALETTE.map(([, shades]) =>
        div()
          .flex()
          .flex_col()
          .gap(2)
          .children(shades.map((c) => swatch(c, c === value, () => set(c), 14))),
      ),
    );
  const field = div()
    .flex()
    .items_center()
    .gap(4)
    .child(div().text_size(11).text_color(c("muted")).child("#"))
    .child(div().flex_1().text_size(12).child(Input.new(p.hexInput)));
  return section(title, div().flex().flex_col().gap(6).child(quickRow).child(grid).child(field));
}

function choice<T>(options: readonly (readonly [T, Element | string])[], value: T, set: (v: T) => void): Element {
  return row(
    ...options.map(([v, label]) =>
      button(typeof label === "string" ? div().text_size(11).child(label) : label, v === value, () => set(v), {
        w: typeof label === "string" ? Math.max(32, label.length * 7 + 12) : 32,
      }),
    ),
  );
}

const strokeLine = (h: number, dash = false): Element =>
  dash
    ? div().w(18).h(0).border_t_2().border_dashed().border_color(c("foreground"))
    : div().w(18).h(h).rounded_sm().bg(c("foreground"));

const has = (p: PanelProps, ...t: CanvasElement["type"][]) => t.some((x) => p.types.has(x));

export function panel(p: PanelProps): Element {
  const s = p.style;
  const parts: Element[] = [colorSection("Stroke", "stroke", s.strokeColor, QUICK_STROKES, p)];
  if (has(p, "rectangle", "diamond", "ellipse")) {
    parts.push(colorSection("Background", "background", s.backgroundColor, QUICK_BACKGROUNDS, p));
    parts.push(
      section(
        "Fill",
        choice<FillStyle>(
          [
            ["hachure", "Hachure"],
            ["cross-hatch", "Cross"],
            ["solid", "Solid"],
          ],
          s.fillStyle,
          (fillStyle) => p.onStyle({ fillStyle }),
        ),
      ),
    );
  }
  if (has(p, "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw")) {
    parts.push(
      section(
        "Stroke width",
        choice(
          [
            [1, strokeLine(1)],
            [2, strokeLine(2)],
            [4, strokeLine(4)],
          ],
          s.strokeWidth,
          (strokeWidth) => p.onStyle({ strokeWidth }),
        ),
      ),
    );
  }
  if (has(p, "rectangle", "diamond", "ellipse", "arrow", "line")) {
    parts.push(
      section(
        "Stroke style",
        choice<StrokeStyle>(
          [
            ["solid", strokeLine(2)],
            ["dashed", strokeLine(2, true)],
            ["dotted", div().text_size(14).child("···")],
          ],
          s.strokeStyle,
          (strokeStyle) => p.onStyle({ strokeStyle }),
        ),
      ),
    );
  }
  if (has(p, "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw")) {
    parts.push(
      section(
        "Sloppiness",
        choice(
          [
            [0, "Architect"],
            [1, "Artist"],
            [2, "Cartoonist"],
          ],
          s.roughness,
          (roughness) => p.onStyle({ roughness }),
        ),
      ),
    );
  }
  if (has(p, "rectangle", "diamond", "arrow", "line")) {
    parts.push(
      section(
        "Edges",
        choice(
          [
            [false, "Sharp"],
            [true, "Round"],
          ],
          s.roundEdges,
          (roundEdges) => p.onStyle({ roundEdges }),
        ),
      ),
    );
  }
  if (has(p, "text")) {
    parts.push(
      section(
        "Font size",
        choice(
          FONT_SIZES.map((f, i) => [f, ["S", "M", "L", "XL"][i] ?? String(f)] as const),
          s.fontSize,
          (fontSize) => p.onStyle({ fontSize }),
        ),
      ),
    );
  }
  parts.push(
    section(
      "Opacity",
      choice(
        [20, 40, 60, 80, 100].map((o) => [o, String(o)] as const),
        s.opacity,
        (opacity) => p.onStyle({ opacity }),
      ),
    ),
  );
  if (p.hasSelection) {
    parts.push(
      section(
        "Actions",
        row(button(icon("copy", 13), false, p.onDuplicate), button(icon("trash", 13, "#e03131"), false, p.onDelete)),
      ),
    );
  }
  return island().absolute().left(12).top(50).w(216).p(10).flex().flex_col().gap(10).children(parts);
}

// --- zoom and history -------------------------------------------------------------------------------------

export interface FooterProps {
  readonly zoom: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onZoom: (factor: number) => void;
  readonly onResetZoom: Cb;
  readonly onUndo: Cb;
  readonly onRedo: Cb;
}

export function footer(p: FooterProps): Element {
  const zoom = island()
    .flex()
    .items_center()
    .p(2)
    .child(button(icon("minus", 13), false, () => p.onZoom(1 / 1.1)))
    .child(
      button(
        div()
          .text_size(12)
          .child(`${Math.round(p.zoom * 100)}%`),
        false,
        p.onResetZoom,
        { w: 52 },
      ),
    )
    .child(button(icon("plus", 13), false, () => p.onZoom(1.1)));
  const history = island()
    .flex()
    .items_center()
    .p(2)
    .child(button(icon("undo", 13), false, p.onUndo, { disabled: !p.canUndo }))
    .child(button(icon("redo", 13), false, p.onRedo, { disabled: !p.canRedo }));
  return div().absolute().left(12).bottom(12).flex().gap(8).child(zoom).child(history);
}
