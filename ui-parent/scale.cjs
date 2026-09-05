/* The phone home board at the three Android text sizes.
   Usage: node ui-parent/scale.cjs <before|after> [zoom|root] [scales]
   Writes ui-parent/scale/<phase>-<method>-x<scale>-<theme>-p<page>.png and
   ui-parent/scale/<phase>-<method>.json with the cards whose text is cut.

   TWO WAYS TO EMULATE THE PHONE'S FONT SETTING.
     zoom  what Android's WebView actually does: `textZoom` multiplies every
           computed font-size, px-specified ones included, and nothing else
           (padding, gaps, cqh clamps stay). Emulated by snapshotting each
           element's computed size and pinning it inline at size x scale.
     root  the root font-size raised to 16/18px, which only moves rem units.
   The phone (font_scale 1.3) matched `zoom`; `root` moved almost nothing,
   because the cards set their type in px through --card-* tokens. */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('/home/qb/temp_sch_erp-/node_modules/playwright')
const { respond } = require('./fixtures.cjs')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'web', 'dist')
const PHASE = process.argv[2] || 'before'
const METHOD = process.argv[3] || 'zoom'
const SCALES = (process.argv[4] || '1,1.15,1.3').split(',').map(Number)
const OUT = path.join(__dirname, 'scale')
fs.mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
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

/* The states the owner's phone showed: one thing waiting, and an instalment
   due today with nothing overdue and nothing counted as outstanding. */
function phoneState(body, p, today) {
  if (p === '/api/v1/attention') {
    return { items: [{ key: 'self.fees_due', severity: 'critical', count: 1, headline: '₹0 due', detail: 'Due by 05 Sep', action: 'Open', href: '/parent/fees/fees_payments' }] }
  }
  if (p === '/api/v1/portal/fees') {
    const inv = body.invoices.map((i, n) =>
      n === 0 ? { ...i, due_on: today, days_overdue: 0, status: 'due', paid_paise: i.net_paise - 1200000, due_paise: 1200000 } : { ...i, paid_paise: i.net_paise, due_paise: 0, days_overdue: 0, status: 'paid' })
    return { ...body, invoices: inv, outstanding_paise: 0 }
  }
  if (p === '/api/v1/portal/summary') return { ...body, outstanding_paise: 0 }
  return body
}

const ZOOM = `(scale) => {
  const seen = new WeakSet()
  const fit = (el) => {
    if (seen.has(el) || !(el instanceof Element)) return
    seen.add(el)
    const px = parseFloat(getComputedStyle(el).fontSize)
    if (px) el.style.fontSize = (px * scale) + 'px'
  }
  const all = (root) => { const els = [root, ...root.querySelectorAll('*')]; const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize)); els.forEach((e, i) => { if (!seen.has(e)) { seen.add(e); if (sizes[i]) e.style.fontSize = (sizes[i] * scale) + 'px' } }) }
  all(document.body)
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof Element) all(n) }).observe(document.body, { childList: true, subtree: true })
  // Real textZoom is there before any script reads a size. A probe the app
  // appends and measures in the same tick must see the multiplied value too,
  // so an unpinned element is pinned the moment anything asks about it.
  const orig = window.getComputedStyle.bind(window)
  window.getComputedStyle = (el, ps) => {
    if (el instanceof Element && el.isConnected && !seen.has(el)) fit(el)
    return orig(el, ps)
  }
  window.dispatchEvent(new Event('resize'))
}`

/* Which cards cut their own text: any text box that ends below the card's
   bottom edge (minus the padding), or a card whose content is taller than it. */
const CLIP = `() => {
  const out = []
  for (const w of document.querySelectorAll('.bento-board[data-pager] > .bento-widget')) {
    const r = w.getBoundingClientRect()
    const cell = w.querySelector('.bento-cell')
    const pad = cell ? parseFloat(getComputedStyle(cell).paddingBottom) : 0
    const title = (w.querySelector('[data-card] p') || w).textContent.trim().slice(0, 24)
    let worst = 0, text = ''
    const walker = document.createTreeWalker(w, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const t = walker.currentNode
      if (!t.textContent.trim()) continue
      const rg = document.createRange(); rg.selectNodeContents(t)
      const b = rg.getBoundingClientRect()
      if (b.height === 0) continue
      const over = b.bottom - (r.bottom - pad)
      if (over > worst) { worst = over; text = t.textContent.trim().slice(0, 40) }
    }
    const tall = w.scrollHeight - w.clientHeight
    const d = w.querySelector('.card-drawing')
    const dbg = d ? { drawH: Math.round(d.getBoundingClientRect().height), ct: getComputedStyle(d).containerType, fs: getComputedStyle(d).fontSize } : null
    if (worst > 0.5 || tall > 1) out.push({ card: title, over: Math.round(worst), tall, text, dbg })
  }
  return out
}`

async function main() {
  const { srv, port } = await serve()
  const browser = await chromium.launch()
  const report = {}
  const today = new Date()
  const iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
  for (const theme of ['light', 'dark']) {
    for (const scale of SCALES) {
      if (theme === 'dark' && scale !== SCALES[SCALES.length - 1]) continue
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
        colorScheme: theme, locale: 'en-IN', timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce',
      })
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
        if (!r) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' })
        if (r.image) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) })
        const body = phoneState(r.body, new URL(req.url()).pathname, iso)
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(body) })
      })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.log('  pageerror', e.message))
      await page.goto(`http://127.0.0.1:${port}/parent?student_id=st-kabir`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      if (scale !== 1) {
        if (METHOD === 'zoom') await page.evaluate(`(${ZOOM})(${scale})`)
        else await page.evaluate((s) => { document.documentElement.style.fontSize = `${14 * s}px` }, scale)
        await page.waitForTimeout(400)
      }
      const key = `${PHASE}-${METHOD}-x${scale}-${theme}`
      const pages = await page.evaluate(() => { const b = document.querySelector('.bento-board[data-pager]'); return b ? Math.round(b.scrollWidth / b.clientWidth) : 1 })
      const clipped = []
      for (let p = 1; p <= pages; p++) {
        await page.evaluate((p) => { const b = document.querySelector('.bento-board[data-pager]'); b?.scrollTo({ left: b.clientWidth * (p - 1), behavior: 'instant' }) }, p)
        await page.waitForTimeout(250)
        await page.screenshot({ path: path.join(OUT, `${key}-p${p}.png`) })
        const c = await page.evaluate(`(${CLIP})()`)
        for (const x of c) clipped.push({ page: p, ...x })
      }
      report[key] = { pages, clipped }
      console.log(key, pages, 'pages;', clipped.length ? 'CLIPPED ' + JSON.stringify(clipped) : 'clean')
      await ctx.close()
    }
  }
  await browser.close()
  srv.close()
  fs.writeFileSync(path.join(OUT, `${PHASE}-${METHOD}.json`), JSON.stringify(report, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
