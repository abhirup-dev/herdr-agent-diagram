// A badge-only pane header: the count of diagrams the agent in this terminal pinned
// with `herdr-draw mermaid`, in the header's right corner, and nothing at all without one.
// Click it: the `diagram-popup` viewer for this terminal. Once the agent ran `herdr-draw canvas open`, a second
// badge toggles the live Excalidraw canvas (`excal-canvas`) as a pane to the right.
// Layout: { "tab": "active", "pane": { "header": { "content": { "mod": "diagram-pane",
//   "props": { "animate": "always", "period": 1100 } }, "height": 22, "position": "top", "reveal": "hover" } } }
// props.animate: "always" (pulse while there are diagrams), "unseen" (only while one is unopened)
// or "never"; props.period: one pulse, in ms.

import * as fs from "fs/promises";
import { h_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import {
  appHome,
  exec,
  home,
  openOverlay,
  panes,
  props,
  readTextFile,
  run,
  setShared,
  shared,
  theme,
  watchFolder,
} from "herdr";

const DATA = "data/herdr-agent-diagram";
// Debug log for herdr-draw (`herdr-draw logs mod`): the mod runtime has no file append, so the last lines are kept
// here and the file rewritten (one writer at a time). Never throws.
const LOG_MAX = 300;
function modLogger(name) {
  // Mods may only write under the app home (herdr.d.ts), so mod logs live there; `herdr-draw logs` reads both.
  const dir = `${appHome()}/data/herdr-draw/logs`;
  const file = `${dir}/mod-${name}.log`;
  let lines = [];
  let writing = false;
  let again = false;
  let loaded = false;
  // Async work in a mod runs through a view's cx.spawn: lines wait until a view lends its cx (log.use).
  let cx = null;
  const write = async () => {
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    try {
      if (!loaded) {
        loaded = true;
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        const old = await fs.readFile(file, "utf8").catch(() => "");
        lines = old.split("\n").filter(Boolean).slice(-LOG_MAX).concat(lines);
      }
      if (lines.length > LOG_MAX) lines = lines.slice(-LOG_MAX);
      if (lines.length) await fs.writeFile(file, `${lines.join("\n")}\n`);
    } catch {
      // logging must never break the mod
    }
    writing = false;
    if (again) {
      again = false;
      flush();
    }
  };
  const flush = () => {
    if (cx) cx.spawn(write);
  };
  const log = (msg) => {
    lines.push(`${new Date().toISOString()} app mod-${name} info  ${msg}`);
    flush();
  };
  log.use = (viewCx) => {
    cx = viewCx;
    flush();
  };
  return log;
}
const log = modLogger("diagram-pane");
/** Element ids from pane ids: a remote pane's id has a slash ("vpsme/p95b..."). */
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Once per app run: when `herdr-draw install` synced other machines, start the sidecar, which follows their
 * terminals (a remote agent's canvas or pins show here). All header instances share one JS realm.
 */
function startSidecarForRemotes(cx) {
  if (globalThis.__herdrDrawRemotes) return;
  globalThis.__herdrDrawRemotes = true;
  cx.spawn(async () => {
    const text = await readTextFile(`${appHome()}/data/herdr-draw/install.json`);
    const machines = Object.keys((text && JSON.parse(text).machines) || {});
    log(
      `app start: synced machines ${machines.join(", ") || "none"}${machines.length ? ", starting the sidecar" : ""}`,
    );
    if (machines.length)
      await exec(`${home()}/.local/bin/herdr-draw`, ["canvas", "start"]).catch((e) =>
        log(`sidecar start failed: ${e}`),
      );
  });
}

export default class Pane extends View {
  init(_props, cx) {
    this.state = null;
    log.use(cx);
    startSidecarForRemotes(cx);
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
    try {
      this.state = text ? JSON.parse(text) : null;
    } catch {
      this.state = null;
    }
    this.canvas = Boolean(await readTextFile(this.file.replace(/state\.json$/, "canvas.json")));
    cx.notify();
  }

  /** The canvas badge: closes the canvas pane in this tab, or starts the services and splits one in on the right. */
  canvasBadge(t, pane, terminal) {
    if (!this.canvas) return null;
    const tab = panes().find((p) => p.pane === pane)?.tab;
    const open = panes().find((p) => p.mod === "excal-canvas" && p.tab === tab);
    return div()
      .id(`ph-canvas-${safeId(pane)}`)
      .flex_none()
      .px(7)
      .h(18)
      .flex()
      .items_center()
      .rounded(9)
      .bg(open ? t.accent : t.background)
      .border_1()
      .border_color(t.accent)
      .shadow_md()
      .text_size(10.5)
      .font_bold()
      .text_color(open ? t.accent_foreground : t.accent)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        log(`canvas badge clicked on ${terminal} (pane ${pane}): ${open ? "closing" : "opening"} the canvas`);
        if (open) return run("pane.close", { pane: open.pane });
        cx.spawn(async () => {
          await exec(`${home()}/.local/bin/herdr-draw`, ["canvas", "start"]).catch(() => null);
          // The agent's own board (a remote one is machine-qualified, vpsme/t1f); the sidecar's default port.
          run("pane.split", { pane, direction: "right", mod: "excal-canvas", props: { board: terminal, port: 3077 } });
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
      .id(`ph-diag-${safeId(pane)}`)
      .flex_none()
      .px(7)
      .h(18)
      .flex()
      .items_center()
      .gap(4)
      .rounded(9)
      .bg(t.accent)
      .shadow_md()
      .text_size(10.5)
      .font_bold()
      .text_color(t.accent_foreground)
      .when(pulse, (el) => el.loop("opacity", { from: 0.7, to: 1, period: props()?.period ?? 1100 }))
      .hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        log(`pin badge clicked on ${terminal} (pane ${pane}): opening the popup`);
        try {
          openOverlay({ mod: "diagram-popup", props: { terminal }, kind: "dialog", width: 0.85, height: 0.85 });
        } catch (e) {
          log(`openOverlay failed: ${e}`);
        }
        setShared(`diagram.seen.${terminal}`, this.state.rev ?? 0);
      })
      .child("◫")
      .child(String(count));
  }

  render() {
    const { pane, terminal } = props() ?? {};
    const t = theme();
    const badges = terminal ? [this.canvasBadge(t, pane, terminal), this.badge(t, pane, terminal)].filter(Boolean) : [];
    // The strip is drawn over the terminal: barely tinted, so only the badges stand out.
    return h_flex()
      .size_full()
      .justify_end()
      .items_center()
      .gap(4)
      .px(6)
      .bg(t.background + "1a")
      .children(badges);
  }
}
