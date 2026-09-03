/* The trade, side by side: for each of the five starting colours, the card
   as it ships today (full fill), as a 16% mix over the card (the other
   agent's cut, which the user called "too soft and dull"), and as this
   branch draws it — a supporting card (wash + band + hue eyebrow) and the
   lead card (full fill, made legible). Light and dark. Contrast measured
   for title / figure / sub-label with the same formulas the product uses
   (imported from web/src/lib/widgets.ts via esbuild). */
import { chromium } from '/home/qb/temp_sch_erp-/node_modules/playwright/index.mjs'
import esbuild from '/home/qb/temp_sch_erp-/web/node_modules/esbuild/lib/main.js'
import fs from 'node:fs'

const ROOT = '/home/qb/temp_sch_erp-/.claude/worktrees/agent-aa628941c4cdf89e7'
const tmp = '/tmp/claude-1000/-home-qb-temp-sch-erp-/beaf6ca8-5684-4269-b99d-ba4dbf32f1b1/scratchpad'
fs.mkdirSync(tmp, { recursive: true })
let src = fs.readFileSync(ROOT + '/web/src/lib/widgets.ts', 'utf8')
src = src.replace(/^import .*$/gm, '').replace(/export function useLayout[\s\S]*$/m, '') // pure helpers only
fs.writeFileSync(tmp + '/widgets.mjs', esbuild.transformSync(src, { loader: 'ts', format: 'esm' }).code)
const W = await import(tmp + '/widgets.mjs')

const hex2rgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16))
const rgb = (t) => hex2rgb(W.hslToHex(t))
const mix = (a, b, k) => a.map((v, i) => Math.round(v * k + b[i] * (1 - k)))
const C = (fg, bg) => +W.contrastOf(fg, bg).toFixed(2)
const css = (c) => `rgb(${c.join(',')})`

const themes = {
  light: { card: [255, 255, 255], ink: [10, 11, 13], bg: [244, 245, 247], wash: (t) => ({ h: t.h, s: t.s * 0.75, l: 86 }), eyebrow: (t) => ({ h: t.h, s: t.s * 0.9, l: 28 }) },
  dark: { card: [28, 30, 38], ink: [255, 255, 255], bg: [13, 15, 20], wash: (t) => ({ h: t.h, s: t.s * 0.55, l: 26 }), eyebrow: (t) => ({ h: t.h, s: t.s * 0.8, l: 82 }) },
}

function variants(t, th) {
  const out = []
  // 1. as shipped: full fill, inkFor, sub at 0.6 alpha
  { const bg = rgb(t); const ink = hex2rgb(W.inkFor(t)); const sub = mix(ink, bg, 0.6)
    out.push({ name: 'Today: full fill', bg, ink, sub, band: null, c: [C(ink, bg), C(ink, bg), C(sub, bg)] }) }
  // 2. 16% mix over the card, theme ink, sub at 0.6
  { const bg = mix(rgb(t), th.card, 0.16); const ink = th.ink; const sub = mix(ink, bg, 0.6)
    out.push({ name: '16% mix (other cut)', bg, ink, sub, band: null, c: [C(ink, bg), C(ink, bg), C(sub, bg)] }) }
  // 3. this branch, supporting card: wash + band + hue eyebrow, theme ink
  { const bg = rgb(th.wash(t)); const ink = th.ink; const sub = rgb(th.eyebrow(t))
    out.push({ name: 'This branch: supporting', bg, ink, sub, band: rgb(t), c: [C(ink, bg), C(ink, bg), C(sub, bg)] }) }
  // 4. this branch, lead card: legible fill, quiet floor
  { const f = W.legibleFill(t); const bg = rgb(f); const ink = hex2rgb(W.inkFor(f)); const a = W.quietFloor(f); const sub = mix(ink, bg, a)
    out.push({ name: `This branch: lead (l ${Math.round(t.l)}→${Math.round(f.l)}, quiet ${a})`, bg, ink, sub, band: null, c: [C(ink, bg), C(ink, bg), C(sub, bg)] }) }
  return out
}

const rows = []
let html = `<style>body{margin:0;font-family:Inter,system-ui,sans-serif;font-size:12px}
.theme{padding:20px 24px}.light{background:#f4f5f7;color:#0a0b0d}.dark{background:#0d0f14;color:#fff}
h2{font-size:13px;font-weight:600;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(4,232px);gap:10px;margin-bottom:14px}
.card{position:relative;overflow:hidden;border-radius:8px;height:118px;padding:14px 14px 10px;box-sizing:border-box}
.band{position:absolute;left:0;right:0;top:0;height:4px}.t{font-size:14px;line-height:1.2}.s{font-size:10px;letter-spacing:.04em;margin-top:3px}
.f{font-size:34px;font-weight:650;letter-spacing:-.035em;line-height:.95;margin-top:8px;font-variant-numeric:tabular-nums}
.m{font-size:9.5px;margin-top:6px;opacity:.85;font-variant-numeric:tabular-nums}.hd{font-size:10px;opacity:.7;margin:0 0 6px}
.bad{color:#c0392b;font-weight:700}.dark .bad{color:#ff8fa3}</style>`
for (const [name, th] of Object.entries(themes)) {
  html += `<div class="theme ${name}"><h2>${name} theme — contrast: title / figure / sub-label (4.5:1 floor)</h2>`
  html += `<div class="grid"><div class="hd">Today: full fill (as shipped)</div><div class="hd">16% mix over the card (other cut)</div><div class="hd">This branch: supporting card</div><div class="hd">This branch: lead card</div></div>`
  for (const t of W.TINT_STARTS) {
    html += `<div class="grid">`
    for (const v of variants(t, th)) {
      const cc = v.c.map((x) => x < 4.5 ? `<span class="bad">${x}</span>` : x).join(' / ')
      html += `<div class="card" style="background:${css(v.bg)};color:${css(v.ink)}">${v.band ? `<div class="band" style="background:${css(v.band)}"></div>` : ''}<div class="t">Outstanding</div><div class="s" style="color:${css(v.sub)}">THIS MONTH</div><div class="f">₹1,23,400</div><div class="m">${cc}</div></div>`
      rows.push({ theme: name, tint: `h${Math.round(t.h)}`, variant: v.name, title: v.c[0], figure: v.c[1], sub: v.c[2], ink: css(v.ink) })
    }
    html += `</div>`
  }
  html += `</div>`
}
fs.writeFileSync(ROOT + '/ui-pass/strip.html', html)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1020, height: 1500 } })
await p.setContent(html)
await p.screenshot({ path: ROOT + '/ui-pass/strip-light-and-dark.png', fullPage: true })
await b.close()
console.table(rows)
