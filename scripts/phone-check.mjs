// Phone + font-scale checker. Loads every route for a role at phone widths x font scales and
// flags layout faults. Read-only: every non-GET API call except sign-in is aborted.
//
//   node scripts/phone-check.mjs <parent|staff> <live|local> <outDir> [widths] [fonts] [routeFilter]
//
// live  : https://yjps.xulo.in as deployed.
// local : same origin (so the real session + read-only data work), but index.html and /assets/*
//         are served from web/dist of this checkout (run `npm run build` in web first).
//
// FONT SCALE. Android WebView applies the phone's font size as textZoom: every computed
// font-size (px included) is multiplied, layout widths are not. Chromium has no textZoom switch,
// so the checker rewrites every `font-size:<n>px` / `font-size:<n>rem` in the app's CSS to
// `calc(<value> * S)` and multiplies inline style font sizes the same way. The root
// `html{font-size:calc(14px*var(--font-scale))}` is scaled by that rewrite too, so rem-based
// sizes follow, exactly as they do under textZoom.
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const [role = 'parent', mode = 'live', outDir = 'phone-check-out', wArg, fArg, filt] = process.argv.slice(2)
const ORIGIN = 'https://yjps.xulo.in'
const DIST = process.env.DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../web/dist')
const WIDTHS = (wArg || '320,360,375,390,412,430').split(',').map(Number)
const FONTS = (fArg || '1,1.3,1.5,2').split(',').map(Number)
const CRED = role === 'parent' ? '8500117127' : '9100575183'
fs.mkdirSync(outDir, { recursive: true })

const scaleCss = (css, s) => s === 1 ? css : css.replace(/font-size:\s*([^;}!]+)/g, (m, v) => /\d(px|vw|vh|vmin|cqi|cqw)/.test(v) && !/\d(em|%)/.test(v.replace(/rem/g, '')) ? `font-size:calc((${v.trim()}) * ${s})` : m)
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }

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

async function wire(ctx, scale, live = mode !== 'local') {
  await ctx.route('**/*', async (route) => { try {
    const req = route.request(), u = new URL(req.url())
    if (u.origin !== ORIGIN) return route.continue()
    const isApi = u.pathname.startsWith('/api/')
    if (isApi) {
      if (req.method() !== 'GET' && !/\/auth\/(login|session|refresh)|\/login$/.test(u.pathname)) return route.abort()
      return route.continue()
    }
    // static
    let body = null, type = null
    if (!live && u.pathname.startsWith('/assets/')) {
      const f = path.join(DIST, decodeURIComponent(u.pathname))
      if (fs.existsSync(f) && fs.statSync(f).isFile()) { body = fs.readFileSync(f); type = MIME[path.extname(f)] || 'application/octet-stream' }
    } else if (!live && req.resourceType() === 'document') {
      body = Buffer.from(swapAssets((await fetchBody(route, 'doc:' + u.pathname)).toString('utf8'))); type = 'text/html'
    }
    if (body == null) {
      if (!/\.css(\?|$)/.test(u.pathname) || scale === 1) return route.continue()
      body = await fetchBody(route, u.href); type = 'text/css'
    }
    if (type === 'text/css') body = scaleCss(body.toString('utf8'), scale)
    if (type === 'text/html') body = body.toString('utf8').replace(/<style>([\s\S]*?)<\/style>/g, (m, c) => `<style>${scaleCss(c, scale)}</style>`)
    return route.fulfill({ status: 200, body, headers: { 'content-type': type, 'cache-control': 'no-store' } })
    } catch { return route.abort().catch(() => {}) }
  })
  if (scale !== 1) await ctx.addInitScript((s) => {
    const fix = (el) => { const v = el.style?.fontSize; if (v && /\d(px|vw|cqi)/.test(v) && !el.dataset.fsx) { el.dataset.fsx = '1'; el.style.fontSize = `calc(${v} * ${s})` } }
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'attributes') fix(m.target); else m.addedNodes.forEach((n) => { if (n.nodeType === 1) { fix(n); n.querySelectorAll?.('[style]').forEach(fix) } }) } })
      .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
  }, scale)
}

