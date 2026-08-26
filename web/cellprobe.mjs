/* Measure every Bento cell in a real browser.

   Reading the CSS cannot answer "does the corner button overlap the drawing" —
   that is a question about boxes after layout, and only a layout engine knows.
   So: sign in as each role, open its board, and for every .bento-cell report
   whether its contents overflow it and whether the action square lands on top
   of anything. */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'https://temperp.187-127-178-100.sslip.io'
const PW = process.env.UI_PROBE_PASSWORD
if (!PW) { console.error('set UI_PROBE_PASSWORD'); process.exit(2) }

const ROLES = ['institution_admin','faculty','finance','admissions','hr','parent','student','hod','librarian','transport_manager','front_office','seller_admin','super_admin']
const VIEWPORTS = [{ name: 'desktop', width: 1600, height: 900 }, { name: 'tablet', width: 900, height: 1000 }, { name: 'phone', width: 390, height: 844 }]

const browser = await chromium.launch()
const rows = []

for (const role of ROLES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    try {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
      await page.fill('input[name="identifier"]', `${role}@vivencia.test`)
      await page.fill('input[name="password"]', PW)
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), page.click('button[type="submit"]')])
      await page.waitForTimeout(2500)

      const r = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.bento-cell')]
        const out = { total: cells.length, overflow: [], collide: [], tiny: [], clipped: [] }
        const rect = (e) => e.getBoundingClientRect()
        const hit = (a, b) => !(a.right <= b.left + 0.5 || a.left >= b.right - 0.5 || a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5)
        for (const c of cells) {
          const name = (c.querySelector('p')?.textContent || '').trim().slice(0, 32) || '(unnamed)'
          const cr = rect(c)
          if (cr.width < 4 || cr.height < 4) { out.tiny.push(name); continue }
          // content taller than the box it lives in
          const shell = c.querySelector(':scope > div, :scope > a')
          if (shell && shell.scrollHeight > shell.clientHeight + 2) out.overflow.push(`${name} +${shell.scrollHeight - shell.clientHeight}px`)
          // the corner action against everything else the cell lays out
          const cue = c.querySelector('.bento-cue')
          if (cue) {
            const qr = rect(cue)
            for (const el of c.querySelectorAll('p, b, span[role="img"], div[role="img"], svg')) {
              if (cue.contains(el) || el.contains(cue)) continue
              const er = rect(el)
              if (er.width < 2 || er.height < 2) continue
              if (hit(qr, er)) { out.collide.push(`${name} <- ${(el.textContent||el.tagName).trim().slice(0,24)}`); break }
            }
          }
          // any text cut off by its own box
          for (const p of c.querySelectorAll('p, b')) {
            if (p.scrollWidth > p.clientWidth + 2 && !p.className.includes('truncate') && !p.className.includes('line-clamp')) {
              out.clipped.push(`${name} :: ${p.textContent.trim().slice(0,24)}`); break
            }
          }
        }
        return out
      })
      rows.push({ role, vp: vp.name, ...r })
    } catch (e) {
      rows.push({ role, vp: vp.name, total: -1, error: String(e).slice(0, 90), overflow: [], collide: [], tiny: [], clipped: [] })
    }
    await ctx.close()
  }
}
await browser.close()

let cells = 0, ov = 0, co = 0, cl = 0, ti = 0
console.log(`\n${'role'.padEnd(20)}${'view'.padEnd(9)}${'cells'.padStart(6)}${'overflow'.padStart(10)}${'collide'.padStart(9)}${'clipped'.padStart(9)}${'tiny'.padStart(6)}`)
for (const r of rows) {
  if (r.total < 0) { console.log(`${r.role.padEnd(20)}${r.vp.padEnd(9)}  ERROR ${r.error}`); continue }
  cells += r.total; ov += r.overflow.length; co += r.collide.length; cl += r.clipped.length; ti += r.tiny.length
  console.log(`${r.role.padEnd(20)}${r.vp.padEnd(9)}${String(r.total).padStart(6)}${String(r.overflow.length).padStart(10)}${String(r.collide.length).padStart(9)}${String(r.clipped.length).padStart(9)}${String(r.tiny.length).padStart(6)}`)
}
console.log(`\nTOTAL cells measured ${cells} | overflow ${ov} | action collisions ${co} | clipped text ${cl} | zero-size ${ti}`)
for (const r of rows) {
  const bad = [...r.overflow.map(x=>['overflow',x]), ...r.collide.map(x=>['collide',x]), ...r.clipped.map(x=>['clipped',x])]
  if (bad.length) { console.log(`\n--- ${r.role} / ${r.vp}`); for (const [k,v] of bad.slice(0,8)) console.log(`    ${k}: ${v}`) }
}
