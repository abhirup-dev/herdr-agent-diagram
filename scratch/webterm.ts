#!/usr/bin/env bun
// Spike: a web page inside a terminal. Bun.WebView (system WebKit on macOS, headless) renders the page;
// frames go to the terminal as Kitty graphics, terminal mouse/keys go back as page events.
//   bun scratch/webterm.ts [url] [--scale 2]      ctrl-q quits
// Drags are synthetic PointerEvents via evaluate() (WebKit backend has no CDP / mouse down-move-up API);
// a press without movement is a real view.click(). Wheel scrolls at the viewport centre (API limit).
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3000";
const scale = Number(args[args.indexOf("--scale") + 1]) || 2; // device px per CSS px
const out = (s: string) => process.stdout.write(s);
import { appendFileSync } from "node:fs";
const log = (s: string) => { appendFileSync("/tmp/webterm.log", `${new Date().toISOString()} ${s}\n`); return true; };

let cell = { w: 0, h: 0 }; // device px per cell, from CSI 16 t
let pixelMouse = false; // terminal confirmed SGR-pixel mouse (1016)
let buf = "";

process.stdin.setRawMode(true);
process.stdin.resume();
out("\x1b[?1049h\x1b[?25l\x1b[2J"); // alt screen, hide cursor
out("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016h"); // mouse: press, drag, any motion, SGR, SGR pixels
out("\x1b[16t\x1b[?1016$p"); // ask: cell size in px, pixel mouse supported?

const view = new Bun.WebView({ width: 800, height: 600 });
const size = () => {
  const cw = cell.w || 18, ch = cell.h || 38; // fallback: roughly a retina 16px font
  return { cols: process.stdout.columns, rows: process.stdout.rows, w: Math.floor((process.stdout.columns * cw) / scale), h: Math.floor((process.stdout.rows * ch) / scale) };
};

// --- frames ---
let last = 0n, id = 1, frames = 0, sent = 0;
async function frameLoop() {
  for (;;) {
    const t0 = performance.now();
    try {
      const png = (await view.screenshot({ format: "png", encoding: "buffer" })) as Buffer;
      frames++;
      const h = BigInt(Bun.hash(png));
      if (h !== last) { last = h; draw(png); sent++; }
    } catch (e) { log(`frame: ${e}`); }
    await Bun.sleep(Math.max(5, 33 - (performance.now() - t0)));
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
type P = { x: number; y: number };
let down: (P & { dragged: boolean }) | null = null;
let hoverAt = 0;
const toCss = (x: number, y: number): P => {
  if (pixelMouse) return { x: (x - 1) / scale, y: (y - 1) / scale };
  const cw = cell.w || 18, ch = cell.h || 38;
  return { x: ((x - 0.5) * cw) / scale, y: ((y - 0.5) * ch) / scale };
};
const ptr = (type: string, p: P, buttons: number, fresh = false) =>
  view.evaluate(`(() => {
    const at = document.elementFromPoint(${p.x}, ${p.y});
    if (${fresh}) window.__wt = at;
    const el = ${type === "pointermove" && !buttons ? "at" : "window.__wt || at"};
    if (!el) return;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: ${p.x}, clientY: ${p.y}, button: 0, buttons: ${buttons}, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("${type}", o));
    el.dispatchEvent(new MouseEvent("${type.replace("pointer", "mouse")}", o));
  })()`);

async function mouse(b: number, x: number, y: number, release: boolean) {
  const p = toCss(x, y);
  const motion = (b & 32) !== 0, btn = b & 3, wheel = (b & 64) !== 0;
  if (wheel) return view.scroll(0, btn === 0 ? -80 : 80);
  if (release) {
    const d = down; down = null;
    if (!d) return;
    if (d.dragged) await ptr("pointerup", p, 0);
    else await view.click(d.x, d.y, btn === 2 ? { button: "right" } : undefined);
    return;
  }
  if (!motion) { down = { ...p, dragged: false }; return; }
  if (down && btn !== 3) {
    if (!down.dragged) { down.dragged = true; await ptr("pointerdown", down, 1, true); }
    await ptr("pointermove", p, 1);
  } else if (performance.now() - hoverAt > 30) { hoverAt = performance.now(); await ptr("pointermove", p, 0); }
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

let queue = Promise.resolve();
const run = (f: () => Promise<unknown> | unknown) => (queue = queue.then(f).catch((e) => log(`input: ${e}`)) as Promise<void>);
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("latin1");
  for (;;) {
    let m;
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf))) { const [, b, x, y, t] = m; run(() => mouse(+b, +x, +y, t === "m")); }
    else if ((m = /^\x1b\[6;(\d+);(\d+)t/.exec(buf))) { cell = { h: +m[1], w: +m[2] }; log(`cell ${m[2]}x${m[1]}`); run(resize); }
    else if ((m = /^\x1b\[\?1016;(\d)\$y/.exec(buf))) { pixelMouse = m[1] === "1" || m[1] === "2"; log(`pixel mouse ${m[1]}`); }
    else if ((m = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(buf))) { const s = m[0]; run(() => key(s)); }
    else if (buf.length) { m = [buf.startsWith("\x1b") && buf.length === 1 ? "\x1b" : buf[0]]; const s = m[0]; run(() => key(s)); }
    else break;
    buf = buf.slice(m[0].length);
  }
});

async function resize() {
  const s = size();
  await view.resize(Math.max(100, s.w), Math.max(100, s.h));
  last = 0n; // force a redraw at the new size
  log(`viewport ${s.w}x${s.h} css for ${s.cols}x${s.rows} cells`);
}
process.stdout.on("resize", () => run(resize));

function quit() {
  out("\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  view.close();
  process.exit(0);
}
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);

await Bun.sleep(300); // let the terminal answer the size queries
log(`start ${url} cell=${JSON.stringify(cell)} pixelMouse=${pixelMouse}`);
await resize();
await view.navigate(url);
frameLoop();
