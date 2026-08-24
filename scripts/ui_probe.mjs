/* Walk the app as a real browser, one role at a time, and report what each
   screen actually rendered.

   WHY THIS EXISTS. Every UI defect in this project up to now was found by a
   person looking at a screenshot and describing it, then me inferring the cause
   from the code. That loop is slow and it was wrong about as often as it was
   right — three of today's "fixes" addressed rules that were correct and being
   applied to elements that were not on the page.

   A browser settles those questions. It also catches the class of bug that no
   amount of reading finds: a rule that is right, shipped, and resolving against
   nothing.

   WHAT IT IS NOT. It is not a test suite — nothing here asserts. It reports
   what rendered so a person can see what changed. Treat a number moving as a
   question, not a failure.

   Usage:
     cd web && node ../scripts/ui_probe.mjs            # against the live host
     BASE=http://localhost:5173 node ../scripts/ui_probe.mjs

   The password is not in this file on purpose. Set UI_PROBE_PASSWORD, and set
   it with `migrate demo-users -password` — passwords are bcrypt over an HMAC
   with a server-side pepper, so they cannot be read back out of the database.
*/
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = process.env.BASE || 'https://temperp.187-127-178-100.sslip.io'
const PW = process.env.UI_PROBE_PASSWORD
const OUT = process.env.OUT || 'ui-probe.json'

if (!PW) {
  console.error('set UI_PROBE_PASSWORD (see the note at the top of this file)')
  process.exit(2)
}

const ROLES = [
  ['institution_admin', 'institution_admin@vivencia.test'],
  ['faculty', 'faculty@vivencia.test'],
  ['finance', 'finance@vivencia.test'],
  ['admissions', 'admissions@vivencia.test'],
  ['hr', 'hr@vivencia.test'],
  ['parent', 'parent@vivencia.test'],
  ['student', 'student@vivencia.test'],
]

const browser = await chromium.launch()
const results = []

for (const [role, email] of ROLES) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } })
  const page = await ctx.newPage()
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[name="identifier"]', email)
    await page.fill('input[name="password"]', PW)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"]'),
    ])

    /* The paths come from the app's own navigation rather than from a list kept
       here, so a screen added tomorrow is probed without anybody remembering to
       add it — and a screen that stops being reachable stops being probed,
       which is itself worth seeing in the diff. */
    const paths = [...new Set(await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/"]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && h.split('/').length === 4)))]

    for (const path of paths) {
      const errors = []
      const failed = []
      const onConsole = (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) }
      const onResponse = (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '')}`) }
      page.on('console', onConsole)
      page.on('response', onResponse)

      let nav = 'ok'
      try {
        await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 })
        await page.waitForTimeout(600)
      } catch { nav = 'timeout' }

      const shape = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body
        const text = (main.innerText || '').trim()
        return {
          chars: text.length,
          heading: (main.querySelector('h1,h2,[role=heading]')?.textContent || '').trim().slice(0, 60),
          // Controls, so a screen that says "choose a section" can be checked
          // for actually having one. A custom combobox is not a <select>.
          controls: main.querySelectorAll('select,input,[role=combobox],[role=listbox]').length,
          empty_state: /no data|nothing to show|no results|none yet|nothing here/i.test(text),
          // Formatting slips that are cheap to spot and easy to reintroduce.
          unrounded_percent: (text.match(/\d+\.\d{4,}\s*%/g) || []).slice(0, 3),
          raw_snake_case: (text.match(/(?:^|\s)[a-z]{3,}_[a-z]{3,}(?:\s|$)/g) || []).map((s) => s.trim()).slice(0, 3),
        }
      })

      page.off('console', onConsole)
      page.off('response', onResponse)
      results.push({ role, path, nav, ...shape, errors: errors.slice(0, 3), failed: [...new Set(failed)].slice(0, 3) })
    }
  } catch (e) {
    results.push({ role, path: '(sign in)', nav: 'failed', error: String(e).slice(0, 200) })
  }
  await ctx.close()
}

await browser.close()
writeFileSync(OUT, JSON.stringify(results, null, 1))

const n = (f) => results.filter(f).length
console.log(`screens        ${results.length}`)
console.log(`console errors ${n((r) => r.errors?.length)}`)
console.log(`failed calls   ${n((r) => r.failed?.length)}`)
console.log(`timeouts       ${n((r) => r.nav === 'timeout')}`)
console.log(`empty states   ${n((r) => r.empty_state)}`)
console.log(`thin (<400ch)  ${n((r) => (r.chars ?? 0) < 400)}`)
console.log(`written to     ${OUT}`)
