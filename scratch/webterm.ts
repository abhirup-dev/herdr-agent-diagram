#!/usr/bin/env bun
// Spike: a web page inside a terminal. Bun.WebView (system WebKit on macOS, headless) renders the page;
// frames go to the terminal as Kitty graphics, terminal mouse/keys go back as page events.
//   bun scratch/webterm.ts [url] [--res 1|2]      ctrl-q quits
// --res 1 (default, fast): the page is laid out at the pane's size but rendered at half the device pixels
//   (viewport halved + CSS zoom 0.5): a frame captures in ~17 ms instead of ~71 ms; text is a little soft.
// --res 2: full retina frames.
// Frames are captured back to back for a moment after any input, otherwise every POLL ms (agent edits).
// Drags are synthetic PointerEvents via evaluate() (the WebKit backend has no CDP or mouse down/move/up);
// a press without movement is a real view.click(). Queued mouse moves are merged. Wheel scrolls at the
// viewport centre (API limit).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--") && !/^\d$/.test(a)) ?? "http://127.0.0.1:3000";
const res = args.includes("--res") ? Number(args[args.indexOf("--res") + 1]) : 1;
const ZOOM = res === 1 ? 0.5 : 1; // page zoom: layout px -> rendered CSS px
const DPR = 2; // WebKit renders at the screen's scale
const HOT_MS = 700, POLL = 120;
const out = (s: string) => process.stdout.write(s);
const log = (s: string) => appendFileSync("/tmp/webterm.log", `${new Date().toISOString()} ${s}\n`);

let cell = { w: 0, h: 0 }; // device px per cell, from CSI 16 t
let pixelMouse = false; // terminal confirmed SGR-pixel mouse (1016)

process.stdin.setRawMode(true);
process.stdin.resume();
out("\x1b[?1049h\x1b[?25l\x1b[2J"); // alt screen, hide cursor
out("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016h"); // mouse: press, drag, any motion, SGR, SGR pixels
out("\x1b[16t\x1b[?1016$p"); // ask: cell size in px, pixel mouse supported?

const view = new Bun.WebView({ width: 800, height: 600 });
// Only one evaluate() may be pending per view: everything that evaluates goes through the input queue.
const applyZoom = () => ZOOM !== 1 && view.evaluate(`document.documentElement.style.zoom = "${ZOOM}"`);
view.onNavigated = () => push({ kind: "zoom" });
const size = () => {
  const cw = cell.w || 18, ch = cell.h || 38; // fallback: roughly a retina 16px font
  const cols = process.stdout.columns, rows = process.stdout.rows;
  const layoutW = (cols * cw) / DPR, layoutH = (rows * ch) / DPR; // page layout in CSS px, matching the pane
  return { cols, rows, w: Math.floor(layoutW * ZOOM), h: Math.floor(layoutH * ZOOM) };
};

// --- frames ---
let last = 0n, id = 1, frames = 0, sent = 0, hotUntil = 0, wake: (() => void) | null = null;
const kick = () => { hotUntil = performance.now() + HOT_MS; wake?.(); };
async function frameLoop() {
  for (;;) {
    try {
      const png = (await view.screenshot({ format: "png", encoding: "buffer" })) as Buffer;
      frames++;
      const h = BigInt(Bun.hash(png));
      if (h !== last) { last = h; draw(png); sent++; }
    } catch (e) { log(`frame: ${e}`); }
    if (performance.now() > hotUntil) await new Promise<void>((r) => { wake = r; setTimeout(r, POLL); }), (wake = null);
  }
}
function draw(png: Buffer) {
  const { cols, rows } = size();
  const b64 = png.toString("base64");
  const next = id === 1 ? 2 : 1;
  let s = "\x1b7\x1b[H";
  for (let i = 0; i < b64.length; i += 4096) {
    const chunk = b64.slice(i, i + 4096), more = i + 4096 < b64.length ? 1 : 0;
    s += i === 0 ? `\x1b_Gf=100,a=T,i=${next},p=1,q=2,C=1,c=${cols},r=${rows},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`;
  }
  s += `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\\x1b8`; // drop the previous image after the new one is up: no flicker
  id = next;
  out(s);
}
setInterval(() => { log(`fps captured=${frames / 5} sent=${sent / 5}`); frames = sent = 0; }, 5000);

