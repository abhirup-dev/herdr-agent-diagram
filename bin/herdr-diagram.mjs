#!/usr/bin/env node
// herdr-diagram: pin Mermaid diagrams for the terminal this agent runs in ($HC_TERMINAL_ID).
// State lives in the Herdr app home so the mod can image() the SVGs by relative path:
//   <app home>/data/herdr-agent-diagram/<terminal>/state.json + <pin>-r<rev>.{dark,light}.svg
//
//   herdr-diagram add [--tab NAME] [--title T] [file]      mermaid or markdown with a ```mermaid fence; stdin if no file
//   herdr-diagram replace <id> [--title T] [file]
//   herdr-diagram remove <id>
//   herdr-diagram ls [--json]
//   herdr-diagram clear
// Options: --terminal <addr> (default $HC_TERMINAL_ID), --png (also write a PNG via resvg)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { render } from 'pele'

const APP_HOME = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app')
const ROOT = path.join(APP_HOME, 'data', 'herdr-agent-diagram')
const DARK = { bg: '#1e1e1e', fg: '#e6e6e6', muted: '#a0a0a0', line: '#d0d0d0', surface: '#2b2b2b', 'surface-alt': '#333', border: '#777', accent: '#7f9cf5' }

// From diagram-view/herdr/viewer.mjs: resolve Pele's var(--x, default) chains so resvg/GPUI can draw it.
export function flatten(svg, theme = {}) {
  const vars = {}
  svg = svg.replace(/var\(--pele-([a-z-]+),([^()]*(?:\([^()]*\))?[^()]*)\)/g, (_, name, d) => theme[name] ?? d.trim())
  for (const m of svg.matchAll(/--(_[a-z]+):([^;"]+)/g)) vars[m[1]] = m[2].trim()
  return svg.replace(/var\(--(_[a-z]+)\)/g, (_, k) => vars[k] ?? 'currentColor')
}

// Markdown with a ```mermaid fence (first fence wins, # heading is the title) or bare mermaid.
export function extract(text) {
  const fence = /```mermaid[^\n]*\n([\s\S]*?)```/.exec(text)
  const head = /^#\s+(.+)$/m.exec(text)
  return { mmd: (fence ? fence[1] : text).trim(), title: fence && head ? head[1].trim() : null }
}

function die(msg) { process.stderr.write(`herdr-diagram: ${msg}\n`); process.exit(1) }

function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tab' || a === '--title' || a === '--terminal') o[a.slice(2)] = argv[++i]
    else if (a.startsWith('--')) o[a.slice(2)] = true
    else o._.push(a)
  }
  return o
}

function load(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) } catch { return { rev: 0, next: 1, tabs: [] } }
}
function save(dir, state) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, '.state.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, path.join(dir, 'state.json'))
}
function findPin(state, id) {
  for (const tab of state.tabs) { const i = tab.pins.findIndex(p => p.id === id); if (i >= 0) return { tab, i, pin: tab.pins[i] } }
  return null
}
function unlinkAssets(dir, pin) {
  for (const f of [pin.dark, pin.light, pin.png]) if (f) fs.rmSync(path.join(APP_HOME, f), { force: true })
}

async function renderPin(dir, terminal, id, rev, mmd, png) {
  let out
  try { out = render(mmd) } catch (e) { die(`Pele could not draw it: ${e.message}`) }
  const rel = f => path.posix.join('data', 'herdr-agent-diagram', terminal, f)
  const files = { dark: rel(`${id}-r${rev}.dark.svg`), light: rel(`${id}-r${rev}.light.svg`) }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(APP_HOME, files.dark), flatten(out.svg, DARK))
  fs.writeFileSync(path.join(APP_HOME, files.light), flatten(out.svg))
  if (png) {
    // shortcut: PNG only on request; upgrade to automatic fallback once we know which SVG features GPUI drops
    const { Resvg } = await import('@resvg/resvg-js')
    files.png = rel(`${id}-r${rev}.png`)
    const data = new Resvg(flatten(out.svg, DARK), { fitTo: { mode: 'width', value: Math.min(2400, out.width * 2) }, background: DARK.bg, font: { loadSystemFonts: true } }).render().asPng()
    fs.writeFileSync(path.join(APP_HOME, files.png), data)
  }
  return { ...files, width: out.width, height: out.height, type: out.mermaidType }
}

function readInput(file) {
  if (file) { try { return fs.readFileSync(file, 'utf8') } catch (e) { die(e.message) } }
  if (process.stdin.isTTY) die('give a file or pipe mermaid on stdin')
  return fs.readFileSync(0, 'utf8')
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const [cmd, ...rest] = o._
  const terminal = o.terminal || process.env.HC_TERMINAL_ID
  if (!terminal) die('no $HC_TERMINAL_ID: run inside a herdr-core terminal or pass --terminal')
  if (/[^A-Za-z0-9_.-]/.test(terminal)) die(`terminal address "${terminal}" is not a plain id (remote machine/ addresses are not supported yet)`)
  const dir = path.join(ROOT, terminal)
  const state = load(dir)

  if (cmd === 'add') {
    const { mmd, title } = extract(readInput(rest[0]))
    if (!mmd) die('empty diagram')
    const id = `d${state.next++}`
    const rev = state.rev + 1
    const art = await renderPin(dir, terminal, id, rev, mmd, o.png)
    const name = o.tab || 'Diagrams'
    let tab = state.tabs.find(t => t.name === name)
    if (!tab) state.tabs.push(tab = { name, pins: [] })
    tab.pins.push({ id, title: o.title || title || `${art.type} ${id}`, mmd, rev, ...art })
    state.rev = rev
    save(dir, state)
    console.log(`${id} pinned in tab "${name}" (${art.type}, ${art.width}x${art.height})`)
  } else if (cmd === 'replace') {
    const found = findPin(state, rest[0]) || die(`no pin ${rest[0]}`)
    const { mmd, title } = extract(readInput(rest[1]))
    if (!mmd) die('empty diagram')
    const rev = state.rev + 1
    const art = await renderPin(dir, terminal, found.pin.id, rev, mmd, o.png)
    unlinkAssets(dir, found.pin)
    found.tab.pins[found.i] = { ...found.pin, title: o.title || title || found.pin.title, mmd, rev, ...art }
    state.rev = rev
    save(dir, state)
    console.log(`${found.pin.id} replaced (${art.type}, ${art.width}x${art.height})`)
  } else if (cmd === 'remove') {
    const found = findPin(state, rest[0]) || die(`no pin ${rest[0]}`)
    unlinkAssets(dir, found.pin)
    found.tab.pins.splice(found.i, 1)
    state.tabs = state.tabs.filter(t => t.pins.length)
    state.rev++
    save(dir, state)
    console.log(`${found.pin.id} removed`)
  } else if (cmd === 'clear') {
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`cleared ${terminal}`)
  } else if (cmd === 'ls' || cmd === undefined) {
    if (o.json) return console.log(JSON.stringify(state, null, 2))
    if (!state.tabs.length) return console.log(`no pins for ${terminal}`)
    for (const t of state.tabs) {
      console.log(`[${t.name}]`)
      for (const p of t.pins) console.log(`  ${p.id}  ${p.title}  (${p.type}, ${p.width}x${p.height})`)
    }
  } else die(`unknown command ${cmd}`)
}

main()
