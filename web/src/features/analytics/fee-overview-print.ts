/* FEE OVERVIEW, AS PRINTED (owner, 2026-10-06; same family as the other
   prints, Inter). School and red rule; the year; four ruled count boxes
   (Demanded, Collected, Outstanding, Concessions); the class table with a
   total row; ageing and concessions side by side; signatures. */

export interface FeeOverviewPrint {
  school: string; logoUrl?: string; printedBy: string
  academic_year: string
  totals: { demanded_paise: number; collected_paise: number; outstanding_paise: number; concession_paise: number; fine_paise: number; students_billed: number; defaulters: number; collected_pct?: number }
  by_class: { class_name: string; students: number; demanded_paise: number; collected_paise: number; outstanding_paise: number; concession_paise: number; collected_pct?: number }[]
  ageing: { bucket: string; invoices: number; students: number; amount_paise: number }[]
  concessions: { kind: string; students: number; awards: number; pending_approval: number; granted_amount_paise: number; percent_awards: number }[]
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const rs = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pc = (n?: number) => (n == null || !isFinite(n) ? '—' : `${n.toFixed(1)}%`)
const tone = (n?: number) => (n == null ? '#64748b' : n >= 90 ? '#15803d' : n >= 60 ? '#b45309' : '#c22525')

export function feeOverviewHtml(o: FeeOverviewPrint): string {
  const t = o.totals
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const box = (label: string, value: string, caption: string) => `<td><div class="bl">${label}</div><div class="bv">${value}</div><div class="bc">${caption}</div></td>`
  const sum = (k: 'students' | 'demanded_paise' | 'collected_paise' | 'outstanding_paise' | 'concession_paise') => o.by_class.reduce((n, c) => n + c[k], 0)
  const allPct = sum('demanded_paise') ? (sum('collected_paise') / sum('demanded_paise')) * 100 : undefined
  const classes = o.by_class.map((c) => `<tr><td><b>${esc(c.class_name)}</b></td><td class="c">${c.students}</td><td class="r">${rs(c.demanded_paise)}</td><td class="r">${rs(c.collected_paise)}</td><td class="r">${rs(c.outstanding_paise)}</td><td class="r">${rs(c.concession_paise)}</td><td class="r" style="color:${tone(c.collected_pct)};font-weight:600">${pc(c.collected_pct)}</td></tr>`).join('')
  const ageTotal = o.ageing.reduce((n, a) => n + a.amount_paise, 0)
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Fee overview · ${esc(o.academic_year)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.lh { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.logo { width: 52px; height: 52px; border-radius: 50%; border: 1px solid #cbd5e1; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #94a3b8; overflow: hidden; }
.logo img { width: 100%; height: 100%; object-fit: contain; }
.lh h1 { font-size: 21px; font-weight: 700; letter-spacing: -.4px; }
.rule { height: 3px; background: #c22525; margin-bottom: 20px; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.title-row h2 { font-size: 18px; font-weight: 700; border-left: 4px solid #c22525; padding-left: 10px; }
.title-row span { font-size: 12px; color: #475569; } .title-row span b { color: #0f172a; }
table.counts { width: 100%; border-collapse: collapse; border: 1.5px solid #0f172a; margin-bottom: 8px; table-layout: fixed; }
table.counts td { border-left: 1.5px solid #0f172a; text-align: center; padding: 0; } table.counts td:first-child { border-left: 0; }
.bl { background: #f1f5f9; border-bottom: 1.5px solid #0f172a; padding: 8px 6px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #1e293b; }
.bv { font-size: 17px; font-weight: 700; padding-top: 10px; line-height: 1.15; }
.bc { font-size: 10.5px; color: #475569; padding: 4px 6px 10px; }
.lead { font-size: 11.5px; color: #475569; margin: 0 0 20px; }
h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; }
table.list { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 20px; }
table.list thead { display: table-header-group; } table.list tr { page-break-inside: avoid; }
table.list th { background: #f8fafc; color: #64748b; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; text-align: left; padding: 8px; border-bottom: 1.5px solid #cbd5e1; }
table.list td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
table.list tr.total td { font-weight: 700; background: #f8fafc; border-top: 1.5px solid #94a3b8; border-bottom: 1.5px solid #94a3b8; }
.r { text-align: right; } .c { text-align: center; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.none { font-size: 11.5px; color: #64748b; font-style: italic; padding: 8px 0 18px; }
.sign { display: flex; justify-content: space-between; margin-top: 46px; page-break-inside: avoid; }
.sig { width: 30%; text-align: center; font-size: 11.5px; font-weight: 600; border-top: 1px solid #334155; padding-top: 6px; }
.foot { display: flex; justify-content: space-between; margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10.5px; color: #94a3b8; }
</style></head><body>
<div class="lh"><div class="logo">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" alt="">` : 'LOGO'}</div><h1>${esc(o.school)}</h1></div>
<div class="rule"></div>
<div class="title-row"><h2>Fee Overview</h2><span>Academic year <b>${esc(o.academic_year)}</b></span></div>
<table class="counts"><tr>${box('Demanded', rs(t.demanded_paise), `${t.students_billed} students billed`)}${box('Collected', rs(t.collected_paise), `${pc(t.collected_pct)} of demand`)}${box('Outstanding', rs(t.outstanding_paise), `${t.defaulters} students owe`)}${box('Concessions', rs(t.concession_paise), t.fine_paise ? `Fines ${rs(t.fine_paise)}` : 'Given this year')}</tr></table>
<p class="lead">This year's bills only. Ageing below also counts arrears carried in from earlier years.</p>
<h3>By class</h3>
${o.by_class.length ? `<table class="list"><thead><tr><th>Class</th><th class="c">Students</th><th class="r">Demanded</th><th class="r">Collected</th><th class="r">Outstanding</th><th class="r">Concession</th><th class="r">Collected</th></tr></thead><tbody>${classes}
<tr class="total"><td>Total</td><td class="c">${sum('students')}</td><td class="r">${rs(sum('demanded_paise'))}</td><td class="r">${rs(sum('collected_paise'))}</td><td class="r">${rs(sum('outstanding_paise'))}</td><td class="r">${rs(sum('concession_paise'))}</td><td class="r" style="color:${tone(allPct)}">${pc(allPct)}</td></tr></tbody></table>` : '<p class="none">No bills raised this year.</p>'}
<div class="two">
  <div><h3>Ageing of what is owed</h3>${o.ageing.length ? `<table class="list"><thead><tr><th>How long</th><th class="c">Invoices</th><th class="c">Students</th><th class="r">Amount</th></tr></thead><tbody>${o.ageing.map((a) => `<tr><td>${esc(a.bucket)}</td><td class="c">${a.invoices}</td><td class="c">${a.students}</td><td class="r">${rs(a.amount_paise)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td></td><td></td><td class="r">${rs(ageTotal)}</td></tr></tbody></table>` : '<p class="none">Nothing owed.</p>'}</div>
  <div><h3>Concessions by reason</h3>${o.concessions.length ? `<table class="list"><thead><tr><th>Reason</th><th class="c">Students</th><th class="c">Pending</th><th class="r">Amount</th></tr></thead><tbody>${o.concessions.map((c) => `<tr><td>${esc(c.kind.replace(/_/g, " ").replace(/^w/, (m) => m.toUpperCase()))}</td><td class="c">${c.students}</td><td class="c">${c.pending_approval || '—'}</td><td class="r">${rs(c.granted_amount_paise)}${c.percent_awards ? ` <span style="color:#64748b">+${c.percent_awards} %</span>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="none">No concessions given.</p>'}</div>
</div>
<div class="sign"><div class="sig">Accountant</div><div class="sig">Principal</div><div class="sig">Correspondent</div></div>
<div class="foot"><span>${esc(o.school)}</span><span>Printed ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</span></div>
</body></html>`
}
