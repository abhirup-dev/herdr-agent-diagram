#!/usr/bin/env node
// herdr-diagram: pin Mermaid diagrams for the terminal this agent runs in ($HC_TERMINAL_ID).
// State lives in the Herdr app home so the mod can image() the SVGs by relative path:
//   <app home>/data/herdr-agent-diagram/<terminal>/state.json + <pin>-r<rev>.svg (raw Pele output, CSS variables intact:
//   the viewer mod substitutes the live theme colors and UI font at display time)
//
//   herdr-diagram add [--tab NAME] [--title T] [file]      mermaid or markdown with a ```mermaid fence; stdin if no file
//   herdr-diagram replace <id> [--title T] [file]
//   herdr-diagram remove <id>
//   herdr-diagram check [file | id]                         render only: errors, PNG preview, readability
//   herdr-diagram ls [--json]
//   herdr-diagram clear
// Options: --terminal <addr> (default $HC_TERMINAL_ID)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { render } from "pele";

const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const ROOT = path.join(APP_HOME, "data", "herdr-agent-diagram");
// GPUI rasterises an SVG at its declared width/height, then scales the bitmap: declare it big (retina x zoom x viewer upscale).
const RASTER = 4;
// A typical maximised popup viewport (logical px, 0.85 of a laptop window): below MIN_FIT the text gets hard to read.
const VIEW = { width: 1100, height: 620 };
const MIN_FIT = 0.7;
const hires = (svg) =>
  svg.replace(
    /(<svg[^>]*?)\swidth="([\d.]+)"\sheight="([\d.]+)"/,
    (_, a, w, h) => `${a} width="${Math.round(w * RASTER)}" height="${Math.round(h * RASTER)}"`,
  );

// Markdown with a ```mermaid fence (first fence wins, # heading is the title) or bare mermaid.
export function extract(text) {
  const fence = /```mermaid[^\n]*\n([\s\S]*?)```/.exec(text);
  const head = /^#\s+(.+)$/m.exec(text);
  return { mmd: (fence ? fence[1] : text).trim(), title: fence && head ? head[1].trim() : null };
}

