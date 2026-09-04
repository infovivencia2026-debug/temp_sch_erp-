/* Why every screen sits on a skeleton — measured, not read.

   "It loads slowly" is a claim about wall-clock time, and the only honest way
   to settle it is to drive the real deployment and time it. This signs in and
   walks a set of screens, recording per screen:

     - every request: URL, status, wall duration, bytes actually on the wire
       (encodedDataLength from CDP, so gzip is counted as gzip)
     - time from navigation until the screen has real content: no skeleton
       (.animate-pulse), no "Loading…"/"Opening…" placeholder
     - duplicates: the identical method+URL fired more than once for one screen
     - waterfalls: a request that only STARTED after another FINISHED, with a
       small gap — what a serial dependent fetch looks like from outside

   Nothing asserts. It prints numbers so causes can be ranked by the
   milliseconds they cost.

   Usage:
     cd web && PROBE_USER=… PROBE_PASS=… node loadprobe.mjs
     PROBE_PATHS='["/institution_admin/home/dashboard"]' node loadprobe.mjs
*/
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = process.env.BASE || 'https://temperp.187-127-178-100.sslip.io'
const WHO = process.env.PROBE_USER
const PW = process.env.PROBE_PASS
const OUT = process.env.OUT || 'loadprobe.json'
const SETTLE = Number(process.env.PROBE_SETTLE || 45000)
const PATHS = JSON.parse(
  process.env.PROBE_PATHS ||
    `["/institution_admin/home/dashboard","/institution_admin/fees/fee_dashboard","/institution_admin/students/students","/institution_admin/staff/leaves_subs","/institution_admin/academics/school_calendar"]`,
)

if (!WHO || !PW) {
  console.error('set PROBE_USER and PROBE_PASS')
  process.exit(2)
}

const short = (u) => u.replace(BASE, '').replace(/^\/api\/v1/, '')
const isApi = (u) => u.includes('/api/')
const isAsset = (u) => /\.(m?js|css)(\?|$)/.test(u)
const kb = (n) => (n / 1024).toFixed(0) + 'kB'

const browser = await chromium.launch()
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()

/* CDP rather than page.on('response'): only Network.loadingFinished carries
   encodedDataLength, which is the number that actually costs the user time.
   content-length is missing on every gzipped response here. */
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
const live = new Map()
let rec = []
const now = () => performance.now()
cdp.on('Network.requestWillBeSent', (e) => live.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type, start: now() }))
cdp.on('Network.responseReceived', (e) => { const r = live.get(e.requestId); if (r) { r.status = e.response.status; r.type = e.type; r.fromCache = e.response.fromDiskCache } })
const done = (e, failed) => {
  const r = live.get(e.requestId)
  if (!r) return
  live.delete(e.requestId)
  rec.push({ ...r, failed: !!failed, size: e.encodedDataLength || r.got || 0, end: now(), ms: Math.round(now() - r.start) })
}
cdp.on('Network.dataReceived', (e) => { const r = live.get(e.requestId); if (r) r.got = (r.got || 0) + (e.encodedDataLength || e.dataLength || 0) })
cdp.on('Network.loadingFinished', (e) => done(e, false))
cdp.on('Network.loadingFailed', (e) => done(e, true))

// --- sign in ---------------------------------------------------------------
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.fill('input[name="identifier"]', WHO)
await page.fill('input[name="password"]', PW)
rec = []
const loginAt = now()
await Promise.all([
  page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
  page.click('button[type="submit"]'),
])

/* The cold boot is its own measurement: it is what a user pays once per
   session, and it is where the bundle and the bootstrap fetches land. */
const settled = await waitForContent(loginAt)
const cold = rec.slice().sort((a, b) => a.start - b.start)
if (/\/login/.test(page.url())) { console.error('still on /login — wrong credentials?'); process.exit(3) }

/* Stop when nothing has been requested for `gap` ms. A fixed sleep stopped
   recording before the lazy feature chunk had even asked for its data. */
async function quiet(gap, cap) {
  const until = now() + cap
  let last = now()
  let n = rec.length
  while (now() < until) {
    if (rec.length !== n) { n = rec.length; last = now() }
    else if (now() - last > gap) return
    await page.waitForTimeout(100)
  }
}

