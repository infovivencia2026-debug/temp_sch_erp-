import { PRINT_KIT_CSS } from '@/lib/print-kit'
/* STAFF ANALYTICS, AS PRINTED (owner, 2026-10-07: "ugly, the lines are not
   right, unnecessary data and + -"). Same family as the fee prints: school
   and red rule, four ruled count boxes, then only what a principal reads on
   paper: staff by department, who joined and who left (no net +/-), each
   person's attendance in the period, and the papers that have lapsed or fall
   due within 60 days. Columns that are zero for the whole school are left out. */

export interface HrPrint {
  school: string; logoUrl?: string; printedBy: string; period: string
  headcount: { department: string; total: number; teaching: number; non_teaching: number; permanent: number; contract: number; probation: number; part_time: number; female: number; male: number; avg_experience_years?: number }[]
  movement: { month: string; joiners: number; leavers: number }[]
  attendance: { employee_code: string; full_name: string; department?: string; days_marked: number; days_present: number; days_absent: number; days_late: number; days_leave: number; attendance_pct?: number }[]
  expiries: { employee_code: string; full_name: string; kind: string; detail: string; expires_on: string; days_left: number }[]
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : esc(iso) }
const month = (s: string) => { const m = /^(\d{4})-(\d{2})/.exec(s ?? ''); return m ? `${MON[Number(m[2]) - 1]} ${m[1]}` : esc(s) }
const tone = (n?: number) => (n == null ? '#64748b' : n >= 90 ? '#15803d' : n >= 75 ? '#b45309' : '#c22525')

