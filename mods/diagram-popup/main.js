// The diagram viewer: a dialog showing one terminal's pinned Mermaid diagrams
// (`herdr-diagram`), as tabs of pages. Props: { terminal, overlay }. Opened by the
// `diagram-pane` header badge or `herdr-app do mod.open --name diagram-popup`
// (then it shows the focused pane's terminal). Reads
// <app home>/data/herdr-agent-diagram/<terminal>/state.json and the raw Pele SVGs
// beside it, substitutes the live theme colors and the app's UI font into a
// cached copy (<pin>-r<rev>.<theme hash>.svg), and marks everything seen while open.
// Each diagram sits in a viewport, fitted by default; its toolbar zooms (− + fit 1:1), pans (← ↑ ↓ →) and
// maximises it. Drag or scroll pans, ⌘/ctrl-scroll zooms, double-click maximises.
// Keys: ←/→ pages, ↑/↓ or a tab's number for tabs, + - 0 zoom and fit, f maximises; while maximised the
// arrows pan. Esc leaves maximised, then closes.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, appHome, readTextFile, writeTextFile, watchFolder, closeOverlay, settings, setShared, focused, panes, fonts } from "herdr";

const DATA = "data/herdr-agent-diagram";
const PER_PAGE = 2;
const MAX_SCALE = 1.6; // fitted diagrams grow at most this much
const MAX_ZOOM = 3;     // the CLI rasterises at 4x the logical size; past ~3x it blurs on retina
const STEP = 80;        // px per pan button press
const HEAD = 28;        // a pin's title row plus gap