async function waitForContent(from) {
  const deadline = now() + SETTLE
  while (now() < deadline) {
    const ok = await page
      .evaluate(() => {
        if (document.querySelectorAll('.animate-pulse').length) return false
        const t = (document.body.innerText || '').trim()
        if (/Loading…|Loading\.\.\.|Opening the school/.test(t)) return false
        return t.length > 400
      })
      .catch(() => false)
    if (ok) return Math.round(now() - from)
    await page.waitForTimeout(60)
  }
  return null
}

// --- per screen ------------------------------------------------------------
const screens = []
for (const path of PATHS) {
  rec = []
  const nav = now()
  await page.goto(BASE + path, { waitUntil: 'commit' }).catch(() => {})
  const visibleAt = await waitForContent(nav)
  await quiet(3000, 25000)
  const reqs = rec.slice().sort((a, b) => a.start - b.start)
  const api = reqs.filter((r) => isApi(r.url))

  const byKey = new Map()
  for (const r of reqs) byKey.set(r.method + ' ' + short(r.url), (byKey.get(r.method + ' ' + short(r.url)) || []).concat([r]))
  const dupes = [...byKey.entries()].filter(([, v]) => v.length > 1)
    .map(([k, v]) => ({ key: k, n: v.length, ms: v.reduce((a, b) => a + b.ms, 0) })).sort((a, b) => b.n - a.n)

  /* B started after A ended with a gap under 500ms and nothing overlapping:
     from outside, that is a fetch that could not be issued until A answered. */
  const chains = []
  for (const b of api) {
    let best = null
    for (const a of api) {
      if (a === b || a.end > b.start) continue
      if (b.start - a.end < 500 && (!best || a.end > best.end)) best = a
    }
    if (best) chains.push({ after: short(best.url), then: short(b.url), gap: Math.round(b.start - best.end), cost: b.ms })
  }

  screens.push({
    path, visibleAt,
    nApi: api.length, apiMs: api.reduce((a, r) => a + r.ms, 0),
    bytes: reqs.reduce((a, r) => a + r.size, 0),
    dupes,
    chains: chains.sort((a, b) => b.cost - a.cost).slice(0, 12),
    all: reqs.map((r) => ({ url: short(r.url), type: r.type, ms: r.ms, start: Math.round(r.start - nav), end: Math.round(r.end - nav), status: r.status || 0, size: r.size })),
  })
}

// --- report ----------------------------------------------------------------
const coldAssets = cold.filter((r) => isAsset(r.url))
const js = coldAssets.filter((r) => /\.m?js/.test(r.url))
console.log(`\n=== COLD BOOT (login -> content) : ${settled ?? '>' + SETTLE}ms ===`)
console.log(`JS ${kb(js.reduce((a, r) => a + r.size, 0))} over ${js.length} files, CSS ${kb(coldAssets.filter((r) => /\.css/.test(r.url)).reduce((a, r) => a + r.size, 0))}, everything ${kb(cold.reduce((a, r) => a + r.size, 0))}`)
for (const r of coldAssets.slice().sort((a, b) => b.size - a.size).slice(0, 15)) console.log(`  ${kb(r.size).padStart(8)}  ${String(r.ms).padStart(5)}ms  ${short(r.url)}`)
console.log('  boot timeline (ms from submit):')
for (const r of cold) console.log(`    ${String(Math.round(r.start - loginAt)).padStart(6)} -> ${String(Math.round(r.end - loginAt)).padStart(6)}  ${String(r.ms).padStart(6)}ms ${kb(r.size).padStart(8)}  ${short(r.url)}`)

console.log('\n=== SCREENS ===')
for (const s of screens) {
  console.log(`\n${s.path}\n  content-visible ${s.visibleAt ?? '>' + SETTLE}ms | ${s.nApi} API calls | ${kb(s.bytes)}`)
  console.log('  timeline (API only, ms from navigation):')
  for (const r of s.all) if (r.type === 'XHR' || r.type === 'Fetch') console.log(`    ${String(r.start).padStart(6)} -> ${String(r.end).padStart(6)}  ${String(r.ms).padStart(6)}ms ${String(r.status)} ${kb(r.size).padStart(8)}  ${r.url}`)
  if (s.dupes.length) { console.log('  duplicates:'); for (const d of s.dupes) console.log(`    x${d.n}  ${d.ms}ms  ${d.key}`) }
  if (s.chains.length) { console.log('  serial (only started after another finished):'); for (const c of s.chains) console.log(`    +${c.gap}ms after ${c.after}  ->  ${c.then} (${c.cost}ms)`) }
}

