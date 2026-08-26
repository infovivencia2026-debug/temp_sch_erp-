import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const b=await chromium.launch(); const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:900}}); const p=await ctx.newPage()
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
await p.waitForTimeout(2500)
for (const stack of ['', 'ui-serif, Georgia, serif', "'Helvetica Neue', Helvetica, Arial, sans-serif"]) {
  await p.evaluate((s)=>{ const r=document.documentElement; if(s) r.style.setProperty('--font-ui', s); else r.style.removeProperty('--font-ui') }, stack)
  await p.waitForTimeout(200)
  const got = await p.evaluate(()=>{
    const cell=document.querySelector('.bento-cell')
    const title=cell?.querySelector('p')
    const fig=[...cell.querySelectorAll('p')].find(e=>getComputedStyle(e).fontSize.replace('px','')>20)
    const sub=[...cell.querySelectorAll('p')].find(e=>getComputedStyle(e).letterSpacing!=='normal')
    return {
      html: getComputedStyle(document.documentElement).fontFamily.slice(0,42),
      title: title?getComputedStyle(title).fontFamily.slice(0,42):'?',
      figure: fig?getComputedStyle(fig).fontFamily.slice(0,42):'?',
      subFamily: sub?getComputedStyle(sub).fontFamily.slice(0,30):'?',
      subTracking: sub?getComputedStyle(sub).letterSpacing:'?',
      subSize: sub?getComputedStyle(sub).fontSize:'?',
    }
  })
  console.log((stack||'(default)').slice(0,34).padEnd(36), JSON.stringify(got))
}
await b.close()
