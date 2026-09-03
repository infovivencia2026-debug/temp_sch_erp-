/* The hybrid card over the whole hue wheel: band of the exact colour on top,
   panel = color-mix(in srgb, tint --tint-mix, card), text at FULL ink (the
   [data-tinted] rule). Worst-case contrast for title/figure/sub over
   h = 0..359 at s=100%, l in {40,50,60}, light at 55% and dark at 40%.
   Renders the five starting colours as a strip for the eye. */
import { chromium } from '/home/qb/temp_sch_erp-/node_modules/playwright/index.mjs'
import fs from 'node:fs'
const OUT = '/home/qb/temp_sch_erp-/.claude/worktrees/agent-aa628941c4cdf89e7/ui-pass/'
const hsl2rgb = (h, s, l) => { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l); const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))) }; return [f(0), f(8), f(4)] }
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
const C = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const mix = (t, k, card) => t.map((v, i) => Math.round(v * k + card[i] * (1 - k)))
const themes = { light: { card: [255, 255, 255], ink: [10, 11, 13], mixk: 0.55, page: '#f4f5f7' }, dark: { card: [28, 30, 38], ink: [255, 255, 255], mixk: 0.40, page: '#0d0f14' } }
const report = {}
for (const [name, th] of Object.entries(themes)) {
  let worst = { c: 99 }
  for (let h = 0; h < 360; h++) for (const l of [40, 50, 60]) {
    const panel = mix(hsl2rgb(h, 100, l), th.mixk, th.card)
    const c = C(th.ink, panel)
    if (c < worst.c) worst = { c: +c.toFixed(2), h, l, panel }
  }
  report[name] = worst
}
console.log('worst full-ink contrast on a hybrid tinted card (all text runs are full ink):', JSON.stringify(report))
const STARTS = [[217, 91, 60], [163, 70, 38], [262, 72, 52], [32, 88, 45], [344, 76, 50]]
let html = `<style>body{margin:0;font-family:Inter,system-ui,sans-serif}.t{padding:20px;display:grid;grid-template-columns:repeat(5,190px);gap:10px}.c{position:relative;height:118px;padding:16px;box-sizing:border-box;overflow:hidden}.b{position:absolute;left:0;right:0;top:0;height:4px}.ti{font-size:15px}.s{font-size:12px;margin-top:2px}.f{font-size:34px;font-weight:650;letter-spacing:-.035em;margin-top:8px;line-height:.95}.m{font-size:10px;margin-top:6px}</style>`
for (const [name, th] of Object.entries(themes)) {
  html += `<div class="t" style="background:${th.page};color:rgb(${th.ink})">`
  for (const [h, s, l] of STARTS) { const t = hsl2rgb(h, s, l); const panel = mix(t, th.mixk, th.card); const c = C(th.ink, panel).toFixed(2)
    html += `<div class="c" style="background:rgb(${panel})"><div class="b" style="background:rgb(${t})"></div><div class="ti">Outstanding</div><div class="s">Now</div><div class="f">₹1,23,400</div><div class="m">${c} / ${c} / ${c}</div></div>` }
  html += `</div>`
}
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1040, height: 330 } })
await p.setContent(html); await p.screenshot({ path: OUT + 'after-hybrid-tintstrip-light-and-dark.png', fullPage: true }); await b.close()
fs.writeFileSync(OUT + 'strip-hybrid.html', html)