const check = () => {
  const iw = innerWidth, o = { h: document.documentElement.scrollWidth > iw + 1, off: [], ov: [], clip: [], split: [], small: [], spill: [] }
  const vis = (e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 0
  const layer = (e) => { let a = e; while (a && a !== document.body) { const p = getComputedStyle(a).position; if (p === 'fixed' || p === 'sticky') return a; a = a.parentElement } return null }
  const scroller = (e) => { let a = e.parentElement; while (a && a !== document.body) { const s = getComputedStyle(a); if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) return a; a = a.parentElement } return null }
  const txt = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
  const nm = (e) => e.tagName.toLowerCase() + ' "' + ((e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 28)) + '"'
  const leaves = [...document.querySelectorAll('body *')].filter((e) => !e.closest('svg') && vis(e) && (txt(e) || ['INPUT', 'BUTTON', 'IMG', 'SELECT', 'TEXTAREA'].includes(e.tagName)))
  for (const e of leaves) {
    const r = e.getBoundingClientRect()
    if ((r.right > iw + 1 || r.left < -1) && !scroller(e)) o.off.push(nm(e))
    if (txt(e)) {
      const s = getComputedStyle(e)
      if (e.clientWidth > 2 && e.scrollWidth > e.clientWidth + 2 && s.textOverflow !== 'ellipsis' && s.overflowX !== 'visible' && !scroller(e)) o.clip.push(nm(e))
      else if (r.width > 2 && s.textOverflow !== 'ellipsis' && !scroller(e)) {
        // text pushed past an ancestor that hides overflow (cut off inside a card)
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const as = getComputedStyle(a)
          if (as.overflowX === 'hidden' || as.overflowX === 'clip') { const ar = a.getBoundingClientRect(); if (ar.width > 2 && (r.right > ar.right + 2 || r.left < ar.left - 2)) o.clip.push(nm(e)); break }
        }
      }
    }
  }
  // text spilling out of its own card/cell/button (drawn over the next one)
  for (const e of leaves) {
    if (!txt(e)) continue
    const box = e.closest('.card, .cell, td, button, [role=button]')
    if (!box || box === e) continue
    const r = e.getBoundingClientRect(), br = box.getBoundingClientRect()
    if ((r.right > br.right + 2 || r.left < br.left - 2) && !scroller(e)) o.spill.push(nm(e))
  }
  // words split across lines (a line break inside a word)
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let words = 0
  for (let n = tw.nextNode(); n && words < 8000; n = tw.nextNode()) {
    const el = n.parentElement
    if (!el || !n.textContent.trim() || el.closest('svg,script,style,textarea,input,[aria-hidden=true]') || !vis(el)) continue
    const re = /[A-Za-zऀ-ॿ₹0-9][A-Za-zऀ-ॿ₹0-9,.'’]{3,}/g
    let m
    while ((m = re.exec(n.textContent)) && words < 8000) {
      words++
      const rg = document.createRange(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length)
      const rs = [...rg.getClientRects()].filter((x) => x.width > 0)
      if (rs.length > 1 && Math.abs(rs[0].top - rs[rs.length - 1].top) > 2 && rs[0].right > 0 && rs[0].left < iw) {
        if (!el.closest('.break-anywhere') && m[0].length < 30) o.split.push(m[0].slice(0, 24))
      }
    }
  }
  for (const e of document.querySelectorAll('button, [role=button], a.btn, [role=tab]')) {
    if (!vis(e)) continue
    const r = e.getBoundingClientRect()
    if (r.height < 40 && r.width >= 40 && (e.innerText || '').trim().length > 1 && !e.closest('td, [role=menu], [role=listbox], .no-tap-check')) o.small.push(nm(e) + ' ' + Math.round(r.height))
  }
  // a cell or block with text is judged by where its text is, not by its padded box
  const textRect = (e) => {
    if (!txt(e) || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(e.tagName)) return e.getBoundingClientRect()
    const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect()
  }
  const L = leaves.slice(0, 700).map((e) => ({ e, r: textRect(e), l: layer(e), s: scroller(e) }))
  outer: for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], c = L[j]
    if (a.l !== c.l || a.s !== c.s || a.e.contains(c.e) || c.e.contains(a.e)) continue
    // a field's own button drawn inside it (calendar, clear, show password) is by design
    // an inline run that wraps has a box covering both lines; not a real overlap
    if (a.e.getClientRects().length > 1 || c.e.getClientRects().length > 1) continue
    if (new Set([a.e.tagName, c.e.tagName]).has('INPUT') && new Set([a.e.tagName, c.e.tagName]).has('BUTTON')) continue
    const x = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left), y = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top)
    if (x > 4 && y > 4) { o.ov.push(nm(a.e) + '  x  ' + nm(c.e)); if (o.ov.length >= 8) break outer }
  }
  for (const k of ['off', 'clip', 'split', 'small', 'spill']) o[k] = [...new Set(o[k])].slice(0, 8)
  o.head = (document.querySelector('main')?.innerText || '').trim().slice(0, 50).replace(/\s+/g, ' ')
  return o
}

