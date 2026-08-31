/* Measures what the browser actually computes, not what the stylesheet says.
   Every motion bug in this file has been a declaration that reads correctly
   and never takes effect, so the only trustworthy check is a computed style
   read out of a live page. */
import { chromium } from 'playwright'
const BASE = process.env.PROBE_BASE || 'https://temperp.187-127-178-100.sslip.io'
const PW = process.env.UI_PROBE_PASSWORD
const b = await chromium.launch()
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
const p = await ctx.newPage()
await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
// No sign-in needed: index.css is global, and the check is what the browser
// computes for a given element, not what any particular screen renders.
await p.waitForTimeout(600)

const out = await p.evaluate(() => {
  const probe = (html, sel) => {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    const el = sel ? host.querySelector(sel) : host.firstElementChild
    const c = getComputedStyle(el)
    const r = {
      animationName: c.animationName,
      animationDuration: c.animationDuration,
      animationTimingFunction: c.animationTimingFunction,
      transitionDuration: c.transitionDuration,
    }
    host.remove()
    return r
  }
  return {
    skeleton: probe('<div class="h-9 animate-pulse rounded-sm bg-muted"></div>'),
    menu: probe('<div role="menu"></div>'),
    dialog: probe('<div role="dialog"></div>'),
    tokens: {
      enter: getComputedStyle(document.documentElement).getPropertyValue('--motion-enter').trim(),
      motion: getComputedStyle(document.documentElement).getPropertyValue('--motion').trim(),
      spring: getComputedStyle(document.documentElement).getPropertyValue('--motion-spring').trim(),
    },
  }
})
console.log(JSON.stringify(out, null, 2))
await b.close()
