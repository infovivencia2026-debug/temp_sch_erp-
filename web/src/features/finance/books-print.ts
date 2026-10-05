import type { CashbookAccount, Voucher } from './ledger-lib'

/* THE DAYBOOK & CASHBOOK, AS PRINTED (owner's design, 2026-10-05).

   Not a copy of the screen: no coloured stat boxes, date pickers or notes.
   School and red rule at the top; the four totals; one cashbook table per
   account that moved or holds money, opening row to closing row, with a line
   to write the counted cash; the day's vouchers with their total; signatures
   for cashier, accountant and principal; who printed it and when. */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? { y: m[1], mo: MON[Number(m[2]) - 1], d: m[3] } : null }
const day = (iso: string) => { const p = parts(iso); return p ? `${p.d} ${p.mo} ${p.y}` : esc(iso) }
const short = (iso: string) => { const p = parts(iso); return p ? `${p.d} ${p.mo}` : esc(iso) }
const TYPE: Record<string, string> = { receipt: 'Receipt', payment: 'Payment', journal: 'Journal', contra: 'Contra', purchase: 'Purchase', sales: 'Sales' }

export interface BooksPrint {
  school: { name: string; sub?: string; logoUrl?: string }
  from: string; to: string
  totals: { opening_paise: number; in_paise: number; out_paise: number; closing_paise: number }
  accounts: CashbookAccount[]
  on: string
  vouchers: Voucher[]
  printedBy: string
}

