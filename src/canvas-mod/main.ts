// excal-canvas: a native Excalidraw editor for Herdr. Draws the scene the canvas sidecar serves (Excalidraw
// elements from the SDK, plus roughjs paths the sidecar generates) natively, and edits it: tools, selection,
// move/resize, text, styles, undo. Edits go to the sidecar as ops; it writes them to the canvas server.
// Mouse: drag with the selection tool, scroll to pan, cmd/ctrl-scroll to zoom, space-drag or the hand to pan.
// Keys: Excalidraw's (1-8/0 or letters for tools, backspace, cmd-z / cmd-shift-z, cmd-a, ctrl-d duplicate,
// arrows nudge), + / - zoom, shift-1 fit (and keep fitting as the scene changes), shift-0 100%, f frame HUD.
// Units: camera offsets and .left()/.w() are logical px (the app zoom multiplies them); paths are built in
// device px (scale = camera zoom x app zoom); pointer positions arrive in device px.
import { InputState, type InputState as InputStateT, Textarea, TextareaState } from "gpui-base";
import { hide_fps_monitor, show_fps_monitor } from "gpui-fps";
import { type Context, div, type Element, type FocusHandle, View } from "gpui-kit";
import { fonts, layout, settings, theme } from "herdr";
import { WebSocket, type WebSocketSocket } from "websocket";
import { type Camera, fit, pan, zoomAt } from "../canvas/camera.ts";
import { darkColor, isDark } from "../canvas/color.ts";
import { elementBounds, HANDLES, handlePoint, isShapeTool, pointHandles, simplePaints } from "../canvas/edit.ts";
import { Editor, type Mods } from "../canvas/editor.ts";
import { type ClientMessage, parseServerMessage, type ServerMessage, SIDECAR_PORT } from "../canvas/protocol.ts";
import { applyMessage, emptyScene, type Scene, sceneBounds } from "../canvas/scene.ts";
import type { Paint } from "../canvas/shape.ts";
import type { CanvasElement, TextElement } from "../canvas/types.ts";
import { type BuiltElement, buildElement, type Hex, hex } from "./paths.ts";
import { footer, panel, toolbar } from "./ui.ts";

const SIDECAR_URL = `ws://127.0.0.1:${SIDECAR_PORT}`;
const HIT_PX = 6;
const PREVIEW_TIMEOUT_MS = 400;

const appZoom = (): number => Number(settings().zoom) || 1;

// fonts() enumerates every installed font: read it once, not per text element per frame.
let installed: ReadonlySet<string> | null = null;

/** Excalidraw font family -> the nearest installed font (GPUI sees installed fonts only). */
function fontFor(family: number): string {
  installed ??= new Set(fonts());
  const wanted =
    family === 3
      ? ["Cascadia Code", "SF Mono", "Menlo"]
      : family === 2 || family === 6
        ? ["Helvetica Neue", "Helvetica", "Arial"]
        : ["Excalifont", "Virgil", "Comic Sans MS", "Helvetica Neue"];
  return wanted.find((f) => installed?.has(f)) ?? "Helvetica Neue";
}

type Link = "connecting" | "connected" | "sidecar down" | "server down";
type Pointer = { readonly position: { x: number; y: number }; readonly local_position?: { x: number; y: number } };
type KeyMods = { shift: boolean; alt: boolean; platform: boolean; control: boolean };

const modsOf = (m: KeyMods): Mods => ({ shift: m.shift, alt: m.alt, cmd: m.platform || m.control });

/** The layout's (else settings') terminal_opacity, 0..1. */
function terminalOpacity(): number {
  const v = (layout() as { terminal_opacity?: unknown } | null)?.terminal_opacity ?? settings().terminal_opacity;
  return typeof v === "number" ? Math.max(0, Math.min(1, v)) : 1;
}

const withAlpha = (color: string, a: number): Hex =>
  `${color.slice(0, 7)}${
    a >= 1
      ? ""
      : Math.round(a * 255)
          .toString(16)
          .padStart(2, "0")
  }` as Hex;

