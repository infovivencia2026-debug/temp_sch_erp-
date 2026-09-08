/* Measures, rather than eyeballs: computed elevation on the surfaces the
   ladder names, on one screen, in one theme. UI_ROLE=... node ui-depth/probe.cjs [light|dark] */
const fs = require('fs'), path = require('path'), http = require('http')
const { chromium } = require('/home/qb/temp_sch_erp-/node_modules/playwright')
const { respond, ROLE_KEY } = require('../ui-parent/fixtures.cjs')
const DIST = path.join(__dirname, '..', 'web', 'dist')
const theme = process.argv[2] || 'light'
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
function serve() { return new Promise((res) => { const s = http.createServer((q, r) => { let f = path.join(DIST, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r) }); s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port })) }) }
;(async () => {
  const { s, port } = await serve()
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
  await ctx.addInitScript((t) => { localStorage.setItem('erp.layout', 'bento'); localStorage.setItem('erp.theme.choice', t); localStorage.setItem('erp.theme', JSON.stringify(t)); localStorage.setItem('erp.tour.seen', '1') }, theme)
  await ctx.route('**/api/v1/**', (route) => { const r = respond(route.request().method(), route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r ? r.body : { items: [] }) }) })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${port}/${ROLE_KEY}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(800)
  const cell = p.locator('.bento-cell:has(.bento-cue)').first()
  const rest = await cell.evaluate((el) => ({ cell: getComputedStyle(el).boxShadow, parent: el.parentElement.className, pOverflow: getComputedStyle(el.parentElement).overflow, pZ: getComputedStyle(el.parentElement).zIndex, gp: el.parentElement.parentElement.className.slice(0, 60) }))
  await cell.hover(); await p.waitForTimeout(400)
  const hov = await cell.evaluate((el) => { const w = el.closest('.bento-widget'); const ws = getComputedStyle(w); return { cell: getComputedStyle(el).boxShadow, cellOverflow: getComputedStyle(el).overflow, z: getComputedStyle(el).zIndex, widget: { overflow: ws.overflow, z: ws.zIndex, pos: ws.position, isBoardChild: w.parentElement.classList.contains('bento-board'), boardClass: w.parentElement.className.slice(0, 80) } } })
  const bb = await cell.boundingBox()
  await p.screenshot({ path: path.join(__dirname, `probe-corner-${theme}.png`), clip: { x: bb.x + bb.width - 60, y: bb.y + bb.height - 30, width: 120, height: 80 } })
  const dock = await p.locator('.bento-dock').evaluate((el) => getComputedStyle(el).boxShadow)
  const vars = await p.evaluate(() => { const c = getComputedStyle(document.documentElement); return ['--elev-1', '--elev-2', '--elev-3', '--edge-lip', '--hairline', '--scrim', '--popover'].map((k) => k + ': ' + c.getPropertyValue(k).trim().replace(/\s+/g, ' ')) })
  console.log(JSON.stringify({ theme, rest, hov, dock, vars }, null, 1))
  await b.close(); s.close()
})()