/* Serial then parallel, from inside the page so the cookie goes along. If a
   handler costs 300ms alone and 9s alongside four others, the fault is
   concurrency, not the query. */
const probeUrls = [...new Set(screens.flatMap((s) => s.all.filter((r) => r.type === 'XHR' || r.type === 'Fetch').map((r) => r.url)))]
const iso = await page.evaluate(async (urls) => {
  const one = async (u) => { const t = performance.now(); const r = await fetch('/api/v1' + u, { credentials: 'include' }); const b = await r.text(); return { u, ms: Math.round(performance.now() - t), bytes: b.length, status: r.status } }
  const alone = []
  for (const u of urls) { alone.push(await one(u)); await new Promise((r) => setTimeout(r, 250)) }
  const t = performance.now()
  const together = await Promise.all(urls.map(one))
  return { alone, together, wall: Math.round(performance.now() - t) }
}, probeUrls)
console.log('\n=== ENDPOINT ISOLATION (alone, sequential) ===')
for (const r of iso.alone.slice().sort((a, b) => b.ms - a.ms)) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.status}  ${kb(r.bytes).padStart(8)} uncompressed  ${r.u}`)
console.log(`\n=== SAME ${probeUrls.length} ENDPOINTS ALL AT ONCE: wall ${iso.wall}ms ===`)
for (const r of iso.together.slice().sort((a, b) => b.ms - a.ms)) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.status}  ${r.u}`)

/* What the app asks for when nobody is touching it, and what one alt-tab
   back costs. Both are per open tab, all day, on every screen. */
rec = []
await page.waitForTimeout(60000)
const idle = {}
for (const r of rec) if (r.type === 'XHR' || r.type === 'Fetch') idle[short(r.url)] = (idle[short(r.url)] || 0) + 1
rec = []
await page.evaluate(() => window.dispatchEvent(new Event('focus')))
await quiet(2000, 20000)
const onFocus = rec.filter((r) => r.type === 'XHR' || r.type === 'Fetch').map((r) => short(r.url))
console.log('\n=== IDLE: 60s on this screen, hands off ===')
for (const [u, n] of Object.entries(idle).sort((a, b) => b[1] - a[1])) console.log(`  x${n}  ${u}`)
console.log(`  ${Object.values(idle).reduce((a, b) => a + b, 0)} requests in 60s with nobody touching it`)
console.log(`\n=== ONE WINDOW-FOCUS COSTS ${onFocus.length} REQUESTS ===\n  ${onFocus.join('\n  ')}`)

/* How latency scales with concurrency. A healthy box absorbs 24 at once; a
   sick one serves them one at a time, and that is the difference between a
   screen in half a second and a screen in twenty. */
const ladder = await page.evaluate(async () => {
  const one = async () => { const t = performance.now(); const r = await fetch('/api/v1/catalog', { credentials: 'include', cache: 'no-store' }); await r.text(); return Math.round(performance.now() - t) }
  const out = {}
  for (const n of [1, 2, 4, 8, 16, 24]) {
    const t = performance.now()
    const ms = await Promise.all(Array.from({ length: n }, one))
    out[n] = { wall: Math.round(performance.now() - t), max: Math.max(...ms) }
    await new Promise((r) => setTimeout(r, 1200))
  }
  return out
})
console.log('\n=== CONCURRENCY LADDER (/catalog) ===')
for (const [n, v] of Object.entries(ladder)) console.log(`  ${String(n).padStart(3)} at once: wall ${String(v.wall).padStart(6)}ms, slowest ${v.max}ms  (${(v.wall / ladder[1].wall).toFixed(1)}x the single-request wall)`)

const allApi = screens.flatMap((s) => s.all.filter((r) => r.type === 'XHR' || r.type === 'Fetch').map((r) => ({ ...r, path: s.path })))
console.log('\n=== SLOWEST 20 API CALLS ===')
for (const r of allApi.sort((a, b) => b.ms - a.ms).slice(0, 20)) console.log(`  ${String(r.ms).padStart(6)}ms  ${r.status}  ${kb(r.size).padStart(8)}  ${r.url}   [${r.path}]`)

writeFileSync(OUT, JSON.stringify({ base: BASE, who: WHO, coldMs: settled, iso, idle, onFocus, ladder, cold: cold.map((r) => ({ url: short(r.url), size: r.size, ms: r.ms, start: Math.round(r.start - loginAt) })), screens }, null, 2))
console.log(`\nwrote ${OUT}`)
await browser.close()