// Pele's SVG uses var(--pele-x, default) for colors and font. GPUI's rasteriser has no CSS
// variables (and ignores the root style's font), so resolve them to the theme and stamp the font on every text.
function themed(svg, vars) {
  svg = svg.replace(/var\(--pele-([a-z-]+),([^()]*(?:\([^()]*\))?[^()]*)\)/g, (_, name, d) => vars[name] ?? d.trim());
  const local = {};
  for (const m of svg.matchAll(/--(_[a-z]+):([^;"]+)/g)) local[m[1]] = m[2].trim();
  return svg
    .replace(/var\(--(_[a-z]+)\)/g, (_, k) => local[k] ?? "currentColor")
    .replace(/<text /g, `<text font-family="${vars.font}" `);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export default class DiagramPopup extends View {
  init(_props, cx) {
    this.state = null;
    this.ready = {}; // pin id -> themed svg path (relative to app home)
    this.tab = 0;
    this.page = 0;
    this.box = { width: 900, height: 500 }; // the pins area, measured
    this.view = {}; // pin id -> { z, x, y } once zoomed or panned; absent means fitted
    this.pos = {};  // pin id -> last laid-out { x, y, scale, fit, W, H, sw, sh }
    this.max = null; // the maximised pin's id
    this.drag = null;
    this.h = cx.focus_handle();
    this.terminal = props()?.terminal || focused()?.terminal || panes().find((p) => p.focused)?.terminal;
    if (!this.terminal) return;
    const root = `${appHome()}/${DATA}`;
    this.dir = `${root}/${this.terminal}`;
    cx.spawn(async (cx) => {
      await this.load(cx);
      this.h.focus();
      // Watch the parent: the terminal's folder may not exist until the first pin. Ignore our own themed copies.
      for (;;) {
        const changed = await watchFolder(root);
        if (changed.some((p) => p.includes(`/${this.terminal}/`) && !/\.[a-z0-9]+\.svg$/.test(p))) await this.load(cx);
      }
    });
  }

  vars() {
    const t = theme();
    const s = settings();
    return {
      bg: t.background, fg: t.foreground, muted: t.muted, line: t.foreground, surface: t.surface,
      "surface-alt": t.raised, border: t.border, accent: t.accent,
      // shortcut: GPUI's SVG rasteriser sees only installed fonts (fonts() lists bundled Geist, the rasteriser can't use it),
      // so the nearest installed sans to Geist; revisit when GPUI exposes bundled fonts to svg text
      font: ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"].find((f) => fonts().includes(f)) ?? "sans-serif",
    };
  }

  async load(cx) {
    const text = await readTextFile(`${this.dir}/state.json`);
    try { this.state = text ? JSON.parse(text) : null; } catch { this.state = null; }
    if (this.state) setShared(`diagram.seen.${this.terminal}`, this.state.rev ?? 0);
    cx.notify();
    await this.prepare(cx);
  }

  // Write a themed copy of each pin's SVG for the current theme and font (cached by a hash of both).
  async prepare(cx) {
    const vars = this.vars();
    const key = hash(JSON.stringify(vars));
    let changed = false;
    for (const tab of this.state?.tabs ?? []) {
      for (const p of tab.pins) {
        const rel = p.svg.replace(/\.svg$/, `.${key}.svg`);
        if (this.ready[p.id] === rel) continue;
        const full = `${appHome()}/${rel}`;
        if ((await readTextFile(full)) === null) {
          const raw = await readTextFile(`${appHome()}/${p.svg}`);
          if (raw === null) continue;
          try { await writeTextFile(full, themed(raw, vars), null); } catch (e) {
            // a concurrent prepare() may have created it first; only a still-missing file is an error
            if ((await readTextFile(full)) === null) { this.err = `write ${rel}: ${e?.message ?? e}`; continue; }
          }
        }
        this.ready[p.id] = rel;
        changed = true;
      }
    }
    if (changed) cx.notify();
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  // Zoom pin `id` by `f` around viewport point (cx0, cy0), default its centre; f = null fits it again.
  zoom(id, f, cx0, cy0) {
    const q = this.pos[id];
    if (!q) return;
    if (f === null) { delete this.view[id]; return; }
    const z = Math.max(Math.min(q.fit, 0.2), Math.min(MAX_ZOOM, q.scale * f));
    const k = z / q.scale;
    cx0 ??= q.W / 2; cy0 ??= q.H / 2;
    this.view[id] = { z, x: cx0 - (cx0 - q.x) * k, y: cy0 - (cy0 - q.y) * k };
  }
  pan(id, dx, dy) {
    const q = this.pos[id];
    if (q) this.view[id] = { z: q.scale, x: q.x + dx, y: q.y + dy };
  }
  toggleMax(id) { this.max = this.max === id ? null : id; delete this.view[id]; }

  // Lay pin p out in a W x slotH slot: fitted unless zoomed, centred on an axis it doesn't fill, else clamped to its edges.
  layout(p, W, slotH, maximised) {
    const fit = Math.max(0.05, Math.min(MAX_SCALE, W / p.width, slotH / p.height));
    const H = maximised ? slotH : Math.max(120, Math.min(slotH, Math.ceil(p.height * fit)));
    const v = this.view[p.id];
    const scale = v?.z ?? fit, sw = p.width * scale, sh = p.height * scale;
    const place = (len, size, want) => (size <= len ? (len - size) / 2 : Math.max(len - size, Math.min(0, want ?? 0)));
    return (this.pos[p.id] = { fit, scale, W, H, sw, sh, x: place(W, sw, v?.x), y: place(H, sh, v?.y) });
  }

  pin(t, p, W, slotH, cx) {
    const file = this.ready[p.id];
    const maximised = this.max === p.id;
    const q = this.layout(p, W, slotH, maximised);
    const btn = (id, label, fn) => div().id(`${id}-${p.id}`).px(6).h(22).flex().items_center().rounded(5).cursor_pointer()
      .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { fn(); cx.notify(); }).child(label);
    const sep = () => div().w(1).h(14).mx(2).bg(t.border);
    const tools = h_flex().items_center().gap(1).p(2).rounded(7).bg(t.popover).border_1().border_color(t.border)
      .child(btn("zout", "−", () => this.zoom(p.id, 1 / 1.25))).child(btn("zin", "+", () => this.zoom(p.id, 1.25)))
      .child(btn("fit", "fit", () => this.zoom(p.id, null))).child(btn("one", "1:1", () => this.zoom(p.id, 1 / q.scale)))
      .child(sep())
      .child(btn("pl", "←", () => this.pan(p.id, STEP, 0))).child(btn("pu", "↑", () => this.pan(p.id, 0, STEP)))
      .child(btn("pd", "↓", () => this.pan(p.id, 0, -STEP))).child(btn("pr", "→", () => this.pan(p.id, -STEP, 0)))
      .child(sep())
      .child(btn("max", maximised ? "restore" : "maximise", () => this.toggleMax(p.id)));
    return v_flex().gap(6).flex_none()
      .child(h_flex().gap(8).items_center().h(22)
        .child(div().font_semibold().text_color(t.foreground).child(p.title))
        .child(div().text_size(11).text_color(t.dim).child(`${p.id} · ${p.type} · ${Math.round(q.scale * 100)}%`))
        .child(div().flex_1()).child(tools))
      .child(div().id(`vp-${p.id}-${p.rev}`).relative().overflow_hidden().w(W).h(q.H).rounded(8)
        .bg(t.background).border_1().border_color(t.border).cursor_grab()
        .on_mouse_down("left", (e, cx) => {
          if (e.click_count === 2) { this.toggleMax(p.id); cx.notify(); return; }
          this.drag = { id: p.id, px: e.position.x, py: e.position.y, x: q.x, y: q.y };
        })
        .on_mouse_move((e, cx) => {
          const d = this.drag;
          if (!d || d.id !== p.id) return;
          this.view[p.id] = { z: this.pos[p.id].scale, x: d.x + e.position.x - d.px, y: d.y + e.position.y - d.py };
          cx.notify();
        })
        .on_scroll_wheel((e, cx) => {
          if (e.modifiers?.platform || e.modifiers?.control) {
            this.zoom(p.id, Math.exp(-e.delta.y / 300), e.local_position?.x, e.local_position?.y);
          } else this.pan(p.id, e.delta.x, e.delta.y);
          cx.stop_propagation();
          cx.notify();
        })
        .child(file ? image(file).absolute().left(q.x).top(q.y).w(q.sw).h(q.sh) : div()));
  }

  render(cx) {
    const t = theme();
    cx.spawn((cx) => this.prepare(cx)); // theme or font may have changed since the last render; a no-op otherwise
    const tabs = this.state?.tabs ?? [];
    this.tab = Math.max(0, Math.min(this.tab, tabs.length - 1));
    const cur = tabs[this.tab];
    const pages = cur ? Math.max(1, Math.ceil(cur.pins.length / PER_PAGE)) : 1;
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const maxPin = cur?.pins.find((p) => p.id === this.max);
    if (!maxPin) this.max = null;
    const shown = maxPin ? [maxPin] : cur ? cur.pins.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE) : [];
    const gap = 14;
    // on_size_change reports unzoomed px while .w()/.h() get multiplied by the app zoom: convert to the latter
    const zoom = settings()?.zoom || 1;
    const box = { width: this.box.width / zoom, height: this.box.height / zoom };
    const W = Math.max(200, box.width - 8);
    const n = Math.max(1, shown.length);
    const slotH = Math.max(120, (box.height - gap * (n - 1)) / n - HEAD);
    const target = maxPin?.id ?? shown[0]?.id;

    const tabStrip = h_flex().gap(4).items_center().flex_none().children(tabs.map((tab, i) =>
      div().id(`tab-${i}`).px(10).h(26).flex().items_center().rounded(6).cursor_pointer().text_size(12)
        .when(i === this.tab, (el) => el.bg(t.selected)).text_color(i === this.tab ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.tab = i; this.page = 0; cx.notify(); })
        .child(`${tab.name} (${tab.pins.length})`)));

    const nav = (id, label, d) => div().id(id).px(8).h(24).flex().items_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.page = Math.max(0, Math.min(pages - 1, this.page + d)); cx.notify(); }).child(label);

    return v_flex()
      .id("diagram-popup")
      .track_focus(this.h)
      .size_full().p(18).gap(10).bg(t.popover).text_size(13)
      .on_mouse_up("left", () => { this.drag = null; })
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") { if (this.max) { this.max = null; cx.stop_propagation(); return cx.notify(); } return this.close(); }
        if (this.max && ["left", "right", "up", "down"].includes(k)) {
          const d = { left: [STEP, 0], right: [-STEP, 0], up: [0, STEP], down: [0, -STEP] }[k];
          this.pan(this.max, d[0], d[1]);
        } else if (target && (k === "+" || k === "=")) this.zoom(target, 1.25);
        else if (target && k === "-") this.zoom(target, 1 / 1.25);
        else if (target && k === "0") this.zoom(target, null);
        else if (target && k === "f") this.toggleMax(target);
        else if (k === "right") this.page = Math.min(pages - 1, this.page + 1);
        else if (k === "left") this.page = Math.max(0, this.page - 1);
        else if (k === "down") { this.tab = (this.tab + 1) % Math.max(1, tabs.length); this.page = 0; }
        else if (k === "up") { this.tab = (this.tab + tabs.length - 1) % Math.max(1, tabs.length); this.page = 0; }
        else if (/^[1-9]$/.test(k) && +k <= tabs.length) { this.tab = +k - 1; this.page = 0; }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(10).flex_none()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Diagrams"))
        .child(div().text_size(11).text_color(t.dim).child(this.terminal ?? "no terminal"))
        .when(Boolean(this.err), (el) => el.child(div().text_size(11).text_color(t.blocked).truncate().child(this.err)))
        .child(tabStrip)
        .child(div().flex_1())
        .when(pages > 1 && !maxPin, (el) => el.child(nav("pg-prev", "‹", -1)).child(div().text_size(11).text_color(t.dim).child(`page ${this.page + 1}/${pages}`)).child(nav("pg-next", "›", 1)))
        .child(div().id("close").ml(12).px(8).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(v_flex().id("pins").flex_1().min_h(0).gap(gap).overflow_hidden()
        .on_size_change((size, cx) => { if (size.width !== this.box.width || size.height !== this.box.height) { this.box = size; cx.notify(); } })
        .when(!shown.length, (el) => el.child(div().text_color(t.dim).child(this.terminal ? `No diagrams pinned for ${this.terminal} yet. An agent pins one with: herdr-diagram add file.mmd` : "No terminal is focused.")))
        .children(shown.map((p) => this.pin(t, p, W, slotH, cx))));
  }
}