const HELP = `herdr-diagram: pin Mermaid diagrams for the Herdr terminal you run in; they show in the app's pane badge and Diagrams popup.

usage: herdr-diagram <command> [options]

  add [--tab NAME] [--title T] [file]   pin a diagram (file or stdin: bare mermaid, or markdown with a \`\`\`mermaid fence
                                        and a # heading as the title); prints its id, a PNG preview path
                                        and how readable it will be in the popup
  replace <id> [--title T] [file]       redraw a pin in place (same id, same tab)
  remove <id>                           unpin; an emptied tab goes with it
  check [file | id]                     render without pinning: Pele errors, a PNG preview to look at,
                                        readability warnings (no terminal needed for a file or stdin)
  ls [--json]                           tabs, ids, titles and sizes
  clear                                 remove every pin of this terminal
  help                                  this text

options:
  --tab NAME         group pins in a tab (default "Diagrams"); one tab per topic
  --title T          the pin's title (else the markdown heading, else the diagram type)
  --terminal ADDR    act for another terminal (default $HC_TERMINAL_ID, set inside herdr-core terminals)

Rendering is Pele (every Mermaid 12.1 diagram type); a diagram Pele can't draw is refused with the reason, nothing is stored.
Every pin also has <id>.png beside its state (light theme), for checking what you drew.
`;
// A PNG preview for the agent to look at: Pele's light defaults for var(--pele-x, d), an installed sans on every <text>
// (the mod themes its own copy at display time; resvg, like GPUI, has no CSS variables).
function toPng(raw, file) {
  let svg = raw.replace(/var\(--pele-[a-z-]+,([^()]*(?:\([^()]*\))?[^()]*)\)/g, (_, d) => d.trim());
  const local = {};
  for (const m of svg.matchAll(/--(_[a-z]+):([^;"]+)/g)) local[m[1]] = m[2].trim();
  svg = svg
    .replace(/var\(--(_[a-z]+)\)/g, (_, k) => local[k] ?? "currentColor")
    .replace(/<text /g, '<text font-family="Helvetica Neue" ');
  const png = new Resvg(svg, {
    background: "white",
    fitTo: { mode: "zoom", value: 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  })
    .render()
    .asPng();
  fs.writeFileSync(file, png);
}

// How the diagram will read in the popup, as warnings for the agent.
function advice({ width, height }) {
  const fit = Math.min(1, VIEW.width / width, VIEW.height / height);
  const out = [`fits the popup at ${Math.round(fit * 100)}% size`];
  if (fit < MIN_FIT)
    out.push(
      `warning: text shows at ${Math.round(fit * 100)}% when fitted; split it, shorten labels, or switch direction (${width > height ? "TD" : "LR"})`,
    );
  return out;
}

function die(msg) {
  process.stderr.write(`herdr-diagram: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tab" || a === "--title" || a === "--terminal") o[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) o[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

function load(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return { rev: 0, next: 1, tabs: [] };
  }
}
function save(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, ".state.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path.join(dir, "state.json"));
}
function findPin(state, id) {
  for (const tab of state.tabs) {
    const i = tab.pins.findIndex((p) => p.id === id);
    if (i >= 0) return { tab, i, pin: tab.pins[i] };
  }
  return null;
}
function unlinkAssets(dir, pin, keepPng) {
  if (pin.svg) fs.rmSync(path.join(APP_HOME, pin.svg), { force: true });
  if (!keepPng) fs.rmSync(path.join(dir, `${pin.id}.png`), { force: true });
  // themed copies the viewer wrote
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    if (f.startsWith(`${pin.id}-r${pin.rev}.`)) fs.rmSync(path.join(dir, f), { force: true });
}

function renderPin(dir, terminal, id, rev, mmd) {
  let out;
  try {
    out = render(mmd);
  } catch (e) {
    die(`Pele could not draw it: ${e.message}`);
  }
  const svg = path.posix.join("data", "herdr-agent-diagram", terminal, `${id}-r${rev}.svg`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(APP_HOME, svg), hires(out.svg));
  const png = path.join(dir, `${id}.png`);
  toPng(out.svg, png);
  return { svg, png, width: out.width, height: out.height, type: out.mermaidType };
}

function readInput(file) {
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      die(e.message);
    }
  }
  if (process.stdin.isTTY) die("give a file or pipe mermaid on stdin");
  return fs.readFileSync(0, "utf8");
}

// Render without pinning: errors, a PNG to look at, and readability advice.
function check(file, mmd = extract(readInput(file)).mmd, label = "") {
  if (!mmd) die("empty diagram");
  let out;
  try {
    out = render(mmd);
  } catch (e) {
    die(`Pele could not draw it: ${e.message}`);
  }
  const png = path.join(os.tmpdir(), `herdr-diagram-check-${process.pid}.png`);
  toPng(out.svg, png);
  console.log(
    `${label}ok (${out.mermaidType}, ${out.width}x${out.height})\npreview: ${png}\n${advice(out).join("\n")}`,
  );
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = o._;
  if (cmd === undefined || cmd === "help" || o.help || o.h) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "check" && (!rest[0] || fs.existsSync(rest[0]))) return check(rest[0]); // a file or stdin: no terminal needed
  if (!["add", "replace", "remove", "ls", "clear", "check"].includes(cmd))
    die(`unknown command ${cmd}; try herdr-diagram help`);
  const terminal = o.terminal || process.env.HC_TERMINAL_ID;
  if (!terminal) die("no $HC_TERMINAL_ID: run inside a herdr-core terminal or pass --terminal");
  if (/[^A-Za-z0-9_.-]/.test(terminal))
    die(`terminal address "${terminal}" is not a plain id (remote machine/ addresses are not supported yet)`);
  const dir = path.join(ROOT, terminal);
  const state = load(dir);

  if (cmd === "add") {
    const { mmd, title } = extract(readInput(rest[0]));
    if (!mmd) die("empty diagram");
    const id = `d${state.next++}`;
    const rev = state.rev + 1;
    const art = renderPin(dir, terminal, id, rev, mmd);
    const name = o.tab || "Diagrams";
    let tab = state.tabs.find((t) => t.name === name);
    if (!tab) {
      tab = { name, pins: [] };
      state.tabs.push(tab);
    }
    tab.pins.push({ id, title: o.title || title || `${art.type} ${id}`, mmd, rev, ...art });
    state.rev = rev;
    save(dir, state);
    console.log(
      `${id} pinned in tab "${name}" (${art.type}, ${art.width}x${art.height})\npreview: ${art.png}\n${advice(art).join("\n")}`,
    );
  } else if (cmd === "replace") {
    const found = findPin(state, rest[0]) || die(`no pin ${rest[0]}`);
    const { mmd, title } = extract(readInput(rest[1]));
    if (!mmd) die("empty diagram");
    const rev = state.rev + 1;
    const art = renderPin(dir, terminal, found.pin.id, rev, mmd);
    unlinkAssets(dir, found.pin, true);
    found.tab.pins[found.i] = { ...found.pin, title: o.title || title || found.pin.title, mmd, rev, ...art };
    state.rev = rev;
    save(dir, state);
    console.log(
      `${found.pin.id} replaced (${art.type}, ${art.width}x${art.height})\npreview: ${art.png}\n${advice(art).join("\n")}`,
    );
  } else if (cmd === "remove") {
    const found = findPin(state, rest[0]) || die(`no pin ${rest[0]}`);
    unlinkAssets(dir, found.pin);
    found.tab.pins.splice(found.i, 1);
    state.tabs = state.tabs.filter((t) => t.pins.length);
    state.rev++;
    save(dir, state);
    console.log(`${found.pin.id} removed`);
  } else if (cmd === "clear") {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`cleared ${terminal}`);
  } else if (cmd === "check") {
    const found = findPin(state, rest[0]) || die(`no file or pin ${rest[0]}`);
    check(null, found.pin.mmd, `${found.pin.id}: `);
  } else if (cmd === "ls") {
    if (o.json) return console.log(JSON.stringify(state, null, 2));
    if (!state.tabs.length) return console.log(`no pins for ${terminal}`);
    for (const t of state.tabs) {
      console.log(`[${t.name}]`);
      for (const p of t.pins) console.log(`  ${p.id}  ${p.title}  (${p.type}, ${p.width}x${p.height})`);
    }
  }
}

// Only run as a CLI; tests and spikes import extract.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