export function hrReportHtml(o: HrPrint): string {
  const sum = (k: keyof HrPrint['headcount'][number]) => o.headcount.reduce((n, h) => n + (Number(h[k]) || 0), 0)
  const total = sum('total'), teaching = sum('teaching')
  const joiners = o.movement.reduce((n, m) => n + m.joiners, 0), leavers = o.movement.reduce((n, m) => n + m.leavers, 0)
  const lapsed = o.expiries.filter((e) => e.days_left < 0).length
  const due = o.expiries.filter((e) => e.days_left <= 60).sort((a, b) => a.days_left - b.days_left)
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const box = (label: string, value: string | number, caption: string) => `<td><div class="bl">${label}</div><div class="bv">${value}</div><div class="bc">${caption}</div></td>`
  // Department columns: always the totals; the employment and gender splits only where the school has any.
  const cols = ([['teaching', 'Teaching'], ['non_teaching', 'Non-teaching'], ['permanent', 'Permanent'], ['contract', 'Contract'], ['probation', 'Probation'], ['part_time', 'Part-time'], ['female', 'Women'], ['male', 'Men']] as const).filter(([k]) => sum(k) > 0)
  const moves = o.movement.filter((m) => m.joiners || m.leavers)
  const att = o.attendance.filter((a) => a.days_marked > 0)
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Staff report · ${esc(o.period)}</title>
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
.bv { font-size: 22px; font-weight: 700; padding-top: 10px; line-height: 1.1; }
.bc { font-size: 10.5px; color: #475569; padding: 4px 6px 10px; }
h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; }
table.list { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 20px; }
table.list thead { display: table-header-group; } table.list tr { page-break-inside: avoid; }
table.list th { background: #f8fafc; color: #64748b; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; text-align: left; padding: 8px; border-bottom: 1.5px solid #cbd5e1; }
table.list td { padding: 8px; border-bottom: 1px solid #e2e8f0; }
table.list tr.total td { font-weight: 700; background: #f8fafc; border-top: 1.5px solid #94a3b8; border-bottom: 1.5px solid #94a3b8; }
.c { text-align: center; } .muted { color: #64748b; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.none { font-size: 11.5px; color: #64748b; font-style: italic; padding: 6px 0 18px; }
.sign { display: flex; justify-content: space-between; margin-top: 40px; page-break-inside: avoid; }
.sig { width: 30%; text-align: center; font-size: 11.5px; font-weight: 600; border-top: 1px solid #334155; padding-top: 6px; }
.foot { display: flex; justify-content: space-between; margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 10.5px; color: #94a3b8; }
${PRINT_KIT_CSS}</style></head><body>
<div class="lh"><div class="logo">${o.logoUrl ? `<img src="${esc(o.logoUrl)}" alt="">` : 'LOGO'}</div><h1>${esc(o.school)}</h1></div>
<div class="rule"></div>
<div class="title-row"><h2>Staff Report</h2><span>Period <b>${esc(o.period)}</b></span></div>
<table class="counts"><tr>${box('Active staff', total, `${teaching} teaching · ${total - teaching} non-teaching`)}${box('Joined', joiners, 'In the period')}${box('Left', leavers, 'In the period')}${box('Documents lapsed', lapsed, lapsed ? 'Renew now' : 'All in date')}</tr></table>
<h3>Staff by department</h3>
${o.headcount.length ? `<table class="list"><thead><tr><th>Department</th><th class="c">Total</th>${cols.map(([, l]) => `<th class="c">${l}</th>`).join('')}</tr></thead><tbody>
${o.headcount.map((h) => `<tr><td><b>${esc(h.department)}</b></td><td class="c"><b>${h.total}</b></td>${cols.map(([k]) => `<td class="c">${h[k] || '<span class="muted">–</span>'}</td>`).join('')}</tr>`).join('')}
<tr class="total"><td>Total</td><td class="c">${total}</td>${cols.map(([k]) => `<td class="c">${sum(k)}</td>`).join('')}</tr></tbody></table>` : '<p class="none">No staff on the roll.</p>'}
<h3>Attendance in the period</h3>
${att.length ? `<table class="list"><thead><tr><th>Code</th><th>Name</th><th>Department</th><th class="c">Days marked</th><th class="c">Present</th><th class="c">Absent</th><th class="c">Late</th><th class="c">Leave</th><th class="c">Attendance</th></tr></thead><tbody>
${att.map((a) => `<tr><td class="muted">${esc(a.employee_code)}</td><td><b>${esc(a.full_name)}</b></td><td class="muted">${esc(a.department || '—')}</td><td class="c">${a.days_marked}</td><td class="c">${a.days_present}</td><td class="c">${a.days_absent || '–'}</td><td class="c">${a.days_late || '–'}</td><td class="c">${a.days_leave || '–'}</td><td class="c" style="color:${tone(a.attendance_pct)};font-weight:600">${a.attendance_pct == null ? '—' : Math.round(a.attendance_pct) + '%'}</td></tr>`).join('')}
</tbody></table>` : '<p class="none">No staff attendance was marked in this period.</p>'}
<div class="two">
  <div><h3>Joined and left</h3>${moves.length ? `<table class="list"><thead><tr><th>Month</th><th class="c">Joined</th><th class="c">Left</th></tr></thead><tbody>${moves.map((m) => `<tr><td>${month(m.month)}</td><td class="c">${m.joiners || '–'}</td><td class="c">${m.leavers || '–'}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nobody joined or left in this period.</p>'}</div>
  <div><h3>Documents to renew</h3>${due.length ? `<table class="list"><thead><tr><th>Name</th><th>Document</th><th>Expires</th></tr></thead><tbody>${due.map((e) => `<tr><td><b>${esc(e.full_name)}</b></td><td>${esc(e.kind)}</td><td style="color:${e.days_left < 0 ? '#c22525' : '#b45309'};font-weight:600">${day(e.expires_on)}${e.days_left < 0 ? ' · lapsed' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="none">Nothing lapsed or due in the next 60 days.</p>'}</div>
</div>
<div class="sign"><div class="sig">HR</div><div class="sig">Principal</div><div class="sig">Correspondent</div></div>
<div class="foot"><span>${esc(o.school)}</span><span>Printed ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</span></div>
</body></html>`
}
