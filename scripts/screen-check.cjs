// Screen check (owner, 2026-11-05: "every screen should fit all devices,
// also everything we build from now on"). Opens every live screen at every
// device size and reports text that overlaps other text, runs out of its box,
// or makes the page scroll sideways. Read-only: it only navigates.
//
//   SCREEN_BASE=https://<school site> SCREEN_ID=<login> SCREEN_PW=<password> //   node scripts/screen-check.cjs [--only <url part>,<url part>] [--sizes phone320,pc1920]
//
// Exits 1 when anything is found; screenshots and report.json go to
// SCREEN_OUT (default screen-check-out/). Needs playwright (root devDependency).
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const BASE = process.env.SCREEN_BASE
const OUT = process.env.SCREEN_OUT || 'screen-check-out'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1].split(',') : null }
const ONLY = arg('--only')
const PICK = arg('--sizes')
const ALL_SIZES = [
  { name: 'phone320', width: 320, height: 640, mobile: true },
  { name: 'phone360', width: 360, height: 780, mobile: true },
  { name: 'phone390', width: 390, height: 844, mobile: true },
  { name: 'phone412', width: 412, height: 915, mobile: true },
  { name: 'phone430', width: 430, height: 932, mobile: true },
  { name: 'tablet768', width: 768, height: 1024, mobile: true },
  { name: 'tablet1024', width: 1024, height: 768, mobile: true },
  { name: 'laptop1280', width: 1280, height: 720, mobile: false },
  { name: 'projector1280x800', width: 1280, height: 800, mobile: false },
  { name: 'laptop1366', width: 1366, height: 768, mobile: false },
  { name: 'laptop1440', width: 1440, height: 900, mobile: false },
  { name: 'laptop1536', width: 1536, height: 864, mobile: false },
  { name: 'pc1920', width: 1920, height: 1080, mobile: false },
  { name: 'smartboard1920', width: 1920, height: 1080, mobile: false, touch: true },
  { name: 'pc2560', width: 2560, height: 1440, mobile: false },
  { name: 'tv3840', width: 3840, height: 2160, mobile: false },
]
const SIZES = PICK ? ALL_SIZES.filter((z) => PICK.includes(z.name)) : ALL_SIZES
fs.mkdirSync(OUT, { recursive: true })

