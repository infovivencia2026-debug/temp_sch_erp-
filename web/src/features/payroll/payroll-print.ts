/* THE PAYROLL REGISTER, AS PRINTED (owner's design, 2026-10-05).

   A4 landscape. School and red rule; month and run status; the four totals;
   one row per payslip with earnings and deductions grouped under their own
   headings (a component is a deduction when its breakup value is negative,
   as the screen draws it in red); totals once at the end; net pay in words;
   four signatures. A run that is not locked prints "DRAFT, Not Approved"
   faintly across the page so nobody pays from it. */

export interface RegisterSlip {
  employee_code: string; full_name: string; left_service?: boolean
  paid_days: string; lop_days: string
  gross_paise: number; deduction_paise: number; net_paise: number
  breakup: Record<string, number>
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const whole = (p: number) => Math.round(p / 100).toLocaleString('en-IN')
const amt = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''))
const three = (n: number) => (n >= 100 ? ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n))
/** Indian words: 12,91,270 → "Twelve Lakh Ninety One Thousand Two Hundred Seventy". */
export function inWords(paise: number): string {
  const rupees = Math.floor(paise / 100), ps = paise % 100
  if (!rupees && !ps) return 'Rupees Zero Only'
  const parts: string[] = []
  const cr = Math.floor(rupees / 1e7), lakh = Math.floor((rupees % 1e7) / 1e5), th = Math.floor((rupees % 1e5) / 1e3), rest = rupees % 1e3
  if (cr) parts.push(three(cr) + ' Crore')
  if (lakh) parts.push(two(lakh) + ' Lakh')
  if (th) parts.push(two(th) + ' Thousand')
  if (rest) parts.push(three(rest))
  return 'Rupees ' + (parts.join(' ') || 'Zero') + (ps ? ' and ' + two(ps) + ' Paise' : '') + ' Only'
}

