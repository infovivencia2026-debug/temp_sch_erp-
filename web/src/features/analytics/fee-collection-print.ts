import { PRINT_KIT_CSS } from '@/lib/print-kit'
/* FEE COLLECTION, AS PRINTED (owner, 2026-10-06: "same layout" as the fee
   overview). School and red rule; the period; four ruled boxes (Collected,
   Receipts, Cash to bank, Other modes); the day book by mode with a total;
   by fee head and by collector side by side; the control totals an auditor
   ties out, shown only where they say something; signatures. */

export interface CollectionPrint {
  school: string; logoUrl?: string; printedBy: string; period: string; group: string
  days: { bucket: string; receipts: number; cash_paise: number; cheque_paise: number; online_paise: number; card_paise: number; adjustment_paise: number; total_paise: number }[]
  heads: { fee_head: string; amount_paise: number }[]
  collectors: { collector: string; receipts: number; cash_paise: number; other_paise: number; total_paise: number }[]
  tie?: { receipts_paise: number; allocated_paise: number; unallocated_paise: number; adjustments_paise: number; refunds_paise: number; pending_instruments_paise: number; bounced_paise: number; receipts_without_number: number }
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const rs = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cell = (p: number) => (p ? rs(p) : '<span class="dash">—</span>')
const bucket = (b: string) => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(b); return m ? (m[3] ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : `${MON[Number(m[2]) - 1]} ${m[1]}`) : esc(b) }

