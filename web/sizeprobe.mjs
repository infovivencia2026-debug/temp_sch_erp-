import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const b=await chromium.launch()
for (const [name,w,h] of [['desktop',1600,900],['phone',390,844]]) {
  const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:w,height:h}}); const p=await ctx.newPage()
  await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
  await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
  await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
  await p.waitForTimeout(2800)
  const r = await p.evaluate(()=>{
    const out=[]
    for (const cell of [...document.querySelectorAll('.bento-cell')].slice(0,4)) {
      const ps=[...cell.querySelectorAll('p')]
      const cs=getComputedStyle(cell)
      out.push({
        cell: Math.round(cell.getBoundingClientRect().width)+'x'+Math.round(cell.getBoundingClientRect().height),
        title: ps[0]? getComputedStyle(ps[0]).fontSize : '-',
        sub:   ps[1]? getComputedStyle(ps[1]).fontSize+' w'+getComputedStyle(ps[1]).fontWeight : '-',
        vars: { fig: cs.getPropertyValue('--card-fig').trim(), sub: cs.getPropertyValue('--card-sub').trim(), title: cs.getPropertyValue('--card-title').trim() },
      })
    }
    return { text: getComputedStyle(document.documentElement).getPropertyValue('--font-scale'), out }
  })
  console.log(name, '--font-scale:', r.text || '(unset)')
  for (const c of r.out) console.log('   ', c.cell.padEnd(10), 'title', c.title.padEnd(8), 'sub', c.sub.padEnd(12), JSON.stringify(c.vars))
  await ctx.close()
}
await b.close()
