/* The home board's editing mode, phone and desktop, reading and editing.
   Usage: node ui-parent/arrange.cjs <before|after>
   Writes ui-parent/arrange/<phase>-<device>-<state>.png

   Editing is entered the way a person enters it: a long press on a card on
   the phone (CDP touch, held 700ms), and on the desktop the board's own Edit
   button where there is one, else the Home tab's context menu. */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('/home/qb/temp_sch_erp-/node_modules/playwright')
const { respond } = require('./fixtures.cjs')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'web', 'dist')
const PHASE = process.argv[2] || 'before'
const OUT = path.join(__dirname, 'arrange')
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

const devices = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
}

async function longPress(page, x, y) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await page.waitForTimeout(700)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function main() {
  const { srv, port } = await serve()
  const browser = await chromium.launch()
  for (const [dev, opts] of Object.entries(devices)) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'light', locale: 'en-IN', timezoneId: 'Asia/Kolkata', reducedMotion: 'reduce' })
    await ctx.addInitScript(() => {
      localStorage.setItem('erp.layout', 'bento')
      localStorage.setItem('erp.theme.choice', 'light')
      localStorage.setItem('erp.theme', JSON.stringify('light'))
      localStorage.setItem('erp.tour.seen', '1')
      localStorage.setItem('portal-last-child', 'st-kabir')
    })
    await ctx.route('**/api/v1/**', async (route) => {
      const req = route.request()
      const r = respond(req.method(), req.url())
      if (!r) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' })
      if (r.image) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) })
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) })
    })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.log('  pageerror', e.message))
    const shot = (state) => page.screenshot({ path: path.join(OUT, `${PHASE}-${dev}-${state}.png`) })
    await page.goto(`http://127.0.0.1:${port}/parent?student_id=st-kabir`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    await shot('read')
    try {
      if (dev === 'phone') {
        const card = await page.locator('.bento-board .bento-widget').first().boundingBox()
        await longPress(page, card.x + card.width / 2, card.y + card.height / 2)
        await page.waitForTimeout(600)
        await shot('edit')
        // The sheet's second row dragged under the third, when there is a sheet.
        const handles = page.locator('[data-arrange-sheet] [data-handle]')
        if (await handles.count() >= 3) {
          const a = await handles.nth(1).boundingBox()
          const b = await handles.nth(2).boundingBox()
          const cdp = await page.context().newCDPSession(page)
          const x = a.x + a.width / 2
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: a.y + a.height / 2 }] })
          for (let i = 1; i <= 8; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: a.y + a.height / 2 + ((b.y + b.height / 2 + 8 - a.y - a.height / 2) * i) / 8 }] })
            await page.waitForTimeout(40)
          }
          await shot('drag')
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await cdp.detach()
          await page.waitForTimeout(400)
          await shot('dropped')
          // Tall on the first card, seen behind the sheet, then Done.
          await page.locator('[data-arrange-sheet] [role=radio]', { hasText: 'Tall' }).first().tap()
          await page.waitForTimeout(400)
          await shot('tall')
          await page.getByRole('button', { name: 'Done' }).tap()
          await page.waitForTimeout(400)
          await shot('done')
        }
        // Settings > Dashboard, where the other door is.
        await page.goto(`http://127.0.0.1:${port}/settings/dashboard?student_id=st-kabir`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(500)
        await shot('settings')
      } else {
        const edit = page.getByRole('button', { name: /^Edit( home| board)?$/ }).first()
        if (await edit.count()) {
          await edit.click()
        } else {
          await page.getByRole('tab', { name: /Home/ }).first().click({ button: 'right' })
          await page.waitForTimeout(300)
          await page.getByRole('menuitem', { name: /Arrange/ }).first().click()
        }
        await page.waitForTimeout(600)
        await shot('edit')
        const card = page.locator('.bento-board .bento-widget').nth(1)
        await card.hover()
        await page.waitForTimeout(300)
        await shot('hover')
        // Drag the second card onto the fourth with the pointer.
        const from = await card.boundingBox()
        const to = await page.locator('.bento-board .bento-widget').nth(3).boundingBox()
        if (from && to) {
          await page.mouse.move(from.x + 40, from.y + 40)
          await page.mouse.down()
          for (let i = 1; i <= 10; i++) {
            await page.mouse.move(from.x + 40 + ((to.x + 40 - from.x - 40) * i) / 10, from.y + 40 + ((to.y + 40 - from.y - 40) * i) / 10)
            await page.waitForTimeout(30)
          }
          await shot('drag')
          await page.mouse.up()
          await page.waitForTimeout(400)
          await shot('dropped')
        }
      }
    } catch (e) {
      console.log('  FAILED', dev, e.message.split('\n')[0])
    }
    await ctx.close()
  }
  await browser.close()
  srv.close()
  console.log('done ->', OUT)
}
main().catch((e) => { console.error(e); process.exit(1) })
