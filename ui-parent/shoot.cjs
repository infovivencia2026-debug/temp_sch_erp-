/* Shoots every parent screen from web/dist against stubbed API fixtures.
   Usage: node ui-parent/shoot.cjs <before|after> [screenFilter]
   Writes ui-parent/<phase>/<screen>--<device>-<theme>.png and metrics.json. */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('/home/qb/temp_sch_erp-/node_modules/playwright')
const { respond, parentRole } = require('./fixtures.cjs')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'web', 'dist')
const PHASE = process.argv[2] || 'before'
const FILTER = process.argv[3] || ''
const OUT = path.join(__dirname, PHASE)
fs.mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x')
      let file = path.join(DIST, decodeURIComponent(u.pathname))
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

// A 96x64 muted picture for /files/* so galleries have something to show.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAAAgRlUEAAAAIklEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAOA3JwAAAaVfL4AAAAAASUVORK5CYII=', 'base64')

const unknown = new Set()

const screens = [
  { id: 'home', path: '/parent' },
  ...parentRole.sections.flatMap((s) =>
    s.features
      .filter((f) => f.key !== 'parent.home.dashboard')
      .map((f) => ({ id: `${s.slug}.${f.slug}`, path: `/parent/${s.slug}/${f.slug}` })),
  ),
  { id: 'launcher', path: '/parent', open: 'launcher' },
  { id: 'alerts', path: '/parent', open: 'alerts' },
  { id: 'settings', path: '/settings' },
]

const devices = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
}

const METRICS = `(() => {
  const vw = innerWidth, vh = innerHeight
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' }
  const parse = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return null; const [r,g,b,a] = m.map(Number); return { r, g, b, a: a === undefined ? 1 : a } }
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.85) return c; n = n.parentElement } const c = parse(getComputedStyle(document.body).backgroundColor); return c && c.a > 0 ? c : { r: 255, g: 255, b: 255, a: 1 } }
  let words = 0; const sizes = new Set(); let minContrast = 99; let worst = ''
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  while (walker.nextNode()) {
    const t = walker.currentNode; const el = t.parentElement; if (!el || !t.textContent.trim()) continue
    if (!vis(el)) continue
    const r = document.createRange(); r.selectNodeContents(t); const rr = r.getBoundingClientRect(); if (rr.bottom < 0 || rr.top > vh) continue
    words += t.textContent.trim().split(/\\s+/).length
    const s = getComputedStyle(el)
    sizes.add(Math.round(parseFloat(s.fontSize) * 2) / 2)
    const fg = parse(s.color); if (fg && fg.a > 0.5 && !seen.has(el)) { seen.add(el); const c = contrast(fg, bgOf(el)); if (c < minContrast) { minContrast = c; worst = t.textContent.trim().slice(0, 30) } }
  }
  let pills = 0
  for (const el of document.querySelectorAll('span,div,a,button,em,b,strong,small')) {
    if (!vis(el)) continue
    const s = getComputedStyle(el); const r = el.getBoundingClientRect()
    if (r.width > 180 || r.height > 40 || r.height < 12) continue
    const br = parseFloat(s.borderTopLeftRadius)
    const txt = (el.textContent || '').trim(); if (!txt || txt.length > 28) continue
    const bg = parse(s.backgroundColor); const bw = parseFloat(s.borderTopWidth)
    const tinted = (bg && bg.a > 0.05) || bw > 0
    if (br >= 6 && tinted && el.children.length <= 1 && !el.closest('[data-dock],nav,[role=tablist]')) pills++
  }
  let minTap = 999; let tapEl = ''
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')) {
    if (!vis(el)) continue
    const r = el.getBoundingClientRect(); const m = Math.min(r.width, r.height)
    if (m < minTap) { minTap = m; tapEl = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) }
  }
  return { words, sizes: [...sizes].sort((a, b) => a - b), pills, minTap: Math.round(minTap), tapEl, minContrast: Math.round(minContrast * 100) / 100, worst }
})()`

async function main() {
  const { srv, port } = await serve()
  const browser = await chromium.launch()
  const metrics = {}
  for (const [dev, opts] of Object.entries(devices)) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ ...opts, colorScheme: theme, locale: 'en-IN', timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce' })
      await ctx.addInitScript((theme) => {
        localStorage.setItem('erp.layout', 'bento')
        localStorage.setItem('erp.theme.choice', theme)
        localStorage.setItem('erp.theme', JSON.stringify(theme))
        localStorage.setItem('erp.tour.seen', '1')
        localStorage.setItem('portal-last-child', 'st-kabir')
      }, theme)
      await ctx.route('**/api/v1/**', async (route) => {
        const req = route.request()
        const r = respond(req.method(), req.url())
        if (!r) { unknown.add(`${req.method()} ${new URL(req.url()).pathname}`); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }) }
        if (r.image) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) })
      })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.log('  pageerror', e.message))
      for (const sc of screens) {
        if (FILTER && !sc.id.includes(FILTER)) continue
        const name = `${sc.id}--${dev}-${theme}`
        try {
          await page.goto(`http://127.0.0.1:${port}${sc.path}?student_id=st-kabir`, { waitUntil: 'networkidle' })
          await page.waitForTimeout(500)
          if (sc.open === 'launcher') {
            await page.getByRole('button', { name: 'All features' }).first().click()
            await page.waitForTimeout(600)
          } else if (sc.open === 'alerts') {
            await page.getByRole('button', { name: /Notifications/ }).first().click()
            await page.waitForTimeout(600)
          }
          await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: dev === 'desktop' })
          if (sc.id === 'home' && dev === 'phone') {
            const pages = await page.evaluate(() => { const b = document.querySelector('.bento-board[data-pager]'); return b ? Math.round(b.scrollWidth / b.clientWidth) : 1 })
            for (let p = 2; p <= pages; p++) {
              await page.evaluate((p) => { const b = document.querySelector('.bento-board[data-pager]'); b.scrollTo({ left: b.clientWidth * (p - 1), behavior: 'instant' }) }, p)
              await page.waitForTimeout(300)
              await page.screenshot({ path: path.join(OUT, `${sc.id}-p${p}--${dev}-${theme}.png`) })
            }
          }
          if (dev === 'phone') {
            const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
            if (h > 900) await page.screenshot({ path: path.join(OUT, `${name}--full.png`), fullPage: true })
          }
          metrics[name] = await page.evaluate(METRICS)
        } catch (e) {
          console.log('  FAILED', name, e.message.split('\n')[0])
          metrics[name] = { error: e.message.split('\n')[0] }
        }
      }
      await ctx.close()
    }
  }
  await browser.close()
  srv.close()
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2))
  if (unknown.size) console.log('UNKNOWN endpoints:\n  ' + [...unknown].join('\n  '))
  console.log('done', Object.keys(metrics).length, 'shots ->', OUT)
}
main().catch((e) => { console.error(e); process.exit(1) })
