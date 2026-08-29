import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const b=await chromium.launch(); const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}})
const p=await ctx.newPage()
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
await p.waitForTimeout(2500)
// Walk the ancestors of the setup panel looking for a containing block.
console.log(await p.evaluate(()=>{
  const out=[]
  let el = document.querySelector('main') || document.body
  // Report every element on the page that would trap position:fixed.
  for (const n of document.querySelectorAll('*')) {
    const cs = getComputedStyle(n)
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' ||
        cs.willChange.includes('transform') || cs.contain.includes('paint') ||
        cs.backdropFilter !== 'none') {
      out.push(`${n.tagName.toLowerCase()}.${String(n.className).slice(0,40)} transform=${cs.transform!=='none'} filter=${cs.filter!=='none'} contain=${cs.contain} backdrop=${cs.backdropFilter!=='none'}`)
    }
    if (out.length>8) break
  }
  return out.join('\n') || 'nothing traps fixed on this page'
}))
await b.close()
