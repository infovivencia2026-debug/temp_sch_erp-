/* Real before/after. Usage:
     node ui-pass/shoot.mjs live before
     node ui-pass/shoot.mjs <distDir> after
   `live` hits https://temperp.187-127-178-100.sslip.io directly. A dist dir is
   served locally with /api, /login, /logout proxied to the live server (host
   header rewritten, cookie attributes relaxed so the browser keeps them on
   127.0.0.1), SPA fallback to index.html. */
import { chromium } from '/home/qb/temp_sch_erp-/node_modules/playwright/index.mjs'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const [, , target, tag] = process.argv
const OUT = '/home/qb/temp_sch_erp-/.claude/worktrees/agent-aa628941c4cdf89e7/ui-pass/'
const LIVE = 'https://temperp.187-127-178-100.sslip.io'
const LIVE_HOST = 'temperp.187-127-178-100.sslip.io'

let base = LIVE
let server
if (target !== 'live') {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/api') || u.pathname === '/login' || u.pathname === '/logout') {
      const headers = { ...req.headers, host: LIVE_HOST }
      delete headers['accept-encoding']
      const up = https.request({ host: LIVE_HOST, port: 443, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (r) => {
        const h = { ...r.headers }
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*secure/ig, '').replace(/;\s*domain=[^;]*/ig, ''))
        if (h.location) h.location = h.location.replace(LIVE, base)
        res.writeHead(r.statusCode, h)
        r.pipe(res)
      })
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
      req.pipe(up)
      return
    }
    let f = path.join(target, decodeURIComponent(u.pathname))
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(target, 'index.html')
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://127.0.0.1:${server.address().port}`
}

