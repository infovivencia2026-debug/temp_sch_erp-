/* Shoots the surfaces the elevation system has to get right, for one role,
   from web/dist against ui-parent's stubbed API.

   Usage: UI_ROLE=<parent|institution_admin> node ui-depth/shoot.cjs <before|after> [filter]
   Writes ui-depth/<phase>/<role>.<screen>--<device>-<theme>.png

   Beyond the parent harness this also captures the STATES the levels are
   defined by: a card under the pointer, a card and a button pressed, a menu
   open. A screenshot of a resting page says nothing about whether hover is
   raised or press is sunk. */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('/home/qb/temp_sch_erp-/node_modules/playwright')
const { respond, role, ROLE_KEY } = require('../ui-parent/fixtures.cjs')

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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAAAgRlUEAAAAIklEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAOA3JwAAAaVfL4AAAAAASUVORK5CYII=', 'base64')

const home = `/${ROLE_KEY}`
const feature = (section, slug) => `${home}/${section}/${slug}`
const SCREENS = ROLE_KEY === 'parent'
  ? [
      { id: 'home', path: home },
      { id: 'home-hover', path: home, act: 'hover-card', desktopOnly: true },
      { id: 'home-press', path: home, act: 'press-card' },
      { id: 'fees', path: (() => { const sec = role.sections.find((x) => x.slug === 'fees') || role.sections[1]; return feature(sec.slug, sec.features[0].slug) })() },
      { id: 'launcher', path: home, act: 'launcher' },
      { id: 'alerts', path: home, act: 'alerts' },
      { id: 'settings', path: '/settings' },
      { id: 'arrange', path: home, act: 'arrange', phoneOnly: true },
    ]
  : [
      { id: 'home', path: home },
      { id: 'home-hover', path: home, act: 'hover-card', desktopOnly: true },
      { id: 'home-press', path: home, act: 'press-card' },
      { id: 'students', path: feature('students', 'student_360') + '?class=cls-5&section=sec-cls-5-A' },
      { id: 'students-hover', path: feature('students', 'student_360') + '?class=cls-5&section=sec-cls-5-A', act: 'hover-row', desktopOnly: true },
      { id: 'form', path: feature('students', 'certificates_transfers') },
      { id: 'form-select', path: feature('students', 'certificates_transfers'), act: 'open-select' },
      { id: 'form-press', path: feature('students', 'certificates_transfers'), act: 'press-button' },
      { id: 'approvals', path: feature('approvals', 'approvals') },
      { id: 'launcher', path: home, act: 'launcher' },
      { id: 'alerts', path: home, act: 'alerts' },
      { id: 'settings', path: '/settings' },
      { id: 'settings-menu', path: home, act: 'gear-menu' },
    ]

const devices = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
}

async function act(page, kind, dev) {
  const first = async (sel) => { const l = page.locator(sel).first(); await l.waitFor({ state: 'visible', timeout: 4000 }); return l }
  if (kind === 'launcher') {
    await (await first('button[aria-label="All features"]')).click(); await page.waitForTimeout(600)
  } else if (kind === 'alerts') {
    await page.getByRole('button', { name: /Notifications/ }).first().click(); await page.waitForTimeout(600)
  } else if (kind === 'hover-card') {
    const c = await first('.bento-cell:has(.bento-cue)'); await c.hover(); await page.waitForTimeout(350)
  } else if (kind === 'press-card') {
    const c = await first('.bento-cell:has(.bento-cue)'); const b = await c.boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(250)
  } else if (kind === 'hover-row') {
    const r = await first('.responsive-table tbody tr, .card ul li, [data-row]'); await r.hover(); await page.waitForTimeout(350)
  } else if (kind === 'open-select') {
    const s = await first('.field.cursor-text, select'); await s.click(); await page.waitForTimeout(400)
  } else if (kind === 'press-button') {
    const b = await first('button.btn:not([disabled])'); const bb = await b.boundingBox()
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.waitForTimeout(250)
  } else if (kind === 'gear-menu') {
    await page.getByRole('button', { name: /Settings/ }).first().click(); await page.waitForTimeout(500)
  } else if (kind === 'arrange') {
    const e = await first('.bento-dots__edit, button[aria-label*="Customi"]'); await e.click(); await page.waitForTimeout(500)
    const a = page.locator('button:has-text("Arrange"), [role="menuitem"]:has-text("Arrange")').first()
    if (await a.count()) { await a.click(); await page.waitForTimeout(500) }
  }
}

async function main() {
  const { srv, port } = await serve()
  const browser = await chromium.launch()
  const unknown = new Set()
  let n = 0
  for (const [dev, opts] of Object.entries(devices)) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ ...opts, colorScheme: theme, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
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
      for (const sc of SCREENS) {
        if (FILTER && !sc.id.includes(FILTER)) continue
        if (sc.desktopOnly && dev !== 'desktop') continue
        if (sc.phoneOnly && dev !== 'phone') continue
        const name = `${ROLE_KEY}.${sc.id}--${dev}-${theme}`
        try {
          await page.goto(`http://127.0.0.1:${port}${sc.path}${sc.path.includes('?') ? '&' : '?'}student_id=st-kabir`, { waitUntil: 'networkidle' })
          await page.waitForTimeout(700)
          if (sc.act) await act(page, sc.act, dev)
          await page.screenshot({ path: path.join(OUT, `${name}.png`) })
          n++
          await page.mouse.up().catch(() => {})
        } catch (e) {
          console.log('  FAILED', name, e.message.split('\n')[0])
        }
      }
      await ctx.close()
    }
  }
  await browser.close()
  srv.close()
  if (unknown.size) console.log('UNKNOWN endpoints:\n  ' + [...unknown].join('\n  '))
  console.log('done', n, 'shots ->', OUT)
}
main().catch((e) => { console.error(e); process.exit(1) })
