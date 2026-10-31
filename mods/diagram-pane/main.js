// A badge-only pane header: the count of diagrams the agent in this terminal pinned
// with `herdr-diagram`, in the header's right corner, and nothing at all without one.
// Click it: the `diagram-popup` viewer for this terminal. Once the agent ran `herdr-canvas open`, a second
// badge toggles the live Excalidraw canvas (`excal-canvas`) as a pane to the right.
// Layout: { "tab": "active", "pane": { "header": { "content": { "mod": "diagram-pane",
//   "props": { "animate": "always", "period": 1100 } }, "height": 22, "position": "top", "reveal": "hover" } } }
// props.animate: "always" (pulse while there are diagrams), "unseen" (only while one is unopened)
// or "never"; props.period: one pulse, in ms.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, theme, appHome, home, readTextFile, watchFolder, openOverlay, shared, setShared, panes, run, exec } from "herdr";
import * as fs from "fs/promises";

const DATA = "data/herdr-agent-diagram";

export default class Pane extends View {
  init(_props, cx) {
    this.state = null;
    const terminal = props()?.terminal;
    if (!terminal) return;
    const root = `${appHome()}/${DATA}`;
    this.file = `${root}/${terminal}/state.json`;
    cx.spawn(async (cx) => {
      // The folder may not exist before the first pin: make it so the watcher has something to watch.
      await fs.mkdir(root, { recursive: true }).catch(() => {});
      await this.load(cx);
      for (;;) {
        const changed = await watchFolder(root);
        if (changed.some((p) => p.includes(`/${terminal}/`))) await this.load(cx);
      }
    });
  }

  async load(cx) {
    const text = await readTextFile(this.file);
    try { this.state = text ? JSON.parse(text) : null; } catch { this.state = null; }
    this.canvas = Boolean(await readTextFile(this.file.replace(/state\.json$/, "canvas.json")));
    cx.notify();
  }

  /** The canvas badge: closes the canvas pane in this tab, or starts the services and splits one in on the right. */
  canvasBadge(t, pane) {
    if (!this.canvas) return null;
    const tab = panes().find((p) => p.pane === pane)?.tab;
    const open = panes().find((p) => p.mod === "excal-canvas" && p.tab === tab);
    return div()
      .id(`ph-canvas-${pane}`)
      .flex_none().px(7).h(18).flex().items_center().rounded(9)
      .bg(open ? t.accent : t.background).border_1().border_color(t.accent).shadow_md()
      .text_size(10.5).font_bold()
      .text_color(open ? t.accent_foreground : t.accent)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (open) return run("pane.close", { pane: open.pane });
        cx.spawn(async () => {
          await exec(`${home()}/.local/bin/herdr-canvas`, ["start"]).catch(() => null);
          run("pane.split", { pane, direction: "right", mod: "excal-canvas" });
        });
      })
      .child("✎ canvas");
  }

  badge(t, pane, terminal) {
    const count = (this.state?.tabs ?? []).reduce((n, tab) => n + tab.pins.length, 0);
    if (!count) return null;
    const unseen = (this.state.rev ?? 0) > (shared(`diagram.seen.${terminal}`) ?? 0);
    const animate = props()?.animate ?? "always";
    const pulse = animate === "always" || (animate === "unseen" && unseen);
    return div()
      .id(`ph-diag-${pane}`)
      .flex_none().px(7).h(18).flex().items_center().gap(4).rounded(9)
      .bg(t.accent).shadow_md()
      .text_size(10.5).font_bold()
      .text_color(t.accent_foreground)
      .when(pulse, (el) => el.loop("opacity", { from: 0.7, to: 1, period: props()?.period ?? 1100 }))
      .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        setShared(`diagram.seen.${terminal}`, this.state.rev ?? 0);
        openOverlay({ mod: "diagram-popup", props: { terminal }, kind: "dialog", width: 0.85, height: 0.85 });
      })
      .child("◫")
      .child(String(count));
  }

  render() {
    const { pane, terminal } = props() ?? {};
    const t = theme();
    const badges = terminal ? [this.canvasBadge(t, pane), this.badge(t, pane, terminal)].filter(Boolean) : [];
    // The strip is drawn over the terminal: barely tinted, so only the badges stand out.
    return h_flex().size_full().justify_end().items_center().gap(4).px(6).bg(t.background + "1a").children(badges);
  }
}