const METRICS = () => {
  const cards = [...document.querySelectorAll('[data-card]')]
  const quiet = cards.filter((c) => c.hasAttribute('data-quiet')).length
  const parse = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; const v = m.slice(0, 4).map(Number); if (c.startsWith('color(')) return [v[0] * 255, v[1] * 255, v[2] * 255, ...(v.length > 3 ? [v[3]] : [])].map((x, i) => (i < 3 ? Math.round(x) : x)); return v }
  const alphaOf = (m) => (m[3] === undefined ? 1 : m[3])
  const sat = (c) => { const m = parse(c); if (!m || alphaOf(m) === 0) return 0; const [r, g, bb] = m; const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb); return mx === 0 ? 0 : (mx - mn) / mx }
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const blend = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)))
  const bgOf = (el) => { let e = el; let acc = null; while (e) { const c = getComputedStyle(e).backgroundColor; const m = parse(c); if (m && alphaOf(m) > 0) { if (alphaOf(m) >= 1) return acc ? blend(acc.fg, acc.a, m.slice(0, 3)) : m.slice(0, 3); if (!acc) acc = { fg: m.slice(0, 3), a: alphaOf(m) } } e = e.parentElement } return acc ? blend(acc.fg, acc.a, [255, 255, 255]) : [255, 255, 255] }
  const board = document.querySelector('.bento-board') || document.querySelector('main') || document.body
  let satFills = 0; const satList = []
  for (const el of board.querySelectorAll('*')) { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width * r.height < 2000) continue; const s = sat(cs.backgroundColor); if (s > 0.4) { satFills++; satList.push(cs.backgroundColor + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)) } }
  let upper = 0
  for (const el of board.querySelectorAll('*')) { const cs = getComputedStyle(el); if (cs.textTransform === 'uppercase' && el.textContent.trim() && el.children.length === 0) upper++ }
  let zeroBig = 0; const figSizes = []
  for (const el of board.querySelectorAll('p, span, b')) { const t = el.textContent.trim(); const fs = parseFloat(getComputedStyle(el).fontSize); if (/^[₹Rs.\s]*0(\.0+)?%?$/.test(t) && fs >= 24) zeroBig++ }
  for (const el of board.querySelectorAll('[data-card] p')) { const fs = parseFloat(getComputedStyle(el).fontSize); if (fs >= 18 && el.getBoundingClientRect().width) figSizes.push(Math.round(fs)) }
  const badges = board.querySelectorAll('[class*="badge" i], [data-badge], .bento-badge').length
  const visible = (s) => { let e = s; while (e && e !== document.body) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.display === 'none') return false; e = e.parentElement } return true }
  const arrowEls = [...board.querySelectorAll('svg.lucide-arrow-up-right')].filter((s) => s.getBoundingClientRect().width && visible(s))
  const arrowOpacities = arrowEls.map((s) => { let o = 1; let e = s; while (e && e !== board) { o *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement } return +o.toFixed(2) })
  const fails = []; let checked = 0; let minRatio = 99
  for (const card of cards) {
    for (const el of card.querySelectorAll('*')) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
      const txt = el.textContent.trim(); if (!txt) continue
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
      const cs = getComputedStyle(el); if (!visible(el)) continue
      const fg = parse(cs.color); if (!fg) continue
      let op = 1; let e = el; while (e && e !== board) { op *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement }
      const alpha = alphaOf(fg) * op
      const bg = bgOf(el)
      const eff = blend(fg.slice(0, 3), alpha, bg)
      const L1 = lum(eff), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
      checked++; if (ratio < minRatio) minRatio = ratio
      if (ratio < 4.5) fails.push({ txt: txt.slice(0, 28), ratio: +ratio.toFixed(2), fs: cs.fontSize, fg: eff.join(','), bg: bg.join(',') })
    }
  }
  const sizes = [...new Set(figSizes)].sort((a, b) => b - a)
  // The ink each card's title is drawn in: one colour across the board means no "rainbow of figures".
  const inkColours = [...new Set(cards.map((c) => { const t = c.querySelector('p'); return t ? getComputedStyle(t).color : null }).filter(Boolean))]
  // Load metrics: distinct words on the board, visible elements per card at rest, skeleton consistency, empty-area ratio.
  const words = new Set((board.innerText || '').toLowerCase().split(/[^\p{L}\p{N}₹%]+/u).filter(Boolean))
  const perCard = cards.map((c) => { let n = 0; for (const el of c.querySelectorAll('*')) { if (!visible(el)) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; if ([...el.childNodes].some((k) => k.nodeType === 3 && k.textContent.trim()) || el.tagName === 'svg' || el.classList.contains('bento-cue')) n++ } return n })
  const cells = cards.map((c) => c.closest('.bento-cell')).filter(Boolean)
  const pads = [...new Set(cells.map((c) => { const s = getComputedStyle(c); return `${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft}` }))]
  const radii = [...new Set(cells.map((c) => getComputedStyle(c).borderRadius))]
  const titleSizes = [...new Set(cards.map((c) => { const p = c.querySelector('p'); return p ? getComputedStyle(p).fontSize : null }))]
  const noteSizes = [...new Set(cards.map((c) => { const p = c.querySelector('.card-note'); return p ? getComputedStyle(p).fontSize : null }).filter(Boolean))]
  const figAll = [...new Set(cards.map((c) => { const p = c.querySelector('.card-fig'); return p ? Math.round(parseFloat(getComputedStyle(p).fontSize)) : null }).filter(Boolean))]
  const emptyRatios = cells.map((cell) => { const cr = cell.getBoundingClientRect(); let x1 = 1e9, y1 = 1e9, x2 = 0, y2 = 0; for (const el of cell.querySelectorAll('p, span, b')) { if (!visible(el)) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; if (r.left < cr.left - 1 || r.right > cr.right + 1) continue; x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom) } return x2 > x1 ? +(((x2 - x1) * (y2 - y1)) / (cr.width * cr.height)).toFixed(2) : 0 })
  // Discipline metrics over <main>, visible only: type sizes, background colours, controls, badges, words.
  const main = document.querySelector('main') || document.body
  const vis = [...main.querySelectorAll('*')].filter((el) => { if (!visible(el)) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).clipPath !== 'inset(50%)' && getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)' })
  const typeSizes = [...new Set(vis.filter((el) => [...el.childNodes].some((k) => k.nodeType === 3 && k.textContent.trim())).map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2))].sort((a, b) => a - b)
  const norm = (c) => { const m = parse(c); return m && alphaOf(m) > 0 ? `${m[0]},${m[1]},${m[2]}/${(alphaOf(m)).toFixed(2)}` : null }
  const bgColours = [...new Set(vis.map((el) => norm(getComputedStyle(el).backgroundColor)).filter(Boolean))]
  const surfaceColours = [...new Set(vis.filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height >= 2000 }).map((el) => norm(getComputedStyle(el).backgroundColor)).filter(Boolean))]
  const controls = vis.filter((el) => el.matches('a[href], button, [role="button"], [role="tab"], input, select, textarea') && !el.closest('[data-card][data-quiet]') || (el.matches('.bento-cue') && !el.closest('[data-card][data-quiet]'))).length
  const controlsAll = vis.filter((el) => el.matches('a[href], button, [role="button"], [role="tab"], input, select, textarea, .bento-cue')).length
  const mainWords = new Set((main.innerText || '').toLowerCase().split(/[^\p{L}\p{N}₹%]+/u).filter(Boolean)).size
  const mainBadges = vis.filter((el) => el.matches('[class*="badge" i], [data-badge], .bento-badge')).length
  const discipline = { typeSizes, typeSizeCount: typeSizes.length, bgColours, bgColourCount: bgColours.length, surfaceColours, surfaceColourCount: surfaceColours.length, controlsOpening: controls, controlsAll, mainWords, mainBadges }
  const load = { discipline, distinctWords: words.size, elementsPerCard: perCard, paddings: pads, radii, titleSizes, noteSizes, figSizesAll: figAll, contentToCardRatio: emptyRatios }
  return { inkColours, load, cards: cards.length, quiet, satFills, satList: satList.slice(0, 8), upper, zeroBig, badges, arrows: arrowEls.length, arrowOpacities: [...new Set(arrowOpacities)], figSizes: sizes.slice(0, 6), leadMarked: !!document.querySelector('.bento-widget[data-lead]'), contrastChecked: checked, contrastMin: +minRatio.toFixed(2), failCount: fails.length, contrastFails: fails.slice(0, 10) }
}