// --- input ---
type P = { x: number; y: number }; // page layout px
let down: (P & { dragged: boolean }) | null = null;
const toLayout = (x: number, y: number): P => {
  if (pixelMouse) return { x: (x - 1) / DPR, y: (y - 1) / DPR };
  const cw = cell.w || 18, ch = cell.h || 38;
  return { x: ((x - 0.5) * cw) / DPR, y: ((y - 0.5) * ch) / DPR };
};
// Hit-test in rendered (zoomed) px, but hand Excalidraw layout px: its coordinate math ignores CSS zoom.
const ptr = (type: string, p: P, buttons: number, fresh = false) =>
  view.evaluate(`(() => {
    const at = document.elementFromPoint(${p.x * ZOOM}, ${p.y * ZOOM});
    if (${fresh}) window.__wt = at;
    const el = ${type === "pointermove" && !buttons ? "at" : "window.__wt || at"};
    if (!el) return;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: ${p.x}, clientY: ${p.y}, button: 0, buttons: ${buttons}, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("${type}", o));
    el.dispatchEvent(new MouseEvent("${type.replace("pointer", "mouse")}", o));
  })()`);

async function mouse(b: number, x: number, y: number, release: boolean) {
  const p = toLayout(x, y);
  const motion = (b & 32) !== 0, btn = b & 3, wheel = (b & 64) !== 0;
  if (wheel) return view.scroll(0, btn === 0 ? -80 : 80);
  if (release) {
    const d = down; down = null;
    if (!d) return;
    if (d.dragged) await ptr("pointerup", p, 0);
    else await view.click(d.x * ZOOM, d.y * ZOOM, btn === 2 ? { button: "right" } : undefined);
    return;
  }
  if (!motion) { down = { ...p, dragged: false }; return; }
  if (down && btn !== 3) {
    if (!down.dragged) { down.dragged = true; await ptr("pointerdown", down, 1, true); }
    await ptr("pointermove", p, 1);
  } else await ptr("pointermove", p, 0);
}

const named: Record<string, string> = { "\r": "Enter", "\x7f": "Backspace", "\t": "Tab", "\x1b": "Escape", "\x1b[A": "ArrowUp", "\x1b[B": "ArrowDown", "\x1b[C": "ArrowRight", "\x1b[D": "ArrowLeft", "\x1b[3~": "Delete", " ": "Space" };
async function key(k: string) {
  if (k === "\x11") return quit(); // ctrl-q
  if (named[k]) return view.press(named[k]);
  const c = k.charCodeAt(0);
  if (k.length === 1 && c >= 1 && c <= 26) return view.press(String.fromCharCode(c + 96), { modifiers: ["Meta"] }); // ctrl-x -> cmd-x
  const editing = await view.evaluate(`(() => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName)); })()`);
  if (editing) return view.type(k);
  for (const ch of k) await view.press(ch);
}

// One worker drains the input queue in order; a run of mouse moves collapses to its last one.
type Ev = { kind: "mouse"; b: number; x: number; y: number; release: boolean } | { kind: "key"; k: string } | { kind: "resize" } | { kind: "zoom" };
const queue: Ev[] = [];
let draining = false;
const isMove = (e?: Ev) => e?.kind === "mouse" && (e.b & 32) !== 0 && !e.release;
async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const e = queue.shift()!;
    if (isMove(e) && isMove(queue[0]) && (queue[0] as any).b === (e as any).b) continue; // a newer move supersedes it
    try {
      if (e.kind === "mouse") await mouse(e.b, e.x, e.y, e.release);
      else if (e.kind === "key") await key(e.k);
      else if (e.kind === "zoom") await applyZoom();
      else await resize();
    } catch (err) { log(`input: ${err}`); }
    kick();
  }
  draining = false;
}
const push = (e: Ev) => { queue.push(e); kick(); drain(); };

let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("latin1");
  for (;;) {
    let m: RegExpExecArray | string[] | null;
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf))) push({ kind: "mouse", b: +m[1], x: +m[2], y: +m[3], release: m[4] === "m" });
    else if ((m = /^\x1b\[6;(\d+);(\d+)t/.exec(buf))) { cell = { h: +m[1], w: +m[2] }; log(`cell ${m[2]}x${m[1]}`); push({ kind: "resize" }); }
    else if ((m = /^\x1b\[\?1016;(\d)\$y/.exec(buf))) { pixelMouse = m[1] === "1" || m[1] === "2"; log(`pixel mouse ${m[1]}`); }
    else if ((m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(buf))) push({ kind: "key", k: m[0] });
    else if (buf.length) { m = [buf[0]]; push({ kind: "key", k: m[0] }); }
    else break;
    buf = buf.slice(m[0].length);
  }
});

async function resize() {
  const s = size();
  await view.resize(Math.max(100, s.w), Math.max(100, s.h));
  last = 0n; // force a redraw at the new size
  log(`viewport ${s.w}x${s.h} css (zoom ${ZOOM}) for ${s.cols}x${s.rows} cells`);
}
process.stdout.on("resize", () => push({ kind: "resize" }));

function quit() {
  out("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  view.close();
  process.exit(0);
}
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);

await Bun.sleep(300); // let the terminal answer the size queries
log(`start ${url} res=${res} cell=${JSON.stringify(cell)} pixelMouse=${pixelMouse}`);
await resize();
await view.navigate(url); // onNavigated queues the zoom
frameLoop();
