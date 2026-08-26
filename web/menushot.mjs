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
  const btns = await p.$$('.bento-dock button, .bento-dock a')
  console.log(name, 'dock controls:', btns.length)
  for (const [i,btn] of btns.entries()) {
    const lbl = await btn.getAttribute('aria-label') || (await btn.getAttribute('data-tip')) || (await btn.innerText()).trim().slice(0,20)
    console.log('   ', i, JSON.stringify(lbl))
  }
  if (btns[2]) { await btns[2].click().catch(()=>{}); await p.waitForTimeout(1500); await p.screenshot({path:`${OUT}/${name}-menu.png`}) }
  await ctx.close()
}
await b.close()
