// excal-canvas: a native Excalidraw canvas for Herdr. Draws the scene the canvas sidecar serves (full
// Excalidraw elements from the Excalidraw SDK, plus roughjs paths the sidecar generates) natively, so strokes
// match excalidraw.com. Milestone 1: live view with pan and zoom; editing comes next.
// Mouse: drag the background or scroll to pan, cmd/ctrl-scroll to zoom at the pointer.
// Keys: + / - zoom, 0 fit the scene (and keep fitting as it changes), 1 actual size, f Herdr frame-rate HUD.
// Units: camera offsets and .left()/.w() are logical px (the app zoom multiplies them); paths are built in
// device px (scale = camera zoom x app zoom); pointer positions arrive in device px.
import { hide_fps_monitor, show_fps_monitor } from "gpui-fps";
import { type Context, div, type Element, type FocusHandle, View } from "gpui-kit";
import { fonts, settings } from "herdr";
import { WebSocket } from "websocket";
import { type Camera, fit, pan, zoomAt } from "../canvas/camera.ts";
import { parseServerMessage, SIDECAR_PORT } from "../canvas/protocol.ts";
import { applyMessage, emptyScene, type Scene, sceneBounds } from "../canvas/scene.ts";
import type { CanvasElement, TextElement } from "../canvas/types.ts";
import { type BuiltElement, buildElement, hex } from "./paths.ts";

const BACKGROUND = "#ffffff";
const SIDECAR_URL = `ws://127.0.0.1:${SIDECAR_PORT}`;

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

export default class ExcalCanvas extends View {
  private scene: Scene = emptyScene;
  private camera: Camera = { offsetX: 0, offsetY: 0, zoom: 1 };
  /** Fit the scene on every change and resize until the user pans or zooms; key 0 turns it back on. */
  private autoFit = true;
  private viewport = { width: 800, height: 600 }; // logical px
  private readonly built = new Map<string, BuiltElement>();
  private link: Link = "connecting";
  private panning: { x: number; y: number; cam: Camera } | null = null;
  private focus: FocusHandle | null = null;

  override init(_props: unknown, cx: Context): void {
    this.focus = cx.focus_handle();
    cx.spawn(async (cx) => {
      for (let delay = 250; ; delay = Math.min(4000, delay * 2)) {
        if (await this.follow(cx)) delay = 250; // it connected before dropping: retry fast
        this.link = "sidecar down";
        cx.notify();
        await new Promise<void>((resolve) => cx.timer.after(delay, () => resolve()));
      }
    });
  }

  /** Follows the sidecar until the connection drops; true when it had connected. */
  private async follow(cx: Context): Promise<boolean> {
    let connected = false;
    try {
      const ws = await WebSocket.connect(SIDECAR_URL);
      connected = true;
      this.link = "connected";
      cx.notify();
      for (;;) {
        const raw = await ws.read();
        if (typeof raw === "string" && this.receive(raw)) cx.notify(); // the sidecar only sends text frames
      }
    } catch {
      return connected;
    }
  }

  /** Applies one sidecar message; true when something on screen changed. */
  private receive(raw: string): boolean {
    const m = parseServerMessage(raw);
    if (!m) return false;
    if (m.type === "status") this.link = m.upstream === "connected" ? "connected" : "server down";
    const changed = new Set<string>();
    this.scene = applyMessage(this.scene, m, changed);
    for (const id of changed) this.built.delete(id);
    if (this.autoFit) this.fitToScene();
    return true;
  }

  private fitToScene(): void {
    const b = sceneBounds(this.scene);
    if (b) this.camera = fit(b, this.viewport.width, this.viewport.height);
  }

  /** Cached paths for `e` at the current scale; rebuilt when the element or the scale changed. */
  private paths(e: CanvasElement): BuiltElement {
    const scale = this.camera.zoom * appZoom();
    const hit = this.built.get(e.id);
    if (hit && hit.scale === scale) return hit;
    const b = buildElement(e, e.paints ?? [], scale);
    this.built.set(e.id, b);
    return b;
  }

  /** Appends the element's painted paths to `out` (no spread: spread calls are slow in the mod runtime). */
  private drawShape(e: CanvasElement, out: Element[]): void {
    const b = this.paths(e);
    const left = b.worldX * this.camera.zoom + this.camera.offsetX;
    const top = b.worldY * this.camera.zoom + this.camera.offsetY;
    for (const p of b.paints) out.push(window.paint_path(p.path, p.color).absolute().left(left).top(top).size_full());
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
      .text_color(hex(e.strokeColor))
      .opacity(e.opacity / 100)
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

  private statusBar(): Element {
    const n = this.scene.order.length;
    const dot = this.link === "connected" ? "#2f9e44" : this.link === "connecting" ? "#f08c00" : "#e03131";
    return div()
      .absolute()
      .left(10)
      .bottom(8)
      .flex()
      .items_center()
      .gap(6)
      .px(8)
      .py(3)
      .rounded(6)
      .bg("#f1f3f5")
      .text_size(11)
      .text_color("#495057")
      .child(div().w(7).h(7).rounded(4).bg(dot))
      .child(
        `${this.link} · ${n} element${n === 1 ? "" : "s"} · rev ${this.scene.rev} · ${Math.round(this.camera.zoom * 100)}%`,
      );
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

  private view(_cx: Context): Element {
    const z = appZoom();
    const children: Element[] = [];
    for (const e of this.scene.order) {
      if (e.type === "text") children.push(this.drawText(e));
      else this.drawShape(e, children);
    }
    const root = div()
      .id("excal-canvas")
      .relative()
      .size_full()
      .overflow_hidden()
      .bg(BACKGROUND)
      .cursor_grab()
      .on_size_change((size, cx) => {
        this.viewport = { width: size.width / z, height: size.height / z };
        if (this.autoFit) this.fitToScene();
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        this.focus?.focus();
        this.panning = { x: e.position.x, y: e.position.y, cam: this.camera };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.panning) return;
        const p = this.panning;
        this.autoFit = false;
        this.camera = pan(p.cam, (e.position.x - p.x) / z, (e.position.y - p.y) / z);
        cx.notify();
      })
      .on_mouse_up("left", () => {
        this.panning = null;
      })
      .on_hover((hovered) => {
        if (!hovered) this.panning = null; // no pointer capture outside the pane
      })
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control) {
          const at = e.local_position ?? e.position;
          this.camera = zoomAt(this.camera, Math.exp(-e.delta.y / 300), [at.x / z, at.y / z]);
        } else this.camera = pan(this.camera, -e.delta.x / z, -e.delta.y / z);
        this.autoFit = false;
        cx.stop_propagation();
        cx.notify();
      })
      .on_key_down((e, cx) => {
        const centre = [this.viewport.width / 2, this.viewport.height / 2] as const;
        if (e.key === "+" || e.key === "=") this.camera = zoomAt(this.camera, 1.2, centre);
        else if (e.key === "-") this.camera = zoomAt(this.camera, 1 / 1.2, centre);
        else if (e.key === "0") this.autoFit = true;
        else if (e.key === "1") this.camera = zoomAt(this.camera, 1 / this.camera.zoom, centre);
        else if (e.key === "f") {
          if (!hide_fps_monitor()) show_fps_monitor({ anchor: "top_right" }); // Herdr's frame HUD
        } else return;
        if (e.key !== "f") this.autoFit = e.key === "0";
        if (this.autoFit) this.fitToScene();
        cx.stop_propagation();
        cx.notify();
      })
      .children(children)
      .child(this.statusBar());
    return this.focus ? root.track_focus(this.focus) : root;
  }
}
