import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const OUT='/tmp/claude-1000/-home-qb-temp-sch-erp-/7dc4d805-96bd-4b62-aadb-3cdc69949126/scratchpad'
const b=await chromium.launch()
const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900},deviceScaleFactor:2})
const p=await ctx.newPage()
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
await p.waitForTimeout(3000)
const bell = await p.$('.bento-dock button[aria-label*="Notification" i]')
console.log('bell in dock:', !!bell)
if (bell) {
  const box = await bell.boundingBox()
  console.log('bell box:', JSON.stringify(box))
  await bell.click()
  await p.waitForTimeout(1200)
  await p.screenshot({path:`${OUT}/notif.png`})
  const info = await p.evaluate(()=>{
    const d=document.querySelector('[role="dialog"][aria-label="Notifications"]')
    if(!d) return 'NO DIALOG'
    const r=d.getBoundingClientRect(); const cs=getComputedStyle(d)
    const parent=d.parentElement
    return { rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
             z:cs.zIndex, pos:cs.position, parentZ:parent?getComputedStyle(parent).zIndex:null,
             viewport:{w:innerWidth,h:innerHeight} }
  })
  console.log('dialog:', JSON.stringify(info))
}
await b.close()
