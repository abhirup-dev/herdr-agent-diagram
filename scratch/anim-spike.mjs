import fs from 'node:fs'
import { render } from 'pele'
import { Resvg } from '@resvg/resvg-js'
import gifenc from 'gifenc'
const { GIFEncoder, quantize, applyPalette } = gifenc
import { flatten } from '../bin/herdr-diagram.mjs'
let src
for (const h of ['usecase-beta', 'usecase']) {
  src = `${h}\n  actor User\n  User e1@--> Login\n  Login e2@--> Dashboard\n  e1@{ animate: true }\n  e2@{ animation: slow }\n`
  try { render(src); break } catch (e) { console.log(h, 'fails:', e.message); src = null }
}
if (!src) process.exit(1)
const out = render(src, { fontFamily: 'Helvetica' })
let svg = flatten(out.svg)
console.log('classes:', svg.match(/class="pele-edge[^"]*"/g), 'dash:', svg.match(/stroke-dasharray="[^"]*"/g))
const W = out.width * 2, H = out.height * 2
const frames = 14, cycle = 14 // dasharray 9 5 = period 14
const gif = GIFEncoder()
for (let i = 0; i < frames; i++) {
  const f = svg.replace(/stroke-dasharray="9 5"/g, `stroke-dasharray="9 5" stroke-dashoffset="${-(i * cycle / frames)}"`)
  const png = new Resvg(f, { fitTo: { mode: 'width', value: W }, background: '#ffffff', font: { loadSystemFonts: true } }).render()
  fs.mkdirSync(process.env.HOME + '/.config/herdr-app/data/herdr-agent-diagram/t63', { recursive: true })
  fs.writeFileSync(process.env.HOME + `/.config/herdr-app/data/herdr-agent-diagram/t63/anim-${i}.png`, png.asPng())
  const rgba = png.pixels
  const palette = quantize(rgba, 64)
  gif.writeFrame(applyPalette(rgba, palette), png.width, png.height, { palette, delay: 70 })
}
gif.finish()
fs.mkdirSync(process.env.HOME + '/.config/herdr-app/data/herdr-agent-diagram/t64', { recursive: true })
fs.writeFileSync(process.env.HOME + '/.config/herdr-app/data/herdr-agent-diagram/t64/anim.gif', gif.bytes())
console.log('gif', gif.bytes().length, 'bytes', out.width, out.height)
