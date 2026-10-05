/* THE STAFF ATTENDANCE REGISTER, AS PRINTED (owner's design, 2026-10-05).

   Every employee on one register, not the ten rows the screen happened to
   show (the old print copied the page, so it printed "1–10 of 20"). School and
   red rule; title and date; four totals; one row per person with the code,
   check-in and the mark; who printed it and when. */

export interface RegisterRow { employee_code: string; full_name: string; check_in?: string; mark: string }

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : esc(iso) }
const LABEL: Record<string, string> = { present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'On leave', week_off: 'Week off', on_duty: 'On duty' }
const TONE: Record<string, string> = { present: '#15803d', late: '#b45309', half_day: '#b45309', absent: '#c22525', leave: '#475569' }
const time = (t?: string) => { if (!t) return ''; const m = /(\d{2}):(\d{2})/.exec(t); if (!m) return esc(t); const h = Number(m[1]); return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}` }

export function staffRegisterHtml(o: { school: { name: string; sub?: string; logoUrl?: string }; onDate: string; rows: RegisterRow[]; printedBy: string }): string {
  const marked = o.rows.filter((r) => r.mark).length
  const present = o.rows.filter((r) => ['present', 'late', 'half_day', 'on_duty'].includes(r.mark)).length
  const away = o.rows.filter((r) => ['absent', 'leave'].includes(r.mark)).length
  const now = new Date()
  const printedAt = `${String(now.getDate()).padStart(2, '0')} ${MON[now.getMonth()]} ${now.getFullYear()}, ${now.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`
  const body = o.rows.map((r) => `<tr><td class="code-col">${esc(r.employee_code)}</td><td>${esc(r.full_name)}</td><td style="color: var(--text-muted);">${time(r.check_in) || '-'}</td><td style="font-weight:600;color:${TONE[r.mark] ?? 'var(--text-muted)'}">${r.mark ? esc(LABEL[r.mark] ?? r.mark) : 'Not marked'}</td></tr>`).join('')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Staff Attendance Register · ${day(o.onDate)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap"><style>
:root { --bg-body: #f8fafc; --bg-card: #ffffff; --text-main: #0f172a; --text-muted: #64748b; --border-color: #cbd5e1; --accent-red: #c22525; }
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: #fff; color: var(--text-main); -webkit-font-smoothing: antialiased; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.document-container { max-width: 100%; margin: 0 auto; background: var(--bg-card); }
.header-brand { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.logo-circle { width: 56px; height: 56px; border-radius: 50%; border: 1px solid var(--border-color); background: #f8fafc; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: var(--text-muted); overflow: hidden; }
.logo-circle img { width: 100%; height: 100%; object-fit: contain; }
.school-titles h1 { margin: 0 0 2px 0; font-size: 22px; font-weight: 700; color: var(--text-main); letter-spacing: -0.5px; }
.school-titles p { margin: 0; font-size: 13px; color: var(--text-muted); font-style: italic; }
.header-divider { height: 3px; background-color: var(--accent-red); margin-bottom: 32px; }
.title-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; }
.title-row h2 { font-size: 20px; font-weight: 700; color: var(--text-main); border-left: 4px solid var(--accent-red); padding-left: 12px; margin: 0; }
.date-badge { font-size: 13px; font-weight: 600; } .date-badge span { color: var(--text-muted); font-weight: 400; margin-right: 6px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
.stat-card { background: #f8fafc; border: 1px solid var(--border-color); border-radius: 6px; padding: 16px; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 700; color: var(--text-main); }
.table-card { border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; margin-bottom: 40px; }
.table-header-bar { background: #f8fafc; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); font-weight: 600; font-size: 13px; }
.table-header-bar span { color: var(--text-muted); font-size: 12px; font-weight: 500; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background-color: #ffffff; color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 20px; text-align: left; border-bottom: 1px solid var(--border-color); }
td { padding: 12px 20px; border-bottom: 1px solid var(--border-color); color: var(--text-main); }
tr:last-child td { border-bottom: none; }
.code-col { color: var(--text-muted); font-weight: 500; }
.footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: 16px; font-weight: 500; }
</style></head><body><div class="document-container">
  <div class="header-brand"><div class="logo-circle">${o.school.logoUrl ? `<img src="${esc(o.school.logoUrl)}" alt="">` : 'LOGO'}</div><div class="school-titles"><h1>${esc(o.school.name)}</h1>${o.school.sub ? `<p>${esc(o.school.sub)}</p>` : ''}</div></div>
  <div class="header-divider"></div>
  <div class="title-row"><h2>Staff Attendance Register</h2><div class="date-badge"><span>Date</span> ${day(o.onDate)}</div></div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Staff</div><div class="stat-value">${o.rows.length}</div></div>
    <div class="stat-card"><div class="stat-label">Marked</div><div class="stat-value">${marked} / ${o.rows.length}</div></div>
    <div class="stat-card"><div class="stat-label">Present</div><div class="stat-value">${present}</div></div>
    <div class="stat-card"><div class="stat-label">Absent / Leave</div><div class="stat-value">${away}</div></div>
  </div>
  <div class="table-card">
    <div class="table-header-bar">Daily Attendance Log<span>${day(o.onDate)}</span></div>
    <table><thead><tr><th>Code</th><th>Employee</th><th>Checked In</th><th>Status / Mark</th></tr></thead><tbody>${body}</tbody></table>
  </div>
  <div class="footer"><div>${esc(o.school.name)}</div><div>Generated ${esc(printedAt)}${o.printedBy ? ` by ${esc(o.printedBy)}` : ''}</div><div>${o.rows.length} staff</div></div>
</div></body></html>`
}
