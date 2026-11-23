// Screenshots of the owner's five reported phone screens at 360 wide, font 1.3.
//   node scripts/phone-shots.mjs <live|local> <outDir> <parentStateJson>
// Uses the same font-scale emulation and local-asset serving as phone-check.mjs.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const [mode = 'live', outDir, state] = process.argv.slice(2)
const ORIGIN = 'https://yjps.xulo.in', S = 1.3
const DIST = process.env.DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../web/dist')
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

const cache = new Map()
async function fetchBody(route, key) {
  if (cache.has(key)) return cache.get(key)
  for (let i = 0; ; i++) {
    try { const b = await (await route.fetch()).body(); cache.set(key, b); return b } catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))) }
  }
}

// Local mode: the live page's HTML (the Worker injects the school's branding and
// config into it), with its /assets/ references swapped for this build's.
const distIndex = () => fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
function swapAssets(html) {
  const local = {}
  for (const m of distIndex().matchAll(/\/assets\/([A-Za-z0-9_.-]+?)-[A-Za-z0-9_-]{8}\.(js|css)/g)) local[m[1] + '.' + m[2]] = m[0]
  return html.replace(/\/assets\/([A-Za-z0-9_.-]+?)-[A-Za-z0-9_-]{8}\.(js|css)/g, (m, n, e) => local[n + '.' + e] || m)
}
const scaleCss = (css) => css.replace(/font-size:\s*([^;}!]+)/g, (m, v) => /\d(px|vw|vh|vmin|cqi|cqw)/.test(v) && !/\d(em|%)/.test(v.replace(/rem/g, '')) ? `font-size:calc((${v.trim()}) * ${S})` : m)
fs.mkdirSync(outDir, { recursive: true })
const b = await chromium.launch()
async function ctxFor(st) {
  const ctx = await b.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ...(st ? { storageState: st } : {}) })
  await ctx.route('**/*', async (route) => { try {
    const req = route.request(), u = new URL(req.url())
    if (u.origin !== ORIGIN) return route.continue()
    if (u.pathname.startsWith('/api/')) return req.method() === 'GET' ? route.continue() : route.abort()
    let body = null, type = null
    if (mode === 'local' && u.pathname.startsWith('/assets/')) {
      const f = path.join(DIST, decodeURIComponent(u.pathname))
      if (fs.existsSync(f) && fs.statSync(f).isFile()) { body = fs.readFileSync(f); type = MIME[path.extname(f)] || 'application/octet-stream' }
    } else if (mode === 'local' && req.resourceType() === 'document') {
      body = Buffer.from(swapAssets((await fetchBody(route, 'doc:' + u.pathname)).toString('utf8'))); type = 'text/html'
    }
    if (body == null) {
      if (!/\.css(\?|$)/.test(u.pathname)) return route.continue()
      body = await fetchBody(route, u.href); type = 'text/css'
    }
    if (type === 'text/css') body = scaleCss(body.toString('utf8'))
    return route.fulfill({ status: 200, body, headers: { 'content-type': type } })
    } catch { return route.abort().catch(() => {}) }
  })
  await ctx.addInitScript((s) => {
    const fix = (el) => { const v = el.style?.fontSize; if (v && /\d(px|vw|cqi)/.test(v) && !el.dataset.fsx) { el.dataset.fsx = '1'; el.style.fontSize = `calc(${v} * ${s})` } }
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'attributes') fix(m.target); else m.addedNodes.forEach((n) => { if (n.nodeType === 1) { fix(n); n.querySelectorAll?.('[style]').forEach(fix) } }) } })
      .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
  }, S)
  return ctx
}
const settle = async (p) => { await p.waitForTimeout(1500); await p.waitForFunction(() => !/Loading|Looking up/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(800) }
const anon = await ctxFor(null), lp = await anon.newPage()
await lp.goto(ORIGIN + '/login', { waitUntil: 'load' }).catch(() => {}); await settle(lp)
await lp.screenshot({ path: path.join(outDir, '3-login.png') })
await anon.close()
const ctx = await ctxFor(state), p = await ctx.newPage()
await p.goto(ORIGIN + '/parent/home/dashboard', { waitUntil: 'load' }).catch(() => {}); await settle(p)
await p.screenshot({ path: path.join(outDir, '2-header-greeting.png') })
await p.screenshot({ path: path.join(outDir, '1-home-tiles.png'), fullPage: true })
await p.goto(ORIGIN + '/parent/leave_absence/apply_student_leave', { waitUntil: 'load' }).catch(() => {}); await settle(p)
await p.getByRole('tab', { name: 'Apply leave' }).first().click().catch(() => p.getByText('Apply leave').first().click().catch(() => {})); await settle(p)
const t = p.locator('table').first()
if (await t.count()) await t.scrollIntoViewIfNeeded().catch(() => {})
await p.screenshot({ path: path.join(outDir, '4-leave-applications.png'), fullPage: true })
await p.goto(ORIGIN + '/parent/school_life/calendar_ptm', { waitUntil: 'load' }).catch(() => {}); await settle(p)
await p.screenshot({ path: path.join(outDir, '5-calendar-chips.png') })
await b.close()
console.log('shots in', outDir)