export function booksHtml(b: BooksPrint): string {
  const accounts = b.accounts.filter((a) => a.entries.length || a.opening_paise || a.closing_paise)
  const cashbooks = accounts.map((a) => `
  <div class="table-container">
    <h3 class="section-title">CASHBOOK — ${esc(a.code)} · ${esc(a.name)}</h3>
    <table>
      <thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th>Contra</th><th class="text-right">In (₹)</th><th class="text-right">Out (₹)</th><th class="text-right">Balance (₹)</th></tr></thead>
      <tbody>
        <tr><td></td><td></td><td colspan="4" style="font-style: italic; color: #475569;">Opening balance</td><td class="text-right">${amt(a.opening_paise)}</td></tr>
        ${a.entries.map((e) => `<tr><td>${day(e.date)}</td><td>${esc(e.voucher_no)}</td><td>${esc(e.narration)}</td><td>${esc(e.contra)}</td><td class="text-right">${e.in_paise ? amt(e.in_paise) : '<span class="dash">–</span>'}</td><td class="text-right">${e.out_paise ? amt(e.out_paise) : '<span class="dash">–</span>'}</td><td class="text-right">${amt((e as { balance_paise?: number }).balance_paise ?? 0)}</td></tr>`).join('')}
        <tr class="row-totals"><td colspan="4" class="text-right">Closing</td><td class="text-right">${amt(a.in_paise)}</td><td class="text-right">${amt(a.out_paise)}</td><td class="text-right">${amt(a.closing_paise)}</td></tr>
      </tbody>
    </table>
    <div class="cash-reconciliation"><span>${a.code === '1310' || /cash/i.test(a.name) ? 'Cash counted' : 'Balance as per statement'}: ₹ <span class="fill-line"></span></span><span>Difference: ₹ <span class="fill-line"></span></span></div>
  </div>`).join('')
  const dayTotal = b.vouchers.reduce((n, v) => n + v.amount_paise, 0)
  const daybook = b.vouchers.length ? `
    <table>
      <thead><tr><th>Voucher</th><th>Type</th><th>Details</th><th>Accounts</th><th class="text-right">Amount (₹)</th><th>Posted by</th></tr></thead>
      <tbody>
        ${b.vouchers.map((v) => `<tr><td>${esc(v.voucher_no)}</td><td>${esc(TYPE[v.voucher_type] ?? v.voucher_type)}</td><td>${esc(v.narration)}</td><td>${esc(v.accounts)}</td><td class="text-right">${amt(v.amount_paise)}</td><td>${esc(v.posted_by ?? '')}</td></tr>`).join('')}
        <tr class="row-totals"><td colspan="3" class="text-center" style="font-weight: 500; font-size: 11px;">${b.vouchers.length} ${b.vouchers.length === 1 ? 'entry' : 'entries'}</td><td class="text-right">Total</td><td class="text-right">${amt(dayTotal)}</td><td></td></tr>
      </tbody>
    </table>` : `<p class="none">No entries on ${day(b.on)}.</p>`
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ` + now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Daybook &amp; Cashbook · ${day(b.from)} – ${day(b.to)}</title><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root { --text-main: #0f172a; --text-muted: #475569; --border-light: #e2e8f0; --border-dark: #94a3b8; --brand-red: #dc2626; }
@page { size: A4; margin: 15mm; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background: #fff; color: var(--text-main); -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.document { background: #ffffff; max-width: 100%; margin: 0 auto; padding: 0; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
.header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid var(--brand-red); padding-bottom: 20px; margin-bottom: 30px; }
.header-left { display: flex; align-items: center; gap: 16px; }
.logo { width: 50px; height: 50px; object-fit: contain; }
.school-info h1 { margin: 0 0 2px 0; font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: -0.5px; }
.school-info p { margin: 0; font-size: 14px; color: var(--text-muted); font-style: italic; }
.header-right { text-align: right; }
.header-right h2 { margin: 0 0 4px 0; font-size: 18px; font-weight: 700; }
.header-right p { margin: 0; font-size: 13px; color: var(--text-muted); font-weight: 500; }
.section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 16px 0; color: var(--text-main); }
.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 40px; }
.summary-card { border: 1px solid var(--border-light); border-radius: 6px; padding: 16px; background: #f8fafc; }
.summary-card span { display: block; font-size: 12px; color: var(--text-muted); font-weight: 600; margin-bottom: 8px; }
.summary-card strong { font-size: 18px; font-weight: 700; color: var(--text-main); }
.table-container { margin-bottom: 40px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border-light); }
th { background: #f1f5f9; font-weight: 600; color: var(--text-muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 2px solid var(--border-dark); }
.text-right { text-align: right; } .text-center { text-align: center; }
.dash { display: inline-block; width: 100%; text-align: center; }
.row-totals td { font-weight: 700; background: #f8fafc; border-top: 2px solid var(--border-dark); border-bottom: 2px solid var(--border-dark); }
.cash-reconciliation { font-size: 13px; font-weight: 600; color: var(--text-main); display: flex; gap: 40px; padding-top: 4px; }
.cash-reconciliation span { display: inline-flex; align-items: flex-end; }
.fill-line { display: inline-block; width: 120px; border-bottom: 1px solid #000; margin-left: 8px; }
.none { font-size: 13px; color: var(--text-muted); font-style: italic; margin: 0 0 40px; }
.signatures { display: flex; justify-content: space-between; margin-top: 80px; margin-bottom: 40px; page-break-inside: avoid; }
.sig-block { width: 200px; text-align: center; }
.sig-line { border-top: 1px solid #000; margin-bottom: 8px; }
.sig-block span { font-size: 13px; font-weight: 600; }
.print-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-light); padding-top: 12px; margin-top: 40px; }
</style></head><body><div class="document">
  <header class="header">
    <div class="header-left">${b.school.logoUrl ? `<img class="logo" src="${esc(b.school.logoUrl)}" alt="">` : ''}<div class="school-info"><h1>${esc(b.school.name)}</h1>${b.school.sub ? `<p>${esc(b.school.sub)}</p>` : ''}</div></div>
    <div class="header-right"><h2>Daybook &amp; Cashbook</h2><p>Period: ${day(b.from)} – ${day(b.to)}</p></div>
  </header>
  <h3 class="section-title">SUMMARY (all cash and bank accounts)</h3>
  <div class="summary-grid">
    <div class="summary-card"><span>Opening (${short(b.from)})</span><strong>₹${amt(b.totals.opening_paise)}</strong></div>
    <div class="summary-card"><span>Received</span><strong>₹${amt(b.totals.in_paise)}</strong></div>
    <div class="summary-card"><span>Paid out</span><strong>₹${amt(b.totals.out_paise)}</strong></div>
    <div class="summary-card"><span>Closing (${short(b.to)})</span><strong>₹${amt(b.totals.closing_paise)}</strong></div>
  </div>
  ${cashbooks || `<p class="none">No cash or bank movement between ${day(b.from)} and ${day(b.to)}.</p>`}
  <div class="table-container">
    <h3 class="section-title">DAYBOOK — ${day(b.on)}</h3>
    ${daybook}
  </div>
  <div class="signatures">
    <div class="sig-block"><div class="sig-line"></div><span>Cashier</span></div>
    <div class="sig-block"><div class="sig-line"></div><span>Accountant</span></div>
    <div class="sig-block"><div class="sig-line"></div><span>Principal</span></div>
  </div>
  <div class="print-footer"><span>Printed on ${esc(printedAt)}${b.printedBy ? ` by ${esc(b.printedBy)}` : ''}</span><span>${esc(b.school.name)}</span></div>
</div></body></html>`
}
