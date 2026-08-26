/* Does every appearance axis actually reach a cell?

   Set the attribute, read what the cell computes. A preference that is stored,
   remembered and multiplied by zero looks exactly like one that works. */
import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const b=await chromium.launch(); const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1600,height:900}}); const p=await ctx.newPage()
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
await p.fill('input[name="identifier"]','institution_admin@vivencia.test'); await p.fill('input[name="password"]',PW)
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
await p.waitForTimeout(2500)

const AXES=[
  ['corners',['sharp','','round'],'borderRadius'],
  ['borders',['none','','strong'],'borderTopWidth'],
  ['shadow',['flat','','lifted','deep'],'boxShadow'],
  ['density',['compact','comfortable','spacious'],'__gap'],
  ['text',['small','','large','larger'],'fontSize'],
]
for (const [attr, values, prop] of AXES) {
  const seen=[]
  for (const v of values) {
    /* Settle first. box-shadow carries a 140ms transition, and reading the
       moment the attribute changes catches the transparent first frame — which
       is how 'lifted' and 'deep' both reported as an empty shadow while
       actually being applied. A probe that races the thing it measures is
       worse than none: it reports a fault that is not there and hides one that
       is. */
    await p.evaluate(({attr,v})=>{
      const r=document.documentElement
      if(v) r.setAttribute(`data-${attr}`,v); else r.removeAttribute(`data-${attr}`)
    },{attr,v})
    await p.waitForTimeout(320)
    const got=await p.evaluate(({attr,v,prop})=>{
      const r=document.documentElement
      if(v) r.setAttribute(`data-${attr}`,v); else r.removeAttribute(`data-${attr}`)
      const cell=document.querySelector('.bento-cell'); const board=document.querySelector('.bento-board')
      if(!cell) return 'NO CELL'
      if(prop==='__gap') return getComputedStyle(board).gap
      if(prop==='fontSize'){ const f=cell.querySelector('p'); return f?getComputedStyle(f).fontSize:'?' }
      return getComputedStyle(cell)[prop]
    },{attr,v,prop})
    seen.push(`${v||'(default)'}=${got}`)
  }
  const distinct=new Set(seen.map(x=>x.split('=')[1])).size
  console.log(`${attr.padEnd(9)} ${distinct>1?'OK  ':'DEAD'} ${seen.join('  ')}`)
}
await b.close()
