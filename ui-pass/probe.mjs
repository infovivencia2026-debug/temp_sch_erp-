/* Diagnostic: which elements carry each type size and each background colour on the home. */
import { chromium } from '/home/qb/temp_sch_erp-/node_modules/playwright/index.mjs'
import http from 'node:http'; import https from 'node:https'; import fs from 'node:fs'; import path from 'node:path'
const [, , target] = process.argv
const LIVE_HOST = 'temperp.187-127-178-100.sslip.io'
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname.startsWith('/api') || u.pathname === '/login' || u.pathname === '/logout') {
    const headers = { ...req.headers, host: LIVE_HOST }; delete headers['accept-encoding']
    const up = https.request({ host: LIVE_HOST, port: 443, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (r) => { const h = { ...r.headers }; if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*secure/ig, '').replace(/;\s*domain=[^;]*/ig, '')); res.writeHead(r.statusCode, h); r.pipe(res) })
    req.pipe(up); return
  }
  let f = path.join(target, decodeURIComponent(u.pathname)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(target, 'index.html')
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(res)
})
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
if (process.env.BUSY) {
  const kpi = { students: 412, staff: 31, sections: 18, attendance_today_pct: 91.3, attendance_marked_today: 380, collected_paise: 48650000, outstanding_paise: 12340000, billed_paise: 61000000, collected_year_paise: 48650000, outstanding_year_paise: 12340000, defaulters: 17, pending_leave: 3, open_applications: 9, unassigned_subjects: 4, year_invoice_count: 412, class_subjects_total: 96, students_by_class: [{ class_id: 'c1', class_name: 'Grade 6', students: 140 }, { class_id: 'c2', class_name: 'Grade 7', students: 136 }], range: { period: 'month', from: '2026-09-01', to: '2026-09-03', label: 'This month' }, as_of_now: [] }
  await ctx.route('**/api/v1/principal/dashboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(kpi) }))
}
const p = await ctx.newPage()
await p.goto(base + '/login', { waitUntil: 'networkidle' }); await p.fill('input[name="identifier"]', 'vignan@gmail.com'); await p.fill('input[name="password"]', 'test@123'); await p.click('button[type="submit"]')
await p.waitForURL(/institution_admin/, { timeout: 30000 }).catch(() => {}); await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(1500)
await p.goto(base + '/institution_admin/home/dashboard', { waitUntil: 'networkidle' }).catch(async () => { await p.waitForTimeout(2000); await p.goto(base + '/institution_admin/home/dashboard', { waitUntil: 'networkidle' }) })
await p.waitForTimeout(2500)
const out = await p.evaluate(() => {
  const main = document.querySelector('main'); const visible = (s) => { let e = s; while (e && e !== document.body) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.display === 'none') return false; e = e.parentElement } return true }
  const sizes = {}, bgs = {}
  for (const el of main.querySelectorAll('*')) { if (!visible(el)) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const cs = getComputedStyle(el)
    if ([...el.childNodes].some((k) => k.nodeType === 3 && k.textContent.trim())) { const k = Math.round(parseFloat(cs.fontSize) * 2) / 2; (sizes[k] ??= new Set()).add(el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 3).join('.') + ' "' + el.textContent.trim().slice(0, 18) + '"') }
    const bg = cs.backgroundColor; if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { (bgs[bg] ??= new Set()).add(el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 3).join('.') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)) } }
  return { sizes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, [...v].slice(0, 4)])), bgs: Object.fromEntries(Object.entries(bgs).map(([k, v]) => [k, [...v].slice(0, 3)])) }
})
console.log(JSON.stringify(out, null, 1)); await b.close(); server.close()