export function registerHtml(o: {
  school: { name: string; logoUrl?: string }
  month: number; year: number; status: string; published: boolean
  rows: RegisterSlip[]; printedBy: string
}): string {
  const all = [...new Set(o.rows.flatMap((r) => Object.keys(r.breakup ?? {})))]
  const isDed = (c: string) => o.rows.some((r) => (r.breakup?.[c] ?? 0) < 0)
  const ORDER = ['Basic', 'HRA', 'DA', 'PF', 'ESI', 'PT', 'TDS']
  const rank = (c: string) => { const i = ORDER.findIndex((x) => c.toUpperCase().startsWith(x.toUpperCase())); return i < 0 ? 99 : i }
  const sort = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b)
  /* The school's own contributions (employer PF, EPS, EDLI) are in the
     breakup but not in the pay: under Earnings they made the row add up to
     more than Gross. They get their own group after Net Pay. */
  const isEmployer = (c: string) => /employer|^eps|edli|admin.?charge/i.test(c)
  const emp = all.filter((c) => !isDed(c) && isEmployer(c)).sort(sort)
  const earn = all.filter((c) => !isDed(c) && !isEmployer(c)).sort(sort)
  const label = (c: string) => esc(c.replace(/_/g, ' ').replace(/\b(pf|esi|pt|tds|hra|da|eps|edli)\b/gi, (m) => m.toUpperCase()).replace(/\bemployer\b/i, '(Employer)').replace(/\b([a-z])/g, (m) => m.toUpperCase()))
  const days = (d: string) => { const n = Number(d); return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : esc(d) }
  const ded = all.filter(isDed).sort(sort)
  const gross = o.rows.reduce((n, r) => n + r.gross_paise, 0)
  const dedT = o.rows.reduce((n, r) => n + r.deduction_paise, 0)
  const net = o.rows.reduce((n, r) => n + r.net_paise, 0)
  const sum = (c: string) => o.rows.reduce((n, r) => n + Math.abs(r.breakup?.[c] ?? 0), 0)
  const cell = (v: number | undefined) => (v ? whole(Math.abs(v)) : '')
  const locked = ['locked', 'paid'].includes(o.status)
  const statusText = !o.status ? 'Not run' : (o.status === 'paid' ? 'Paid' : o.status === 'locked' ? 'Locked' : 'Draft') + (o.published ? ' · Published' : '')
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`

  const body = o.rows.map((r, i) => `<tr>
    <td class="text-left">${i + 1}</td>
    <td class="col-code text-left">${esc(r.employee_code)}</td>
    <td class="col-emp text-left">${esc(r.full_name)}${r.left_service ? ' <span class="emp-left">(Left)</span>' : ''}</td>
    <td class="text-center">${days(r.paid_days)}</td>
    <td class="text-center">${Number(r.lop_days) > 0 ? days(r.lop_days) : ''}</td>
    ${earn.map((c) => `<td class="text-right amt-cell">${cell(r.breakup?.[c])}</td>`).join('')}
    <td class="text-right amt-cell col-highlight">${amt(r.gross_paise)}</td>
    ${ded.map((c) => `<td class="text-right amt-cell">${cell(r.breakup?.[c])}</td>`).join('')}
    <td class="text-right amt-cell col-highlight">${amt(r.deduction_paise)}</td>
    <td class="text-right amt-cell col-highlight">${amt(r.net_paise)}</td>
    ${emp.map((c) => `<td class="text-right amt-cell emp-col">${cell(r.breakup?.[c])}</td>`).join('')}
  </tr>`).join('')

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Payroll Register · ${MONTHS[o.month - 1]} ${o.year}</title><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root { --text-main: #0f172a; --text-muted: #64748b; --border-light: #e2e8f0; --border-dark: #94a3b8; --brand-red: #dc2626; --bg-highlight: #f8fafc; }
@page { size: A4 landscape; margin: 15mm; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background: #fff; color: var(--text-main); -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.document { background: #ffffff; max-width: 100%; margin: 0 auto; padding: 0; position: relative; z-index: 1; }
thead { display: table-header-group; } tfoot { display: table-footer-group; } tr { page-break-inside: avoid; }
.logo-watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 350px; height: 350px; opacity: 0.04; z-index: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; }
.logo-watermark img { max-width: 100%; max-height: 100%; filter: grayscale(100%); }
.draft-watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 110px; color: rgba(220, 38, 38, 0.07); font-weight: 900; white-space: nowrap; z-index: 0; pointer-events: none; text-transform: uppercase; letter-spacing: 2px; }
.content-wrapper { position: relative; z-index: 2; }
.header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid var(--brand-red); padding-bottom: 20px; margin-bottom: 24px; }
.header-left { display: flex; align-items: center; gap: 16px; }
.logo { width: 48px; height: 48px; object-fit: contain; }
.school-info h1 { margin: 0 0 4px 0; font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: -0.5px; }
.school-info p { margin: 0; font-size: 13px; color: var(--text-muted); font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; }
.header-right { text-align: right; }
.header-right h2 { margin: 0 0 6px 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.header-right p { margin: 0 0 4px 0; font-size: 13px; font-weight: 600; color: var(--text-main); }
.header-right .status { font-size: 12px; color: var(--text-muted); font-weight: 500; }
.summary-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
.summary-item { display: flex; flex-direction: column; gap: 4px; }
.summary-item span { font-size: 11px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
.summary-item strong { font-size: 16px; font-weight: 700; color: var(--text-main); }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 16px; font-variant-numeric: tabular-nums; }
th, td { padding: 10px 8px; border-bottom: 1px solid var(--border-light); }
tbody tr:nth-child(even) { background-color: #f8fafc; }
thead tr.group-headers th { text-align: center; padding-bottom: 6px; color: var(--text-main); font-size: 10px; font-weight: 700; letter-spacing: 1px; border-bottom: none; }
.group-title { display: block; border-top: 1px solid var(--border-dark); padding-top: 6px; margin: 0 4px; }
thead tr.col-headers th { color: var(--text-muted); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; vertical-align: bottom; border-bottom: 2px solid var(--border-dark); line-height: 1.3; background-color: #ffffff; }
.text-left { text-align: left; } .text-center { text-align: center; } .text-right { text-align: right; }
.col-sno { width: 3%; } .col-code { width: 5%; color: var(--text-muted); } .col-emp { width: 14%; font-weight: 500; } .col-days { width: 4%; }
.amt-cell { white-space: nowrap; }
.col-highlight { font-weight: 600; color: var(--text-main); }
tbody tr:nth-child(odd) .col-highlight { background-color: #f8fafc; }
tbody tr:nth-child(even) .col-highlight { background-color: #f1f5f9; }
.emp-left { color: var(--text-muted); font-style: italic; font-size: 10px; margin-left: 6px; font-weight: 400; }
tfoot td { font-weight: 700; font-size: 12.5px; color: var(--text-main); border-top: 2px solid var(--border-dark); border-bottom: 2px solid var(--border-dark); padding: 14px 8px; background-color: #ffffff; }
tfoot .col-highlight { background-color: #f1f5f9; }
.net-words { font-size: 12px; color: var(--text-muted); margin-bottom: 60px; font-style: italic; }
.net-words strong { color: var(--text-main); font-style: normal; font-weight: 600; }
.signatures { display: flex; justify-content: space-between; margin-bottom: 40px; page-break-inside: avoid; }
.sig-block { width: 22%; text-align: center; }
.sig-line { border-top: 1px solid var(--border-dark); margin-bottom: 10px; }
.sig-block span { display: block; font-size: 12px; font-weight: 600; color: var(--text-main); }
.print-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-light); padding-top: 12px; }
.emp-col { color: var(--text-muted); }
.none { font-size: 13px; color: var(--text-muted); font-style: italic; padding: 20px 0 40px; }
</style></head><body><div class="document">
  ${o.school.logoUrl ? `<div class="logo-watermark"><img src="${esc(o.school.logoUrl)}" alt=""></div>` : ''}
  ${locked ? '' : '<div class="draft-watermark">DRAFT, Not Approved</div>'}
  <div class="content-wrapper">
    <header class="header">
      <div class="header-left">${o.school.logoUrl ? `<img class="logo" src="${esc(o.school.logoUrl)}" alt="">` : ''}<div class="school-info"><h1>${esc(o.school.name)}</h1><p>Financial Operations Department</p></div></div>
      <div class="header-right"><h2>Payroll Register</h2><p>Month: ${MONTHS[o.month - 1]} ${o.year}</p><div class="status">Run status: ${esc(statusText)}</div></div>
    </header>
    <div class="summary-bar">
      <div class="summary-item"><span>Staff Paid</span><strong>${o.rows.length}</strong></div>
      <div class="summary-item"><span>Total Gross</span><strong>₹${amt(gross)}</strong></div>
      <div class="summary-item"><span>Total Deductions</span><strong>₹${amt(dedT)}</strong></div>
      <div class="summary-item"><span>Total Net Pay</span><strong>₹${amt(net)}</strong></div>
    </div>
    ${o.rows.length ? `<table>
      <thead>
        <tr class="group-headers"><th colspan="5"></th><th colspan="${earn.length + 1}"><span class="group-title">EARNINGS</span></th><th colspan="${ded.length + 1}"><span class="group-title">DEDUCTIONS</span></th><th></th>${emp.length ? `<th colspan="${emp.length}"><span class="group-title">EMPLOYER SHARE</span></th>` : ''}</tr>
        <tr class="col-headers">
          <th class="col-sno text-left">S.No</th><th class="col-code text-left">Code</th><th class="col-emp text-left">Employee</th>
          <th class="col-days text-center">Paid<br>Days</th><th class="col-days text-center">LOP<br>Days</th>
          ${earn.map((c) => `<th class="text-right">${label(c)}</th>`).join('')}<th class="text-right col-highlight">Gross</th>
          ${ded.map((c) => `<th class="text-right">${label(c)}</th>`).join('')}<th class="text-right col-highlight">Total<br>Ded.</th>
          <th class="text-right col-highlight" style="color:var(--text-main);">Net Pay</th>
          ${emp.map((c) => `<th class="text-right emp-col">${label(c)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="5" class="text-left">TOTAL (${o.rows.length} staff)</td>
        ${earn.map((c) => `<td class="text-right amt-cell">${whole(sum(c))}</td>`).join('')}<td class="text-right amt-cell col-highlight">${amt(gross)}</td>
        ${ded.map((c) => `<td class="text-right amt-cell">${whole(sum(c))}</td>`).join('')}<td class="text-right amt-cell col-highlight">${amt(dedT)}</td>
        <td class="text-right amt-cell col-highlight">${amt(net)}</td>
        ${emp.map((c) => `<td class="text-right amt-cell emp-col">${whole(sum(c))}</td>`).join('')}
      </tr></tfoot>
    </table>
    <div class="net-words">Net pay in words: <strong>${inWords(net)}</strong></div>` : `<p class="none">No payroll run for ${MONTHS[o.month - 1]} ${o.year} yet.</p>`}
    <div class="signatures">
      <div class="sig-block"><div class="sig-line"></div><span>Prepared by (HR)</span></div>
      <div class="sig-block"><div class="sig-line"></div><span>Checked by (Accounts)</span></div>
      <div class="sig-block"><div class="sig-line"></div><span>Principal</span></div>
      <div class="sig-block"><div class="sig-line"></div><span>Correspondent / Trustee</span></div>
    </div>
    <div class="print-footer"><span>Printed on ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</span><span>${esc(o.school.name)}</span></div>
  </div>
</div></body></html>`
}