const b = await chromium.launch()
// sign in once (live assets; the session cookie is what we keep)
const lc = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
await wire(lc, 1, true)
const lp = await lc.newPage()
for (let i = 0; i < 4 && !(await lp.locator('input[name=identifier]').count()); i++) await lp.goto(ORIGIN + '/login', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
await lp.fill('input[name=identifier]', CRED); await lp.fill('input[name=password]', CRED)
await lp.click('button[type=submit]'); await lp.waitForTimeout(5000)
await lp.locator('text=Skip for now').first().click().catch(() => {}); await lp.waitForTimeout(3000)
let routes
if (role === 'parent') {
  for (const btn of await lp.locator('nav button[aria-expanded="false"], aside button[aria-expanded="false"]').all()) await btn.click().catch(() => {})
  await lp.waitForTimeout(800)
  const found = await lp.evaluate(() => [...document.querySelectorAll('a[href^="/parent/"], a[href^="/account"]')].map((a) => a.getAttribute('href').split('?')[0]))
  routes = [...new Set([...found, '/parent/home/dashboard', '/parent/attendance/attendance', '/parent/academics/homework_academics', '/parent/academics/timetable',
    '/parent/academics/results_report_cards', '/parent/fees/fees_payments', '/parent/school_life/calendar_ptm',
    '/parent/leave_absence/apply_student_leave', '/account'])]
} else {
  routes = JSON.parse(fs.readFileSync(new URL('./phone-check-staff-routes.json', import.meta.url), 'utf8'))
}
if (filt) routes = routes.filter((r) => r.includes(filt))
const state = path.join(outDir, `state-${role}.json`)
await lc.storageState({ path: state }); await lc.close()
console.log(role, mode, 'routes', routes.length)

const rep = []
const combos = WIDTHS.flatMap((w) => FONTS.map((f) => [w, f]))
const save = () => fs.writeFileSync(path.join(outDir, `report-${role}-${mode}.json`), JSON.stringify(rep))
async function run([w, f]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 800 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: 1, storageState: state })
  await wire(ctx, f)
  const p = await ctx.newPage()
  let js = []
  p.on('pageerror', (e) => js.push(e.message.slice(0, 80)))
  p.on('dialog', (d) => d.dismiss().catch(() => {}))
  for (const r of routes) {
    js = []
    await p.goto(ORIGIN + r, { waitUntil: 'load', timeout: 45000 }).catch(() => {})
    await p.waitForTimeout(1200)
    await p.waitForFunction(() => !/Loading|Looking up/.test(document.querySelector('main')?.innerText || document.body.innerText), null, { timeout: 8000 }).catch(() => {})
    await p.waitForTimeout(600)
    const c = await p.evaluate(check).catch((e) => ({ err: String(e).slice(0, 80) }))
    if (process.env.SHOTS) await p.screenshot({ path: path.join(outDir, `${w}-${f}-${r.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {})
    rep.push({ w, f, route: r, ...c, js: [...new Set(js)] })
  }
  await ctx.close(); save()
  console.log('done', w, f)
}
const q = [...combos]
await Promise.all(Array.from({ length: Math.min(8, q.length) }, async () => { while (q.length) await run(q.shift()) }))
await b.close(); save()
// summary
const sum = {}
for (const x of rep) {
  const k = `${x.w}@${x.f}`; const s = (sum[k] ??= { pages: 0, bad: 0, h: 0, off: 0, clip: 0, spill: 0, ov: 0, split: 0, small: 0, js: 0 })
  s.pages++
  const flags = { h: x.h ? 1 : 0, off: x.off?.length || 0, clip: x.clip?.length || 0, spill: x.spill?.length || 0, ov: x.ov?.length || 0, split: x.split?.length || 0, small: x.small?.length || 0, js: x.js?.length || 0 }
  for (const [kk, v] of Object.entries(flags)) s[kk] += v ? 1 : 0
  if (Object.values(flags).some(Boolean)) s.bad++
}
fs.writeFileSync(path.join(outDir, `summary-${role}-${mode}.json`), JSON.stringify(sum, null, 1))
console.table(sum)