function detect() {
  const vw = window.innerWidth
  const issues = []
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const label = (el) => {
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)
    const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 3).join('.') : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} "${t}"`
  }
  // Sideways scroll of the whole page.
  const sw = document.documentElement.scrollWidth
  if (sw > vw + 1) {
    let worst = null
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 && visible(el) && (!worst || r.right > worst.r)) worst = { r: r.right, el }
    }
    issues.push({ kind: 'page-scrolls-sideways', detail: `page is ${sw}px wide on a ${vw}px screen`, el: worst ? label(worst.el) : '' })
  }
  // Text pieces: elements with their own text.
  const texts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  while (walker.nextNode()) {
    const n = walker.currentNode
    if (!n.textContent.trim()) continue
    const el = n.parentElement
    if (!el || seen.has(el) || !visible(el)) continue
    if (el.closest('svg,script,style,[aria-hidden="true"],.sr-only,[hidden]')) continue
    seen.add(el)
    const range = document.createRange(); range.selectNodeContents(n)
    // What of the text is actually on screen: cut to every clipping parent.
    let clip = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 }
    for (let q = el; q && q !== document.body; q = q.parentElement) {
      const qs = getComputedStyle(q)
      if (qs.overflowX !== 'visible' || qs.overflowY !== 'visible') {
        const qr = q.getBoundingClientRect()
        clip = { left: Math.max(clip.left, qr.left), top: Math.max(clip.top, qr.top), right: Math.min(clip.right, qr.right), bottom: Math.min(clip.bottom, qr.bottom) }
      }
    }
    for (const r0 of range.getClientRects()) {
      const r = { left: Math.max(r0.left, clip.left), top: Math.max(r0.top, clip.top), right: Math.min(r0.right, clip.right), bottom: Math.min(r0.bottom, clip.bottom) }
      r.width = r.right - r.left; r.height = r.bottom - r.top
      if (r.width < 2 || r.height < 2) continue
      if (r.bottom < 0 || r.top > window.innerHeight * 3) continue
      texts.push({ el, r })
    }
  }
  // Text running out of its box with no ellipsis and not scrollable.
  for (const el of seen) {
    const s = getComputedStyle(el)
    if (s.textOverflow === 'ellipsis') continue
    if (/(auto|scroll)/.test(s.overflowX)) continue
    if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0 && s.display !== 'inline' && /(hidden|clip)/.test(s.overflowX)) {
      issues.push({ kind: 'text-cut-off', detail: `${el.scrollWidth}px of text in a ${el.clientWidth}px box`, el: label(el) })
    }
  }
  // A text box that clips and has round corners shaves its first and last letters.
  for (const el of seen) {
    const s = getComputedStyle(el)
    if (!/(hidden|clip)/.test(s.overflowX)) continue
    const rad = parseFloat(s.borderTopLeftRadius) || 0
    const pad = parseFloat(s.paddingLeft) || 0
    if (rad > 3 && rad > pad + 2 && el.getBoundingClientRect().height < 40) issues.push({ kind: 'letters-shaved-by-round-corner', detail: `radius ${rad}px, padding ${pad}px`, el: label(el) })
  }
  // Two different pieces of text drawn over each other.
  const hits = new Set()
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j]
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (x <= 2 || y <= 3) continue
      const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (x * y < small * 0.15) continue
      // Only if one is actually painted over the other at that spot.
      const cx = Math.max(a.r.left, b.r.left) + x / 2, cy = Math.max(a.r.top, b.r.top) + y / 2
      if (cy < 0 || cy > window.innerHeight) continue
      const top = document.elementFromPoint(cx, cy)
      if (!top || !(a.el.contains(top) || b.el.contains(top) || top.contains(a.el) || top.contains(b.el))) continue
      const key = label(a.el) + '|' + label(b.el)
      if (hits.has(key)) continue
      hits.add(key)
      const fixed = (e) => { for (let p = e; p; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === 'fixed' || ps === 'sticky') return true } return false }
      issues.push({
        kind: fixed(a.el) !== fixed(b.el) ? 'covered-by-floating-element' : 'text-overlaps-text',
        detail: `${Math.round(x)}x${Math.round(y)}px overlap at ${Math.round(cx)},${Math.round(cy)}`,
        el: label(a.el) + '  <->  ' + label(b.el),
        top: top ? label(top) : '',
      })
    }
  }
  return issues.slice(0, 40)
}

;(async () => {
  const browser = await chromium.launch()
  const login = async (ctx) => {
    const page = await ctx.newPage()
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('#identifier', process.env.SCREEN_ID)
    await page.fill('#password', process.env.SCREEN_PW)
    await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.click('#login-submit')])
    await page.waitForTimeout(2000)
    const ok = !page.url().includes('/login')
    await page.close()
    return ok
  }
  const base = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  if (!(await login(base))) { console.log('LOGIN FAILED'); await browser.close(); process.exit(2) }
  const state = await base.storageState()
  const cat = await (await base.request.get(BASE + '/api/v1/catalog')).json()
  const urls = new Set(['/', '/settings', '/account', '/help', '/concerns'])
  for (const r of cat.roles || []) {
    for (const s of r.sections || []) for (const f of s.features || []) {
      if (f.in_scope && f.live) urls.add(`/${r.key}/${s.slug}/${f.slug}`)
    }
  }
  let list = [...urls]
  if (ONLY) list = list.filter((u) => ONLY.some((o) => u.includes(o)))
  console.log('screens', list.length)
  const report = []
  for (const size of SIZES) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile || !!size.touch, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    for (const u of list) {
      try {
        await page.goto(BASE + u, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
        await page.waitForTimeout(800)
        const issues = await page.evaluate(detect)
        if (issues.length) {
          const shot = `${size.name}${u.replace(/[^a-z0-9]+/gi, '_')}.png`.slice(0, 150)
          await page.screenshot({ path: path.join(OUT, shot) })
          report.push({ size: size.name, url: u, final: page.url().replace(BASE, ''), shot, issues })
        }
        console.log(size.name, u, issues.length)
      } catch (e) {
        report.push({ size: size.name, url: u, error: String(e).slice(0, 200) })
        console.log(size.name, u, 'ERR')
      }
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
    }
    await ctx.close()
  }
  await browser.close()
  const found = report.filter((r) => r.error || r.issues.length).length
  console.log(found ? `${found} screen/size pairs need fixing: see ${OUT}/report.json` : 'All screens fit every size')
  process.exit(found ? 1 : 0)
})()
