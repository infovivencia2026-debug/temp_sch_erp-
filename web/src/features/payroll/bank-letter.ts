/* THE SALARY TRANSFER LETTER TO THE SCHOOL'S BANK (owner, 2026-10-14: like the
   BANK STMT sheet of a school's own salary workbook). A4 portrait: the bank
   and branch from payroll settings, a request to debit the school's account,
   the staff list with account, IFSC and net pay, the total in figures and
   words, and space for two signatures. Only for a locked month. */
import { inWords } from './payroll-print'

export interface LetterRow { full_name: string; employee_code: string; bank_account: string; bank_ifsc: string; net_paise: number }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function bankLetterHtml(o: {
  school: string; month: number; year: number
  bank: { name: string; branch: string; account: string; address: string }
  rows: LetterRow[]
}): string {
  const total = o.rows.reduce((n, r) => n + r.net_paise, 0)
  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  const body = o.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.full_name)}</td><td>${esc(r.bank_account) || '<em>missing</em>'}</td><td>${esc(r.bank_ifsc) || '<em>missing</em>'}</td><td class="r">${amt(r.net_paise)}</td></tr>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Salary transfer ${MONTHS[o.month - 1]} ${o.year}</title><style>
@page { size: A4 portrait; margin: 16mm; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 12.5px; color: #111; }
h1 { font-size: 18px; margin: 0 0 2px; } .muted { color: #555; }
.to { margin: 18px 0 12px; line-height: 1.5; } .subj { font-weight: 700; margin: 10px 0; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid #999; padding: 5px 6px; text-align: left; } th { background: #f0f0f0; } .r { text-align: right; }
tfoot td { font-weight: 700; } em { color: #b00; }
.sig { display: flex; justify-content: space-between; margin-top: 64px; } .sig div { width: 40%; border-top: 1px solid #333; padding-top: 6px; text-align: center; }
</style></head><body>
<h1>${esc(o.school)}</h1><div class="muted">Date: ${esc(today)}</div>
<div class="to">To<br>The Branch Manager<br>${esc(o.bank.name || '________________')}${o.bank.branch ? `<br>${esc(o.bank.branch)}` : ''}${o.bank.address ? `<br>${esc(o.bank.address)}` : ''}</div>
<div>Dear Sir / Madam,</div>
<div class="subj">Sub: Transfer of staff salaries for ${MONTHS[o.month - 1]} ${o.year}</div>
<p>We request you to debit our account no. <strong>${esc(o.bank.account || '________________')}</strong> by <strong>₹${amt(total)}</strong> (${esc(inWords(total))}) and credit the salaries of the staff listed below to their accounts.</p>
<table><thead><tr><th>S.No</th><th>Name</th><th>Account number</th><th>IFSC</th><th class="r">Amount (₹)</th></tr></thead>
<tbody>${body}</tbody><tfoot><tr><td colspan="4">Total (${o.rows.length} staff)</td><td class="r">${amt(total)}</td></tr></tfoot></table>
<p>Thanking you,<br>Yours faithfully,<br>For ${esc(o.school)}</p>
<div class="sig"><div>Authorised signatory</div><div>Authorised signatory</div></div>
</body></html>`
}