const TINTS = JSON.stringify({ placed: [
  { id: 'pulse', w: 2, h: 2, tint: { h: 217, s: 91, l: 60 } },
  { id: 'outstanding', w: 1, h: 1, tint: { h: 344, s: 76, l: 50 } },
  { id: 'students', w: 2, h: 1, tint: { h: 163, s: 70, l: 38 } },
  { id: 'approvals', w: 1, h: 1, tint: { h: 32, s: 88, l: 45 } },
], removed: [] })

const b = await chromium.launch()
async function setTheme(p, dark) {
  await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  await p.evaluate((d) => { document.documentElement.classList.toggle('dark', d); if (d) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme }, dark)
  await p.waitForTimeout(500)
}
async function measure(p, scenario, dev, theme) {
  console.log(JSON.stringify({ tag, scenario, dev, theme, ...(await p.evaluate(METRICS)) }))
}

for (const [dev, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
  if (process.env.BUSY) {
    const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10)
    const trend = Array.from({ length: 30 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() - (29 - i)); const total = 412; const present = 350 + Math.round(30 * Math.sin(i / 3)); return { date: iso(d), present, absent: total - present, total, pct: Math.round((present / total) * 1000) / 10 } })
    const kpi = { students: 412, staff: 31, sections: 18, attendance_today_pct: 91.3, attendance_marked_today: 380, collected_paise: 48650000, outstanding_paise: 12340000, billed_paise: 61000000, collected_year_paise: 48650000, outstanding_year_paise: 12340000, defaulters: 17, pending_leave: 3, open_applications: 9, unassigned_subjects: 4, year_invoice_count: 412, class_subjects_total: 96, students_by_class: [{ class_id: 'c1', class_name: 'Grade 6', students: 140 }, { class_id: 'c2', class_name: 'Grade 7', students: 136 }, { class_id: 'c3', class_name: 'Grade 8', students: 136 }], range: { period: 'month', from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today), label: 'This month' }, as_of_now: [] }
    await ctx.route('**/api/v1/principal/dashboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(kpi) }))
    await ctx.route('**/api/v1/principal/attendance-trend**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: trend }) }))
  }
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)))
  await p.goto(base + '/login', { waitUntil: 'networkidle' })
  await p.fill('input[name="identifier"]', 'vignan@gmail.com')
  await p.fill('input[name="password"]', 'test@123')
  await p.click('button[type="submit"]')
  await p.waitForURL(/institution_admin/, { timeout: 30000 }).catch(() => console.log('login did not redirect:', p.url()))
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(1500)
  await p.goto(base + '/institution_admin/home/dashboard', { waitUntil: 'networkidle' }).catch(async () => { await p.waitForTimeout(2000); await p.goto(base + '/institution_admin/home/dashboard', { waitUntil: 'networkidle' }) })
  await p.waitForTimeout(2500)
  await p.screenshot({ path: `${OUT}${tag}-home-${dev}.png` })
  await measure(p, 'plain', dev, 'light')
  await setTheme(p, true)
  await p.screenshot({ path: `${OUT}${tag}-home-${dev}-dark.png` })
  await measure(p, 'plain', dev, 'dark')
  await setTheme(p, false)
  // the same board with four saved card colours (localStorage only; nothing on the server changes)
  await p.evaluate((t) => localStorage.setItem('erp.widgets.principal', t), TINTS)
  await p.reload({ waitUntil: 'networkidle' })
  await p.waitForTimeout(2500)
  await p.screenshot({ path: `${OUT}${tag}-home-tinted-${dev}.png` })
  await measure(p, 'tinted', dev, 'light')
  await setTheme(p, true)
  await p.screenshot({ path: `${OUT}${tag}-home-tinted-${dev}-dark.png` })
  await measure(p, 'tinted', dev, 'dark')
  await setTheme(p, false)
  await p.evaluate(() => localStorage.removeItem('erp.widgets.principal'))
  // one data screen
  await p.goto(base + '/institution_admin/students/directory', { waitUntil: 'networkidle' })
  await p.waitForTimeout(2000)
  await p.screenshot({ path: `${OUT}${tag}-data-${dev}.png` })
  console.log('data url', p.url())
  // the launcher
  await p.goto(base + '/institution_admin/home/dashboard', { waitUntil: 'networkidle' })
  await p.waitForTimeout(1200)
  const btn = p.locator('[aria-label="All features"], button:has-text("All features"), [aria-label="Browse"], button:has-text("Browse")').first()
  if (await btn.count()) { await btn.click(); await p.waitForTimeout(1200); await p.screenshot({ path: `${OUT}${tag}-launcher-${dev}.png` }) } else console.log('no launcher button')
  await ctx.close()
}
await b.close()
server?.close()