export default class ExcalCanvas extends View {
  private scene: Scene = emptyScene;
  private readonly ed = new Editor(() => this.scene.order);
  private camera: Camera = { offsetX: 0, offsetY: 0, zoom: 1 };
  /** Fit the scene on every change and resize until the user pans, zooms or edits; shift-1 turns it back on. */
  private autoFit = true;
  private viewport = { width: 800, height: 600 }; // logical px
  private readonly built = new Map<string, BuiltElement>();
  /** Rough paths the sidecar made for drafts, by element id. */
  private readonly previewPaints = new Map<string, readonly Paint[]>();
  /** The element size each paint set was generated at, so it can be stretched to a draft's size. */
  private readonly paintSize = new WeakMap<readonly Paint[], { readonly w: number; readonly h: number }>();
  private previewInFlight: { req: number; at: number } | null = null;
  private nextReq = 1;
  private link: Link = "connecting";
  private ws: WebSocketSocket | null = null;
  private history = { canUndo: false, canRedo: false };
  private panning: { x: number; y: number; cam: Camera } | null = null;
  private spaceHeld = false;
  private shades: "stroke" | "background" | null = null;
  private focus: FocusHandle | null = null;
  private hexInput: InputStateT | null = null;
  private text: { readonly id: string; readonly state: TextareaState } | null = null;