export function feeCollectionHtml(o: CollectionPrint): string {
  const s = (k: keyof CollectionPrint['days'][number]) => o.days.reduce((n, d) => n + (d[k] as number), 0)
  const total = s('total_paise'), cash = s('cash_paise'), receipts = s('receipts')
  const other = total - cash
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const box = (label: string, value: string, caption: string) => `<td><div class="bl">${label}</div><div class="bv">${value}</div><div class="bc">${caption}</div></td>`
  // Mode columns that were actually used in the period; an all-dash column is noise.
  const modes = ([['cash_paise', 'Cash'], ['cheque_paise', 'Cheque'], ['online_paise', 'Online'], ['card_paise', 'Card'], ['adjustment_paise', 'Adjustment']] as const).filter(([k]) => s(k) !== 0)
  const t = o.tie
  const controls = t ? ([
    ['Applied to invoices', t.allocated_paise, true],
    ['Unapplied (advance)', t.unallocated_paise, t.unallocated_paise !== 0],
    ['Write-offs', t.adjustments_paise, t.adjustments_paise !== 0],
    ['Refunds paid', t.refunds_paise, t.refunds_paise !== 0],
    ['Cheques not yet cleared', t.pending_instruments_paise, t.pending_instruments_paise !== 0],
    ['Bounced', t.bounced_paise, t.bounced_paise !== 0],
  ] as const).filter(([, , show]) => show) : []
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Fee collection · ${esc(o.period)}</title>
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
table.counts { width: 100%; border-collapse: collapse; border: 1.5px solid #0f172a; margin-bottom: 22px; table-layout: fixed; }
table.counts td { border-left: 1.5px solid #0f172a; text-align: center; padding: 0; } table.counts td:first-child { border-left: 0; }
.bl { background: #f1f5f9; border-bottom: 1.5px solid #0f172a; padding: 8px 6px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #1e293b; }
.bv { font-size: 17px; font-weight: 700; padding-top: 10px; line-height: 1.15; }
.bc { font-size: 10.5px; color: #475569; padding: 4px 6px 10px; }
h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; }
table.list { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 20px; }
table.list thead { display: table-header-group; } table.list tr { page-break-inside: avoid; }
table.list th { background: #f8fafc; color: #64748b; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; text-align: left; padding: 8px; border-bottom: 1.5px solid #cbd5e1; }
table.list td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
table.list tr.total td { font-weight: 700; background: #f8fafc; border-top: 1.5px solid #94a3b8; border-bottom: 1.5px solid #94a3b8; }
.r { text-align: right; } .c { text-align: center; } .dash { color: #cbd5e1; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.none { font-size: 11.5px; color: #64748b; font-style: italic; padding: 8px 0 18px; }
.warn { font-size: 11px; color: #b91c1c; margin: -12px 0 18px; }
.cashline { display: flex; gap: 40px; font-size: 12px; font-weight: 600; margin: -8px 0 22px; }
.cashline span { display: inline-flex; align-items: flex-end; } .fill { display: inline-block; width: 120px; border-bottom: 1px solid #000; margin-left: 8px; }
.sign { display: flex; justify-content: space-between; margin-top: 40px; page-break-inside: avoid; }
.sig { width: 30%; text-align: center; font-size: 11.5px; font-weight: 600; border-top: 1px solid #334155; padding-top: 6px; }
.foot { display: flex; justify-content: space-between; margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10.5px; color: #94a3b8; }
${PRINT_KIT_CSS}</style></head><body>
<div class="lh"><div class="logo">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" alt="">` : 'LOGO'}</div><h1>${esc(o.school)}</h1></div>
<div class="rule"></div>
<div class="title-row"><h2>Fee Collection</h2><span>Period <b>${esc(o.period)}</b></span></div>
<table class="counts"><tr>${box('Collected', rs(total), 'All modes')}${box('Receipts', String(receipts), 'Issued in the period')}${box('Cash', rs(cash), 'To be counted and banked')}${box('Other modes', rs(other), 'Cheque, online, card')}</tr></table>
<h3>Day book${o.group === 'month' ? ' (by month)' : ''}</h3>
${o.days.length ? `<table class="list"><thead><tr><th>${o.group === 'month' ? 'Month' : 'Date'}</th><th class="c">Receipts</th>${modes.map(([, l]) => `<th class="r">${l}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>
${o.days.map((d) => `<tr><td>${bucket(d.bucket)}</td><td class="c">${d.receipts}</td>${modes.map(([k]) => `<td class="r">${cell(d[k])}</td>`).join('')}<td class="r"><b>${rs(d.total_paise)}</b></td></tr>`).join('')}
<tr class="total"><td>Total</td><td class="c">${receipts}</td>${modes.map(([k]) => `<td class="r">${rs(s(k))}</td>`).join('')}<td class="r">${rs(total)}</td></tr></tbody></table>` : '<p class="none">No fees collected in this period.</p>'}
${cash ? `<div class="cashline"><span>Cash counted: ₹ <span class="fill"></span></span><span>Banked on: <span class="fill"></span></span><span>Difference: ₹ <span class="fill"></span></span></div>` : ''}
<div class="two">
  <div><h3>By fee head</h3>${o.heads.length ? `<table class="list"><thead><tr><th>Fee head</th><th class="r">Collected</th></tr></thead><tbody>${o.heads.map((h) => `<tr><td>${esc(h.fee_head)}</td><td class="r">${rs(h.amount_paise)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td class="r">${rs(o.heads.reduce((n, h) => n + h.amount_paise, 0))}</td></tr></tbody></table>` : '<p class="none">Nothing applied to fee heads.</p>'}</div>
  <div><h3>By collector</h3>${o.collectors.length ? `<table class="list"><thead><tr><th>Collected by</th><th class="c">Receipts</th><th class="r">Cash</th><th class="r">Total</th></tr></thead><tbody>${o.collectors.map((c) => `<tr><td>${esc(c.collector || '—')}</td><td class="c">${c.receipts}</td><td class="r">${cell(c.cash_paise)}</td><td class="r">${rs(c.total_paise)}</td></tr>`).join('')}</tbody></table>` : '<p class="none">No receipts.</p>'}</div>
</div>
${controls.length ? `<h3>Control totals</h3><table class="list"><tbody>${controls.map(([l, v]) => `<tr><td>${l}</td><td class="r">${rs(v)}</td></tr>`).join('')}</tbody></table>` : ''}
${t && t.receipts_without_number > 0 ? `<p class="warn">${t.receipts_without_number} receipt${t.receipts_without_number === 1 ? '' : 's'} without a receipt number. Check before closing the books.</p>` : ''}
<div class="sign"><div class="sig">Cashier</div><div class="sig">Accountant</div><div class="sig">Principal</div></div>
<div class="foot"><span>${esc(o.school)}</span><span>Printed ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</span></div>
</body></html>`
}
