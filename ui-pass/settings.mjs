/* Settings before/after. node ui-pass/settings.mjs live before | <distDir> after */
import { chromium } from '/home/qb/temp_sch_erp-/node_modules/playwright/index.mjs'
import http from 'node:http'; import https from 'node:https'; import fs from 'node:fs'; import path from 'node:path'
const [, , target, tag] = process.argv
const OUT = '/home/qb/temp_sch_erp-/.claude/worktrees/agent-aa628941c4cdf89e7/ui-pass/'
const LIVE = 'https://temperp.187-127-178-100.sslip.io'; const LIVE_HOST = 'temperp.187-127-178-100.sslip.io'
let base = LIVE; let server
if (target !== 'live') {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/api') || u.pathname === '/login' || u.pathname === '/logout') {
      const headers = { ...req.headers, host: LIVE_HOST }; delete headers['accept-encoding']
      const up = https.request({ host: LIVE_HOST, port: 443, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (r) => { const h = { ...r.headers }; if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*secure/ig, '').replace(/;\s*domain=[^;]*/ig, '')); if (h.location) h.location = h.location.replace(LIVE, base); res.writeHead(r.statusCode, h); r.pipe(res) })
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)) }); req.pipe(up); return
    }
    let f = path.join(target, decodeURIComponent(u.pathname)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(target, 'index.html')
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`
}
const METRICS = () => {
  const main = document.querySelector('main') || document.body
  const parse = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; const v = m.slice(0, 4).map(Number); if (c.startsWith('color(')) return [v[0] * 255, v[1] * 255, v[2] * 255, ...(v.length > 3 ? [v[3]] : [])].map((x, i) => (i < 3 ? Math.round(x) : x)); return v }
  const alphaOf = (m) => (m[3] === undefined ? 1 : m[3])
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const blend = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)))
  const bgOf = (el) => { let e = el; let acc = null; while (e) { const m = parse(getComputedStyle(e).backgroundColor); if (m && alphaOf(m) > 0) { if (alphaOf(m) >= 1) return acc ? blend(acc.fg, acc.a, m.slice(0, 3)) : m.slice(0, 3); if (!acc) acc = { fg: m.slice(0, 3), a: alphaOf(m) } } e = e.parentElement } return acc ? blend(acc.fg, acc.a, [255, 255, 255]) : [255, 255, 255] }
  const visible = (s) => { let e = s; while (e && e !== document.body) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.display === 'none') return false; e = e.parentElement } return true }
  const vis = [...main.querySelectorAll('*')].filter((el) => { if (!visible(el)) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 1 && r.height > 1 && cs.clip !== 'rect(0px, 0px, 0px, 0px)' })
  const textEls = vis.filter((el) => [...el.childNodes].some((k) => k.nodeType === 3 && k.textContent.trim()))
  const text = textEls.map((el) => [...el.childNodes].filter((k) => k.nodeType === 3).map((k) => k.textContent).join(' ')).join(' ')
  const wordsAll = text.toLowerCase().split(/[^\p{L}\p{N}%]+/u).filter(Boolean)
  const typeSizes = [...new Set(textEls.map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2))].sort((a, b) => a - b)
  const controls = vis.filter((el) => el.matches('a[href], button, [role="button"], [role="tab"], [role="switch"], [role="radio"], [role="slider"], input, select, textarea'))
  const pills = vis.filter((el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const br = parseFloat(cs.borderRadius); const bgm = parse(cs.backgroundColor); const hasBg = (bgm && alphaOf(bgm) > 0) || cs.borderStyle !== 'none'; return el.children.length === 0 && el.textContent.trim().length > 0 && el.textContent.trim().length <= 14 && r.height <= 30 && br >= 6 && hasBg && !el.matches('button, a, input') })
  const fails = []; let minRatio = 99; let checked = 0
  for (const el of textEls) { const fg = parse(getComputedStyle(el).color); if (!fg) continue; let op = 1; let e = el; while (e && e !== main) { op *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement } const bg = bgOf(el); const eff = blend(fg.slice(0, 3), alphaOf(fg) * op, bg); const L1 = lum(eff), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); checked++; if (ratio < minRatio) minRatio = ratio; if (ratio < 4.5) fails.push({ txt: el.textContent.trim().slice(0, 24), ratio: +ratio.toFixed(2), fs: getComputedStyle(el).fontSize }) }
  const rows = [...main.querySelectorAll('[data-row]')]
  const rowHeights = [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))]
  const rowPads = [...new Set(rows.map((r) => { const s = getComputedStyle(r); return `${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft}` }))]
  const smallTargets = controls.filter((c) => { const r = c.getBoundingClientRect(); return r.height < 44 || r.width < 44 }).map((c) => `${c.tagName.toLowerCase()} "${c.textContent.trim().slice(0, 14) || c.getAttribute('aria-label') || ''}" ${Math.round(c.getBoundingClientRect().width)}x${Math.round(c.getBoundingClientRect().height)}`)
  return { words: wordsAll.length, distinctWords: new Set(wordsAll).size, controls: controls.length, controlKinds: Object.entries(controls.reduce((a, c) => { const k = c.tagName.toLowerCase() + (c.getAttribute('role') ? '[' + c.getAttribute('role') + ']' : c.type ? '[' + c.type + ']' : ''); a[k] = (a[k] || 0) + 1; return a }, {})), pills: pills.length, pillText: pills.map((p) => p.textContent.trim()).slice(0, 14), typeSizes, typeSizeCount: typeSizes.length, rows: rows.length, rowHeights, rowPads, smallTargets: smallTargets.slice(0, 12), smallTargetCount: smallTargets.length, contrastChecked: checked, contrastMin: +minRatio.toFixed(2), failCount: fails.length, fails: fails.slice(0, 8) }
}
const b = await chromium.launch()
async function setTheme(p, dark) { await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' }); await p.evaluate((d) => { document.documentElement.classList.toggle('dark', d); if (d) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme }, dark); await p.waitForTimeout(500) }
for (const [dev, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, ignoreHTTPSErrors: true }); const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)))
  await p.goto(base + '/login', { waitUntil: 'networkidle' }); await p.fill('input[name="identifier"]', 'vignan@gmail.com'); await p.fill('input[name="password"]', 'test@123'); await p.click('button[type="submit"]')
  await p.waitForURL(/institution_admin/, { timeout: 30000 }).catch(() => {}); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(1500)
  const go = async (u) => { await p.goto(base + u, { waitUntil: 'networkidle' }).catch(async () => { await p.waitForTimeout(2000); await p.goto(base + u, { waitUntil: 'networkidle' }) }); await p.waitForTimeout(1500) }
  await go('/settings')
  console.log('url', p.url())
  await p.screenshot({ path: `${OUT}${tag}-settings-${dev}.png`, fullPage: true })
  console.log(JSON.stringify({ tag, dev, theme: 'light', ...(await p.evaluate(METRICS)) }))
  await setTheme(p, true); await p.screenshot({ path: `${OUT}${tag}-settings-${dev}-dark.png`, fullPage: true })
  console.log(JSON.stringify({ tag, dev, theme: 'dark', ...(await p.evaluate(METRICS)) }))
  await setTheme(p, false)
  for (const sec of ['appearance', 'dock', 'dashboard', 'school']) {
    await go('/settings/' + sec)
    await p.screenshot({ path: `${OUT}${tag}-settings-${sec}-${dev}.png`, fullPage: true })
    console.log(JSON.stringify({ tag, dev, theme: 'light', section: sec, ...(await p.evaluate(METRICS)) }))
    if (sec === 'appearance') { await setTheme(p, true); await p.screenshot({ path: `${OUT}${tag}-settings-${sec}-${dev}-dark.png`, fullPage: true }); console.log(JSON.stringify({ tag, dev, theme: 'dark', section: sec, ...(await p.evaluate(METRICS)) })); await setTheme(p, false) }
  }

  await ctx.close()
}
await b.close(); server?.close()