  override init(_props: unknown, cx: Context): void {
    this.focus = cx.focus_handle();
    const hexInput = InputState.new({ placeholder: "1e1e1e" });
    hexInput.on("submit", (_e, cx) => {
      const v = hexInput.value().trim().replace(/^#/, "");
      if (/^[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(v) && this.shades) {
        this.ed.setStyle(this.shades === "stroke" ? { strokeColor: `#${v}` } : { backgroundColor: `#${v}` });
        this.flush(cx);
      }
    });
    this.hexInput = hexInput;
    cx.spawn(async (cx) => {
      for (let delay = 250; ; delay = Math.min(4000, delay * 2)) {
        if (await this.follow(cx)) delay = 250; // it connected before dropping: retry fast
        this.link = "sidecar down";
        this.ws = null;
        cx.notify();
        await new Promise<void>((resolve) => cx.timer.after(delay, () => resolve()));
      }
    });
  }

  // --- sidecar link ---------------------------------------------------------------------------------------

  /** Follows the sidecar until the connection drops; true when it had connected. */
  private async follow(cx: Context): Promise<boolean> {
    let connected = false;
    try {
      const ws = await WebSocket.connect(SIDECAR_URL);
      connected = true;
      this.ws = ws;
      this.link = "connected";
      cx.notify();
      for (;;) {
        const raw = await ws.read();
        if (typeof raw === "string" && this.receive(raw, cx)) cx.notify(); // the sidecar only sends text frames
      }
    } catch {
      return connected;
    }
  }

  private send(m: ClientMessage): void {
    this.ws?.write(JSON.stringify(m)).catch(() => {});
  }

  /** Applies one sidecar message; true when something on screen changed. */
  private receive(raw: string, cx: Context): boolean {
    const m = parseServerMessage(raw);
    if (!m) return false;
    if (m.type === "status") this.link = m.upstream === "connected" ? "connected" : "server down";
    else if (m.type === "history") this.history = { canUndo: m.canUndo, canRedo: m.canRedo };
    else if (m.type === "preview") this.onPreview(m, cx);
    else this.onScene(m);
    return true;
  }

  private onScene(m: Extract<ServerMessage, { type: "scene" | "patch" }>): void {
    const changed = new Set<string>();
    this.scene = applyMessage(this.scene, m, changed);
    for (const id of changed) {
      this.built.delete(id);
      if (!this.ed.drafts.has(id)) this.previewPaints.delete(id);
    }
    for (const e of m.type === "scene" ? m.elements : m.upsert)
      if (e.paints) this.paintSize.set(e.paints, { w: e.width, h: e.height });
    this.ed.reconcile();
    if (this.autoFit) this.fitToScene();
  }

  private onPreview(m: Extract<ServerMessage, { type: "preview" }>, cx: Context): void {
    if (this.previewInFlight?.req === m.req) this.previewInFlight = null;
    this.previewPaints.set(m.id, m.paints);
    this.paintSize.set(m.paints, { w: m.width, h: m.height });
    this.built.delete(m.id);
    this.flushPreviews();
    cx.notify();
  }

  /** Sends the editor's queued ops, one preview request (one in flight), and syncs the text editor. */
  private flush(cx: Context): void {
    for (const ops of this.ed.outbox.splice(0)) this.send({ type: "ops", ops });
    this.flushPreviews();
    this.syncTextEditor(cx);
    cx.notify();
  }

  private flushPreviews(): void {
    const now = Date.now();
    if (this.previewInFlight && now - this.previewInFlight.at < PREVIEW_TIMEOUT_MS) return;
    const first = this.ed.previews.entries().next();
    if (first.done) return;
    const [id, element] = first.value;
    this.ed.previews.delete(id);
    const req = this.nextReq++;
    this.previewInFlight = { req, at: now };
    this.send({ type: "preview", req, element });
  }

  // --- text editing ---------------------------------------------------------------------------------------

  /** Opens a textarea when the editor starts editing text, and drops it when the editor stops. */
  private syncTextEditor(_cx: Context): void {
    const t = this.ed.editing;
    if (this.text && this.text.id !== t?.id) {
      this.text.state.release();
      this.text = null;
      this.focus?.focus();
    }
    if (!t || this.text) return;
    const state = TextareaState.new({ value: t.text });
    state.set_auto_grow(1, 40);
    state.on("change", (_e, cx) => {
      if (this.ed.editing?.id === t.id) this.ed.editing = { ...this.ed.editing, text: state.value() };
      cx.notify();
    });
    state.on("blur", (_e, cx) => this.commitText(cx));
    this.text = { id: t.id, state };
    state.focus();
  }

  private commitText(cx: Context): void {
    const t = this.text;
    if (!t || this.ed.editing?.id !== t.id) return;
    this.ed.commitText(t.state.value());
    this.flush(cx);
  }

  // --- camera ---------------------------------------------------------------------------------------------

  private fitToScene(): void {
    const b = sceneBounds(this.scene);
    if (b) this.camera = fit(b, this.viewport.width, this.viewport.height);
  }

  private zoomBy(factor: number): void {
    this.autoFit = false;
    this.camera = zoomAt(this.camera, factor, [this.viewport.width / 2, this.viewport.height / 2]);
  }

  /** Canvas-local logical px of a pointer event. */
  private local(e: Pointer): { x: number; y: number } {
    const z = appZoom();
    const p = e.local_position ?? e.position;
    return { x: p.x / z, y: p.y / z };
  }

  private world(e: Pointer): { x: number; y: number } {
    const { x, y } = this.local(e);
    const c = this.camera;
    return { x: (x - c.offsetX) / c.zoom, y: (y - c.offsetY) / c.zoom };
  }

  // --- drawing --------------------------------------------------------------------------------------------

  /** The paths to draw for `e`: a fresh preview for drafts, else the server's, else plain ones. */
  private paintsOf(e: CanvasElement): readonly Paint[] {
    if (this.ed.pointDrag === e.id) return this.smooth(e);
    const draft = this.ed.drafts.has(e.id) || this.ed.pending.has(e.id);
    const preview = this.previewPaints.get(e.id);
    if (draft && preview) return preview;
    return e.paints ?? preview ?? simplePaints(e);
  }

  /** Plain smooth paths for a line under a point drag, rebuilt only when the line changed. */
  private smoothFor: { e: CanvasElement; paints: readonly Paint[] } | null = null;
  private smooth(e: CanvasElement): readonly Paint[] {
    if (this.smoothFor?.e !== e) this.smoothFor = { e, paints: simplePaints(e) };
    return this.smoothFor.paints;
  }

  /** Cached native paths for `e`: rebuilt when its paths, the zoom or its stretch changed. */
  private paths(e: CanvasElement): BuiltElement {
    const scale = this.camera.zoom * appZoom();
    const src = this.paintsOf(e);
    const size = this.paintSize.get(src);
    const sx = size && size.w > 0.5 ? Math.round((e.width / size.w) * 1000) / 1000 : 1;
    const sy = size && size.h > 0.5 ? Math.round((e.height / size.h) * 1000) / 1000 : 1;
    const hit = this.built.get(e.id);
    if (hit && hit.src === src && hit.scale === scale && hit.sx === sx && hit.sy === sy) return hit;
    const b = buildElement(e, src, scale, sx, sy);
    this.built.set(e.id, b);
    return b;
  }

  /** Herdr's theme colours, read each frame so the canvas follows theme switches. */
  private ui: Record<string, string> = {};
  /** On a dark theme, element colours go through Excalidraw's dark-mode filter. */
  private dark = false;
  /** The canvas fill: the terminals' background at their opacity, so the layout's backdrop shows through alike. */
  private backdrop: Hex = "#ffffff";
  private ink(c: string): Hex {
    return hex(this.dark ? darkColor(c) : c);
  }

  /** Appends the element's painted paths to `out` (no spread: spread calls are slow in the mod runtime). */
  private drawShape(e: CanvasElement, out: Element[]): void {
    const b = this.paths(e);
    const left = (e.x + b.mx) * this.camera.zoom + this.camera.offsetX;
    const top = (e.y + b.my) * this.camera.zoom + this.camera.offsetY;
    const fade = this.ed.erasing.has(e.id);
    for (const p of b.paints) {
      const el = window.paint_path(p.path, this.ink(p.color)).absolute().left(left).top(top).size_full();
      out.push(fade ? el.opacity(0.3) : el);
    }
  }

  private drawText(e: TextElement): Element {
    const { zoom, offsetX, offsetY } = this.camera;
    const lineH = e.fontSize * e.lineHeight * zoom;
    const align = (el: Element) =>
      e.textAlign === "center" ? el.text_center() : e.textAlign === "right" ? el.text_right() : el.text_left();
    return div()
      .absolute()
      .left(e.x * zoom + offsetX)
      .top(e.y * zoom + offsetY)
      .w(Math.max(1, e.width * zoom))
      .font_family(fontFor(e.fontFamily))
      .text_size(e.fontSize * zoom)
      .line_height(e.lineHeight) // a bare number is a multiplier, as in Excalidraw
      .text_color(this.ink(e.strokeColor))
      .opacity((this.ed.erasing.has(e.id) ? 0.3 : 1) * (e.opacity / 100))
      .whitespace_nowrap()
      .children(
        e.text.split("\n").map((line) =>
          align(
            div()
              .h(lineH)
              .child(line || " "),
          ),
        ),
      );
  }

  /** A screen-space div over world bounds `b`, grown by `pad` px. */
  private screenBox(b: { minX: number; minY: number; maxX: number; maxY: number }, pad: number): Element {
    const { zoom, offsetX, offsetY } = this.camera;
    return div()
      .absolute()
      .left(b.minX * zoom + offsetX - pad)
      .top(b.minY * zoom + offsetY - pad)
      .w((b.maxX - b.minX) * zoom + 2 * pad)
      .h((b.maxY - b.minY) * zoom + 2 * pad);
  }

  /** A square or round handle of `size` px centred on world point (x, y), nudged by (dx, dy) px. */
  private handle(x: number, y: number, size: number, dx = 0, dy = 0): Element {
    const { zoom, offsetX, offsetY } = this.camera;
    return div()
      .absolute()
      .left(x * zoom + offsetX + dx - size / 2)
      .top(y * zoom + offsetY + dy - size / 2)
      .size(size)
      .border_1()
      .border_color(this.ui.accent as Hex);
  }

  /** Selection outlines, handles and the marquee, in screen px. */
  private drawSelection(els: readonly CanvasElement[], out: Element[]): void {
    const marquee = this.ed.marquee();
    if (marquee)
      out.push(
        this.screenBox(marquee, 0)
          .bg(`${this.ui.accent}14` as Hex)
          .border_1()
          .border_color(this.ui.accent as Hex),
      );
    if (!this.ed.selected.size || this.ed.editing) return;
    const lin = this.ed.singleLinear(els);
    if (lin) {
      // Excalidraw's line editing: a handle per point, a lighter one mid-segment (drag it to bend).
      for (const h of pointHandles(lin)) {
        const dot = this.handle(h.at[0], h.at[1], h.kind === "point" ? 10 : 8).rounded_full();
        out.push(h.kind === "point" ? dot.bg(this.ui.background as Hex) : dot.bg(`${this.ui.accent}55` as Hex));
      }
      return;
    }
    this.drawResizeBox(els, out);
  }

  /** Dashed outlines per element, the group box and its eight resize handles. */
  private drawResizeBox(els: readonly CanvasElement[], out: Element[]): void {
    const selected = els.filter((e) => this.ed.selected.has(e.id));
    if (selected.length > 1)
      for (const e of selected)
        out.push(
          this.screenBox(elementBounds(e), 4)
            .border_1()
            .border_dashed()
            .border_color(this.ui.accent as Hex),
        );
    const all = this.ed.selectionBounds(els);
    if (!all) return;
    out.push(
      this.screenBox(all, 6)
        .border_1()
        .border_color(this.ui.accent as Hex),
    );
    if (this.ed.busy) return;
    for (const h of HANDLES) {
      const [hx, hy] = handlePoint(all, h);
      const dx = h.includes("w") ? -6 : h.includes("e") ? 6 : 0;
      const dy = h.startsWith("n") ? -6 : h.startsWith("s") ? 6 : 0;
      out.push(
        this.handle(hx, hy, 8, dx, dy)
          .rounded_sm()
          .bg(this.ui.background as Hex),
      );
    }
  }

  private drawTextEditor(): Element | null {
    const t = this.ed.editing;
    if (!t || !this.text) return null;
    const { zoom, offsetX, offsetY } = this.camera;
    const area = Textarea.new(this.text.state)
      .text_size(t.fontSize * zoom)
      .font_family(fontFor(5))
      .text_color(this.ink(t.color));
    return div()
      .absolute()
      .left(t.x * zoom + offsetX)
      .top(t.y * zoom + offsetY)
      .w(Math.max(t.width * zoom, 160))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(t.align === "center" ? area.text_center() : area);
  }

  private chrome(): Element[] {
    const ed = this.ed;
    const out: Element[] = [toolbar(ed.tool, (t) => this.act(() => ed.setTool(t)))];
    const selected = ed.elements().filter((e) => ed.selected.has(e.id));
    const types = new Set<CanvasElement["type"]>(selected.map((e) => e.type));
    if (!selected.length && isShapeTool(ed.tool)) types.add(ed.tool);
    if (types.size && this.hexInput)
      out.push(
        panel({
          style: selected.length ? ed.shownStyle() : ed.style,
          types,
          hasSelection: selected.length > 0,
          shades: this.shades,
          hexInput: this.hexInput,
          onStyle: (p) => this.act(() => ed.setStyle(p)),
          onShades: (w) => this.act(() => (this.shades = w)),
          onDelete: () => this.act(() => ed.remove([...ed.selected])),
          onDuplicate: () => this.act(() => ed.duplicate()),
        }),
      );
    out.push(
      footer({
        zoom: this.camera.zoom,
        canUndo: this.history.canUndo,
        canRedo: this.history.canRedo,
        onZoom: (f) => this.act(() => this.zoomBy(f)),
        onResetZoom: () => this.act(() => this.zoomBy(1 / this.camera.zoom)),
        onUndo: () => this.act(() => this.send({ type: "undo" })),
        onRedo: () => this.act(() => this.send({ type: "redo" })),
      }),
    );
    out.push(this.statusBar());
    return out;
  }

  /** Runs a chrome action, then sends what it produced and gives the keyboard back to the canvas. */
  private pendingCx: Context | null = null;
  private act(fn: () => void): void {
    fn();
    this.focus?.focus();
    if (this.pendingCx) this.flush(this.pendingCx);
  }

  /** The last handler failure, shown in the status bar. */
  private failure = "";
  /** Runs an event handler, keeping its failure on screen (Herdr swallows handler exceptions silently). */
  private guard(name: string, cx: Context, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.failure = `${name} failed: ${err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err)}`;
      cx.notify();
    }
  }

  private statusBar(): Element {
    const n = this.scene.order.length;
    const dot = this.link === "connected" ? "#2f9e44" : this.link === "connecting" ? "#f08c00" : "#e03131";
    return div()
      .absolute()
      .right(12)
      .bottom(16)
      .flex()
      .items_center()
      .gap(6)
      .text_size(11)
      .text_color(this.ui.muted as Hex)
      .child(div().w(7).h(7).rounded(4).bg(dot))
      .child(`${this.link} · ${n} element${n === 1 ? "" : "s"} ${this.failure ? ` · ${this.failure}` : ""}`);
  }

  override render(cx: Context): Element {
    try {
      return this.view(cx);
    } catch (e) {
      // Show the failure in the pane: Herdr keeps the last good frame and logs nothing to disk.
      const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
      return div().size_full().p(12).bg("#fff5f5").text_size(12).text_color("#c92a2a").whitespace_normal().child(msg);
    }
  }

  private view(cx: Context): Element {
    this.pendingCx = cx;
    this.ui = theme();
    this.dark = isDark(this.ui.background ?? "#ffffff");
    // Terminals end up layering their background twice (measured: 0.7 shows as ~0.91), so match that.
    this.backdrop = withAlpha(this.ui.background ?? "#ffffff", 1 - (1 - terminalOpacity()) ** 2);
    const z = appZoom();
    const els = this.ed.elements();
    const hidden = this.ed.editing?.id;
    const children: Element[] = [];
    for (const e of els) {
      if (e.id === hidden) continue;
      if (e.type === "text") children.push(this.drawText(e));
      else this.drawShape(e, children);
    }
    this.drawSelection(els, children);
    const editor = this.drawTextEditor();
    if (editor) children.push(editor);
    const tool = this.ed.tool;
    const root = div()
      .id("excal-canvas")
      .relative()
      .size_full()
      .overflow_hidden()
      .bg(this.backdrop)
      .on_size_change((size, cx) => {
        this.viewport = { width: size.width / z, height: size.height / z };
        if (this.autoFit) this.fitToScene();
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) =>
        this.guard("down", cx, () => {
          this.pendingCx = cx;
          this.focus?.focus();
          this.autoFit = false;
          this.shades = null;
          if (tool === "hand" || this.spaceHeld) {
            this.panning = { x: e.position.x, y: e.position.y, cam: this.camera };
          } else {
            const w = this.world(e);
            this.ed.down(w.x, w.y, modsOf(e.modifiers), e.click_count, HIT_PX / this.camera.zoom);
          }
          this.flush(cx);
        }),
      )
      .on_mouse_move((e, cx) => {
        if (this.panning) {
          const p = this.panning;
          this.camera = pan(p.cam, (e.position.x - p.x) / z, (e.position.y - p.y) / z);
          cx.notify();
        } else if (this.ed.busy) {
          const w = this.world(e);
          this.ed.move(w.x, w.y, modsOf(e.modifiers), HIT_PX / this.camera.zoom);
          this.flushPreviews();
          cx.notify();
        }
      })
      .on_mouse_up("left", (e, cx) =>
        this.guard("up", cx, () => {
          this.panning = null;
          const w = this.world(e);
          this.ed.up(w.x, w.y, modsOf(e.modifiers), HIT_PX / this.camera.zoom);
          this.flush(cx);
        }),
      )
      .on_hover((hovered, cx) => {
        if (hovered) return;
        this.panning = null; // no pointer capture outside the pane
        this.ed.leave();
        this.flush(cx);
      })
      .on_scroll_wheel((e, cx) => {
        this.autoFit = false;
        // Herdr delivers a pinch as an empty scroll (no scale), so a plain two-finger swipe zooms instead:
        // fingers up zooms in. Shift or cmd/ctrl + swipe pans; GPUI deltas already follow the fingers.
        if (e.modifiers.shift || e.modifiers.platform || e.modifiers.control)
          this.camera = pan(this.camera, e.delta.x, e.delta.y);
        else {
          const at = this.local(e);
          this.camera = zoomAt(this.camera, Math.exp(-e.delta.y / 300), [at.x, at.y]);
        }
        cx.stop_propagation();
        cx.notify();
      })
      .on_key_down((e, cx) =>
        this.guard(`key ${e.keystroke}`, cx, () => {
          this.pendingCx = cx;
          if (this.onKey(e.keystroke, e.key)) {
            cx.stop_propagation();
            this.flush(cx);
          }
        }),
      )
      .on_key_up((e) => {
        if (e.key === "space") this.spaceHeld = false;
      })
      .children(children)
      .children(this.chrome());
    const cursor =
      tool === "hand" || this.spaceHeld
        ? root.cursor_grab()
        : tool === "text"
          ? root.cursor_text()
          : tool === "selection"
            ? root.cursor_default()
            : root.cursor_crosshair();
    return this.focus ? cursor.track_focus(this.focus) : cursor;
  }

  /** Canvas shortcuts. True when handled. Keys typed into the text editor bubble here too: ignore them. */
  private onKey(keystroke: string, key: string): boolean {
    if (this.ed.editing) {
      if (keystroke !== "escape" || !this.pendingCx) return false;
      this.commitText(this.pendingCx);
      return true;
    }
    if (keystroke === "space") this.spaceHeld = true;
    else if (keystroke === "cmd-z") this.send({ type: "undo" });
    else if (keystroke === "cmd-shift-z") this.send({ type: "redo" });
    else if (key === "+" || key === "=") this.zoomBy(1.1);
    else if (key === "-") this.zoomBy(1 / 1.1);
    else if (key === "!") {
      this.autoFit = true;
      this.fitToScene();
    } else if (key === ")") this.zoomBy(1 / this.camera.zoom);
    else if (keystroke === "f") {
      if (!hide_fps_monitor()) show_fps_monitor({ anchor: "top_right" }); // Herdr's frame HUD
    } else return this.ed.key(keystroke);
    return true;
  }
}
