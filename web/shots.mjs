import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const OUT='/tmp/claude-1000/-home-qb-temp-sch-erp-/7dc4d805-96bd-4b62-aadb-3cdc69949126/scratchpad'
const b=await chromium.launch()
for (const [name,w,h] of [['phone',390,844],['tablet',820,1180]]) {
  const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:w,height:h},deviceScaleFactor:2})
  const p=await ctx.newPage()
  await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
  await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
  await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
  await p.waitForTimeout(3000)
  await p.screenshot({path:`${OUT}/${name}.png`})
  console.log(name, 'ok')
  await ctx.close()
}
await b.close()
