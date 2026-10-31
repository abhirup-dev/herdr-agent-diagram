// The diagram viewer: a dialog showing one terminal's pinned Mermaid diagrams
// (`herdr-diagram`), as tabs of pages. Props: { terminal, overlay }. Opened by the
// `diagram-pane` header badge or `herdr-app do mod.open --name diagram-popup`
// (then it shows the focused pane's terminal). Reads
// <app home>/data/herdr-agent-diagram/<terminal>/state.json and the raw Pele SVGs
// beside it, substitutes the live theme colors and the app's UI font into a
// cached copy (<pin>-r<rev>.<theme hash>.svg), and marks everything seen while open.
// Keys: ←/→ pages, ↑/↓ or a tab's number for tabs, Esc closes.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, appHome, readTextFile, writeTextFile, watchFolder, closeOverlay, settings, setShared, focused, panes, fonts } from "herdr";

const DATA = "data/herdr-agent-diagram";
const PER_PAGE = 2;
const MAX_SCALE = 1.6;

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
    this.size = { width: 900, height: 600 };
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

  pin(t, p, availW) {
    const file = this.ready[p.id];
    const scale = Math.min(MAX_SCALE, availW / p.width);
    const w = Math.round(p.width * scale), h = Math.round(p.height * scale);
    return v_flex().gap(6).flex_none()
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().text_color(t.foreground).child(p.title))
        .child(div().text_size(11).text_color(t.dim).child(`${p.id} · ${p.type}`)))
      .child(div().id(`pin-${p.id}-${p.rev}`).w_full().overflow_scrollbar().p(10).rounded(8)
        .bg(t.background).border_1().border_color(t.border)
        .child(file ? image(file).w(w).h(h).flex_none() : div().w(w).h(h).flex_none()));
  }

  render(cx) {
    const t = theme();
    cx.spawn((cx) => this.prepare(cx)); // theme or font may have changed since the last render; a no-op otherwise
    const tabs = this.state?.tabs ?? [];
    this.tab = Math.max(0, Math.min(this.tab, tabs.length - 1));
    const cur = tabs[this.tab];
    const pages = cur ? Math.max(1, Math.ceil(cur.pins.length / PER_PAGE)) : 1;
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const shown = cur ? cur.pins.slice(this.page * PER_PAGE, (this.page + 1) * PER_PAGE) : [];
    const availW = Math.max(200, this.size.width - 2 * 18 - 2 * 10 - 12);

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
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "right") this.page = Math.min(pages - 1, this.page + 1);
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
        .when(pages > 1, (el) => el.child(nav("pg-prev", "‹", -1)).child(div().text_size(11).text_color(t.dim).child(`page ${this.page + 1}/${pages}`)).child(nav("pg-next", "›", 1)))
        .child(div().id("close").ml(12).px(8).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(v_flex().id("pins").flex_1().min_h(0).gap(14).overflow_y_scrollbar().pr(6)
        .when(!shown.length, (el) => el.child(div().text_color(t.dim).child(this.terminal ? `No diagrams pinned for ${this.terminal} yet. An agent pins one with: herdr-diagram add file.mmd` : "No terminal is focused.")))
        .children(shown.map((p) => this.pin(t, p, availW))));
  }
}
