const { chromium } = require('playwright-core')
const BASE = 'https://temperp.187-127-178-100.sslip.io'
;(async () => {
  const b = await chromium.launch({ channel: 'chrome' })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1240, height: 760 } })
  const p = await ctx.newPage()
  await p.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await p.fill('input[name=username], input[type=text]', 'ramesh')
  await p.fill('input[type=password]', 'Onrolonrol@ai')
  await Promise.all([p.waitForNavigation({ timeout: 90000 }).catch(() => {}), p.click('button[type=submit]')])
  await p.waitForTimeout(7000)
  await p.click('.bento-dock [aria-label="Settings"]')
  await p.waitForTimeout(2000)
  const tabs = await p.$$('[data-appearance-dialog] [role=tab], [data-appearance-dialog] button')
  for (const name of ['Role switch', 'Account']) {
    const el = await p.$('[data-appearance-dialog] >> text="' + name + '"')
    if (!el) { console.log('tab not found: ' + name); continue }
    await el.click(); await p.waitForTimeout(1500)
    await p.screenshot({ path: name.replace(' ', '') + '.png' })
    const t = await p.evaluate(() => {
      const rows = document.querySelectorAll('[data-appearance-dialog] a, [data-appearance-dialog] [class*=row]')
      return [...rows].map((r) => r.innerText.split(String.fromCharCode(10))[0]).filter(Boolean).join(' | ')
    })
    console.log(name + ' >>> ' + t)
  }
  await b.close()
})()