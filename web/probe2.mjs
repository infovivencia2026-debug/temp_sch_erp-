import { chromium } from 'playwright'
const BASE='https://temperp.187-127-178-100.sslip.io', PW=process.env.UI_PROBE_PASSWORD
const b=await chromium.launch(); const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:900,height:1000}}); const p=await ctx.newPage()
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'})
await p.fill('input[name="identifier"]','finance@vivencia.test'); await p.fill('input[name="password"]',PW)
await Promise.all([p.waitForNavigation({waitUntil:'networkidle'}).catch(()=>{}),p.click('button[type="submit"]')])
await p.waitForTimeout(2500)
console.log(JSON.stringify(await p.evaluate(()=>{
  const board=document.querySelector('.bento-board')
  const bs=board?getComputedStyle(board):null
  const cell=document.querySelector('.bento-cell')
  const shell=cell?.querySelector(':scope > div, :scope > a')
  const cs=cell?getComputedStyle(cell):null
  return {
    boardH: board?.getBoundingClientRect().height,
    boardHVar: bs?.getPropertyValue('height'),
    boardRows: bs?.gridTemplateRows,
    boardCols: bs?.gridTemplateColumns,
    boardHCustom: bs?.getPropertyValue('--board-h'),
    cellH: cell?.getBoundingClientRect().height,
    cellStyleH: cs?.height,
    cellOverflow: cs?.overflow,
    shellClient: shell?.clientHeight, shellScroll: shell?.scrollHeight,
    shellClasses: shell?.className?.slice(0,90),
    inner: [...(shell?.children??[])].map(c=>({cls:String(c.className).slice(0,50),h:c.getBoundingClientRect().height,sh:c.scrollHeight})),
  }
},null),null,2))
await b.close()
